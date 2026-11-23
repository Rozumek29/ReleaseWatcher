import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, it } from 'bun:test';
import { buildCheckScript, cleanOutput, newCheckToken, parseCheckOutput, shQuote, vzdumpCommand, type CheckStep } from '../src/proxmox/domain.ts';

/**
 * Runs the generated node command in a real POSIX shell with a stub `pct` (no Proxmox, no network):
 * `pct status` reports the given state, `pct exec <vmid> -- cmd…` runs cmd locally.
 */
/** Prints stdin as the JSON of `qm guest exec`, with the exit code from the first argument. */
const GUEST_JSON = [
  "const data = require('node:fs').readFileSync(0, 'utf8');",
  "const result = { exitcode: Number(process.argv.at(-1)), exited: 1, 'out-data': data, 'out-truncated': 0 };",
  'process.stdout.write(JSON.stringify(result, null, 3) + "\\n");',
].join('\n');

/**
 * `lxc` set = the node has the LXC tools: `lxc-info` reports that state and `lxc-attach … -- cmd…` (an executable,
 * since the script `exec`s it) runs cmd locally. Otherwise `lxc-info` fails like for an unknown container.
 */
async function runOnStubNode(script: string, status: 'running' | 'stopped', agent = true, lxc?: 'RUNNING' | 'STOPPED') {
  const bin = await mkdtemp(join(tmpdir(), 'rw-lxc-'));
  await Bun.write(join(bin, 'lxc-attach'), '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done; shift\nexec "$@"\n');
  // Executables, not shell functions: dash does not allow a dash in a function name.
  const info = lxc ? `echo '${lxc}'` : `echo "$2 doesn't exist" >&2; exit 1`;
  await Bun.write(join(bin, 'lxc-info'), `#!/bin/sh\n${info}\n`);
  for (const tool of ['lxc-attach', 'lxc-info']) await chmod(join(bin, tool), 0o755);
  const stub = [
    'pct() {',
    '  case "$1" in',
    `    status) echo "status: ${status}" ;;`,
    '    exec) shift 2; [ "$1" = "--" ] && shift; "$@" ;;',
    '  esac',
    '}',
    // `qm guest exec <vmid> [--timeout n] -- cmd…` runs cmd locally and prints its result as JSON, like Proxmox.
    'qm() {',
    '  case "$1" in',
    `    status) echo "status: ${status}" ;;`,
    '    guest)',
    agent ? '' : `      echo 'QEMU guest agent is not running' >&2; return 255`,
    '      shift 3; while [ "$1" != "--" ]; do shift; done; shift',
    '      out=$("$@" 2>&1); rc=$?',
    // Bun itself writes the JSON (correct escaping without jq on the test machine).
    `      printf '%s' "$out" | "$RW_BUN" -e ${shQuote(GUEST_JSON)} "$rc" ;;`,
    '  esac',
    '}',
  ].join('\n');
  const proc = Bun.spawn(['sh', '-c', `${stub}\n${script}`], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, RW_BUN: process.execPath, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, SSL_CERT_FILE: '/pve/ca.pem' },
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  await rm(bin, { recursive: true, force: true });
  return cleanOutput(stdout + stderr);
}

