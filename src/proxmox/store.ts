import type { Database } from 'bun:sqlite';
import { parseJson, parseStringArray } from '../json.ts';
import type { SecretBox } from '../secret-box.ts';
import type { HomeAssistantState } from './home-assistant.ts';
import {
  type AptPackage,
  type Container,
  type ContainerApp,
  DEFAULT_RUN_HISTORY,
  type GuestKind,
  type LatestSource,
  NODE_VMID,
  type OsRelease,
  type ResourceChange,
  type Run,
  type RunHistoryLimits,
  type RunKind,
  type RunResume,
  type RunStatus,
  type RunTrigger,
  type TargetKind,
  isPackageManager,
} from './domain.ts';

interface ContainerRow {
  id: number;
  host_id: number | null;
  kind: string;
  vmid: number;
  name: string;
  is_enabled: number;
  apt_enabled: number;
  backup_before_update: number | null;
  start_when_stopped: number;
  check_cron: string | null;
  update_cores: number | null;
  update_memory_mb: number | null;
  resources_to_restore: string | null;
  status: string | null;
  apt_upgradable: string | null;
  package_manager: string | null;
  restart_reasons: string | null;
  os_release: string | null;
  home_assistant: string | null;
  home_assistant_url: string | null;
  home_assistant_token: string | null;
  home_assistant_install: number;
  last_checked_at: string | null;
  last_error: string | null;
  notified_signature: string | null;
  docker_enabled: number;
  docker_engine: string | null;
  docker_error: string | null;
  created_at: string;
}

interface AppRow {
  id: number;
  container_id: number;
  name: string;
  version_command: string | null;
  latest_source: string;
  repository_id: number | null;
  latest_command: string | null;
  update_command: string | null;
  use_tty: number;
  timeout_seconds: number;
  installed_version: string | null;
  latest_version: string | null;
  checked_at: string | null;
  error: string | null;
  created_at: string;
}

interface RunRow {
  id: number;
  container_id: number;
  app_id: number | null;
  kind: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  /** Plain text while running, zstd-compressed (BLOB) once finished – see {@link packOutput}. */
  output: string | Uint8Array;
}

function parsePackages(json: string | null): AptPackage[] {
  const parsed = parseJson<unknown>(json, null);
  return Array.isArray(parsed) ? parsed.filter((p): p is AptPackage => typeof p?.name === 'string') : [];
}

const toContainer = (r: ContainerRow, secrets: SecretBox): Container => ({
  id: r.id,
  hostId: r.host_id,
  kind: r.kind as TargetKind,
  vmid: r.vmid,
  name: r.name,
  isEnabled: r.is_enabled === 1,
  aptEnabled: r.apt_enabled === 1,
  backupBeforeUpdate: r.backup_before_update === null ? null : r.backup_before_update === 1,
  startWhenStopped: r.start_when_stopped === 1,
  checkCron: r.check_cron,
  updateCores: r.update_cores,
  updateMemoryMb: r.update_memory_mb,
  resourcesToRestore: parseJson<ResourceChange | null>(r.resources_to_restore, null),
  status: r.status,
  aptUpgradable: parsePackages(r.apt_upgradable),
  packageManager: isPackageManager(r.package_manager) ? r.package_manager : null,
  restartReasons: parseStringArray(r.restart_reasons),
  osRelease: parseOsReleaseJson(r.os_release),
  homeAssistant: parseHomeAssistant(r.home_assistant),
  homeAssistantUrl: r.home_assistant_url,
  homeAssistantToken: secrets.decryptNullable(r.home_assistant_token),
  homeAssistantInstall: r.home_assistant_install === 1,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  notifiedSignature: r.notified_signature,
  dockerEnabled: r.docker_enabled === 1,
  dockerEngine: r.docker_engine,
  dockerError: r.docker_error,
  createdAt: r.created_at,
});

const OS_RELEASE_KEYS = ['id', 'name', 'versionId', 'pointVersion', 'codename', 'prettyName', 'proxmoxVersion'] as const;

