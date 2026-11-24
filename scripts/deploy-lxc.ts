// Builds ReleaseWatcher and installs (or updates) it as a systemd service in a Proxmox LXC – one command from your
// computer. Files travel over SSH to the node and into the container with `pct push`; `deploy/install.sh` then
// sets everything up inside the container (user, directories, service, first configuration with a Basic auth
// password). Running it again updates the app and keeps the configuration and data.
//
// Usage: bun scripts/deploy-lxc.ts --ct <vmid> [options]
//   --ct <vmid>        target container (required)
//   --node <host>      Proxmox node; default: the host saved in the local database (Settings → Proxmox node)
//   --user <name>      SSH user on the node (default: root, or the one saved in the local database)
//   --port <port>      SSH port (default: 22, or the saved one)
//   --identity <file>  SSH private key; default: your normal ssh setup (~/.ssh, agent, ~/.ssh/config)
//   --db               copy the local database (repositories, containers, settings) – only when the container has
//                      none yet; add --force-db to replace an existing one
//   --baseline         build for older x64 CPUs without AVX2 (the default build crashes there with
//                      "Illegal instruction")
//   --arm64            build for a 64-bit ARM node (e.g. Proxmox on a Raspberry Pi)
//   --skip-build       reuse dist/releasewatcher-linux-x64 (or -linux-x64-baseline / -linux-arm64)
//   --database <path>  local database to read defaults from / copy (default: DATABASE_PATH or releasewatcher.db)

import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildExecutable } from './build-executable.ts';

const root = resolve(import.meta.dir, '..');
const { values } = parseArgs({
  options: {
    ct: { type: 'string' },
    node: { type: 'string' },
    user: { type: 'string' },
    port: { type: 'string' },
    identity: { type: 'string' },
    db: { type: 'boolean', default: false },
    'force-db': { type: 'boolean', default: false },
    baseline: { type: 'boolean', default: false },
    arm64: { type: 'boolean', default: false },
    'skip-build': { type: 'boolean', default: false },
    database: { type: 'string' },
  },
});

const fail = (message: string): never => {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
};
const step = (message: string) => console.log(`\x1b[1;34m»\x1b[0m ${message}`);

const vmid = values.ct ?? fail('Pass the container ID: --ct <vmid> (e.g. --ct 251).');
if (!/^\d+$/.test(vmid)) {
  fail(`--ct must be a number, got "${vmid}".`);
}

// Defaults come from the first Proxmox host of the local (development) database – or, in a database of an older
// version, from its former Proxmox settings.
const databasePath = resolve(root, values.database ?? process.env['DATABASE_PATH'] ?? 'releasewatcher.db');
const saved: Record<string, string> = {};
if (existsSync(databasePath)) {
  const db = new Database(databasePath, { readonly: true });
  try {
    for (const row of db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings').all()) {
      saved[row.key] = row.value;
    }
    const host = db
      .query<{ address: string; port: number; user: string }, []>(
        "SELECT address, port, user FROM hosts WHERE type = 'proxmox' ORDER BY id LIMIT 1",
      )
      .get();
    if (host) {
      saved['proxmoxHost'] = host.address;
      saved['proxmoxPort'] = String(host.port);
      saved['proxmoxUser'] = host.user;
    }
  } catch {
    // no settings / hosts table yet
  } finally {
    db.close();
  }
}
const node = values.node ?? saved['proxmoxHost'] ?? process.env['PROXMOX_HOST'] ?? fail(
  'Unknown Proxmox node – pass --node <host> (or add it under Settings → Connections of your local instance).',
);
const user = values.user ?? saved['proxmoxUser'] ?? 'root';
const port = values.port ?? saved['proxmoxPort'] ?? '22';
if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(node) || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(user) || !/^\d+$/.test(port)) {
  fail('Invalid node, user or port.');
}

