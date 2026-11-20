import { compareVersions } from '../version.ts';
import { type HomeAssistantState, type InstallContext, installableUpdates } from './home-assistant.ts';

export const TARGET_KINDS = ['lxc', 'vm', 'node'] as const;
/**
 * `lxc` = a container managed through `pct exec`; `vm` = a virtual machine reached through the QEMU guest agent
 * (`qm guest exec`); `node` = the Proxmox host itself (apt only).
 */
export type TargetKind = (typeof TARGET_KINDS)[number];
/** A guest on the node: a container or a virtual machine. */
export type GuestKind = Exclude<TargetKind, 'node'>;

/** Proxmox CLI managing a guest: `pct` for containers, `qm` for virtual machines. */
export const guestCli = (kind: GuestKind): 'pct' | 'qm' => (kind === 'vm' ? 'qm' : 'pct');

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
  /** Why the container (or host) should be restarted, from the last check; empty = no restart needed. */
  restartReasons: string[];
  /** Home Assistant OS found in this virtual machine by the last check (its pending updates); null = not HAOS. */
  homeAssistant: HomeAssistantState | null;
  /** Base URL of Home Assistant for the REST API (live checks, integration updates); null = not configured. */
  homeAssistantUrl: string | null;
  /** Long-lived access token for the REST API (secret, encrypted at rest); null = read saved states without it. */
  homeAssistantToken: string | null;
  /** Install Home Assistant updates from ReleaseWatcher; false (default) = only check and report them. */
  homeAssistantInstall: boolean;
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

export const RUN_KINDS = ['check', 'apt-upgrade', 'app-update', 'restart', 'home-assistant-update'] as const;
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

/** One update of a container started by "update all". */
export type PendingUpdate = { kind: 'apt-upgrade' } | { kind: 'app-update'; appId: number } | { kind: 'home-assistant-update' };

/** True when the Home Assistant API can be used (URL and token configured). */
export const hasHomeAssistantApi = (c: Pick<Container, 'homeAssistantUrl' | 'homeAssistantToken'>): boolean =>
  c.homeAssistantUrl !== null && c.homeAssistantToken !== null;

/** Whether (and which) Home Assistant updates of a guest may be installed from ReleaseWatcher. */
export const homeAssistantInstallContext = (
  c: Pick<Container, 'homeAssistantUrl' | 'homeAssistantToken' | 'homeAssistantInstall'>,
): InstallContext => ({ enabled: c.homeAssistantInstall, hasApi: hasHomeAssistantApi(c) });

/**
 * Updates "update all" runs in a container, in order: apt first, then every application with a known newer
 * version and an update command, then the Home Assistant updates that can be installed from here. The Proxmox host, disabled containers and stopped containers that may not be
 * started are left out (they are updated by hand).
 */
export function pendingUpdates(container: Container, apps: readonly ContainerApp[]): PendingUpdate[] {
  if (container.kind === 'node' || !container.isEnabled) {
    return [];
  }
  if (container.status === 'stopped' && !container.startWhenStopped) {
    return [];
  }
  const updates: PendingUpdate[] = [];
  if (container.aptEnabled && container.aptUpgradable.length > 0) {
    updates.push({ kind: 'apt-upgrade' });
  }
  for (const app of apps) {
    if (app.updateCommand && appUpdateAvailable(app) === true) {
      updates.push({ kind: 'app-update', appId: app.id });
    }
  }
  if (installableUpdates(container.homeAssistant, homeAssistantInstallContext(container)).length > 0) {
    updates.push({ kind: 'home-assistant-update' });
  }
  return updates;
}

/** Quotes a string for a POSIX shell. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Command run on the node that executes `script` inside a container. */
export const pctExec = (vmid: number, script: string): string =>
  `pct exec ${vmid} -- sh -c ${shQuote(`${QUIET_PROFILE}\n${script}`)}`;

/**
 * Command run on the node that executes `script` inside a virtual machine through the QEMU guest agent. `qm guest
 * exec` waits up to `timeoutSeconds` and then prints the result as JSON ({@link parseGuestExecResult}); stderr is
 * merged into stdout so the output keeps its order.
 */
export const qmGuestExec = (vmid: number, script: string, timeoutSeconds: number): string =>
  `qm guest exec ${vmid} --timeout ${Math.max(1, Math.round(timeoutSeconds))} -- sh -c ${shQuote(`exec 2>&1\n${QUIET_PROFILE}\n${script}`)}`;