function parseOsReleaseJson(json: string | null): OsRelease | null {
  const parsed = parseJson<Record<string, unknown> | null>(json, null);
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const str = (key: (typeof OS_RELEASE_KEYS)[number]) => (typeof parsed[key] === 'string' ? (parsed[key] as string) : null);
  return {
    id: str('id'),
    name: str('name'),
    versionId: str('versionId'),
    pointVersion: str('pointVersion'),
    codename: str('codename'),
    prettyName: str('prettyName'),
    proxmoxVersion: str('proxmoxVersion'),
  };
}

function parseHomeAssistant(json: string | null): HomeAssistantState | null {
  const parsed = parseJson<HomeAssistantState | null>(json, null);
  return parsed && Array.isArray(parsed.updates) ? parsed : null;
}

const toApp = (r: AppRow): ContainerApp => ({
  id: r.id,
  containerId: r.container_id,
  name: r.name,
  versionCommand: r.version_command,
  latestSource: r.latest_source as LatestSource,
  repositoryId: r.repository_id,
  latestCommand: r.latest_command,
  updateCommand: r.update_command,
  useTty: r.use_tty === 1,
  timeoutSeconds: r.timeout_seconds,
  installedVersion: r.installed_version,
  latestVersion: r.latest_version,
  checkedAt: r.checked_at,
  error: r.error,
  createdAt: r.created_at,
});

const toRun = (r: RunRow): Run => ({
  id: r.id,
  containerId: r.container_id,
  appId: r.app_id,
  kind: r.kind as RunKind,
  trigger: r.trigger as RunTrigger,
  status: r.status as RunStatus,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  exitCode: r.exit_code,
  output: unpackOutput(r.output),
});

/** Free database pages (4 KiB each) collected before pruned runs give them back to the file system. */
const FREE_PAGES_TO_RELEASE = 256;

/** Output shorter than this stays plain text (compression would not pay off). */
const PACK_OUTPUT_FROM = 512;

/** Console output of a finished run as stored: zstd-compressed (logs shrink about 3–4×), short output as text. */
export function packOutput(output: string): string | Uint8Array {
  return output.length < PACK_OUTPUT_FROM ? output : Bun.zstdCompressSync(Buffer.from(output));
}

function unpackOutput(stored: string | Uint8Array): string {
  return typeof stored === 'string' ? stored : Buffer.from(Bun.zstdDecompressSync(stored)).toString('utf8');
}

/** Editable application fields. */
export type AppInput = Pick<
  ContainerApp,
  'name' | 'versionCommand' | 'latestSource' | 'repositoryId' | 'latestCommand' | 'updateCommand' | 'useTty' | 'timeoutSeconds'
>;