describe('batched check script', () => {
  const steps: CheckStep[] = [
    { id: 'v1', script: `echo "it's 1.2.3"`, timeoutSeconds: 10 },
    { id: 'v2', script: 'echo first\necho second >&2\nexit 3', timeoutSeconds: 10 },
    { id: 'l1', script: `printf '%s' 'no newline'`, timeoutSeconds: 10 },
    { id: 'l2', script: 'sleep 5; echo late', timeoutSeconds: 1 },
  ];

  it('runs every step once and keeps output and exit codes apart', async () => {
    const token = newCheckToken();
    const output = await runOnStubNode(buildCheckScript({ kind: 'lxc', vmid: 101 }, steps, token), 'running');
    const result = parseCheckOutput(output, token);

    assert.deepEqual(result.status, { exitCode: 0, output: 'status: running' });
    assert.deepEqual(result.steps.get('v1'), { exitCode: 0, output: "it's 1.2.3" });
    assert.equal(result.steps.get('v2')?.exitCode, 3);
    assert.match(result.steps.get('v2')?.output ?? '', /first\nsecond/);
    assert.deepEqual(result.steps.get('l1'), { exitCode: 0, output: 'no newline' });
    // `timeout` (coreutils/busybox) stops the step; the following steps would still run.
    assert.equal(result.steps.get('l2')?.exitCode, 124);
  });

  it('does not run anything inside a stopped container', async () => {
    const token = newCheckToken();
    const output = await runOnStubNode(buildCheckScript({ kind: 'lxc', vmid: 102 }, steps, token), 'stopped');
    const result = parseCheckOutput(output, token);
    assert.deepEqual(result.status, { exitCode: 0, output: 'status: stopped' });
    assert.equal(result.steps.size, 0);
  });

  it('asks the LXC tools directly when the node has them (pct starts slowly)', async () => {
    const token = newCheckToken();
    const withEnv: CheckStep[] = [...steps, { id: 'env', script: 'echo "ssl=${SSL_CERT_FILE-unset}"', timeoutSeconds: 10 }];
    // The stub `pct` reports "stopped" – a running status shows that it was not asked.
    const result = parseCheckOutput(await runOnStubNode(buildCheckScript({ kind: 'lxc', vmid: 101 }, withEnv, token), 'stopped', true, 'RUNNING'), token);
    assert.deepEqual(result.status, { exitCode: 0, output: 'status: running' });
    assert.deepEqual(result.steps.get('v1'), { exitCode: 0, output: "it's 1.2.3" });
    assert.equal(result.steps.get('v2')?.exitCode, 3);
    assert.equal(result.steps.get('l2')?.exitCode, 124);
    // Like `pct exec`: the SSL variables PVE sets for itself do not reach the container.
    assert.deepEqual(result.steps.get('env'), { exitCode: 0, output: 'ssl=unset' });
  });

  it('reads a stopped container from the LXC tools and runs nothing in it', async () => {
    const token = newCheckToken();
    const script = buildCheckScript({ kind: 'lxc', vmid: 102 }, steps, token);
    const result = parseCheckOutput(await runOnStubNode(script, 'running', true, 'STOPPED'), token);
    assert.deepEqual(result.status, { exitCode: 0, output: 'status: stopped' });
    assert.equal(result.steps.size, 0);
  });

  it('falls back to pct when the LXC tools do not know the container', async () => {
    const token = newCheckToken();
    const script = buildCheckScript({ kind: 'lxc', vmid: 999 }, steps, token).replace(
      'pct status 999',
      `{ echo "Configuration file 'nodes/pve/lxc/999.conf' does not exist" >&2; false; }`,
    );
    const result = parseCheckOutput(await runOnStubNode(script, 'running'), token);
    assert.equal(result.status?.exitCode, 1);
    assert.match(result.status?.output ?? '', /999\.conf' does not exist/);
    assert.equal(result.steps.size, 0);
  });

  it('runs the steps on the node itself for the host (no pct at all)', async () => {
    const token = newCheckToken();
    const script = buildCheckScript(null, steps, token);
    assert.equal(script.includes('pct'), false);
    // The stub `pct` would report "stopped" – the host script must not ask it.
    const result = parseCheckOutput(await runOnStubNode(script, 'stopped'), token);
    assert.deepEqual(result.status, { exitCode: 0, output: 'status: running' });
    assert.deepEqual(result.steps.get('v1'), { exitCode: 0, output: "it's 1.2.3" });
    assert.equal(result.steps.get('v2')?.exitCode, 3);
  });

  it('runs the steps in a virtual machine through the guest agent and reads them from its JSON', async () => {
    const token = newCheckToken();
    const script = buildCheckScript({ kind: 'vm', vmid: 137 }, steps, token);
    assert.match(script, /qm status 137/);
    assert.match(script, /qm guest exec 137 --timeout 61 -- sh -lc/);
    assert.equal(script.includes('pct'), false);
    const result = parseCheckOutput(await runOnStubNode(script, 'running'), token, true);

    assert.deepEqual(result.status, { exitCode: 0, output: 'status: running' });
    assert.equal(result.guestError, null);
    assert.deepEqual(result.steps.get('v1'), { exitCode: 0, output: "it's 1.2.3" });
    assert.equal(result.steps.get('v2')?.exitCode, 3);
    assert.match(result.steps.get('v2')?.output ?? '', /first\nsecond/);
    assert.deepEqual(result.steps.get('l1'), { exitCode: 0, output: 'no newline' });
    assert.equal(result.steps.get('l2')?.exitCode, 124);
  });

  it('reports a missing guest agent instead of step results', async () => {
    const token = newCheckToken();
    const script = buildCheckScript({ kind: 'vm', vmid: 137 }, steps, token);
    const result = parseCheckOutput(await runOnStubNode(script, 'running', false), token, true);
    assert.deepEqual(result.status, { exitCode: 0, output: 'status: running' });
    assert.equal(result.steps.size, 0);
    assert.equal(result.guestError, 'QEMU guest agent is not running');
  });

  it('backs up with zstd, except on Proxmox Backup Server', async () => {
    const run = async (storage: string) => {
      const stub = [
        'pvesm() {',
        '  echo "Name Type Status Total Used Available %"',
        '  case "$3" in pbs) echo "pbs pbs active 1 1 1 1%" ;; *) echo "$3 dir active 1 1 1 1%" ;; esac',
        '}',
        'vzdump() { printf "vzdump"; printf " [%s]" "$@"; echo; }',
      ].join('\n');
      const proc = Bun.spawn(['sh', '-c', `${stub}\n${vzdumpCommand(101, storage, "before it's updated")}`], {
        stdout: 'pipe',
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return out.trim();
    };
    assert.equal(
      await run('local'),
      "vzdump [101] [--storage] [local] [--mode] [snapshot] [--compress] [zstd] [--notes-template] [before it's updated]",
    );
    assert.equal(
      await run('pbs'),
      "vzdump [101] [--storage] [pbs] [--mode] [snapshot] [--notes-template] [before it's updated]",
    );
  });

  it('ignores markers with a different token', () => {
    const token = newCheckToken();
    const fake = `${newCheckToken()} begin v1\nhacked\n`;
    const result = parseCheckOutput(`${token} begin v1\n${fake}${token} end v1 0\n`, token);
    assert.equal(result.steps.get('v1')?.exitCode, 0);
    assert.match(result.steps.get('v1')?.output ?? '', /hacked/);
  });
});
