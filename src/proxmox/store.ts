import type { Database } from 'bun:sqlite';
import type { SecretBox } from '../secret-box.ts';
import type { HomeAssistantState } from './home-assistant.ts';
import {
  type AptPackage,
  type Container,
  type ContainerApp,
  type GuestKind,
  type LatestSource,
  NODE_VMID,
  type ResourceChange,
  type Run,
  type RunKind,
  type RunResume,
  type RunStatus,
  type RunTrigger,
  type TargetKind,
} from './domain.ts';

interface ContainerRow {
  id: number;
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
  restart_reasons: string | null;
  home_assistant: string | null;
  home_assistant_url: string | null;
  home_assistant_token: string | null;
  home_assistant_install: number;
  last_checked_at: string | null;
  last_error: string | null;
  notified_signature: string | null;
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
  output: string;
}

function parseJson<T>(json: string | null): T | null {
  if (!json) {
    return null;
  }
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function parsePackages(json: string | null): AptPackage[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is AptPackage => typeof p?.name === 'string') : [];
  } catch {
    return [];
  }
}

function parseStrings(json: string | null): string[] {
  const parsed = parseJson<unknown>(json);
  return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
}

const toContainer = (r: ContainerRow, secrets: SecretBox): Container => ({
  id: r.id,
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
  resourcesToRestore: parseJson<ResourceChange>(r.resources_to_restore),
  status: r.status,
  aptUpgradable: parsePackages(r.apt_upgradable),
  restartReasons: parseStrings(r.restart_reasons),
  homeAssistant: parseHomeAssistant(r.home_assistant),
  homeAssistantUrl: r.home_assistant_url,
  homeAssistantToken: secrets.decryptNullable(r.home_assistant_token),
  homeAssistantInstall: r.home_assistant_install === 1,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  notifiedSignature: r.notified_signature,
  createdAt: r.created_at,
});

function parseHomeAssistant(json: string | null): HomeAssistantState | null {
  const parsed = parseJson<HomeAssistantState>(json);
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
  output: r.output,
});

/** Editable application fields. */
export type AppInput = Pick<
  ContainerApp,
  'name' | 'versionCommand' | 'latestSource' | 'repositoryId' | 'latestCommand' | 'updateCommand' | 'useTty' | 'timeoutSeconds'
>;

/** Runs kept per container; older ones are pruned. */
export const RUNS_KEPT_PER_CONTAINER = 50;

/** SQLite persistence of containers, their applications and runs (tables created by `RepositoryStore`). */
export class ContainerStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;
  private readonly toContainer = (r: ContainerRow): Container => toContainer(r, this.secrets);

  /** @param secrets encrypts the Home Assistant token (the `RepositoryStore`'s box: `store.secretBox`) */
  constructor(db: Database, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
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

  existsVmid(vmid: number): boolean {
    return this.db.query("SELECT 1 FROM containers WHERE vmid = ? AND kind IN ('lxc', 'vm')").get(vmid) !== null;
  }

  /** The Proxmox host entry, when it has been added. */
  getNode(): Container | null {
    const row = this.db.query<ContainerRow, []>("SELECT * FROM containers WHERE kind = 'node'").get();
    return row ? this.toContainer(row) : null;
  }

  /** Adds the Proxmox host as a target (apt only). */
  addNode(name: string): Container {
    const result = this.db
      .query("INSERT INTO containers (kind, vmid, name, created_at) VALUES ('node', ?, ?, ?)")
      .run(NODE_VMID, name, new Date().toISOString());
    return this.get(Number(result.lastInsertRowid))!;
  }

  /** Adds a container or virtual machine. */
  add(vmid: number, name: string, kind: GuestKind = 'lxc'): Container {
    const result = this.db
      .query('INSERT INTO containers (kind, vmid, name, created_at) VALUES (?, ?, ?, ?)')
      .run(kind, vmid, name, new Date().toISOString());
    return this.get(Number(result.lastInsertRowid))!;
  }

  save(c: Container): void {
    this.db
      .query(
        `UPDATE containers SET
           name = ?, is_enabled = ?, apt_enabled = ?, backup_before_update = ?, start_when_stopped = ?, check_cron = ?,
           update_cores = ?, update_memory_mb = ?, status = ?,
           apt_upgradable = ?, restart_reasons = ?, home_assistant = ?, home_assistant_url = ?, home_assistant_token = ?,
           home_assistant_install = ?, last_checked_at = ?, last_error = ?, notified_signature = ?
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
        c.restartReasons.length > 0 ? JSON.stringify(c.restartReasons) : null,
        c.homeAssistant ? JSON.stringify(c.homeAssistant) : null,
        c.homeAssistantUrl,
        this.secrets.encryptNullable(c.homeAssistantToken),
        c.homeAssistantInstall ? 1 : 0,
        c.lastCheckedAt,
        c.lastError,
        c.notifiedSignature,
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
    const result = this.db
      .query('INSERT INTO container_apps (container_id, name, created_at) VALUES (?, ?, ?)')
      .run(containerId, input.name, new Date().toISOString());
    const app = this.getApp(containerId, Number(result.lastInsertRowid))!;
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
    const result = this.db
      .query(
        `INSERT INTO container_runs (container_id, app_id, kind, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(containerId, appId, kind, trigger, new Date().toISOString());
    return this.getRun(Number(result.lastInsertRowid))!;
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
        const resume = parseJson<RunResume>(r.resume);
        return resume ? [{ run: toRun(r), resume }] : [];
      });
  }

  finishRun(run: Run): void {
    this.db
      .query('UPDATE container_runs SET status = ?, finished_at = ?, exit_code = ?, output = ?, resume = NULL WHERE id = ?')
      .run(run.status, run.finishedAt, run.exitCode, run.output, run.id);
    // Keep only the newest runs of this container.
    this.db
      .query(
        `DELETE FROM container_runs WHERE container_id = ?1 AND id NOT IN (
           SELECT id FROM container_runs WHERE container_id = ?1 ORDER BY id DESC LIMIT ?2)`,
      )
      .run(run.containerId, RUNS_KEPT_PER_CONTAINER);
  }

  getRun(id: number): Run | null {
    const row = this.db.query<RunRow, [number]>('SELECT * FROM container_runs WHERE id = ?').get(id);
    return row ? toRun(row) : null;
  }

  /** Newest runs of a container, without their output. */
  listRuns(containerId: number, limit = 20): Omit<Run, 'output'>[] {
    return this.db
      .query<Omit<RunRow, 'output'>, [number, number]>(
        `SELECT id, container_id, app_id, kind, trigger, status, started_at, finished_at, exit_code
         FROM container_runs WHERE container_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(containerId, limit)
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
}
