import { Database, type SQLQueryBindings } from 'bun:sqlite';
import {
  impactOfRank,
  normalizeSeverity,
  severityOfRank,
  severityRank,
  type AdvisorySeverity,
  type AdvisorySource,
  type AdvisorySummary,
  type AdvisoryVulnerability,
  type SecurityAdvisory,
} from './advisories.ts';
import { fullName, PROVIDERS, type MachineAppRef, type RepositoryProvider, type RepositoryRef, type WatchedRepository } from './domain.ts';
import { parseJson, parseStringArray } from './json.ts';
import { SecretBox, SecretDecryptionError } from './secret-box.ts';

/** Settings whose values are secrets and are stored encrypted. */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set([
  'discordWebhookUrl',
  'githubToken',
  'proxmoxSshKey',
  'smtpPassword',
  'ntfyToken',
  'gotifyToken',
  'telegramBotToken',
  'slackWebhookUrl',
  'pushoverUserKey',
  'pushoverAppToken',
  'webhookUrl',
  'webhookHeaders',
  'oidcClientSecret',
]);

/** Known plain text stored encrypted in `app_meta` to detect a wrong encryption key at startup. */
const KEY_CHECK_NAME = 'secretsKeyCheck';
const KEY_CHECK_VALUE = 'releasewatcher';

interface Row {
  id: number;
  provider: string;
  host: string | null;
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
  installed_app_id: number | null;
  installed_docker_id: number | null;
  github_token: string | null;
  advisories_etag: string | null;
  advisories_checked_at: string | null;
  advisories_error: string | null;
  osv_ecosystem: string | null;
  osv_package: string | null;
  advisory_baselines: string | null;
  icon: string | null;
}

interface AdvisoryRow {
  repository_id: number;
  advisory_id: string;
  source: string;
  aliases: string;
  cve_id: string | null;
  summary: string;
  severity: string;
  cvss_score: number | null;
  html_url: string;
  published_at: string;
  updated_at: string | null;
  vulnerabilities: string;
}

const toAdvisory = (r: AdvisoryRow): SecurityAdvisory => ({
  id: r.advisory_id,
  source: r.source === 'osv' ? 'osv' : 'github',
  aliases: parseStringArray(r.aliases),
  cveId: r.cve_id,
  summary: r.summary,
  severity: normalizeSeverity(r.severity),
  cvssScore: r.cvss_score,
  htmlUrl: r.html_url,
  publishedAt: r.published_at,
  updatedAt: r.updated_at,
  vulnerabilities: parseVulnerabilities(r.vulnerabilities),
});

function parseVulnerabilities(json: string): AdvisoryVulnerability[] {
  const parsed = parseJson<unknown>(json, null);
  return Array.isArray(parsed) ? (parsed as AdvisoryVulnerability[]) : [];
}

/** Provider of a row; an unknown value (written by a newer version) is read as GitHub's without a host. */
const toProvider = (provider: string, host: string | null): RepositoryProvider =>
  (PROVIDERS as readonly string[]).includes(provider) ? (provider as RepositoryProvider) : host === null ? 'github' : 'gitea';

const toEntity = (r: Row, secrets: SecretBox): WatchedRepository => ({
  id: r.id,
  provider: toProvider(r.provider, r.host),
  host: r.host,
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
  installedVersionApp:
    r.installed_app_id !== null
      ? { kind: 'app', id: r.installed_app_id }
      : r.installed_docker_id !== null
        ? { kind: 'docker', id: r.installed_docker_id }
        : null,
  githubToken: secrets.decryptNullable(r.github_token),
  advisoriesEtag: r.advisories_etag,
  advisoriesCheckedAt: r.advisories_checked_at,
  advisoriesError: r.advisories_error,
  osvEcosystem: r.osv_ecosystem,
  osvPackage: r.osv_package,
  advisoryBaselines: parseStringArray(r.advisory_baselines),
  icon: r.icon,
});

function parseHeaders(json: string | null): { name: string; value: string }[] {
  const parsed = parseJson<unknown>(json, null);
  return Array.isArray(parsed)
    ? parsed.filter((h): h is { name: string; value: string } => typeof h?.name === 'string' && typeof h?.value === 'string')
    : [];
}

interface PageRow extends AdvisoryRow {
  impact: number | null;
  severity_rank: number;
  affected_versions: string;
  provider: string;
  host: string | null;
  owner: string;
  name: string;
  installed_version: string | null;
  icon: string | null;
}

/** Filters of the Vulnerabilities page; omitted = no filter. */
export interface AdvisoryFilter {
  /** Impact rank: 2 affects an installed version, 1 unknown, 0 not affected. */
  impact?: number;
  severity?: AdvisorySeverity;
  source?: AdvisorySource;
  /** Text in the summary, the ids/aliases or the repository name (case-insensitive). */
  query?: string;
}

/** Sort key of the last advisory of a page. */
export interface AdvisoryCursor {
  impact: number;
  severityRank: number;
  publishedAt: string;
  repositoryId: number;
  advisoryId: string;
}

export interface AdvisoryPageRow {
  advisory: SecurityAdvisory;
  repository: RepositoryRef & { id: number; installedVersion: string | null; icon: string | null };
  affects: boolean | null;
  affectedVersions: string[];
  cursor: AdvisoryCursor;
}

export interface AdvisoryOverview {
  total: number;
  affecting: number;
  unknown: number;
  unaffected: number;
  /** Critical advisories affecting an installed version. */
  critical: number;
  /** Repositories with an advisory affecting an installed version. */
  repositories: number;
  /** Advisories affecting an installed version without a released fix. */
  noFix: number;
  sources: AdvisorySource[];
}

