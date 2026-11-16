import { compareVersions } from '../version.ts';

/** An LXC container on the Proxmox node, managed through `pct exec`. */
export interface Container {
  id: number;
  /** Proxmox container ID (e.g. 101). */
  vmid: number;
  name: string;
  /** Disabled containers are skipped by scheduled checks. */
  isEnabled: boolean;
  /** Check (and allow upgrading) apt packages. */
  aptEnabled: boolean;
  /** Back up (vzdump) before updates by default; null = use the global setting. */
  backupBeforeUpdate: boolean | null;
  /** Cron expression overriding the global check schedule; null = use the global one. */
  checkCron: string | null;
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

export const DEFAULT_APP_TIMEOUT_SECONDS = 30 * 60;
export const MIN_APP_TIMEOUT_SECONDS = 10;
export const MAX_APP_TIMEOUT_SECONDS = 6 * 60 * 60;

/** True/false when both versions are known, otherwise null. Non-comparable versions differ → update. */
export function appUpdateAvailable(app: Pick<ContainerApp, 'installedVersion' | 'latestVersion'>): boolean | null {
  if (!app.installedVersion || !app.latestVersion) {
    return null;
  }
  const diff = compareVersions(app.latestVersion, app.installedVersion);
  return diff === null ? app.latestVersion.trim() !== app.installedVersion.trim() : diff > 0;
}

/** Quotes a string for a POSIX shell. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Command run on the node that executes `script` inside a container. */
export const pctExec = (vmid: number, script: string): string => `pct exec ${vmid} -- sh -lc ${shQuote(script)}`;

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
export function buildCheckScript(vmid: number, steps: readonly CheckStep[], token: string): string {
  const node = [
    `s=$(pct status ${vmid} 2>&1); rc=$?`,
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
    node.push(
      `case "$s" in *'status: running'*) pct exec ${vmid} -- sh -lc "$(printf %s '${encoded}' | base64 -d)" ;; esac`,
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
