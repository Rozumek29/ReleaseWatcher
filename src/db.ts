import { Database } from 'bun:sqlite';
import type { WatchedRepository } from './domain.ts';

interface Row {
  id: number;
  owner: string;
  name: string;
  include_prereleases: number;
  is_enabled: number;
  last_seen_tag: string | null;
  last_seen_published_at: string | null;
  etag: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
  installed_version_url: string | null;
  installed_version_field: string | null;
  installed_version_headers: string | null;
  installed_version: string | null;
  installed_version_checked_at: string | null;
  installed_version_error: string | null;
  github_token: string | null;
}

const toEntity = (r: Row): WatchedRepository => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  includePrereleases: r.include_prereleases === 1,
  isEnabled: r.is_enabled === 1,
  lastSeenTag: r.last_seen_tag,
  lastSeenPublishedAt: r.last_seen_published_at,
  etag: r.etag,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  createdAt: r.created_at,
  installedVersionUrl: r.installed_version_url,
  installedVersionField: r.installed_version_field,
  installedVersionHeaders: parseHeaders(r.installed_version_headers),
  installedVersion: r.installed_version,
  installedVersionCheckedAt: r.installed_version_checked_at,
  installedVersionError: r.installed_version_error,
  githubToken: r.github_token,
});

function parseHeaders(json: string | null): { name: string; value: string }[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((h): h is { name: string; value: string } => typeof h?.name === 'string' && typeof h?.value === 'string')
      : [];
  } catch {
    return [];
  }
}