/** Command run on the node that executes `script` inside a container or virtual machine. */
export const guestExec = (target: { kind: GuestKind; vmid: number }, script: string, timeoutSeconds: number): string =>
  target.kind === 'vm' ? qmGuestExec(target.vmid, script, timeoutSeconds) : pctExec(target.vmid, script);

/** Result of `qm guest exec`. */
export interface GuestExecResult {
  exitCode: number;
  output: string;
  /** The command was still running when `qm guest exec` stopped waiting (it keeps running in the guest). */
  timedOut: boolean;
}

/**
 * Parses the JSON printed by `qm guest exec` (`exitcode`, `exited`, `out-data`, `err-data`, `*-truncated`).
 * Returns null when the output holds no such JSON, e.g. "QEMU guest agent is not running".
 */
export function parseGuestExecResult(output: string): GuestExecResult | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end < start) {
    return null;
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(output.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('exited' in json || 'pid' in json)) {
    return null;
  }
  const text = (key: string) => (typeof json[key] === 'string' ? (json[key] as string) : '');
  let combined = text('out-data') + text('err-data');
  if (json['out-truncated'] === 1 || json['err-truncated'] === 1 || json['out-truncated'] === true) {
    combined += '\n[output truncated by the QEMU guest agent]\n';
  }
  if (json['exited'] !== 1 && json['exited'] !== true) {
    return { exitCode: -1, output: combined, timedOut: true };
  }
  return { exitCode: typeof json['exitcode'] === 'number' ? json['exitcode'] : -1, output: combined, timedOut: false };
}

/**
 * Sets the user's login variables: `pct exec` clears the environment (and the detached systemd unit has no `HOME`
 * either), so without them git cannot read `~/.gitconfig` – e.g. the credential helper of `gh auth login` – and
 * private repositories fail with "could not read Username".
 */
const LOGIN_ENV = [
  'USER=$(id -un 2>/dev/null || echo root)',
  'HOME=$(getent passwd "$USER" 2>/dev/null | cut -d: -f6)',
  'if [ -z "$HOME" ]; then HOME=$(awk -F: -v u="$USER" \'$1 == u { print $6; exit }\' /etc/passwd 2>/dev/null); fi',
  'if [ -z "$HOME" ]; then HOME=/root; fi',
  'LOGNAME=$USER',
  'export USER LOGNAME HOME',
].join('\n');

/**
 * Loads the login environment (HOME, PATH etc.) like `sh -l`, but without its output: Proxmox community-script
 * containers print a banner from `/etc/profile.d` (with `echo -e`, shown as "-e …" by dash) on every login shell.
 */
const QUIET_PROFILE = `${LOGIN_ENV}\n{ if [ -r /etc/profile ]; then . /etc/profile; fi; if [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi; } </dev/null >/dev/null 2>&1`;

/** Directory on the node holding the output and exit code of detached commands (removed after reading). */
export const DETACHED_DIR = '/var/tmp/releasewatcher';

/** Steps of an update that run detached on the node. */
export type DetachedStep = 'backup' | 'update' | 'restart';

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

/** Node command stopping a detached unit (e.g. one stuck at an interactive prompt); its output stays readable. */
export const detachedStopCommand = (unit: string): string =>
  `# releasewatcher stop ${unit}\nsystemctl stop ${unit} 2>/dev/null; true`;

/**
 * Environment set before every application update command so that scripts take their non-interactive path:
 * Proxmox VE Helper Scripts (community-scripts) skip their "Silent / Verbose / Cancel" menu when `PHS_SILENT=1`
 * (note the spelling: Proxmox Helper Scripts), and apt/debconf do not ask questions.
 */
export const NON_INTERACTIVE_ENV = 'export PHS_SILENT=1 DEBIAN_FRONTEND=noninteractive';

/** Script running an application update command non-interactively (see {@link NON_INTERACTIVE_ENV}). */
export const appUpdateScript = (command: string): string => `${NON_INTERACTIVE_ENV}\n${command}`;

/** Removes terminal escape sequences (colours, cursor movement, charset switches) from command output. */
export function stripTerminalCodes(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()*+][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMc]/g, '')
    .replace(/[\x0e\x0f]/g, '');
}