/** SQLite persistence of containers, their applications and runs (tables created by `RepositoryStore`). */
export class ContainerStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;
  private readonly toContainer = (r: ContainerRow): Container => toContainer(r, this.secrets);

  private readonly runHistory: () => RunHistoryLimits;

  /**
   * @param secrets encrypts the Home Assistant token (the `RepositoryStore`'s box: `store.secretBox`)
   * @param runHistory how many runs to keep per container (read for every prune, so setting changes apply at once)
   */
  constructor(db: Database, secrets: SecretBox, runHistory: () => RunHistoryLimits = () => DEFAULT_RUN_HISTORY) {
    this.db = db;
    this.secrets = secrets;
    this.runHistory = runHistory;
  }

  list(): Container[] {
    return this.db.query<ContainerRow, []>('SELECT * FROM containers ORDER BY vmid').all().map(this.toContainer);
  }

  listEnabled(): Container[] {
    return this.db.query<ContainerRow, []>('SELECT * FROM containers WHERE is_enabled = 1 ORDER BY vmid').all().map(this.toContainer);
  }

  get(id: number): Container | null {
    const row = this.db.query<ContainerRow, [number]>('SELECT * FROM containers WHERE id = ?').get(id);
    return row ? this.toContainer(row) : null;
  }

  /** Names of all targets by id – without reading (and decrypting) the rest of each row. */
  names(): Map<number, string> {
    const rows = this.db.query<{ id: number; name: string }, []>('SELECT id, name FROM containers').all();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** The fields the check schedule needs of every enabled target (no secrets decrypted, no JSON parsed). */
  listEnabledSchedules(): Pick<Container, 'id' | 'hostId' | 'checkCron'>[] {
    return this.db
      .query<Pick<ContainerRow, 'id' | 'host_id' | 'check_cron'>, []>(
        'SELECT id, host_id, check_cron FROM containers WHERE is_enabled = 1 ORDER BY vmid',
      )
      .all()
      .map((r) => ({ id: r.id, hostId: r.host_id, checkCron: r.check_cron }));
  }

  /** Ids of the targets reached through the host `hostId` (the node itself, its guests, a server). */
  idsOnHost(hostId: number | null): number[] {
    return this.db
      .query<{ id: number }, [number | null]>('SELECT id FROM containers WHERE host_id IS ?')
      .all(hostId)
      .map((r) => r.id);
  }

  /** True when guest `vmid` of the node `hostId` has been added. */
  existsVmid(hostId: number, vmid: number): boolean {
    return (
      this.db.query("SELECT 1 FROM containers WHERE host_id = ? AND vmid = ? AND kind IN ('lxc', 'vm')").get(hostId, vmid) !==
      null
    );
  }

  /** VMIDs of the guests (containers, virtual machines) of the node `hostId` that have been added. */
  addedVmids(hostId: number): Set<number> {
    const rows = this.db
      .query<{ vmid: number }, [number]>("SELECT vmid FROM containers WHERE host_id = ? AND kind IN ('lxc', 'vm')")
      .all(hostId);
    return new Set(rows.map((r) => r.vmid));
  }

  /** The entry of the Proxmox node `hostId` itself, when it has been added. */
  getNode(hostId: number): Container | null {
    const row = this.db
      .query<ContainerRow, [number]>("SELECT * FROM containers WHERE host_id = ? AND kind = 'node'")
      .get(hostId);
    return row ? this.toContainer(row) : null;
  }

  /** Adds the Proxmox node `hostId` itself as a target (apt only). */
  addNode(hostId: number, name: string): Container {
    return this.insert(hostId, 'node', NODE_VMID, name);
  }

  /** The target of the server `hostId` (a server host has exactly one). */
  getServer(hostId: number): Container | null {
    const row = this.db
      .query<ContainerRow, [number]>("SELECT * FROM containers WHERE host_id = ? AND kind = 'server'")
      .get(hostId);
    return row ? this.toContainer(row) : null;
  }

  /** Adds the target of the server `hostId` (apt and applications, commands run directly on it). */
  addServer(hostId: number, name: string): Container {
    return this.insert(hostId, 'server', NODE_VMID, name);
  }

  /** Adds a container or virtual machine of the node `hostId`. */
  add(hostId: number, vmid: number, name: string, kind: GuestKind = 'lxc'): Container {
    return this.insert(hostId, kind, vmid, name);
  }

  private insert(hostId: number, kind: TargetKind, vmid: number, name: string): Container {
    const row = this.db
      .query<ContainerRow, [number, string, number, string, string]>(
        'INSERT INTO containers (host_id, kind, vmid, name, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *',
      )
      .get(hostId, kind, vmid, name, new Date().toISOString())!;
    return this.toContainer(row);
  }

  save(c: Container): void {
    this.db
      .query(
        `UPDATE containers SET
           name = ?, is_enabled = ?, apt_enabled = ?, backup_before_update = ?, start_when_stopped = ?, check_cron = ?,
           update_cores = ?, update_memory_mb = ?, status = ?,
           apt_upgradable = ?, package_manager = ?, restart_reasons = ?, os_release = ?, home_assistant = ?, home_assistant_url = ?, home_assistant_token = ?,
           home_assistant_install = ?, last_checked_at = ?, last_error = ?, notified_signature = ?,
           docker_enabled = ?, docker_engine = ?, docker_error = ?
         WHERE id = ?`,
      )
      .run(
        c.name,
        c.isEnabled ? 1 : 0,
        c.aptEnabled ? 1 : 0,
        c.backupBeforeUpdate === null ? null : c.backupBeforeUpdate ? 1 : 0,
        c.startWhenStopped ? 1 : 0,
        c.checkCron,
        c.updateCores,
        c.updateMemoryMb,
        c.status,
        c.aptUpgradable.length > 0 ? JSON.stringify(c.aptUpgradable) : null,
        c.packageManager,
        c.restartReasons.length > 0 ? JSON.stringify(c.restartReasons) : null,
        c.osRelease ? JSON.stringify(c.osRelease) : null,
        c.homeAssistant ? JSON.stringify(c.homeAssistant) : null,
        c.homeAssistantUrl,
        this.secrets.encryptNullable(c.homeAssistantToken),
        c.homeAssistantInstall ? 1 : 0,
        c.lastCheckedAt,
        c.lastError,
        c.notifiedSignature,
        c.dockerEnabled ? 1 : 0,
        c.dockerEngine,
        c.dockerError,
        c.id,
      );
  }

  /**
   * Records (or clears) resources to restore after an update. Written separately from {@link save}, so saving
   * a container object loaded before the update cannot overwrite it.
   */
  setResourcesToRestore(c: Container, change: ResourceChange | null): void {
    c.resourcesToRestore = change;
    this.db
      .query('UPDATE containers SET resources_to_restore = ? WHERE id = ?')
      .run(change ? JSON.stringify(change) : null, c.id);
  }

  delete(id: number): boolean {
    return this.db.query('DELETE FROM containers WHERE id = ?').run(id).changes > 0;
  }

  listApps(containerId?: number): ContainerApp[] {
    const rows =
      containerId === undefined
        ? this.db.query<AppRow, []>('SELECT * FROM container_apps ORDER BY container_id, name COLLATE NOCASE, id').all()
        : this.db.query<AppRow, [number]>('SELECT * FROM container_apps WHERE container_id = ? ORDER BY name COLLATE NOCASE, id').all(containerId);
    return rows.map(toApp);
  }

  /** Linked repository and versions of every application – without commands and other settings. */
  listAppVersions(): Pick<ContainerApp, 'repositoryId' | 'installedVersion' | 'latestVersion'>[] {
    return this.db
      .query<Pick<AppRow, 'repository_id' | 'installed_version' | 'latest_version'>, []>(
        'SELECT repository_id, installed_version, latest_version FROM container_apps',
      )
      .all()
      .map((r) => ({ repositoryId: r.repository_id, installedVersion: r.installed_version, latestVersion: r.latest_version }));
  }

  /** Installed versions of the applications linked to a repository. */
  linkedAppVersions(repositoryId: number): (string | null)[] {
    return this.db
      .query<Pick<AppRow, 'installed_version'>, [number]>('SELECT installed_version FROM container_apps WHERE repository_id = ?')
      .all(repositoryId)
      .map((r) => r.installed_version);
  }

  /**
   * Ids of the enabled containers with an application whose latest version comes from a linked repository and
   * differs from that repository's newest release – the checks that bring them up to date (all repositories, or one).
   */
  enabledIdsWithStaleLatest(repositoryId?: number): number[] {
    const sql = `SELECT DISTINCT c.id FROM containers c
        JOIN container_apps a ON a.container_id = c.id
        JOIN watched_repositories r ON r.id = a.repository_id
       WHERE c.is_enabled = 1 AND a.latest_source = 'github' AND r.last_seen_tag IS NOT NULL
         AND a.latest_version IS NOT r.last_seen_tag`;
    return repositoryId === undefined
      ? this.db.query<{ id: number }, []>(`${sql} ORDER BY c.vmid`).all().map((r) => r.id)
      : this.db
          .query<{ id: number }, [number]>(`${sql} AND r.id = ? ORDER BY c.vmid`)
          .all(repositoryId)
          .map((r) => r.id);
  }

  /** Counts for the status summary, computed by SQLite (no rows are read, no secrets decrypted). */
  statusCounts(): { total: number; enabled: number; withErrors: number; aptPending: number; homeAssistantUpdates: number } {
    return this.db
      .query<{ total: number; enabled: number; withErrors: number; aptPending: number; homeAssistantUpdates: number }, []>(
        `SELECT count(*) AS total,
                coalesce(sum(is_enabled = 1), 0) AS enabled,
                coalesce(sum(last_error IS NOT NULL AND last_error <> ''), 0) AS withErrors,
                coalesce(sum(CASE WHEN json_valid(apt_upgradable) THEN json_array_length(apt_upgradable) > 0 ELSE 0 END), 0) AS aptPending,
                coalesce(sum(CASE WHEN json_valid(home_assistant) AND json_type(home_assistant, '$.updates') = 'array'
                                  THEN json_array_length(home_assistant, '$.updates') ELSE 0 END), 0) AS homeAssistantUpdates
         FROM containers`,
      )
      .get()!;
  }

  getApp(containerId: number, appId: number): ContainerApp | null {
    const row = this.db
      .query<AppRow, [number, number]>('SELECT * FROM container_apps WHERE id = ? AND container_id = ?')
      .get(appId, containerId);
    return row ? toApp(row) : null;
  }

  addApp(containerId: number, input: AppInput): ContainerApp {
    const app = toApp(
      this.db
        .query<AppRow, [number, string, string]>(
          'INSERT INTO container_apps (container_id, name, created_at) VALUES (?, ?, ?) RETURNING *',
        )
        .get(containerId, input.name, new Date().toISOString())!,
    );
    Object.assign(app, input);
    this.saveApp(app);
    return app;
  }

  saveApp(a: ContainerApp): void {
    this.db
      .query(
        `UPDATE container_apps SET
           name = ?, version_command = ?, latest_source = ?, repository_id = ?, latest_command = ?, update_command = ?,
           use_tty = ?, timeout_seconds = ?, installed_version = ?, latest_version = ?, checked_at = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        a.name,
        a.versionCommand,
        a.latestSource,
        a.repositoryId,
        a.latestCommand,
        a.updateCommand,
        a.useTty ? 1 : 0,
        a.timeoutSeconds,
        a.installedVersion,
        a.latestVersion,
        a.checkedAt,
        a.error,
        a.id,
      );
  }

  deleteApp(containerId: number, appId: number): boolean {
    return this.db.query('DELETE FROM container_apps WHERE id = ? AND container_id = ?').run(appId, containerId).changes > 0;
  }

  startRun(containerId: number, appId: number | null, kind: RunKind, trigger: RunTrigger): Run {
    const row = this.db
      .query<RunRow, [number, number | null, string, string, string]>(
        `INSERT INTO container_runs (container_id, app_id, kind, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)
         RETURNING id, container_id, app_id, kind, trigger, status, started_at, finished_at, exit_code, output`,
      )
      .get(containerId, appId, kind, trigger, new Date().toISOString())!;
    return toRun(row);
  }

  saveRunOutput(id: number, output: string): void {
    this.db.query('UPDATE container_runs SET output = ? WHERE id = ?').run(output, id);
  }

  /** Records the detached step a run is waiting for (null when it is done). */
  setRunResume(id: number, resume: RunResume | null): void {
    this.db.query('UPDATE container_runs SET resume = ? WHERE id = ?').run(resume ? JSON.stringify(resume) : null, id);
  }

  /** Runs left "running" by a previous process while a detached step was executing on the node. */
  listResumableRuns(): { run: Run; resume: RunResume }[] {
    return this.db
      .query<RunRow & { resume: string | null }, []>(
        "SELECT * FROM container_runs WHERE status = 'running' AND resume IS NOT NULL ORDER BY id",
      )
      .all()
      .flatMap((r) => {
        const resume = parseJson<RunResume | null>(r.resume, null);
        return resume ? [{ run: toRun(r), resume }] : [];
      });
  }

  finishRun(run: Run): void {
    this.db
      .query('UPDATE container_runs SET status = ?, finished_at = ?, exit_code = ?, output = ?, resume = NULL WHERE id = ?')
      .run(run.status, run.finishedAt, run.exitCode, packOutput(run.output), run.id);
    this.pruneRuns(run.containerId);
  }

  /**
   * Deletes the runs beyond the run history limits (checks and other runs counted separately) – of one container, or
   * of all when `containerId` is omitted (after the limits were lowered). Returns the number of deleted runs.
   */
  pruneRuns(containerId: number | null = null): number {
    const { checks, others } = this.runHistory();
    if (checks === null && others === null) {
      return 0;
    }
    const pruned = this.db
      .query(
        `DELETE FROM container_runs WHERE status <> 'running' AND id IN (
           SELECT id FROM (
             SELECT id, kind, ROW_NUMBER() OVER (PARTITION BY container_id, kind = 'check' ORDER BY id DESC) AS n
             FROM container_runs WHERE ?1 IS NULL OR container_id = ?1)
           WHERE n > CASE WHEN kind = 'check' THEN coalesce(?2, n) ELSE coalesce(?3, n) END)`,
      )
      .run(containerId, checks, others).changes;
    if (pruned > 0) {
      this.releaseFreePages();
    }
    return pruned;
  }

  getRun(id: number): Run | null {
    const row = this.db.query<RunRow, [number]>('SELECT * FROM container_runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  /** Newest runs of a container, without their output; `beforeId` continues after the last run of the previous page. */
  listRuns(containerId: number, limit = 20, beforeId: number | null = null): Omit<Run, 'output'>[] {
    return this.db
      .query<Omit<RunRow, 'output'>, [number, number | null, number]>(
        `SELECT id, container_id, app_id, kind, trigger, status, started_at, finished_at, exit_code
         FROM container_runs WHERE container_id = ?1 AND (?2 IS NULL OR id < ?2) ORDER BY id DESC LIMIT ?3`,
      )
      .all(containerId, beforeId, limit)
      .map((r) => {
        const { output: _, ...rest } = toRun({ ...r, output: '' });
        return rest;
      });
  }

  /**
   * Marks runs left in the "running" state by a previous process as failed – except those waiting for a detached
   * step on the node (see {@link listResumableRuns}), unless `includeResumable` is set.
   */
  failInterruptedRuns(includeResumable = false): number {
    return this.db
      .query(
        `UPDATE container_runs SET status = 'failed', finished_at = ?, output = output || ?, resume = NULL
         WHERE status = 'running'${includeResumable ? '' : ' AND resume IS NULL'}`,
      )
      .run(new Date().toISOString(), '\n[ReleaseWatcher was restarted while this was running]').changes;
  }

  /**
   * Compresses the output of finished runs still stored as plain text (written before compression existed, or
   * failed by {@link failInterruptedRuns}). Returns the number of compressed runs.
   */
  packFinishedOutputs(): number {
    const rows = this.db
      .query<{ id: number; output: string }, [number]>(
        `SELECT id, output FROM container_runs
         WHERE status <> 'running' AND typeof(output) = 'text' AND length(output) >= ?`,
      )
      .all(PACK_OUTPUT_FROM);
    if (rows.length === 0) {
      return 0;
    }
    const update = this.db.query('UPDATE container_runs SET output = ? WHERE id = ?');
    this.db.transaction(() => {
      for (const { id, output } of rows) {
        update.run(packOutput(output), id);
      }
    })();
    this.releaseFreePages(1);
    return rows.length;
  }

  /**
   * Gives free pages back to the file system (the database uses auto_vacuum = INCREMENTAL) once at least `minPages`
   * have piled up: a prune after a finished run frees a page or two – not worth moving pages around every time.
   */
  private releaseFreePages(minPages = FREE_PAGES_TO_RELEASE): void {
    const free = this.db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()!.freelist_count;
    if (free >= minPages) {
      this.db.run('PRAGMA incremental_vacuum');
    }
  }
}
