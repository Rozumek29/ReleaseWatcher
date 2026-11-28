import type { Database } from 'bun:sqlite';
import type { SecretBox } from '../secret-box.ts';
import type { HomeAssistantComponent, HomeAssistantConnection, ReadComponent } from './domain.ts';

interface ConnectionRow {
  id: number;
  name: string;
  url: string;
  token: string;
  is_enabled: number;
  install_enabled: number;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface ComponentRow {
  id: number;
  connection_id: number;
  entity_id: string;
  name: string;
  has_update: number;
  installed_version: string | null;
  latest_version: string | null;
  release_url: string | null;
  repository: string;
  supports_backup: number;
  install_error: string | null;
  last_seen_at: string | null;
  repository_id: number | null;
}

/** Components with the id of the watched repository they name (`full_name` has a unique index). */
const SELECT_COMPONENTS = `SELECT c.*, r.id AS repository_id
                             FROM home_assistant_components c
                             LEFT JOIN watched_repositories r ON r.full_name = c.repository`;

const toComponent = (r: ComponentRow): HomeAssistantComponent => ({
  id: r.id,
  connectionId: r.connection_id,
  entityId: r.entity_id,
  name: r.name,
  hasUpdate: r.has_update === 1,
  installedVersion: r.installed_version,
  latestVersion: r.latest_version,
  releaseUrl: r.release_url,
  repository: r.repository,
  supportsBackup: r.supports_backup === 1,
  installError: r.install_error,
  lastSeenAt: r.last_seen_at,
  repositoryId: r.repository_id,
});

/** SQLite persistence of Home Assistant connections (token encrypted) and their components (tables from `RepositoryStore`). */
export class HomeAssistantStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;

  constructor(db: Database, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  // --- Connections ---

  listConnections(): HomeAssistantConnection[] {
    return this.db.query<ConnectionRow, []>('SELECT * FROM home_assistant_connections ORDER BY name COLLATE NOCASE, id').all().map(this.toConnection);
  }

  getConnection(id: number): HomeAssistantConnection | null {
    const row = this.db.query<ConnectionRow, [number]>('SELECT * FROM home_assistant_connections WHERE id = ?').get(id);
    return row ? this.toConnection(row) : null;
  }

  addConnection(name: string, url: string, token: string): HomeAssistantConnection {
    return this.toConnection(
      this.db
        .query<ConnectionRow, [string, string, string, string]>(
          'INSERT INTO home_assistant_connections (name, url, token, created_at) VALUES (?, ?, ?, ?) RETURNING *',
        )
        .get(name, url, this.secrets.encrypt(token), new Date().toISOString())!,
    );
  }

  saveConnection(c: HomeAssistantConnection): void {
    this.db
      .query(
        'UPDATE home_assistant_connections SET name = ?, url = ?, token = ?, is_enabled = ?, install_enabled = ?, last_checked_at = ?, last_error = ? WHERE id = ?',
      )
      .run(c.name, c.url, this.secrets.encrypt(c.token), c.isEnabled ? 1 : 0, c.installEnabled ? 1 : 0, c.lastCheckedAt, c.lastError, c.id);
  }

  deleteConnection(id: number): boolean {
    return this.db.query('DELETE FROM home_assistant_connections WHERE id = ?').run(id).changes > 0;
  }

  // --- Components ---

  /** Components of every connection (or one), by name. */
  listComponents(connectionId?: number): HomeAssistantComponent[] {
    const rows =
      connectionId === undefined
        ? this.db.query<ComponentRow, []>(`${SELECT_COMPONENTS} ORDER BY c.name COLLATE NOCASE, c.id`).all()
        : this.db
            .query<ComponentRow, [number]>(`${SELECT_COMPONENTS} WHERE c.connection_id = ? ORDER BY c.name COLLATE NOCASE, c.id`)
            .all(connectionId);
    return rows.map(toComponent);
  }

  getComponent(id: number): HomeAssistantComponent | null {
    const row = this.db.query<ComponentRow, [number]>(`${SELECT_COMPONENTS} WHERE c.id = ?`).get(id);
    return row ? toComponent(row) : null;
  }

  /** Components that name a watched repository (all, or those of one repository). */
  listLinked(repositoryId?: number): HomeAssistantComponent[] {
    const rows =
      repositoryId === undefined
        ? this.db.query<ComponentRow, []>(`${SELECT_COMPONENTS} WHERE r.id IS NOT NULL ORDER BY c.id`).all()
        : this.db.query<ComponentRow, [number]>(`${SELECT_COMPONENTS} WHERE r.id = ? ORDER BY c.id`).all(repositoryId);
    return rows.map(toComponent);
  }

  /**
   * Stores what a connection's update entities say now: known entities are updated in place (they keep their id), new
   * ones are added and those Home Assistant no longer has are removed.
   */
  replaceComponents(connectionId: number, components: readonly ReadComponent[], now: Date): void {
    const upsert = this.db.query(
      `INSERT INTO home_assistant_components (connection_id, entity_id, name, has_update, installed_version, latest_version, release_url,
                                              repository, supports_backup, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, entity_id) DO UPDATE SET
         name = excluded.name, has_update = excluded.has_update, installed_version = excluded.installed_version,
         latest_version = excluded.latest_version, release_url = excluded.release_url, repository = excluded.repository,
         supports_backup = excluded.supports_backup, last_seen_at = excluded.last_seen_at`,
    );
    const seenAt = now.toISOString();
    const remove = this.db.query('DELETE FROM home_assistant_components WHERE id = ?');
    this.db.transaction(() => {
      const seen = new Set(components.map((c) => c.entityId));
      for (const existing of this.listComponents(connectionId)) {
        if (!seen.has(existing.entityId)) remove.run(existing.id);
      }
      for (const c of components) {
        upsert.run(
          connectionId, c.entityId, c.name, c.hasUpdate ? 1 : 0, c.installedVersion, c.latestVersion, c.releaseUrl, c.repository,
          c.supportsBackup ? 1 : 0, seenAt,
        );
      }
    })();
  }

  /** Remembers why the last installation of a component failed (null = it worked). */
  setInstallError(componentId: number, error: string | null): void {
    this.db.query('UPDATE home_assistant_components SET install_error = ? WHERE id = ?').run(error, componentId);
  }

  clearComponents(connectionId: number): void {
    this.db.query('DELETE FROM home_assistant_components WHERE connection_id = ?').run(connectionId);
  }

  private readonly toConnection = (r: ConnectionRow): HomeAssistantConnection => ({
    id: r.id,
    name: r.name,
    url: r.url,
    token: this.secrets.decrypt(r.token),
    isEnabled: r.is_enabled === 1,
    installEnabled: r.install_enabled === 1,
    lastCheckedAt: r.last_checked_at,
    lastError: r.last_error,
    createdAt: r.created_at,
  });
}