/** Number of characters at the end of the output that {@link detectInteractivePrompt} looks at. */
export const PROMPT_TAIL_LENGTH = 4000;

/**
 * Recognises output that ends at a prompt waiting for input: a whiptail/dialog screen (buttons like `<Ok>`), a
 * yes/no question (`[Y/n]`, `(y/N)`), a dpkg config-file question (`[default=N] ?`) or "Press Enter". Returns a short
 * description of the prompt, or null. Only meaningful when the output has not changed for a while.
 */
export function detectInteractivePrompt(output: string): string | null {
  const text = stripTerminalCodes(output.slice(-PROMPT_TAIL_LENGTH));
  if (/<\s*(?:Ok|Yes|No|Cancel|Exit[- ]Script)\s*>/i.test(text)) {
    return 'an interactive menu (whiptail/dialog)';
  }
  const end = text.replace(/\s+$/, '').split(/[\r\n]/).at(-1) ?? '';
  if (/[[(]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[\])]\s*[:?]?$/i.test(end) || /\[default=\w+\]\s*\?$/i.test(end)) {
    return `a question waiting for an answer ("${end.trim().slice(-120)}")`;
  }
  if (/press (?:enter|return|any key)/i.test(end)) {
    return `a prompt waiting for a key press ("${end.trim().slice(-120)}")`;
  }
  return null;
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

/** Seconds to wait for a default route after `pct start` (services need the network, e.g. apt). */
export const START_NETWORK_WAIT_SECONDS = 60;
/** Seconds to wait for the QEMU guest agent after `qm start` (a virtual machine boots longer than a container). */
export const START_AGENT_WAIT_SECONDS = 180;
/** Seconds `pct shutdown` / `qm shutdown` waits for a clean shutdown before the guest is stopped forcibly. */
export const SHUTDOWN_TIMEOUT_SECONDS = 120;

/** A guest addressed by node commands. */
export type GuestTarget = { kind: GuestKind; vmid: number };

/** Seconds {@link waitUntilReadyLines} may wait for a guest. */
export const readyWaitSeconds = (target: GuestTarget): number =>
  target.kind === 'vm' ? START_AGENT_WAIT_SECONDS : START_NETWORK_WAIT_SECONDS;

/**
 * Waits until a running guest can run commands: a container until it has a default route (read from /proc, so no
 * tools are needed inside), a virtual machine until its guest agent answers. Without it after the wait it continues
 * anyway – the following commands report their errors.
 */
function waitUntilReadyLines(target: GuestTarget): string[] {
  const seconds = readyWaitSeconds(target);
  const probe =
    target.kind === 'vm'
      ? `qm agent ${target.vmid} ping >/dev/null 2>&1`
      : `pct exec ${target.vmid} -- sh -c ${shQuote(`awk '$2 == "00000000" { found = 1 } END { exit !found }' /proc/net/route`)} >/dev/null 2>&1`;
  const what = target.kind === 'vm' ? 'No answer from the QEMU guest agent' : 'No network';
  return [
    `for i in $(seq 1 ${seconds}); do`,
    `  ${probe} && exit 0`,
    `  sleep 1`,
    `done`,
    `echo '${what} after ${seconds} s – continuing anyway.'`,
  ];
}

/** Starts a stopped guest and waits until it is ready. */
export const startGuestCommand = (target: GuestTarget): string =>
  [`${guestCli(target.kind)} start ${target.vmid} || exit $?`, ...waitUntilReadyLines(target)].join('\n');

/** Shuts a guest down cleanly, stopping it forcibly after {@link SHUTDOWN_TIMEOUT_SECONDS}. */
export const shutdownGuestCommand = (target: GuestTarget): string =>
  `${guestCli(target.kind)} shutdown ${target.vmid} --timeout ${SHUTDOWN_TIMEOUT_SECONDS} --forceStop 1`;

/**
 * Restarts a running guest (clean shutdown, stopped forcibly after {@link SHUTDOWN_TIMEOUT_SECONDS}) and waits
 * until it is ready again.
 */
export const restartGuestCommand = (target: GuestTarget): string =>
  [`${guestCli(target.kind)} reboot ${target.vmid} --timeout ${SHUTDOWN_TIMEOUT_SECONDS} || exit $?`, ...waitUntilReadyLines(target)].join('\n');

/** Seconds between scheduling a restart of the Proxmox host and the restart itself. */
export const NODE_RESTART_DELAY_SECONDS = 15;

/**
 * Schedules a restart of the Proxmox host as a transient systemd timer, so the SSH command returns before the
 * connection drops (ReleaseWatcher may itself run in a container on this node). Fails when one is already scheduled.
 */
export const NODE_RESTART_COMMAND =
  `systemd-run --quiet --unit=releasewatcher-host-restart --on-active=${NODE_RESTART_DELAY_SECONDS} ` +
  '--timer-property=AccuracySec=1s systemctl reboot';

/**
 * Node command backing up a guest with vzdump (snapshot mode – vzdump falls back to suspend mode when the
 * volumes cannot be snapshotted). zstd compression except on Proxmox Backup Server, which compresses itself.
 * Retention follows the prune settings of the storage.
 */
export function vzdumpCommand(vmid: number, storage: string, note: string): string {
  const id = shQuote(storage);
  return [
    `if pvesm status --storage ${id} 2>/dev/null | awk 'NR > 1 { print $2 }' | grep -qx pbs; then compress=''; else compress='--compress zstd'; fi`,
    `vzdump ${vmid} --storage ${id} --mode snapshot $compress --notes-template ${shQuote(note)}`,
  ].join('\n');
}

/** A container or virtual machine found on the node. */
export interface DiscoveredContainer {
  kind: GuestKind;
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
    result.push({ kind: 'lxc', vmid, status: tokens[1]!, name: tokens.length >= 3 ? tokens.at(-1)! : `CT ${vmid}` });
  }
  return result;
}

