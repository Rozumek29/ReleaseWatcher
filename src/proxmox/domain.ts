import { compareVersions } from '../version.ts';

export const TARGET_KINDS = ['lxc', 'node'] as const;
/** `lxc` = a container managed through `pct exec`; `node` = the Proxmox host itself (apt only). */
export type TargetKind = (typeof TARGET_KINDS)[number];

/** vmid stored for the Proxmox host entry (real container IDs start at 100). */
export const NODE_VMID = 0;

/** An LXC container on the Proxmox node, managed through `pct exec` – or the node itself (`kind: 'node'`). */
export interface Container {
  id: number;
  kind: TargetKind;
  /** Proxmox container ID (e.g. 101); {@link NODE_VMID} for the host. */
  vmid: number;
  name: string;
  /** Disabled containers are skipped by scheduled checks. */
  isEnabled: boolean;
  /** Check (and allow upgrading) apt packages. */
  aptEnabled: boolean;
  /** Back up (vzdump) before updates by default; null = use the global setting. */
  backupBeforeUpdate: boolean | null;
  /** Start the container for checks and updates when it is stopped, and shut it down again afterwards. */
  startWhenStopped: boolean;
  /** Cron expression overriding the global check schedule; null = use the global one. */
  checkCron: string | null;
  /** CPU cores during updates (raised with `pct set`, restored afterwards); null = unchanged. */
  updateCores: number | null;
  /** Memory in MiB during updates (raised with `pct set`, restored afterwards); null = unchanged. */
  updateMemoryMb: number | null;
  /** Resources raised for an update that still have to be restored (survives a restart). */
  resourcesToRestore: ResourceChange | null;
  /** Last status reported by `pct status` (running, stopped, …). */
  status: string | null;
  aptUpgradable: AptPackage[];
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Fingerprint of the pending updates already notified about (prevents repeated notifications). */
  notifiedSignature: string | null;
  createdAt: string;
}

export interface AptPackage {
  name: string;
  currentVersion: string | null;
  newVersion: string;
}

export const LATEST_SOURCES = ['none', 'github', 'command'] as const;
/** Where the newest available version of an application comes from. */
export type LatestSource = (typeof LATEST_SOURCES)[number];

/** An application inside a container with its own version check and update command. */
export interface ContainerApp {
  id: number;
  containerId: number;
  name: string;
  /** Prints the installed version, e.g. `cat /opt/vaultwarden_version.txt`. */
  versionCommand: string | null;
  latestSource: LatestSource;
  /** Watched GitHub repository whose newest release is the latest version (latestSource = github). */
  repositoryId: number | null;
  /** Prints the newest available version (latestSource = command). Runs inside the container. */
  latestCommand: string | null;
  /** Updates the application, e.g. `update` (community-scripts) or `cd /opt/app && ./pull.sh`. */
  updateCommand: string | null;
  /** Run the update with a pseudo-terminal (needed by some interactive scripts). */
  useTty: boolean;
  timeoutSeconds: number;
  installedVersion: string | null;
  latestVersion: string | null;
  checkedAt: string | null;
  error: string | null;
  createdAt: string;
}

export const RUN_KINDS = ['check', 'apt-upgrade', 'app-update'] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export type RunStatus = 'running' | 'succeeded' | 'failed';
export type RunTrigger = 'manual' | 'schedule';

/** One execution (check or update) with its console output. */
export interface Run {
  id: number;
  containerId: number;
  appId: number | null;
  kind: RunKind;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  output: string;
}

/** A detached step of a run still executing on the node – lets a restarted ReleaseWatcher re-attach to it. */
export interface RunResume {
  unit: string;
  step: DetachedStep;
  timeoutSeconds: number;
  /** The container was started for this run and has to be shut down again afterwards. */
  startedContainer: boolean;
}

export const DEFAULT_APP_TIMEOUT_SECONDS = 30 * 60;
export const MIN_APP_TIMEOUT_SECONDS = 10;
export const MAX_APP_TIMEOUT_SECONDS = 6 * 60 * 60;

/** A git commit hash (full or abbreviated, at least 7 hex digits). */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;

/**
 * True/false when both versions are known, otherwise null. Non-comparable versions differ → update.
 * Two commit hashes are compared as opaque values (an abbreviated hash matches the full one).
 */
