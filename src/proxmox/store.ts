import type { Database } from 'bun:sqlite';
import type { AptPackage, Container, ContainerApp, LatestSource, Run, RunKind, RunStatus, RunTrigger } from './domain.ts';

interface ContainerRow {
  id: number;
  vmid: number;
  name: string;
  is_enabled: number;
  apt_enabled: number;
  backup_before_update: number | null;
  start_when_stopped: number;
  check_cron: string | null;
  status: string | null;
  apt_upgradable: string | null;
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

const toContainer = (r: ContainerRow): Container => ({
  id: r.id,
  vmid: r.vmid,
  name: r.name,
  isEnabled: r.is_enabled === 1,
  aptEnabled: r.apt_enabled === 1,
  backupBeforeUpdate: r.backup_before_update === null ? null : r.backup_before_update === 1,
  startWhenStopped: r.start_when_stopped === 1,
  checkCron: r.check_cron,
  status: r.status,
  aptUpgradable: parsePackages(r.apt_upgradable),
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  notifiedSignature: r.notified_signature,
  createdAt: r.created_at,
});

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

  constructor(db: Database) {
    this.db = db;
  }

  list(): Container[] {
    return this.db.query<ContainerRow, []>('SELECT * FROM containers ORDER BY vmid').all().map(toContainer);
  }

  listEnabled(): Container[] {
    return this.db.query<ContainerRow, []>('SELECT * FROM containers WHERE is_enabled = 1 ORDER BY vmid').all().map(toContainer);
  }

  get(id: number): Container | null {
    const row = this.db.query<ContainerRow, [number]>('SELECT * FROM containers WHERE id = ?').get(id);
    return row ? toContainer(row) : null;
  }

  existsVmid(vmid: number): boolean {
    return this.db.query('SELECT 1 FROM containers WHERE vmid = ?').get(vmid) !== null;
  }

  add(vmid: number, name: string): Container {
    const result = this.db
      .query('INSERT INTO containers (vmid, name, created_at) VALUES (?, ?, ?)')
      .run(vmid, name, new Date().toISOString());
    return this.get(Number(result.lastInsertRowid))!;
  }

  save(c: Container): void {
    this.db
      .query(
        `UPDATE containers SET
           name = ?, is_enabled = ?, apt_enabled = ?, backup_before_update = ?, start_when_stopped = ?, check_cron = ?,
           status = ?,
           apt_upgradable = ?, last_checked_at = ?, last_error = ?, notified_signature = ?
         WHERE id = ?`,
      )
      .run(
        c.name,
        c.isEnabled ? 1 : 0,
        c.aptEnabled ? 1 : 0,
        c.backupBeforeUpdate === null ? null : c.backupBeforeUpdate ? 1 : 0,
        c.startWhenStopped ? 1 : 0,
        c.checkCron,
        c.status,
        c.aptUpgradable.length > 0 ? JSON.stringify(c.aptUpgradable) : null,
        c.lastCheckedAt,
        c.lastError,
        c.notifiedSignature,
        c.id,
      );
  }

  delete(id: number): boolean {
    return this.db.query('DELETE FROM containers WHERE id = ?').run(id).changes > 0;
  }

  listApps(containerId?: number): ContainerApp[] {
    const rows =
      containerId === undefined
        ? this.db.query<AppRow, []>('SELECT * FROM container_apps ORDER BY container_id, id').all()
        : this.db.query<AppRow, [number]>('SELECT * FROM container_apps WHERE container_id = ? ORDER BY id').all(containerId);
    return rows.map(toApp);
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

  finishRun(run: Run): void {
    this.db
      .query('UPDATE container_runs SET status = ?, finished_at = ?, exit_code = ?, output = ? WHERE id = ?')
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

  /** Marks runs left in the "running" state by a previous process as failed. */
  failInterruptedRuns(): number {
    return this.db
      .query(
        `UPDATE container_runs SET status = 'failed', finished_at = ?, output = output || ?
         WHERE status = 'running'`,
      )
      .run(new Date().toISOString(), '\n[ReleaseWatcher was restarted while this was running]').changes;
  }
}