/** Parses the table printed by `qm list` (VMID, Name, Status, Mem, Bootdisk, PID). */
export function parseQmList(output: string): DiscoveredContainer[] {
  const result: DiscoveredContainer[] = [];
  for (const line of output.split('\n')) {
    const [id, name, status] = line.trim().split(/\s+/);
    const vmid = Number(id);
    if (!/^\d+$/.test(id ?? '') || !Number.isSafeInteger(vmid) || !name || !status) {
      continue; // header or noise
    }
    result.push({ kind: 'vm', vmid, status, name });
  }
  return result;
}

/** Marker between the `pct list` and `qm list` output of {@link DISCOVER_COMMAND}. */
const QM_LIST_MARKER = '---releasewatcher-qm---';

/** Lists containers and virtual machines with one SSH connection. */
export const DISCOVER_COMMAND = `pct list || exit $?\necho '${QM_LIST_MARKER}'\nqm list`;

/** Parses the output of {@link DISCOVER_COMMAND}: containers first, then virtual machines, by VMID. */
export function parseDiscoverOutput(output: string): DiscoveredContainer[] {
  const at = output.indexOf(QM_LIST_MARKER);
  const pct = at === -1 ? output : output.slice(0, at);
  const qm = at === -1 ? '' : output.slice(at + QM_LIST_MARKER.length);
  return [...parsePctList(pct), ...parseQmList(qm)].toSorted((a, b) => a.vmid - b.vmid);
}

/** Parses `pct status <vmid>` ("status: running"). */
export const parsePctStatus = (output: string): string | null => output.match(/status:\s*(\S+)/)?.[1] ?? null;

/** Marker separating `apt-get update` noise from the package list. */
export const APT_LIST_MARKER = '---releasewatcher-apt---';

export const APT_CHECK_SCRIPT = [
  'command -v apt-get >/dev/null 2>&1 || { echo "apt-get is not available here (no Debian or Ubuntu)" >&2; exit 127; }',
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
  'apt-get -y autoremove',
].join(' && ');

/** Prints `file [packages…]` when a package asked for a restart (`/var/run/reboot-required`, Debian/Ubuntu). */
const REBOOT_REQUIRED_FILE_CHECK = String.raw`if [ -f /var/run/reboot-required ]; then
  if [ -s /var/run/reboot-required.pkgs ]; then echo "file $(sort -u /var/run/reboot-required.pkgs | tr '\n' ' ')"; else echo file; fi
fi`;

/**
 * Restart check inside a container: the reboot-required file and processes that still use executables or libraries
 * an upgrade replaced (`(deleted)` mappings, like `needrestart`), printed as `stale <process name>`. Always exits 0.
 */