/** Schema migrations, applied in order. Append new entries – never edit existing ones. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE watched_repositories (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     owner                  TEXT    NOT NULL COLLATE NOCASE,
     name                   TEXT    NOT NULL COLLATE NOCASE,
     include_prereleases    INTEGER NOT NULL DEFAULT 0,
     is_enabled             INTEGER NOT NULL DEFAULT 1,
     last_seen_tag          TEXT,
     last_seen_published_at TEXT,
     etag                   TEXT,
     last_checked_at        TEXT,
     last_error             TEXT,
     created_at             TEXT    NOT NULL,
     UNIQUE (owner, name)
   )`,
  `CREATE TABLE settings (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
  `ALTER TABLE watched_repositories ADD COLUMN installed_version_url TEXT;
   ALTER TABLE watched_repositories ADD COLUMN installed_version_field TEXT;
   ALTER TABLE watched_repositories ADD COLUMN installed_version TEXT;
   ALTER TABLE watched_repositories ADD COLUMN installed_version_checked_at TEXT;
   ALTER TABLE watched_repositories ADD COLUMN installed_version_error TEXT;`,
  `ALTER TABLE watched_repositories ADD COLUMN installed_version_headers TEXT;`,
  // Proxmox LXC containers, their applications and the log of checks/updates (+ missing indexes).
  `CREATE INDEX idx_watched_repositories_enabled ON watched_repositories (is_enabled, id);

   CREATE TABLE containers (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     vmid                   INTEGER NOT NULL UNIQUE,
     name                   TEXT    NOT NULL,
     is_enabled             INTEGER NOT NULL DEFAULT 1,
     apt_enabled            INTEGER NOT NULL DEFAULT 1,
     snapshot_before_update INTEGER NOT NULL DEFAULT 0,
     check_cron             TEXT,
     status                 TEXT,
     apt_upgradable         TEXT,
     last_checked_at        TEXT,
     last_error             TEXT,
     notified_signature     TEXT,
     created_at             TEXT    NOT NULL
   );
   CREATE INDEX idx_containers_enabled ON containers (is_enabled, vmid);

   CREATE TABLE container_apps (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     container_id      INTEGER NOT NULL REFERENCES containers (id) ON DELETE CASCADE,
     name              TEXT    NOT NULL,
     version_command   TEXT,
     latest_source     TEXT    NOT NULL DEFAULT 'none',
     repository_id     INTEGER REFERENCES watched_repositories (id) ON DELETE SET NULL,
     latest_command    TEXT,
     update_command    TEXT,
     use_tty           INTEGER NOT NULL DEFAULT 0,
     timeout_seconds   INTEGER NOT NULL DEFAULT 1800,
     installed_version TEXT,
     latest_version    TEXT,
     checked_at        TEXT,
     error             TEXT,
     created_at        TEXT    NOT NULL
   );
   CREATE INDEX idx_container_apps_container ON container_apps (container_id, id);
   CREATE INDEX idx_container_apps_repository ON container_apps (repository_id) WHERE repository_id IS NOT NULL;

   CREATE TABLE container_runs (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     container_id INTEGER NOT NULL REFERENCES containers (id) ON DELETE CASCADE,
     app_id       INTEGER REFERENCES container_apps (id) ON DELETE SET NULL,
     kind         TEXT    NOT NULL,
     trigger      TEXT    NOT NULL,
     status       TEXT    NOT NULL,
     started_at   TEXT    NOT NULL,
     finished_at  TEXT,
     exit_code    INTEGER,
     output       TEXT    NOT NULL DEFAULT ''
   );
   CREATE INDEX idx_container_runs_container ON container_runs (container_id, id DESC);
   CREATE INDEX idx_container_runs_app ON container_runs (app_id) WHERE app_id IS NOT NULL;
   CREATE INDEX idx_container_runs_running ON container_runs (status) WHERE status = 'running';`,
  // Snapshots replaced by vzdump backups; NULL = use the global default.
  `ALTER TABLE containers ADD COLUMN backup_before_update INTEGER;
   UPDATE containers SET backup_before_update = 1 WHERE snapshot_before_update = 1;
   ALTER TABLE containers DROP COLUMN snapshot_before_update;`,
  // Per-repository GitHub token (overrides the global one).
  `ALTER TABLE watched_repositories ADD COLUMN github_token TEXT;`,
  // Login: a single admin account with a password and optional passkeys, plus browser sessions.
  `CREATE TABLE account (
     id                  INTEGER PRIMARY KEY CHECK (id = 1),
     username            TEXT NOT NULL,
     password_hash       TEXT NOT NULL,
     webauthn_user_id    TEXT NOT NULL,
     created_at          TEXT NOT NULL,
     password_changed_at TEXT NOT NULL
   );

   CREATE TABLE passkeys (
     id           TEXT PRIMARY KEY,
     public_key   BLOB NOT NULL,
     counter      INTEGER NOT NULL DEFAULT 0,
     transports   TEXT,
     device_type  TEXT,
     backed_up    INTEGER NOT NULL DEFAULT 0,
     name         TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     last_used_at TEXT
   );

   CREATE TABLE sessions (
     id           TEXT PRIMARY KEY,
     method       TEXT NOT NULL,
     user_agent   TEXT,
     ip           TEXT,
     created_at   TEXT NOT NULL,
     last_seen_at TEXT NOT NULL,
     expires_at   TEXT NOT NULL
   );
   CREATE INDEX idx_sessions_expires ON sessions (expires_at);`,
  // Start a stopped container temporarily for checks and updates (shut down again afterwards).
  `ALTER TABLE containers ADD COLUMN start_when_stopped INTEGER NOT NULL DEFAULT 0;`,
];

/** SQLite-backed store of watched repositories (uses Bun's built-in bun:sqlite module). */
export class RepositoryStore {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.run('PRAGMA journal_mode = WAL');
    this.db.run('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  /** The shared connection (used by other stores such as `ContainerStore`). */
  get database(): Database {
    return this.db;
  }

  list(): WatchedRepository[] {
    return this.db.query<Row, []>('SELECT * FROM watched_repositories ORDER BY owner, name').all().map(toEntity);
  }

  listEnabled(): WatchedRepository[] {
    return this.db.query<Row, []>('SELECT * FROM watched_repositories WHERE is_enabled = 1 ORDER BY id').all().map(toEntity);
  }

  get(id: number): WatchedRepository | null {
    const row = this.db.query<Row, [number]>('SELECT * FROM watched_repositories WHERE id = ?').get(id);
    return row ? toEntity(row) : null;
  }

  /** Case-insensitive lookup (columns use NOCASE collation). */
  exists(owner: string, name: string): boolean {
    return this.db.query('SELECT 1 FROM watched_repositories WHERE owner = ? AND name = ?').get(owner, name) !== null;
  }

  add(owner: string, name: string, includePrereleases: boolean): WatchedRepository {
    const result = this.db
      .query('INSERT INTO watched_repositories (owner, name, include_prereleases, created_at) VALUES (?, ?, ?, ?)')
      .run(owner, name, includePrereleases ? 1 : 0, new Date().toISOString());
    return this.get(Number(result.lastInsertRowid))!;
  }

  /** Persists all mutable fields of the entity. */
  save(repo: WatchedRepository): void {
    this.db
      .query(
        `UPDATE watched_repositories SET
           include_prereleases = ?, is_enabled = ?, last_seen_tag = ?, last_seen_published_at = ?,
           etag = ?, last_checked_at = ?, last_error = ?,
           installed_version_url = ?, installed_version_field = ?, installed_version_headers = ?, installed_version = ?,
           installed_version_checked_at = ?, installed_version_error = ?, github_token = ?
         WHERE id = ?`,
      )
      .run(
        repo.includePrereleases ? 1 : 0,
        repo.isEnabled ? 1 : 0,
        repo.lastSeenTag,
        repo.lastSeenPublishedAt,
        repo.etag,
        repo.lastCheckedAt,
        repo.lastError,
        repo.installedVersionUrl,
        repo.installedVersionField,
        repo.installedVersionHeaders.length > 0 ? JSON.stringify(repo.installedVersionHeaders) : null,
        repo.installedVersion,
        repo.installedVersionCheckedAt,
        repo.installedVersionError,
        repo.githubToken,
        repo.id,
      );
  }

  delete(id: number): boolean {
    return this.db.query('DELETE FROM watched_repositories WHERE id = ?').run(id).changes > 0;
  }

  /** Returns all persisted settings as raw key/value pairs. */
  readSettings(): Record<string, string> {
    const rows = this.db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings').all();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Upserts a setting; null removes it (the environment default applies again). */
  writeSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.query('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      this.db
        .query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, value);
    }
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    const { user_version: version } = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    const apply = this.db.transaction((index: number) => {
      this.db.exec(MIGRATIONS[index]!);
      this.db.exec(`PRAGMA user_version = ${index + 1}`);
    });
    for (let i = version; i < MIGRATIONS.length; i++) {
      apply(i);
    }
  }
}