/** WHERE conditions (on `repository_advisories a JOIN watched_repositories r`) for a filter. */
function advisoryWhere(filter: AdvisoryFilter): { where: string[]; params: SQLQueryBindings[] } {
  const where: string[] = [];
  const params: SQLQueryBindings[] = [];
  if (filter.impact !== undefined) {
    where.push('a.impact = ?');
    params.push(filter.impact);
  }
  if (filter.severity !== undefined) {
    where.push('a.severity_rank = ?');
    params.push(severityRank(filter.severity));
  }
  if (filter.source !== undefined) {
    where.push('a.source = ?');
    params.push(filter.source);
  }
  const query = filter.query?.trim();
  if (query) {
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const like = (column: string) => `${column} LIKE ? ESCAPE '\\'`;
    where.push(`(${['a.summary', 'a.advisory_id', 'a.cve_id', 'a.aliases', 'r.full_name'].map(like).join(' OR ')})`);
    params.push(pattern, pattern, pattern, pattern, pattern);
  }
  return { where, params };
}

/** Schema migrations, applied in order. Append new entries – never edit existing ones. Exported for migration tests. */
export const MIGRATIONS: readonly string[] = [
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
  // Security advisories (GitHub, OSV.dev) of watched repositories, refreshed with the release checks.
  `ALTER TABLE watched_repositories ADD COLUMN advisories_etag TEXT;
   ALTER TABLE watched_repositories ADD COLUMN advisories_checked_at TEXT;
   ALTER TABLE watched_repositories ADD COLUMN advisories_error TEXT;
   ALTER TABLE watched_repositories ADD COLUMN osv_ecosystem TEXT;
   ALTER TABLE watched_repositories ADD COLUMN osv_package TEXT;
   ALTER TABLE watched_repositories ADD COLUMN advisory_baselines TEXT;

   CREATE TABLE repository_advisories (
     repository_id   INTEGER NOT NULL REFERENCES watched_repositories (id) ON DELETE CASCADE,
     advisory_id     TEXT    NOT NULL,
     source          TEXT    NOT NULL,
     aliases         TEXT    NOT NULL DEFAULT '[]',
     cve_id          TEXT,
     summary         TEXT    NOT NULL,
     severity        TEXT    NOT NULL,
     cvss_score      REAL,
     html_url        TEXT    NOT NULL,
     published_at    TEXT    NOT NULL,
     updated_at      TEXT,
     vulnerabilities TEXT    NOT NULL DEFAULT '[]',
     first_seen_at   TEXT    NOT NULL,
     PRIMARY KEY (repository_id, advisory_id)
   );`,
  // Vulnerabilities page: sort keys stored for keyset pagination. `impact` (2 affects an installed version, 1 unknown,
  // 0 not affected) is computed from the installed versions by `AdvisoryImpacts`; NULL = not computed yet.
  `ALTER TABLE repository_advisories ADD COLUMN severity_rank INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE repository_advisories ADD COLUMN impact INTEGER;
   ALTER TABLE repository_advisories ADD COLUMN affected_versions TEXT NOT NULL DEFAULT '[]';
   UPDATE repository_advisories SET severity_rank = CASE lower(severity)
     WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'moderate' THEN 2 WHEN 'low' THEN 1 ELSE 0 END;
   CREATE INDEX idx_repository_advisories_page
     ON repository_advisories (impact DESC, severity_rank DESC, published_at DESC, repository_id DESC, advisory_id DESC);`,
  // Named SSH keys (private key encrypted) and the machines reached with them: Proxmox nodes and servers. Every
  // target belongs to a host, so `containers` is rebuilt without the global UNIQUE on vmid (two nodes may both have
  // CT 100); the old Proxmox settings are moved into a host at startup (`seedProxmoxHost`). Runs with foreign keys
  // off (see migrate()), so dropping the old table does not cascade into container_apps / container_runs.
  `CREATE TABLE ssh_keys (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     name        TEXT    NOT NULL UNIQUE COLLATE NOCASE,
     private_key TEXT    NOT NULL,
     public_key  TEXT,
     fingerprint TEXT,
     created_at  TEXT    NOT NULL
   );

   CREATE TABLE hosts (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     type       TEXT    NOT NULL,
     name       TEXT    NOT NULL,
     address    TEXT    NOT NULL,
     port       INTEGER NOT NULL DEFAULT 22,
     user       TEXT    NOT NULL DEFAULT 'root',
     ssh_key_id INTEGER REFERENCES ssh_keys (id),
     created_at TEXT    NOT NULL
   );
   CREATE INDEX idx_hosts_ssh_key ON hosts (ssh_key_id) WHERE ssh_key_id IS NOT NULL;

   CREATE TABLE containers_new (
     id                     INTEGER PRIMARY KEY AUTOINCREMENT,
     host_id                INTEGER REFERENCES hosts (id),
     kind                   TEXT    NOT NULL DEFAULT 'lxc',
     vmid                   INTEGER NOT NULL,
     name                   TEXT    NOT NULL,
     is_enabled             INTEGER NOT NULL DEFAULT 1,
     apt_enabled            INTEGER NOT NULL DEFAULT 1,
     check_cron             TEXT,
     status                 TEXT,
     apt_upgradable         TEXT,
     last_checked_at        TEXT,
     last_error             TEXT,
     notified_signature     TEXT,
     created_at             TEXT    NOT NULL,
     backup_before_update   INTEGER,
     start_when_stopped     INTEGER NOT NULL DEFAULT 0,
     update_cores           INTEGER,
     update_memory_mb       INTEGER,
     resources_to_restore   TEXT,
     restart_reasons        TEXT,
     home_assistant         TEXT,
     home_assistant_url     TEXT,
     home_assistant_token   TEXT,
     home_assistant_install INTEGER NOT NULL DEFAULT 0
   );
   INSERT INTO containers_new (
     id, kind, vmid, name, is_enabled, apt_enabled, check_cron, status, apt_upgradable, last_checked_at, last_error,
     notified_signature, created_at, backup_before_update, start_when_stopped, update_cores, update_memory_mb,
     resources_to_restore, restart_reasons, home_assistant, home_assistant_url, home_assistant_token, home_assistant_install)
   SELECT
     id, kind, vmid, name, is_enabled, apt_enabled, check_cron, status, apt_upgradable, last_checked_at, last_error,
     notified_signature, created_at, backup_before_update, start_when_stopped, update_cores, update_memory_mb,
     resources_to_restore, restart_reasons, home_assistant, home_assistant_url, home_assistant_token, home_assistant_install
   FROM containers;
   DROP TABLE containers;
   ALTER TABLE containers_new RENAME TO containers;
   CREATE UNIQUE INDEX idx_containers_host_vmid ON containers (host_id, kind, vmid);
   CREATE INDEX idx_containers_enabled ON containers (is_enabled, vmid);`,
  // Backup storage per Proxmox node (storage IDs differ between nodes); NULL = the global setting.
  `ALTER TABLE hosts ADD COLUMN backup_storage TEXT;`,
  // Password sign-in can be turned off (passkeys only); `--reset-login` brings it back with a new account.
  `ALTER TABLE account ADD COLUMN password_login INTEGER NOT NULL DEFAULT 1;`,
  // Operating system of a target (/etc/os-release, JSON `OsRelease`) read by the last check; NULL = not read yet.
  `ALTER TABLE containers ADD COLUMN os_release TEXT;`,
  // API tokens for dashboards and scripts (`Authorization: Bearer` / `X-API-Key`); only a SHA-256 of the token is stored.
  `CREATE TABLE api_tokens (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     name         TEXT NOT NULL,
     scope        TEXT NOT NULL,
     token_hash   TEXT NOT NULL UNIQUE,
     prefix       TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     expires_at   TEXT,
     last_used_at TEXT,
     last_used_ip TEXT
   );`,
  // Custom icon of a repository: an image URL or a selfh.st/icons shorthand (`sh:<slug>`); NULL = owner avatar.
  `ALTER TABLE watched_repositories ADD COLUMN icon TEXT;`,
  // Docker / Podman: containers listed on targets (detected over SSH, per-target switch) and at Docker endpoints
  // (socket, socket proxy, TCP), the registry digest of every tag they run and digests resolved to version tags.
  // A container is identified by its source and name (IDs change when it is recreated); exactly one source is set.
  `ALTER TABLE containers ADD COLUMN docker_enabled INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE containers ADD COLUMN docker_engine TEXT;
   ALTER TABLE containers ADD COLUMN docker_error TEXT;
   CREATE TABLE docker_endpoints (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     name            TEXT NOT NULL,
     url             TEXT NOT NULL,
     is_enabled      INTEGER NOT NULL DEFAULT 1,
     engine          TEXT,
     last_checked_at TEXT,
     last_error      TEXT,
     created_at      TEXT NOT NULL
   );
   CREATE TABLE docker_containers (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     target_id         INTEGER REFERENCES containers (id) ON DELETE CASCADE,
     endpoint_id       INTEGER REFERENCES docker_endpoints (id) ON DELETE CASCADE,
     name              TEXT NOT NULL,
     container_id      TEXT NOT NULL,
     image             TEXT NOT NULL,
     image_id          TEXT,
     state             TEXT,
     repo_digests      TEXT,
     labels            TEXT,
     present           INTEGER NOT NULL DEFAULT 1,
     ignored           INTEGER NOT NULL DEFAULT 0,
     link_auto         INTEGER NOT NULL DEFAULT 1,
     repository_id     INTEGER REFERENCES watched_repositories (id) ON DELETE SET NULL,
     label_repository  TEXT,
     installed_version TEXT,
     first_seen_at     TEXT NOT NULL,
     last_seen_at      TEXT NOT NULL,
     CHECK ((target_id IS NULL) <> (endpoint_id IS NULL))
   );
   CREATE UNIQUE INDEX idx_docker_containers_source ON docker_containers (IFNULL(target_id, 0), IFNULL(endpoint_id, 0), name);
   CREATE INDEX idx_docker_containers_target ON docker_containers (target_id);
   CREATE INDEX idx_docker_containers_endpoint ON docker_containers (endpoint_id);
   CREATE INDEX idx_docker_containers_repository ON docker_containers (repository_id);
   CREATE INDEX idx_docker_containers_label_repository ON docker_containers (label_repository);
   CREATE TABLE docker_image_tags (
     key           TEXT PRIMARY KEY,
     remote_digest TEXT,
     checked_at    TEXT,
     error         TEXT
   );
   CREATE TABLE docker_digest_versions (
     repository TEXT NOT NULL,
     digest     TEXT NOT NULL,
     version    TEXT,
     checked_at TEXT NOT NULL,
     PRIMARY KEY (repository, digest)
   );`,
  // Newest image of a tag a notification was sent for. Images already known count as notified, so only images pushed
  // from now on are reported.
  `ALTER TABLE docker_image_tags ADD COLUMN notified_digest TEXT;
   UPDATE docker_image_tags SET notified_digest = remote_digest;`,
  // Docker containers are linked through their labels by the lower-case `owner/name` of a repository.
  `CREATE INDEX idx_watched_repositories_full_name ON watched_repositories (lower(owner || '/' || name));`,
  // Sign-in with an OpenID Connect provider: the account is linked to one identity (issuer + subject).
  `ALTER TABLE account ADD COLUMN oidc_issuer TEXT;
   ALTER TABLE account ADD COLUMN oidc_subject TEXT;
   ALTER TABLE account ADD COLUMN oidc_label TEXT;
   ALTER TABLE account ADD COLUMN oidc_linked_at TEXT;`,
  // Package manager of a target found by the last check (apt, dnf, yum, zypper, apk, pacman). Until now only apt was
  // checked, so targets whose apt check worked use apt.
  `ALTER TABLE containers ADD COLUMN package_manager TEXT;
   UPDATE containers SET package_manager = 'apt'
    WHERE apt_enabled = 1 AND last_checked_at IS NOT NULL AND (last_error IS NULL OR last_error NOT LIKE '%apt:%');`,
  // Flatpak / Snap found by the last check with their pending updates (JSON object keyed by store).
  `ALTER TABLE containers ADD COLUMN app_stores TEXT;`,
  // Installed version read from an app on a machine: a container app or a Docker container. The triggers keep the
  // repository's installed version equal to the one the app reports, whichever code path (check, settings, backup
  // import, cascading delete) changes the app. When the app is unlinked, hidden or removed, the repository keeps the last
  // version as entered by hand and says why in `installed_version_error`.
  `ALTER TABLE watched_repositories ADD COLUMN installed_app_id INTEGER REFERENCES container_apps (id) ON DELETE SET NULL;
   ALTER TABLE watched_repositories ADD COLUMN installed_docker_id INTEGER REFERENCES docker_containers (id) ON DELETE SET NULL;
   CREATE INDEX idx_watched_repositories_installed_app ON watched_repositories (installed_app_id) WHERE installed_app_id IS NOT NULL;
   CREATE INDEX idx_watched_repositories_installed_docker ON watched_repositories (installed_docker_id) WHERE installed_docker_id IS NOT NULL;

   CREATE TRIGGER container_app_installed_version AFTER UPDATE OF repository_id, installed_version, checked_at, error ON container_apps
   BEGIN
     UPDATE watched_repositories
        SET installed_app_id = NULL,
            installed_version_error = 'The app on the machine is no longer linked to this repository, so its last version is kept as entered by hand.'
      WHERE installed_app_id = NEW.id AND id IS NOT NEW.repository_id;
     UPDATE watched_repositories
        SET installed_version = coalesce(NEW.installed_version, installed_version),
            installed_version_checked_at = NEW.checked_at,
            installed_version_error = NEW.error
      WHERE installed_app_id = NEW.id;
   END;
   CREATE TRIGGER container_app_installed_version_removed BEFORE DELETE ON container_apps
   BEGIN
     UPDATE watched_repositories
        SET installed_app_id = NULL,
            installed_version_error = 'The app was removed from the machine, so its last version is kept as entered by hand.'
      WHERE installed_app_id = OLD.id;
   END;

   CREATE TRIGGER docker_container_installed_version
   AFTER UPDATE OF installed_version, present, ignored, link_auto, repository_id, label_repository, last_seen_at ON docker_containers
   BEGIN
     UPDATE watched_repositories
        SET installed_docker_id = NULL,
            installed_version_error = 'The Docker container is hidden or no longer linked to this repository, so its last version is kept as entered by hand.'
      WHERE installed_docker_id = NEW.id
        AND (NEW.ignored = 1 OR id IS NOT IIF(NEW.link_auto = 1,
              (SELECT r.id FROM watched_repositories r WHERE lower(r.owner || '/' || r.name) = +NEW.label_repository),
              NEW.repository_id));
     UPDATE watched_repositories
        SET installed_version = coalesce(NEW.installed_version, installed_version),
            installed_version_checked_at = NEW.last_seen_at,
            installed_version_error = IIF(NEW.present = 1, NULL, 'The Docker container was not found by the last check.')
      WHERE installed_docker_id = NEW.id;
   END;
   CREATE TRIGGER docker_container_installed_version_removed BEFORE DELETE ON docker_containers
   BEGIN
     UPDATE watched_repositories
        SET installed_docker_id = NULL,
            installed_version_error = 'The Docker container was removed, so its last version is kept as entered by hand.'
      WHERE installed_docker_id = OLD.id;
   END;

   -- Apps linked before: a repository without a version URL reads its version from the first linked app that reports
   -- one (as when linking from now on) – an application, else a Docker container linked by hand.
   UPDATE watched_repositories
      SET installed_app_id = (SELECT min(a.id) FROM container_apps a
                               WHERE a.repository_id = watched_repositories.id
                                 AND (a.version_command IS NOT NULL OR a.installed_version IS NOT NULL))
    WHERE installed_version_url IS NULL;
   UPDATE watched_repositories
      SET installed_docker_id = (SELECT min(d.id) FROM docker_containers d
                                  WHERE d.link_auto = 0 AND d.repository_id = watched_repositories.id
                                    AND d.present = 1 AND d.ignored = 0 AND d.installed_version IS NOT NULL)
    WHERE installed_version_url IS NULL AND installed_app_id IS NULL;
   UPDATE watched_repositories
      SET installed_version = coalesce(a.installed_version, watched_repositories.installed_version),
          installed_version_checked_at = a.checked_at, installed_version_error = a.error
     FROM container_apps a WHERE a.id = watched_repositories.installed_app_id;
   UPDATE watched_repositories
      SET installed_version = d.installed_version, installed_version_checked_at = d.last_seen_at, installed_version_error = NULL
     FROM docker_containers d WHERE d.id = watched_repositories.installed_docker_id;`,
  // Repositories on Gitea/Forgejo and GitLab instances: `provider` says which API to ask, `host` names the instance
  // (NULL on GitHub). The table is rebuilt because the old UNIQUE (owner, name) cannot hold the host; `full_name` (the
  // lower-case `fullName()`, unique) replaces it and is what Docker labels are matched by. The triggers that read the
  // table are recreated around the rebuild. Runs with foreign keys off (see migrate()), so dropping the old table does
  // not touch the apps, Docker containers and advisories that reference it.
  `DROP TRIGGER container_app_installed_version;
   DROP TRIGGER container_app_installed_version_removed;
   DROP TRIGGER docker_container_installed_version;
   DROP TRIGGER docker_container_installed_version_removed;

   CREATE TABLE watched_repositories_new (
     id                           INTEGER PRIMARY KEY AUTOINCREMENT,
     provider                     TEXT    NOT NULL DEFAULT 'github',
     host                         TEXT    COLLATE NOCASE,
     owner                        TEXT    NOT NULL COLLATE NOCASE,
     name                         TEXT    NOT NULL COLLATE NOCASE,
     include_prereleases          INTEGER NOT NULL DEFAULT 0,
     is_enabled                   INTEGER NOT NULL DEFAULT 1,
     last_seen_tag                TEXT,
     last_seen_published_at       TEXT,
     etag                         TEXT,
     last_checked_at              TEXT,
     last_error                   TEXT,
     created_at                   TEXT    NOT NULL,
     installed_version_url        TEXT,
     installed_version_field      TEXT,
     installed_version            TEXT,
     installed_version_checked_at TEXT,
     installed_version_error      TEXT,
     installed_version_headers    TEXT,
     github_token                 TEXT,
     advisories_etag              TEXT,
     advisories_checked_at        TEXT,
     advisories_error             TEXT,
     osv_ecosystem                TEXT,
     osv_package                  TEXT,
     advisory_baselines           TEXT,
     icon                         TEXT,
     installed_app_id             INTEGER REFERENCES container_apps (id) ON DELETE SET NULL,
     installed_docker_id          INTEGER REFERENCES docker_containers (id) ON DELETE SET NULL,
     full_name                    TEXT    GENERATED ALWAYS AS (lower(coalesce(host || '/', '') || owner || '/' || name)) VIRTUAL,
     CHECK ((provider = 'github') = (host IS NULL))
   );
   INSERT INTO watched_repositories_new (
     id, owner, name, include_prereleases, is_enabled, last_seen_tag, last_seen_published_at, etag, last_checked_at,
     last_error, created_at, installed_version_url, installed_version_field, installed_version,
     installed_version_checked_at, installed_version_error, installed_version_headers, github_token, advisories_etag,
     advisories_checked_at, advisories_error, osv_ecosystem, osv_package, advisory_baselines, icon, installed_app_id,
     installed_docker_id)
   SELECT
     id, owner, name, include_prereleases, is_enabled, last_seen_tag, last_seen_published_at, etag, last_checked_at,
     last_error, created_at, installed_version_url, installed_version_field, installed_version,
     installed_version_checked_at, installed_version_error, installed_version_headers, github_token, advisories_etag,
     advisories_checked_at, advisories_error, osv_ecosystem, osv_package, advisory_baselines, icon, installed_app_id,
     installed_docker_id
   FROM watched_repositories;
   DROP TABLE watched_repositories;
   ALTER TABLE watched_repositories_new RENAME TO watched_repositories;
   CREATE UNIQUE INDEX idx_watched_repositories_full_name ON watched_repositories (full_name);
   CREATE INDEX idx_watched_repositories_enabled ON watched_repositories (is_enabled, id);
   CREATE INDEX idx_watched_repositories_installed_app ON watched_repositories (installed_app_id) WHERE installed_app_id IS NOT NULL;
   CREATE INDEX idx_watched_repositories_installed_docker ON watched_repositories (installed_docker_id) WHERE installed_docker_id IS NOT NULL;

   CREATE TRIGGER container_app_installed_version AFTER UPDATE OF repository_id, installed_version, checked_at, error ON container_apps
   BEGIN
     UPDATE watched_repositories
        SET installed_app_id = NULL,
            installed_version_error = 'The app on the machine is no longer linked to this repository, so its last version is kept as entered by hand.'
      WHERE installed_app_id = NEW.id AND id IS NOT NEW.repository_id;
     UPDATE watched_repositories
        SET installed_version = coalesce(NEW.installed_version, installed_version),
            installed_version_checked_at = NEW.checked_at,
            installed_version_error = NEW.error
      WHERE installed_app_id = NEW.id;
   END;
   CREATE TRIGGER container_app_installed_version_removed BEFORE DELETE ON container_apps
   BEGIN
     UPDATE watched_repositories
        SET installed_app_id = NULL,
            installed_version_error = 'The app was removed from the machine, so its last version is kept as entered by hand.'
      WHERE installed_app_id = OLD.id;
   END;
   CREATE TRIGGER docker_container_installed_version
   AFTER UPDATE OF installed_version, present, ignored, link_auto, repository_id, label_repository, last_seen_at ON docker_containers
   BEGIN
     UPDATE watched_repositories
        SET installed_docker_id = NULL,
            installed_version_error = 'The Docker container is hidden or no longer linked to this repository, so its last version is kept as entered by hand.'
      WHERE installed_docker_id = NEW.id
        AND (NEW.ignored = 1 OR id IS NOT IIF(NEW.link_auto = 1,
              (SELECT r.id FROM watched_repositories r WHERE r.full_name = NEW.label_repository),
              NEW.repository_id));
     UPDATE watched_repositories
        SET installed_version = coalesce(NEW.installed_version, installed_version),
            installed_version_checked_at = NEW.last_seen_at,
            installed_version_error = IIF(NEW.present = 1, NULL, 'The Docker container was not found by the last check.')
      WHERE installed_docker_id = NEW.id;
   END;
   CREATE TRIGGER docker_container_installed_version_removed BEFORE DELETE ON docker_containers
   BEGIN
     UPDATE watched_repositories
        SET installed_docker_id = NULL,
            installed_version_error = 'The Docker container was removed, so its last version is kept as entered by hand.'
      WHERE installed_docker_id = OLD.id;
   END;`,
];