export function appUpdateAvailable(app: Pick<ContainerApp, 'installedVersion' | 'latestVersion'>): boolean | null {
  if (!app.installedVersion || !app.latestVersion) {
    return null;
  }
  const installed = app.installedVersion.trim().toLowerCase();
  const latest = app.latestVersion.trim().toLowerCase();
  if (COMMIT_HASH_PATTERN.test(installed) && COMMIT_HASH_PATTERN.test(latest)) {
    return !(installed.startsWith(latest) || latest.startsWith(installed));
  }
  const diff = compareVersions(app.latestVersion, app.installedVersion);
  return diff === null ? app.latestVersion.trim() !== app.installedVersion.trim() : diff > 0;
}

/** Quotes a string for a POSIX shell. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Command run on the node that executes `script` inside a container. */
export const pctExec = (vmid: number, script: string): string => `pct exec ${vmid} -- sh -lc ${shQuote(script)}`;

/** Directory on the node holding the output and exit code of detached commands (removed after reading). */
export const DETACHED_DIR = '/var/tmp/releasewatcher';

/** Steps of an update that run detached on the node. */
export type DetachedStep = 'backup' | 'update';

/** Name of the transient systemd unit (and its directory) of one detached step. */
export const detachedUnit = (runId: number, step: DetachedStep): string => `releasewatcher-run-${runId}-${step}`;

const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/**
 * Node command that starts `command` (a node command such as `pct exec …` or `vzdump …`) as a transient systemd unit,
 * detached from the SSH session: it keeps running when the connection drops or ReleaseWatcher restarts, and
 * {@link detachedFollowCommand} reads its output (again, after a reconnect). Output goes to `<dir>/log`, the exit
 * code to `<dir>/rc`. With `tty` the command runs in a pseudo-terminal (`script` from util-linux) for interactive
 * scripts that write to /dev/tty. systemd stops it after `timeoutSeconds`. Directories older than a week are pruned.
 */
export function detachedStartCommand(unit: string, command: string, options: { tty: boolean; timeoutSeconds: number }): string {
  const dir = `${DETACHED_DIR}/${unit}`;
  const run = options.tty ? `script -qefc 'sh ${dir}/command' /dev/null` : `sh ${dir}/command`;
  const wrapper = [`${run} </dev/null >${dir}/log 2>&1`, `echo $? >${dir}/rc.tmp && mv ${dir}/rc.tmp ${dir}/rc`].join('\n');
  return [
    `# releasewatcher detached ${unit}`,
    `find ${DETACHED_DIR} -mindepth 1 -maxdepth 1 -mtime +7 -exec rm -rf {} + 2>/dev/null`,
    `mkdir -p ${dir} && : >${dir}/log && rm -f ${dir}/rc || exit $?`,
    `printf %s '${base64(command)}' | base64 -d >${dir}/command || exit $?`,
    `printf %s '${base64(wrapper)}' | base64 -d >${dir}/run || exit $?`,
    `systemd-run --quiet --collect --unit=${unit} -p RuntimeMaxSec=${Math.max(1, Math.round(options.timeoutSeconds))} /bin/sh ${dir}/run`,
  ].join('\n');
}

/**
 * Node command printing the whole output of a detached unit – live until it finishes – followed by a
 * `<token> exit <code>` line (`exit lost` when it ended without an exit code, e.g. stopped by its timeout;
 * `<token> missing` when its directory does not exist).
 */
export function detachedFollowCommand(unit: string, token: string): string {
  const dir = `${DETACHED_DIR}/${unit}`;
  return [
    `# releasewatcher follow ${unit}`,
    `[ -d ${dir} ] || { printf '\\n%s missing\\n' '${token}'; exit 0; }`,
    `pid=$(systemctl show -p MainPID --value ${unit} 2>/dev/null)`,
    `if [ "\${pid:-0}" != 0 ]; then tail -c +1 -f --pid="$pid" ${dir}/log; else cat ${dir}/log; fi`,
    `if [ -f ${dir}/rc ]; then printf '\\n%s exit %s\\n' '${token}' "$(cat ${dir}/rc)"; else printf '\\n%s exit lost\\n' '${token}'; fi`,
  ].join('\n');
}

/** Node command removing the files of a finished detached unit. */
export const detachedCleanupCommand = (unit: string): string =>
  `# releasewatcher cleanup ${unit}\nrm -rf ${DETACHED_DIR}/${unit}`;

export interface DetachedOutput {
  /** `incomplete` = the connection ended before the end marker (reconnect and read again). */
  state: 'finished' | 'lost' | 'missing' | 'incomplete';
  exitCode: number | null;
  /** Output of the command, without the end marker. */
  output: string;
}