const STALE_PROCESSES_CHECK = String.raw`for d in /proc/[0-9]*; do
  if grep -qE ' /(usr/)?(s?bin|lib(exec|32|64|x32)?)/[^ ]* \(deleted\)$' "$d/maps" 2>/dev/null; then
    echo "stale $(cat "$d/comm" 2>/dev/null)"
  fi
done | sort -u`;

/** Prints `kernel <running> <newest>` when a newer kernel than the running one is installed in /boot. */
const KERNEL_CHECK = String.raw`running=$(uname -r)
newest=$(ls -1 /boot/vmlinuz-* 2>/dev/null | sed 's|^/boot/vmlinuz-||' | sort -V | tail -n 1)
if [ -n "$newest" ] && [ "$newest" != "$running" ]; then echo "kernel $running $newest"; fi`;

export const RESTART_CHECK_SCRIPT = `${REBOOT_REQUIRED_FILE_CHECK}\n${STALE_PROCESSES_CHECK}\ntrue`;

/** Restart check inside a virtual machine: like a container, plus a newer installed kernel. Always exits 0. */
export const VM_RESTART_CHECK_SCRIPT = `${REBOOT_REQUIRED_FILE_CHECK}\n${KERNEL_CHECK}\n${STALE_PROCESSES_CHECK}\ntrue`;

/**
 * Restart check of the Proxmox host: the reboot-required file and an installed kernel newer than the running one.
 * Processes using replaced files are not reported – on the host the running guests keep such files open until they
 * restart themselves. Always exits 0.
 */
export const NODE_RESTART_CHECK_SCRIPT = `${REBOOT_REQUIRED_FILE_CHECK}\n${KERNEL_CHECK}\ntrue`;

/** The restart check script for a target. */
export const restartCheckScript = (kind: TargetKind): string =>
  kind === 'node' ? NODE_RESTART_CHECK_SCRIPT : kind === 'vm' ? VM_RESTART_CHECK_SCRIPT : RESTART_CHECK_SCRIPT;

/** Process names listed in a restart reason before the rest is summarised as "and N more". */
const MAX_STALE_NAMES = 8;

/** Turns the output of {@link RESTART_CHECK_SCRIPT} / {@link NODE_RESTART_CHECK_SCRIPT} into readable reasons. */
export function parseRestartCheck(output: string): string[] {
  const reasons: string[] = [];
  const stale = new Set<string>();
  for (const line of output.split('\n')) {
    const [type, ...rest] = line.trim().split(/\s+/);
    if (type === 'file') {
      const packages = [...new Set(rest)];
      reasons.push(
        packages.length > 0
          ? `Requested by ${packages.length === 1 ? 'package' : 'packages'} ${packages.join(', ')}`
          : 'Requested by an upgraded package',
      );
    } else if (type === 'kernel' && rest.length >= 2) {
      reasons.push(`Kernel ${rest[1]} is installed, ${rest[0]} is running`);
    } else if (type === 'stale' && rest.length > 0) {
      stale.add(rest.join(' '));
    }
  }
  if (stale.size > 0) {
    const names = [...stale].toSorted();
    const more = names.length > MAX_STALE_NAMES ? ` and ${names.length - MAX_STALE_NAMES} more` : '';
    reasons.push(`Processes use upgraded files: ${names.slice(0, MAX_STALE_NAMES).join(', ')}${more}`);
  }
  return reasons;
}

/** Human-readable name of a check/update target in logs and notifications. */
export const targetLabel = (c: Pick<Container, 'kind' | 'vmid'>): string =>
  c.kind === 'node' ? 'the Proxmox host' : c.kind === 'vm' ? `VM ${c.vmid}` : `CT ${c.vmid}`;