const staging = mkdtempSync(join(tmpdir(), 'releasewatcher-deploy-'));
try {
  // 1. Build
  if (values.baseline && values.arm64) fail('--baseline and --arm64 cannot be combined.');
  const buildTarget = values.arm64 ? 'bun-linux-arm64' : values.baseline ? 'bun-linux-x64-baseline' : 'bun-linux-x64';
  const binary = join(root, 'dist', `releasewatcher-${buildTarget.replace(/^bun-/, '')}`);
  if (!values['skip-build']) {
    step('Building the UI');
    // NG_CLI_ANALYTICS: never stop at the Angular CLI's interactive analytics question.
    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: root,
      stdout: 'inherit',
      stderr: 'inherit',
      env: { ...process.env, NG_CLI_ANALYTICS: 'false' },
    });
    if (build.exitCode !== 0) fail('UI build failed.');
    step('Compiling the Linux executable');
    await buildExecutable({ outfile: binary, target: buildTarget });
  } else if (!existsSync(binary)) {
    fail(`${binary} does not exist – run without --skip-build.`);
  }

  // 2. Stage the files (text files with LF line endings – they run on Linux). The executable is mostly the Bun
  //    runtime (~110 MB); zstd halves the upload and the Proxmox node (which uses zstd for backups) unpacks it.
  step('Compressing the executable');
  await Bun.write(join(staging, 'releasewatcher-linux-x64.zst'), await Bun.zstdCompress(await Bun.file(binary).bytes(), { level: 9 }));
  for (const [from, to] of [
    ['deploy/install.sh', 'install.sh'],
    ['deploy/releasewatcher.service', 'releasewatcher.service'],
    ['.env.example', '.env.example'],
  ] as const) {
    writeFileSync(join(staging, to), readFileSync(join(root, from), 'utf8').replace(/\r\n/g, '\n'));
  }
  const uploads = ['releasewatcher-linux-x64.zst', 'install.sh', 'releasewatcher.service', '.env.example'];
  /** Files pushed into the container (after unpacking on the node). */
  const files = ['releasewatcher-linux-x64', 'install.sh', 'releasewatcher.service', '.env.example'];
  if (values.db || values['force-db']) {
    if (!existsSync(databasePath)) fail(`${databasePath} does not exist.`);
    step(`Snapshotting the local database ${databasePath}`);
    // VACUUM INTO gives a consistent copy even while the dev server is running.
    const db = new Database(databasePath, { readonly: true });
    db.run(`VACUUM INTO '${join(staging, 'releasewatcher.db').replaceAll("'", "''")}'`);
    db.close();
    files.push('releasewatcher.db');
    uploads.push('releasewatcher.db');
  }

  // 3. SSH options: an explicit key or the user's normal ssh setup
  // BatchMode: a rejected key would otherwise fall back to a password prompt that never shows under Bun.spawnSync
  // on Windows, and the deploy would hang silently instead of failing.
  const sshOptions = ['-p', port, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (values.identity) {
    sshOptions.push('-i', resolve(values.identity), '-o', 'IdentitiesOnly=yes');
  }
  // On Windows use the system OpenSSH client: it talks to the Windows ssh-agent service, while the ssh from Git
  // for Windows (first on PATH in Git Bash) cannot see those keys and fails with "Permission denied".
  const windowsOpenSsh = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'OpenSSH');
  const useWindowsSsh = process.platform === 'win32' && existsSync(join(windowsOpenSsh, 'ssh.exe'));
  const ssh = useWindowsSsh ? join(windowsOpenSsh, 'ssh.exe') : 'ssh';
  const scp = useWindowsSsh ? join(windowsOpenSsh, 'scp.exe') : 'scp';
  const target = `${user}@${node}`;
  const remoteDir = `/tmp/releasewatcher-deploy-${process.pid}`;
  const run = (cmd: string[], cwd = staging) => Bun.spawnSync(cmd, { cwd, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });

  // 4. Upload to the node (relative paths: scp would read "C:\…" as a host name)
  step(`Uploading to ${target}`);
  if (run([ssh, ...sshOptions, target, `mkdir -p ${remoteDir}`]).exitCode !== 0) {
    fail(`Cannot connect to ${target} over SSH.`);
  }
  if (run([scp, '-q', ...sshOptions.map((o) => (o === '-p' ? '-P' : o)), ...uploads, `${target}:${remoteDir}/`]).exitCode !== 0) {
    fail('Upload to the node failed.');
  }

  // 5. Into the container and install
  step(`Installing into CT ${vmid}`);
  const sudo = user === 'root' ? '' : 'sudo ';
  const remote = [
    'set -e',
    `trap 'rm -rf ${remoteDir}' EXIT`,
    `zstd -dq --rm ${remoteDir}/releasewatcher-linux-x64.zst`,
    `${sudo}pct status ${vmid} | grep -q 'status: running' || { echo "CT ${vmid} is not running – starting it"; ${sudo}pct start ${vmid}; sleep 5; }`,
    `${sudo}pct exec ${vmid} -- mkdir -p /root/releasewatcher-deploy`,
    ...files.map((f) => `${sudo}pct push ${vmid} ${remoteDir}/${f} /root/releasewatcher-deploy/${f}`),
    `${sudo}pct exec ${vmid} -- env FORCE_DB=${values['force-db'] ? 1 : 0} sh /root/releasewatcher-deploy/install.sh /root/releasewatcher-deploy`,
    `${sudo}pct exec ${vmid} -- rm -rf /root/releasewatcher-deploy`,
  ].join('\n');
  if (run([ssh, ...sshOptions, target, remote]).exitCode !== 0) {
    fail(`Installation in CT ${vmid} failed – see the output above.`);
  }
} finally {
  rmSync(staging, { recursive: true, force: true });
}