/** Splits the output of {@link detachedFollowCommand} into the command output and its result. */
export function parseDetachedOutput(output: string, token: string): DetachedOutput {
  const at = output.lastIndexOf(`\n${token} `);
  if (at === -1) {
    return { state: 'incomplete', exitCode: null, output };
  }
  const text = output.slice(0, at);
  const marker = output.slice(at + token.length + 2).trim();
  if (marker.startsWith('missing')) {
    return { state: 'missing', exitCode: null, output: text };
  }
  const code = marker.match(/^exit (-?\d+)/)?.[1];
  return code === undefined
    ? { state: 'lost', exitCode: null, output: text }
    : { state: 'finished', exitCode: Number(code), output: text };
}

/** CPU cores and memory of a container (`pct config`); null = not set (all host cores / Proxmox default). */
export interface ContainerResources {
  cores: number | null;
  memoryMb: number | null;
}

/** Values to set with `pct set` – null removes the option (back to the Proxmox default). */
export type ResourceChange = Partial<ContainerResources>;

export const MIN_UPDATE_CORES = 1;
export const MAX_UPDATE_CORES = 512;
export const MIN_UPDATE_MEMORY_MB = 64;
export const MAX_UPDATE_MEMORY_MB = 4 * 1024 * 1024;
/** Memory of a container whose config has no `memory` line (Proxmox default). */
const DEFAULT_MEMORY_MB = 512;

