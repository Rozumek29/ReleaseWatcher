import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { buildCheckScript, cleanOutput, newCheckToken, parseCheckOutput, vzdumpCommand, type CheckStep } from '../src/proxmox/domain.ts';

/**
 * Runs the generated node command in a real POSIX shell with a stub `pct` (no Proxmox, no network):
 * `pct status` reports the given state, `pct exec <vmid> -- cmd…` runs cmd locally.
 */
async function runOnStubNode(script: string, status: 'running' | 'stopped') {
  const stub = [
    'pct() {',
    '  case "$1" in',
    `    status) echo "status: ${status}" ;;`,
    '    exec) shift 2; [ "$1" = "--" ] && shift; "$@" ;;',
    '  esac',
    '}',
  ].join('\n');
  const proc = Bun.spawn(['sh', '-c', `${stub}\n${script}`], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
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
    const output = await runOnStubNode(buildCheckScript(101, steps, token), 'running');
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
    const output = await runOnStubNode(buildCheckScript(102, steps, token), 'stopped');
    const result = parseCheckOutput(output, token);
    assert.deepEqual(result.status, { exitCode: 0, output: 'status: stopped' });
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