export const APT_UPGRADE_SCRIPT = [
  'export DEBIAN_FRONTEND=noninteractive',
  'apt-get update',
  'apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade',
  'apt-get -y autoremove',
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

/** Unfinished line kept by {@link OutputCleaner} above which only its last redraw is kept. */
const MAX_PENDING_LINE = 16 * 1024;

/**
 * {@link cleanOutput} for output that arrives in chunks: a spinner redraws its line with `\r` across many chunks,
 * so lines are passed on only once they are complete (or at {@link flush}) – cleaning each chunk on its own would
 * keep one frame per chunk ("⠋ Working⠙ Working⠹ Working…").
 */
export class OutputCleaner {
  private pending = '';

  /** Adds raw output; returns the cleaned lines it completed (empty while the line is still being drawn). */
  push(raw: string): string {
    this.pending += raw;
    const end = this.pending.lastIndexOf('\n');
    if (end === -1) {
      if (this.pending.length > MAX_PENDING_LINE) {
        const redraw = this.pending.lastIndexOf('\r');
        if (redraw > 0) {
          this.pending = this.pending.slice(redraw);
        }
      }
      return '';
    }
    const complete = this.pending.slice(0, end + 1);
    this.pending = this.pending.slice(end + 1);
    return cleanOutput(complete);
  }

  /** Returns the cleaned rest of an unfinished line (end of the output). */
  flush(): string {
    const rest = cleanOutput(this.pending);
    this.pending = '';
    return rest;
  }
}

/** Fingerprint of everything pending in a container; null when nothing is pending. */
export function pendingSignature(
  container: Pick<Container, 'aptUpgradable' | 'homeAssistant'>,
  apps: readonly ContainerApp[],
): string | null {
  const parts = [
    ...container.aptUpgradable.map((p) => `apt:${p.name}=${p.newVersion}`),
    ...(container.homeAssistant?.updates ?? []).map((u) => `ha:${u.id}=${u.latestVersion}`),
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
  /** `pct status` / `qm status` result; null when the node was not reached. */
  status: StepResult | null;
  steps: Map<string, StepResult>;
  /** Why the steps did not run in a virtual machine (e.g. "QEMU guest agent is not running"); null otherwise. */
  guestError: string | null;
}

/** Random section marker – command output cannot fake it. */
export const newCheckToken = (): string => `@@RW-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}@@`;

/** Extra seconds `qm guest exec` waits for a batched check beyond the sum of its step timeouts. */
const GUEST_CHECK_GRACE_SECONDS = 30;

/**
 * Builds a single node command that runs `pct status` / `qm status` and – only for a running guest – all `steps`
 * inside it with one `pct exec` / `qm guest exec` (one SSH connection). `target` null = the steps run on the node
 * itself. Every step gets its own timeout (`timeout` from coreutils/busybox when available) and exit code; output
 * sections are delimited by `<token> begin <id>` / `<token> end <id> <exit code>` lines. The guest script travels
 * base64-encoded, so user commands are quoted only once.
 */
export function buildCheckScript(target: GuestTarget | null, steps: readonly CheckStep[], token: string): string {
  const node = [
    // null = the steps run on the node itself, which is running when this script runs at all.
    target === null
      ? `s='status: running'; rc=0`
      : `s=$(${guestCli(target.kind)} status ${target.vmid} 2>&1); rc=$?`,
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
    if (target === null) {
      node.push(`sh -lc ${decoded}`);
    } else {
      const total = steps.reduce((sum, s) => sum + Math.max(1, Math.round(s.timeoutSeconds)), 0) + GUEST_CHECK_GRACE_SECONDS;
      const exec =
        target.kind === 'vm'
          ? `qm guest exec ${target.vmid} --timeout ${total} -- sh -lc ${decoded} 2>&1`
          : `pct exec ${target.vmid} -- sh -lc ${decoded}`;
      node.push(`case "$s" in *'status: running'*) ${exec} ;; esac`);
    }
  }
  return node.join('\n');
}

/**
 * Splits the output of {@link buildCheckScript} into its sections. With `guest` (a virtual machine) the steps come
 * from the JSON of `qm guest exec` printed after the status section.
 */
export function parseCheckOutput(output: string, token: string, guest = false): CheckBatchResult {
  if (guest) {
    const marker = output.match(new RegExp(`^${token} end status .*$`, 'm'));
    const statusEnd = marker?.index === undefined ? output.length : marker.index + marker[0].length;
    const { status } = parseSections(output.slice(0, statusEnd), token);
    const rest = output.slice(statusEnd).trim();
    const result = rest ? parseGuestExecResult(rest) : null;
    if (result) {
      const steps = parseSections(result.output, token).steps;
      return { status, steps, guestError: result.timedOut ? 'the check did not finish in time' : null };
    }
    return { status, steps: new Map(), guestError: rest ? rest.slice(0, 500) : null };
  }
  return { ...parseSections(output, token), guestError: null };
}

function parseSections(output: string, token: string): { status: StepResult | null; steps: Map<string, StepResult> } {
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