/** Reads `cores` and `memory` from `pct config <vmid>`. */
export function parsePctResources(config: string): ContainerResources {
  const value = (key: string): number | null => {
    const match = config.match(new RegExp(`^${key}:\\s*(\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { cores: value('cores'), memoryMb: value('memory') };
}

/**
 * What to change for an update and how to undo it. Resources are only raised, never lowered: a container without a
 * core limit already uses all cores. Returns null when nothing has to change.
 */
export function planResourceRaise(
  current: ContainerResources,
  wanted: ContainerResources,
): { raise: ResourceChange; restore: ResourceChange } | null {
  const raise: ResourceChange = {};
  const restore: ResourceChange = {};
  if (wanted.cores !== null && current.cores !== null && current.cores < wanted.cores) {
    raise.cores = wanted.cores;
    restore.cores = current.cores;
  }
  if (wanted.memoryMb !== null && (current.memoryMb ?? DEFAULT_MEMORY_MB) < wanted.memoryMb) {
    raise.memoryMb = wanted.memoryMb;
    restore.memoryMb = current.memoryMb;
  }
  return Object.keys(raise).length > 0 ? { raise, restore } : null;
}

/** `pct set` command applying a {@link ResourceChange} (works while the container runs). */
export function pctSetResourcesCommand(vmid: number, change: ResourceChange): string {
  const args: string[] = [];
  const remove: string[] = [];
  const add = (option: string, value: number | null | undefined) => {
    if (value === undefined) return;
    if (value === null) remove.push(option);
    else args.push(`--${option} ${Math.round(value)}`);
  };
  add('cores', change.cores);
  add('memory', change.memoryMb);
  if (remove.length > 0) {
    args.push(`--delete ${remove.join(',')}`);
  }
  return `pct set ${vmid} ${args.join(' ')}`;
}

/** Human-readable description of a {@link ResourceChange} for run logs. */
export function describeResources(change: ResourceChange): string {
  const parts: string[] = [];
  if (change.cores !== undefined) parts.push(change.cores === null ? 'cores: unlimited' : `${change.cores} cores`);
  if (change.memoryMb !== undefined) parts.push(change.memoryMb === null ? 'memory: default' : `${change.memoryMb} MiB memory`);
  return parts.join(', ');
}

/** Proxmox storage ID (`pvesm` naming rules). */
export const STORAGE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,99}$/;

/** A storage on the node that accepts backups (`pvesm status --content backup`). */
export interface BackupStorage {
  name: string;
  type: string;
  status: string;
  /** Free space in bytes, when reported. */
  availableBytes: number | null;
}

/** Parses `pvesm status` (Name, Type, Status, Total, Used, Available in KiB, %). */
export function parsePvesmStatus(output: string): BackupStorage[] {
  const storages: BackupStorage[] = [];
  for (const line of output.split('\n')) {
    const [name, type, status, , , available] = line.trim().split(/\s+/);
    if (!name || !type || !status || name === 'Name' || !STORAGE_ID_PATTERN.test(name)) {
      continue;
    }
    const kib = Number(available);
    storages.push({ name, type, status, availableBytes: Number.isFinite(kib) && available ? kib * 1024 : null });
  }
  return storages;
}

/**
 * Node command backing up a container with vzdump (snapshot mode – vzdump falls back to suspend mode when the
 * volumes cannot be snapshotted). zstd compression except on Proxmox Backup Server, which compresses itself.
 * Retention follows the prune settings of the storage.
 */
/** Seconds to wait for a default route after `pct start` (services need the network, e.g. apt). */
export const START_NETWORK_WAIT_SECONDS = 60;
/** Seconds `pct shutdown` waits for a clean shutdown before the container is stopped forcibly. */
export const SHUTDOWN_TIMEOUT_SECONDS = 120;

/**
 * Starts a stopped container and waits until it has a default route (read from /proc, so no tools are needed
 * inside). Without a network after the wait it continues anyway – the following commands report their errors.
 */
export function startContainerCommand(vmid: number): string {
  const networkReady = shQuote(`awk '$2 == "00000000" { found = 1 } END { exit !found }' /proc/net/route`);
  return [
    `pct start ${vmid} || exit $?`,
    `for i in $(seq 1 ${START_NETWORK_WAIT_SECONDS}); do`,
    `  pct exec ${vmid} -- sh -c ${networkReady} >/dev/null 2>&1 && exit 0`,
    `  sleep 1`,
    `done`,
    `echo 'No network after ${START_NETWORK_WAIT_SECONDS} s – continuing anyway.'`,
  ].join('\n');
}

/** Shuts a container down cleanly, stopping it forcibly after {@link SHUTDOWN_TIMEOUT_SECONDS}. */
export const shutdownContainerCommand = (vmid: number): string =>
  `pct shutdown ${vmid} --timeout ${SHUTDOWN_TIMEOUT_SECONDS} --forceStop 1`;

export function vzdumpCommand(vmid: number, storage: string, note: string): string {
  const id = shQuote(storage);
  return [
    `if pvesm status --storage ${id} 2>/dev/null | awk 'NR > 1 { print $2 }' | grep -qx pbs; then compress=''; else compress='--compress zstd'; fi`,
    `vzdump ${vmid} --storage ${id} --mode snapshot $compress --notes-template ${shQuote(note)}`,
  ].join('\n');
}

export interface DiscoveredContainer {
  vmid: number;
  status: string;
  name: string;
}

/** Parses the table printed by `pct list` (VMID, Status, optional Lock, Name). */
export function parsePctList(output: string): DiscoveredContainer[] {
  const result: DiscoveredContainer[] = [];
  for (const line of output.split('\n')) {
    const tokens = line.trim().split(/\s+/);
    const vmid = Number(tokens[0]);
    if (!/^\d+$/.test(tokens[0] ?? '') || !Number.isSafeInteger(vmid) || tokens.length < 2) {
      continue; // header or noise
    }
    result.push({ vmid, status: tokens[1]!, name: tokens.length >= 3 ? tokens.at(-1)! : `CT ${vmid}` });
  }
  return result;
}

/** Parses `pct status <vmid>` ("status: running"). */
export const parsePctStatus = (output: string): string | null => output.match(/status:\s*(\S+)/)?.[1] ?? null;

/** Marker separating `apt-get update` noise from the package list. */
export const APT_LIST_MARKER = '---releasewatcher-apt---';

export const APT_CHECK_SCRIPT = [
  'command -v apt-get >/dev/null 2>&1 || { echo "apt-get is not available in this container" >&2; exit 127; }',
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get -qq update',
  `echo '${APT_LIST_MARKER}'`,
  'apt list --upgradable 2>/dev/null',
].join('\n');

/**
 * Upgrade of the Proxmox host. Proxmox VE must be upgraded with `dist-upgrade` (= `full-upgrade`): a plain
 * `upgrade` holds back packages with new dependencies and can leave PVE half-upgraded.
 */
export const NODE_APT_UPGRADE_SCRIPT = [
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update',
  'apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold dist-upgrade',
].join(' && ');

/** Human-readable name of a check/update target in logs and notifications. */
export const targetLabel = (c: Pick<Container, 'kind' | 'vmid'>): string =>
  c.kind === 'node' ? 'the Proxmox host' : `CT ${c.vmid}`;

export const APT_UPGRADE_SCRIPT = [
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update',
  'apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade',
].join(' && ');

const APT_LINE = /^([^\s/]+)\/\S+\s+(\S+)\s+\S+(?:\s+\[upgradable from:\s*([^\]\s]+)\])?/;

/** Parses `apt list --upgradable` (lines like `curl/stable 8.1 amd64 [upgradable from: 8.0]`). */
export function parseAptUpgradable(output: string): AptPackage[] {
  const markerAt = output.indexOf(APT_LIST_MARKER);
  const list = markerAt === -1 ? output : output.slice(markerAt + APT_LIST_MARKER.length);
  const packages: AptPackage[] = [];
  for (const line of list.split('\n')) {
    const match = line.trim().match(APT_LINE);
    if (match) {
      packages.push({ name: match[1]!, newVersion: match[2]!, currentVersion: match[3] ?? null });
    }
  }
  return packages;
}

/** First non-empty output line – how a version command reports its result. */
export function firstLine(output: string): string | null {
  const line = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ? line.slice(0, 200) : null;
}

/** Removes ANSI escape sequences and carriage-return redraws produced by interactive scripts. */
export function cleanOutput(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>]/g, '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.split('\r').filter(Boolean).at(-1) ?? '')
      .join('\n')
  );
}

/** Fingerprint of everything pending in a container; null when nothing is pending. */
export function pendingSignature(container: Pick<Container, 'aptUpgradable'>, apps: readonly ContainerApp[]): string | null {
  const parts = [
    ...container.aptUpgradable.map((p) => `apt:${p.name}=${p.newVersion}`),
    ...apps.filter((a) => appUpdateAvailable(a)).map((a) => `app:${a.id}=${a.latestVersion}`),
  ].toSorted();
  return parts.length > 0 ? parts.join('|') : null;
}

/** One command of a batched container check. */
export interface CheckStep {
  /** Section id in the output (letters, digits, `-`). */
  id: string;
  script: string;
  timeoutSeconds: number;
}

export interface StepResult {
  exitCode: number;
  output: string;
}

export interface CheckBatchResult {
  /** `pct status` result; null when the node was not reached. */
  status: StepResult | null;
  steps: Map<string, StepResult>;
}

/** Random section marker – command output cannot fake it. */
export const newCheckToken = (): string => `@@RW-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}@@`;

/**
 * Builds a single node command that runs `pct status` and – only for a running container – all `steps` inside it
 * with one `pct exec` (one SSH connection, two `pct` starts instead of one per command). Every step gets its own
 * timeout (`timeout` from coreutils/busybox when available) and exit code; output sections are delimited by
 * `<token> begin <id>` / `<token> end <id> <exit code>` lines. The container script travels base64-encoded, so
 * user commands are quoted only once.
 */
export function buildCheckScript(vmid: number | null, steps: readonly CheckStep[], token: string): string {
  const node = [
    // null = the steps run on the node itself, which is running when this script runs at all.
    vmid === null ? `s='status: running'; rc=0` : `s=$(pct status ${vmid} 2>&1); rc=$?`,
    `printf '%s begin status\n%s\n%s end status %s\n' '${token}' "$s" '${token}' "$rc"`,
  ];
  if (steps.length > 0) {
    const inner = [
      'rw_step() {',
      `  printf '%s begin %s\n' '${token}' "$1"`,
      '  if command -v timeout >/dev/null 2>&1; then timeout "$2" sh -c "$3" </dev/null 2>&1; else sh -c "$3" </dev/null 2>&1; fi',
      '  rc=$?',
      `  printf '\n%s end %s %s\n' '${token}' "$1" "$rc"`,
      '}',
      ...steps.map((s) => `rw_step ${s.id} ${Math.max(1, Math.round(s.timeoutSeconds))} ${shQuote(s.script)}`),
    ].join('\n');
    const encoded = Buffer.from(inner, 'utf8').toString('base64');
    const decoded = `"$(printf %s '${encoded}' | base64 -d)"`;
    node.push(
      vmid === null
        ? `sh -lc ${decoded}`
        : `case "$s" in *'status: running'*) pct exec ${vmid} -- sh -lc ${decoded} ;; esac`,
    );
  }
  return node.join('\n');
}

/** Splits the output of {@link buildCheckScript} into its sections. */
export function parseCheckOutput(output: string, token: string): CheckBatchResult {
  const steps = new Map<string, StepResult>();
  let current: { id: string; lines: string[] } | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith(`${token} begin `)) {
      current = { id: line.slice(token.length + 7).trim(), lines: [] };
      continue;
    }
    if (current && line.startsWith(`${token} end `)) {
      const [id, code] = line.slice(token.length + 5).trim().split(' ');
      if (id === current.id) {
        let text = current.lines.join('\n');
        if (current.id !== 'status' && text.endsWith('\n')) {
          text = text.slice(0, -1); // newline printed before the end marker
        }
        steps.set(id, { exitCode: Number(code ?? 1), output: text });
      }
      current = null;
      continue;
    }
    current?.lines.push(line);
  }
  const status = steps.get('status') ?? null;
  steps.delete('status');
  return { status, steps };
}