/** ReleaseWatcher's own repository: watched in every new database, so the app announces its own releases. */
export const SELF_REPOSITORY = { owner: 'rozumek29', name: 'releasewatcher' } as const;

/** `PRAGMA auto_vacuum` value of INCREMENTAL. */
const AUTO_VACUUM_INCREMENTAL = 2;
/** Bytes the WAL file keeps on disk after a checkpoint. */
const WAL_SIZE_LIMIT = 512 * 1024;

/** The app a repository's installed version is read from, as shown to the user. */
export interface InstalledVersionAppName extends MachineAppRef {
  name: string;
  /** Name of the machine (target) or Docker connection. */
  machine: string;
}

/** SQL condition: the installed version of the repository row is read from an app on a machine. */
const FROM_MACHINE = '(installed_app_id IS NOT NULL OR installed_docker_id IS NOT NULL)';

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
    // Freed pages (pruned runs, removed repositories) are given back with `PRAGMA incremental_vacuum` instead of
    // keeping the file at its largest size. Takes effect at once for a new file; an existing one is converted by
    // compact() below. Must run before journal_mode = WAL.
    this.db.run('PRAGMA auto_vacuum = INCREMENTAL');
    this.db.run('PRAGMA journal_mode = WAL');
    // The WAL file is reused, not shrunk, after a checkpoint – cap what it keeps on disk.
    this.db.run(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT}`);
    // Safe with WAL (no corruption; at most the last commits are lost on a power cut) and avoids an fsync per write.
    this.db.run('PRAGMA synchronous = NORMAL');
    this.db.run('PRAGMA foreign_keys = ON');
    try {
      this.migrate();
      this.encryptSecrets();
      this.compact();
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
  listStatusFields(): Pick<WatchedRepository, 'id' | 'isEnabled' | 'lastError' | 'lastSeenTag' | 'installedVersion'>[] {
    return this.db
      .query<Pick<Row, 'id' | 'is_enabled' | 'last_error' | 'last_seen_tag' | 'installed_version'>, []>(
        'SELECT id, is_enabled, last_error, last_seen_tag, installed_version FROM watched_repositories',
      )
      .all()
      .map((r) => ({
        id: r.id,
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

  /** Case-insensitive lookup by `fullName()`; `host` null = GitHub. */
  exists(owner: string, name: string, host: string | null = null): boolean {
    const key = fullName({ host, owner, name }).toLowerCase();
    return this.db.query('SELECT 1 FROM watched_repositories WHERE full_name = ?').get(key) !== null;
  }

  /** Adds a repository; `origin` is where it lives (default GitHub). */
  add(
    owner: string,
    name: string,
    includePrereleases: boolean,
    origin: Pick<RepositoryRef, 'provider' | 'host'> = { provider: 'github', host: null },
  ): WatchedRepository {
    const host = origin.provider === 'github' ? null : origin.host;
    if (origin.provider !== 'github' && !host) {
      throw new Error(`A ${origin.provider} repository needs a host.`);
    }
    const row = this.db
      .query<Row, [string, string | null, string, string, number, string]>(
        'INSERT INTO watched_repositories (provider, host, owner, name, include_prereleases, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *',
      )
      .get(origin.provider, host, owner, name, includePrereleases ? 1 : 0, new Date().toISOString())!;
    return toEntity(row, this.secrets);
  }

  /** Persists all mutable fields of the entity. */
  save(repo: WatchedRepository): void {
    this.db
      .query(
        `UPDATE watched_repositories SET
           include_prereleases = ?, is_enabled = ?, last_seen_tag = ?, last_seen_published_at = ?,
           etag = ?, last_checked_at = ?, last_error = ?,
           installed_version_url = ?, installed_version_field = ?, installed_version_headers = ?,
           -- A version read from an app on a machine is kept up to date by triggers: never overwrite it with a copy
           -- that may have been read before the app's last check.
           installed_version = IIF(${FROM_MACHINE}, installed_version, ?),
           installed_version_checked_at = IIF(${FROM_MACHINE}, installed_version_checked_at, ?),
           installed_version_error = IIF(${FROM_MACHINE}, installed_version_error, ?), github_token = ?,
           advisories_etag = ?, advisories_checked_at = ?, advisories_error = ?,
           osv_ecosystem = ?, osv_package = ?, advisory_baselines = ?, icon = ?
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
        repo.advisoriesEtag,
        repo.advisoriesCheckedAt,
        repo.advisoriesError,
        repo.osvEcosystem,
        repo.osvPackage,
        repo.advisoryBaselines.length > 0 ? JSON.stringify(repo.advisoryBaselines) : null,
        repo.icon,
        repo.id,
      );
  }

  /**
   * Reads the installed version of a repository from an app on a machine (null = stop; the last version stays as
   * entered by hand). The version, its check time and error are copied from the app at once; triggers keep them in sync
   * afterwards. The caller links the app to the repository first – an unlinked app is dropped again by the triggers.
   */
  setInstalledVersionApp(repositoryId: number, app: MachineAppRef | null): void {
    if (app === null) {
      this.db
        .query('UPDATE watched_repositories SET installed_app_id = NULL, installed_docker_id = NULL WHERE id = ?')
        .run(repositoryId);
    } else if (app.kind === 'app') {
      this.db
        .query(
          `UPDATE watched_repositories
              SET installed_app_id = a.id, installed_docker_id = NULL,
                  installed_version = coalesce(a.installed_version, watched_repositories.installed_version),
                  installed_version_checked_at = a.checked_at, installed_version_error = a.error
             FROM container_apps a
            WHERE a.id = ?2 AND watched_repositories.id = ?1`,
        )
        .run(repositoryId, app.id);
    } else {
      this.db
        .query(
          `UPDATE watched_repositories
              SET installed_docker_id = d.id, installed_app_id = NULL,
                  installed_version = coalesce(d.installed_version, watched_repositories.installed_version),
                  installed_version_checked_at = d.last_seen_at,
                  installed_version_error = IIF(d.present = 1, NULL, 'The Docker container was not found by the last check.')
             FROM docker_containers d
            WHERE d.id = ?2 AND watched_repositories.id = ?1`,
        )
        .run(repositoryId, app.id);
    }
  }

  /** Names of the apps the installed versions are read from, with their machines, by repository id. */
  installedVersionApps(): Map<number, InstalledVersionAppName> {
    type NameRow = { repository_id: number; kind: 'app' | 'docker'; id: number; name: string; machine: string | null };
    const rows = this.db
      .query<NameRow, []>(
        `SELECT r.id AS repository_id, 'app' AS kind, a.id, a.name, c.name AS machine
           FROM watched_repositories r
           JOIN container_apps a ON a.id = r.installed_app_id
           JOIN containers c ON c.id = a.container_id
         UNION ALL
         SELECT r.id, 'docker', d.id, d.name, coalesce(c.name, e.name)
           FROM watched_repositories r
           JOIN docker_containers d ON d.id = r.installed_docker_id
           LEFT JOIN containers c ON c.id = d.target_id
           LEFT JOIN docker_endpoints e ON e.id = d.endpoint_id`,
      )
      .all();
    return new Map(rows.map((r) => [r.repository_id, { kind: r.kind, id: r.id, name: r.name, machine: r.machine ?? '' }]));
  }

  /**
   * Number of rows changed through this connection so far. Every store shares the connection, so a cached value
   * derived from the database stays valid while this number does not change.
   */
  revision(): number {
    return this.db.query<{ n: number }, []>('SELECT total_changes() AS n').get()!.n;
  }

  /** Stored security advisories of one repository (unsorted). */
  listAdvisories(repositoryId: number): SecurityAdvisory[] {
    return this.db
      .query<AdvisoryRow, [number]>('SELECT * FROM repository_advisories WHERE repository_id = ?')
      .all(repositoryId)
      .map(toAdvisory);
  }

  /** Ids of the stored advisories of a repository. */
  advisoryIds(repositoryId: number): Set<string> {
    const rows = this.db
      .query<Pick<AdvisoryRow, 'advisory_id'>, [number]>('SELECT advisory_id FROM repository_advisories WHERE repository_id = ?')
      .all(repositoryId);
    return new Set(rows.map((r) => r.advisory_id));
  }

  /** Ids and aliases of the stored advisories of a repository (of one source, or all) – for duplicate checks. */
  listAdvisoryKeys(repositoryId: number, source?: AdvisorySource): Pick<SecurityAdvisory, 'id' | 'aliases' | 'cveId'>[] {
    const rows =
      source === undefined
        ? this.db
            .query<Pick<AdvisoryRow, 'advisory_id' | 'aliases' | 'cve_id'>, [number]>(
              'SELECT advisory_id, aliases, cve_id FROM repository_advisories WHERE repository_id = ?',
            )
            .all(repositoryId)
        : this.db
            .query<Pick<AdvisoryRow, 'advisory_id' | 'aliases' | 'cve_id'>, [number, string]>(
              'SELECT advisory_id, aliases, cve_id FROM repository_advisories WHERE repository_id = ? AND source = ?',
            )
            .all(repositoryId, source);
    return rows.map((r) => ({ id: r.advisory_id, aliases: parseStringArray(r.aliases), cveId: r.cve_id }));
  }

  /** Inserts or updates advisories in one transaction (see {@link saveAdvisory}). */
  saveAdvisories(repositoryId: number, advisories: readonly SecurityAdvisory[], now: Date): void {
    if (advisories.length > 0) {
      this.db.transaction(() => {
        for (const advisory of advisories) {
          this.saveAdvisory(repositoryId, advisory, now);
        }
      })();
    }
  }

  /**
   * Inserts or updates one advisory (keeps the date it was first seen). An unchanged advisory is not written again:
   * sources without an ETag (OSV.dev) return the same list on every check.
   */
  saveAdvisory(repositoryId: number, advisory: SecurityAdvisory, now: Date): void {
    this.db
      .query(
        `INSERT INTO repository_advisories
           (repository_id, advisory_id, source, aliases, cve_id, summary, severity, cvss_score, html_url, published_at,
            updated_at, vulnerabilities, first_seen_at, severity_rank)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repository_id, advisory_id) DO UPDATE SET
           source = excluded.source, aliases = excluded.aliases, cve_id = excluded.cve_id, summary = excluded.summary, severity = excluded.severity,
           cvss_score = excluded.cvss_score, html_url = excluded.html_url, published_at = excluded.published_at,
           updated_at = excluded.updated_at, vulnerabilities = excluded.vulnerabilities, severity_rank = excluded.severity_rank,
           -- The impact depends only on the vulnerable ranges: computed again when they change.
           impact = CASE WHEN vulnerabilities IS excluded.vulnerabilities THEN impact END
         WHERE source IS NOT excluded.source OR aliases IS NOT excluded.aliases OR cve_id IS NOT excluded.cve_id
           OR summary IS NOT excluded.summary OR severity IS NOT excluded.severity OR cvss_score IS NOT excluded.cvss_score
           OR html_url IS NOT excluded.html_url OR published_at IS NOT excluded.published_at
           OR updated_at IS NOT excluded.updated_at OR vulnerabilities IS NOT excluded.vulnerabilities`,
      )
      .run(
        repositoryId,
        advisory.id,
        advisory.source,
        JSON.stringify(advisory.aliases),
        advisory.cveId,
        advisory.summary,
        advisory.severity,
        advisory.cvssScore,
        advisory.htmlUrl,
        advisory.publishedAt,
        advisory.updatedAt,
        JSON.stringify(advisory.vulnerabilities),
        now.toISOString(),
        severityRank(advisory.severity),
      );
  }

  /** Advisories whose impact must be computed: not computed yet, or of a repository whose installed versions changed. */
  listAdvisoriesForImpact(
    repositoryIds: readonly number[],
  ): { repositoryId: number; advisoryId: string; vulnerabilities: AdvisoryVulnerability[] }[] {
    return this.db
      .query<Pick<AdvisoryRow, 'repository_id' | 'advisory_id' | 'vulnerabilities'>, [string]>(
        `SELECT repository_id, advisory_id, vulnerabilities FROM repository_advisories
         WHERE impact IS NULL OR repository_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(repositoryIds))
      .map((r) => ({ repositoryId: r.repository_id, advisoryId: r.advisory_id, vulnerabilities: parseVulnerabilities(r.vulnerabilities) }));
  }

  /** Stores computed impacts in one transaction; unchanged rows are not written. */
  saveAdvisoryImpacts(
    impacts: readonly { repositoryId: number; advisoryId: string; impact: number; affectedVersions: readonly string[] }[],
  ): void {
    if (impacts.length === 0) {
      return;
    }
    const update = this.db.query(
      `UPDATE repository_advisories SET impact = ?1, affected_versions = ?2
       WHERE repository_id = ?3 AND advisory_id = ?4 AND (impact IS NOT ?1 OR affected_versions IS NOT ?2)`,
    );
    this.db.transaction(() => {
      for (const i of impacts) {
        update.run(i.impact, JSON.stringify(i.affectedVersions), i.repositoryId, i.advisoryId);
      }
    })();
  }

  /** Advisory summary per repository (all, or one), aggregated by SQLite from the stored impacts. */
  advisorySummaries(repositoryId?: number): Map<number, AdvisorySummary> {
    type SummaryRow = { repository_id: number; total: number; affecting: number; affecting_rank: number | null; top_rank: number | null };
    const select = `SELECT repository_id, count(*) AS total, coalesce(sum(impact = 2), 0) AS affecting,
                           max(CASE WHEN impact = 2 THEN severity_rank END) AS affecting_rank, max(severity_rank) AS top_rank
                    FROM repository_advisories`;
    const rows =
      repositoryId === undefined
        ? this.db.query<SummaryRow, []>(`${select} GROUP BY repository_id`).all()
        : this.db.query<SummaryRow, [number]>(`${select} WHERE repository_id = ? GROUP BY repository_id`).all(repositoryId);
    return new Map(
      rows.map((r) => [
        r.repository_id,
        { total: r.total, affecting: r.affecting, highestSeverity: severityOfRank(r.affecting > 0 ? r.affecting_rank : r.top_rank) },
      ]),
    );
  }

  /** Number of all advisories and of those affecting an installed version (status summary). */
  advisoryTotals(): { total: number; affecting: number } {
    return this.db
      .query<{ total: number; affecting: number }, []>(
        'SELECT count(*) AS total, coalesce(sum(impact = 2), 0) AS affecting FROM repository_advisories',
      )
      .get()!;
  }

  /** Counts for the Vulnerabilities page (over all advisories, independent of filters) and the sources present. */
  advisoryOverview(): AdvisoryOverview {
    const row = this.db
      .query<Omit<AdvisoryOverview, 'sources'>, []>(
        `SELECT count(*) AS total,
                coalesce(sum(impact = 2), 0) AS affecting,
                coalesce(sum(impact IS NULL OR impact = 1), 0) AS unknown,
                coalesce(sum(impact = 0), 0) AS unaffected,
                coalesce(sum(impact = 2 AND severity_rank = 4), 0) AS critical,
                count(DISTINCT CASE WHEN impact = 2 THEN repository_id END) AS repositories,
                coalesce(sum(impact = 2 AND EXISTS (
                  SELECT 1 FROM json_each(vulnerabilities) WHERE coalesce(json_extract(value, '$.patchedVersions'), '') = ''
                )), 0) AS noFix
         FROM repository_advisories`,
      )
      .get()!;
    const sources = this.db
      .query<{ source: string }, []>('SELECT DISTINCT source FROM repository_advisories ORDER BY source')
      .all()
      .map((r): AdvisorySource => (r.source === 'osv' ? 'osv' : 'github'));
    return { ...row, sources };
  }

  /**
   * One page of the advisories of all repositories: affecting an installed version first, then most severe, then
   * newest. Keyset pagination – `after` is the cursor of the last row of the previous page, so rows added or removed
   * meanwhile never shift the following pages. Returns up to `limit` rows and whether more follow.
   */
  pageAdvisories(filter: AdvisoryFilter, after: AdvisoryCursor | null, limit: number): { rows: AdvisoryPageRow[]; hasMore: boolean } {
    const { where, params } = advisoryWhere(filter);
    if (after) {
      where.push('(a.impact, a.severity_rank, a.published_at, a.repository_id, a.advisory_id) < (?, ?, ?, ?, ?)');
      params.push(after.impact, after.severityRank, after.publishedAt, after.repositoryId, after.advisoryId);
    }
    params.push(limit + 1);
    const rows = this.db
      .query<PageRow, SQLQueryBindings[]>(
        `SELECT a.*, r.provider, r.host, r.owner, r.name, r.installed_version, r.icon
         FROM repository_advisories a JOIN watched_repositories r ON r.id = a.repository_id
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY a.impact DESC, a.severity_rank DESC, a.published_at DESC, a.repository_id DESC, a.advisory_id DESC
         LIMIT ?`,
      )
      .all(...params);
    return {
      hasMore: rows.length > limit,
      rows: rows.slice(0, limit).map((r) => ({
        advisory: toAdvisory(r),
        repository: {
          id: r.repository_id,
          provider: toProvider(r.provider, r.host),
          host: r.host,
          owner: r.owner,
          name: r.name,
          installedVersion: r.installed_version,
          icon: r.icon,
        },
        affects: impactOfRank(r.impact ?? 1),
        affectedVersions: parseStringArray(r.affected_versions),
        cursor: {
          impact: r.impact ?? 1,
          severityRank: r.severity_rank,
          publishedAt: r.published_at,
          repositoryId: r.repository_id,
          advisoryId: r.advisory_id,
        },
      })),
    };
  }

  /** Number of advisories matching `filter`. */
  countAdvisories(filter: AdvisoryFilter): number {
    const { where, params } = advisoryWhere(filter);
    return this.db
      .query<{ n: number }, SQLQueryBindings[]>(
        `SELECT count(*) AS n FROM repository_advisories a JOIN watched_repositories r ON r.id = a.repository_id
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`,
      )
      .get(...params)!.n;
  }

  /** Removes advisories of `source` that are no longer published (withdrawn or deleted), or all of it without `keepIds`. */
  removeAdvisoriesExcept(repositoryId: number, source: AdvisorySource, keepIds: readonly string[] = []): void {
    this.db
      .query(
        `DELETE FROM repository_advisories
         WHERE repository_id = ? AND source = ? AND advisory_id NOT IN (SELECT value FROM json_each(?))`,
      )
      .run(repositoryId, source, JSON.stringify(keepIds));
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

  /**
   * Converts a database created without auto_vacuum (one VACUUM rewrites the file; quick for a database of a few MB)
   * and gives back free pages left by earlier deletes.
   */
  private compact(): void {
    const { auto_vacuum: mode } = this.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()!;
    if (mode !== AUTO_VACUUM_INCREMENTAL) {
      this.db.run('VACUUM');
    } else {
      this.db.run('PRAGMA incremental_vacuum');
    }
  }

  private migrate(): void {
    const { user_version: version } = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!;
    this.isNew = version === 0;
    const apply = this.db.transaction((index: number) => {
      this.db.exec(MIGRATIONS[index]!);
      this.db.exec(`PRAGMA user_version = ${index + 1}`);
    });
    if (version >= MIGRATIONS.length) {
      return;
    }
    // Foreign keys are off while migrating (the pragma cannot change inside a transaction): rebuilding a table
    // (create new → copy → drop old → rename) must not cascade deletes into the tables that reference it.
    this.db.run('PRAGMA foreign_keys = OFF');
    try {
      for (let i = version; i < MIGRATIONS.length; i++) {
        apply(i);
      }
      const broken = this.db.query('PRAGMA foreign_key_check').all();
      if (broken.length > 0) {
        throw new Error(`Database migration left ${broken.length} broken foreign key reference(s).`);
      }
    } finally {
      this.db.run('PRAGMA foreign_keys = ON');
    }
  }
}
