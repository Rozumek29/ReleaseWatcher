import { Database } from 'bun:sqlite';
import type { WatchedRepository } from './domain.ts';
import { SecretBox, SecretDecryptionError } from './secret-box.ts';

/** Settings whose values are secrets and are stored encrypted. */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(['discordWebhookUrl', 'githubToken', 'proxmoxSshKey', 'smtpPassword']);

/** Known plain text stored encrypted in `app_meta` to detect a wrong encryption key at startup. */
const KEY_CHECK_NAME = 'secretsKeyCheck';
const KEY_CHECK_VALUE = 'releasewatcher';

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

const toEntity = (r: Row, secrets: SecretBox): WatchedRepository => ({
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
  installedVersionHeaders: parseHeaders(secrets.decryptNullable(r.installed_version_headers)),
  installedVersion: r.installed_version,
  installedVersionCheckedAt: r.installed_version_checked_at,
  installedVersionError: r.installed_version_error,
  githubToken: secrets.decryptNullable(r.github_token),
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
  // The Proxmox host itself as a check/update target (apt only), stored with vmid 0.
  `ALTER TABLE containers ADD COLUMN kind TEXT NOT NULL DEFAULT 'lxc';`,
  // Internal values of the app itself (e.g. the encryption key check); never exposed through the API.
  // IF NOT EXISTS: development databases of the encryption branch created it before the two migrations above.
  `CREATE TABLE IF NOT EXISTS app_meta (
     key   TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );`,
  // Resources raised during updates (restored afterwards) and detached updates that survive a restart.
  `ALTER TABLE containers ADD COLUMN update_cores INTEGER;
   ALTER TABLE containers ADD COLUMN update_memory_mb INTEGER;
   ALTER TABLE containers ADD COLUMN resources_to_restore TEXT;
   ALTER TABLE container_runs ADD COLUMN resume TEXT;`,
  // Reasons why a container or the host should be restarted (JSON array of strings, from the last check).
  `ALTER TABLE containers ADD COLUMN restart_reasons TEXT;`,
  // Home Assistant OS in virtual machines: pending updates (JSON), the REST API connection (token encrypted) and
  // whether its updates may be installed from here (off = check only).
  `ALTER TABLE containers ADD COLUMN home_assistant TEXT;
   ALTER TABLE containers ADD COLUMN home_assistant_url TEXT;
   ALTER TABLE containers ADD COLUMN home_assistant_token TEXT;
   ALTER TABLE containers ADD COLUMN home_assistant_install INTEGER NOT NULL DEFAULT 0;`,
];

/** ReleaseWatcher's own repository: watched in every new database, so the app announces its own releases. */
export const SELF_REPOSITORY = { owner: 'rozumek29', name: 'releasewatcher' } as const;

/** SQLite-backed store of watched repositories (uses Bun's built-in bun:sqlite module). */
export class RepositoryStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;
  private isNew = false;

  /**
   * `secrets` encrypts tokens, keys and header values. It may be omitted only for an in-memory database (tests):
   * a file encrypted with a random key would lose its secrets on the next start.
   */
  constructor(path: string, secrets?: SecretBox) {
    if (!secrets && path !== ':memory:') {
      throw new Error('RepositoryStore needs the encryption key (SecretBox) for a database file.');
    }
    this.db = new Database(path);
    this.secrets = secrets ?? SecretBox.ephemeral();
    this.db.run('PRAGMA journal_mode = WAL');
    // Safe with WAL (no corruption; at most the last commits are lost on a power cut) and avoids an fsync per write.
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    try {
      this.migrate();
      this.encryptSecrets();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** True when this instance created the database (it had no schema yet), false for an existing one. */
  get created(): boolean {
    return this.isNew;
  }

  /**
   * Adds ReleaseWatcher's own repository to a database created just now. Called once at startup, so a user who
   * removes the repository later does not get it back. `installedVersionUrl` (this server's `/api/version`) lets the
   * checker compare the running version with the latest release. Returns the added repository, or `null`.
   */
  seedNewDatabase(installedVersionUrl: string | null = null): WatchedRepository | null {
    if (!this.isNew || this.exists(SELF_REPOSITORY.owner, SELF_REPOSITORY.name)) {
      return null;
    }
    const repo = this.add(SELF_REPOSITORY.owner, SELF_REPOSITORY.name, false);
    if (installedVersionUrl) {
      repo.installedVersionUrl = installedVersionUrl;
      repo.installedVersionField = 'version';
      this.save(repo);
    }
    return repo;
  }

  /** The shared connection (used by other stores such as `ContainerStore`). */
  get database(): Database {
    return this.db;
  }

  /** Encrypts secrets of other stores sharing the connection (`ContainerStore`). */
  get secretBox(): SecretBox {
    return this.secrets;
  }

  list(): WatchedRepository[] {
    return this.db
      .query<Row, []>('SELECT * FROM watched_repositories ORDER BY name COLLATE NOCASE, owner COLLATE NOCASE')
      .all()
      .map((r) => toEntity(r, this.secrets));
  }

  /** The few fields the status summary needs – without reading (and decrypting) the secrets of every repository. */
  listStatusFields(): Pick<WatchedRepository, 'isEnabled' | 'lastError' | 'lastSeenTag' | 'installedVersion'>[] {
    return this.db
      .query<Pick<Row, 'is_enabled' | 'last_error' | 'last_seen_tag' | 'installed_version'>, []>(
        'SELECT is_enabled, last_error, last_seen_tag, installed_version FROM watched_repositories',
      )
      .all()
      .map((r) => ({
        isEnabled: r.is_enabled === 1,
        lastError: r.last_error,
        lastSeenTag: r.last_seen_tag,
        installedVersion: r.installed_version,
      }));
  }

  listEnabled(): WatchedRepository[] {
    return this.db.query<Row, []>('SELECT * FROM watched_repositories WHERE is_enabled = 1 ORDER BY id').all().map((r) => toEntity(r, this.secrets));
  }

  get(id: number): WatchedRepository | null {
    const row = this.db.query<Row, [number]>('SELECT * FROM watched_repositories WHERE id = ?').get(id);
    return row ? toEntity(row, this.secrets) : null;
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
        repo.installedVersionHeaders.length > 0 ? this.secrets.encrypt(JSON.stringify(repo.installedVersionHeaders)) : null,
        repo.installedVersion,
        repo.installedVersionCheckedAt,
        repo.installedVersionError,
        this.secrets.encryptNullable(repo.githubToken),
        repo.id,
      );
  }

  delete(id: number): boolean {
    return this.db.query('DELETE FROM watched_repositories WHERE id = ?').run(id).changes > 0;
  }

  /** Returns all persisted settings as raw key/value pairs. */
  readSettings(): Record<string, string> {
    const rows = this.db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings').all();
    return Object.fromEntries(
      rows.map((r) => [r.key, SECRET_SETTING_KEYS.has(r.key) ? this.secrets.decrypt(r.value) : r.value]),
    );
  }

  /** Upserts a setting; null removes it (the environment default applies again). */
  writeSetting(key: string, value: string | null): void {
    if (value === null) {
      this.db.query('DELETE FROM settings WHERE key = ?').run(key);
    } else {
      this.db
        .query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, SECRET_SETTING_KEYS.has(key) ? this.secrets.encrypt(value) : value);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Verifies the encryption key against the database and encrypts secrets still stored as plain text (written
   * before encryption existed). Fails loudly on a wrong key instead of silently losing the secrets.
   */
  private encryptSecrets(): void {
    const check = this.db
      .query<{ value: string }, [string]>('SELECT value FROM app_meta WHERE key = ?')
      .get(KEY_CHECK_NAME)?.value;
    if (check !== undefined) {
      let matches = false;
      try {
        matches = this.secrets.decrypt(check) === KEY_CHECK_VALUE;
      } catch (error) {
        if (!(error instanceof SecretDecryptionError)) {
          throw error;
        }
      }
      if (!matches) {
        throw new Error(
          'The encryption key does not match this database. Restore the original ENCRYPTION_KEY or the ' +
            'encryption.key file next to the database – secrets saved with another key cannot be read.',
        );
      }
    }

    const plain = (value: string | null): value is string => value !== null && !SecretBox.isEncrypted(value);
    this.db.transaction(() => {
      const repos = this.db
        .query<Pick<Row, 'id' | 'github_token' | 'installed_version_headers'>, []>(
          'SELECT id, github_token, installed_version_headers FROM watched_repositories',
        )
        .all();
      for (const r of repos) {
        if (plain(r.github_token) || plain(r.installed_version_headers)) {
          this.db
            .query('UPDATE watched_repositories SET github_token = ?, installed_version_headers = ? WHERE id = ?')
            .run(
              plain(r.github_token) ? this.secrets.encrypt(r.github_token) : r.github_token,
              plain(r.installed_version_headers) ? this.secrets.encrypt(r.installed_version_headers) : r.installed_version_headers,
              r.id,
            );
        }
      }
      for (const key of SECRET_SETTING_KEYS) {
        const row = this.db.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key);
        if (row && plain(row.value)) {
          this.db.query('UPDATE settings SET value = ? WHERE key = ?').run(this.secrets.encrypt(row.value), key);
        }
      }
      if (check === undefined) {
        this.db
          .query('INSERT INTO app_meta (key, value) VALUES (?, ?)')
          .run(KEY_CHECK_NAME, this.secrets.encrypt(KEY_CHECK_VALUE));
      }
    })();
  }

  private migrate(): void {
    const { user_version: version } = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    this.isNew = version === 0;
    const apply = this.db.transaction((index: number) => {
      this.db.exec(MIGRATIONS[index]!);
      this.db.exec(`PRAGMA user_version = ${index + 1}`);
    });
    for (let i = version; i < MIGRATIONS.length; i++) {
      apply(i);
    }
  }
}
