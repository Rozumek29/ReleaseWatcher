import type { Database } from 'bun:sqlite';
import type { WatchedRepository } from '../domain.ts';
import type {
  DockerContainer,
  DockerEndpoint,
  DockerSource,
  EngineContainer,
  ImageTagState,
} from './domain.ts';

interface EndpointRow {
  id: number;
  name: string;
  url: string;
  is_enabled: number;
  engine: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface ContainerRow {
  id: number;
  target_id: number | null;
  endpoint_id: number | null;
  name: string;
  container_id: string;
  image: string;
  image_id: string | null;
  state: string | null;
  repo_digests: string | null;
  labels: string | null;
  present: number;
  ignored: number;
  link_auto: number;
  repository_id: number | null;
  label_repository: string | null;
  installed_version: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

interface TagRow {
  key: string;
  remote_digest: string | null;
  checked_at: string | null;
  error: string | null;
  notified_digest: string | null;
}

const toTagState = (r: TagRow): ImageTagState => ({
  key: r.key,
  remoteDigest: r.remote_digest,
  checkedAt: r.checked_at,
  error: r.error,
  notifiedDigest: r.notified_digest,
});

const toEndpoint = (r: EndpointRow): DockerEndpoint => ({
  id: r.id,
  name: r.name,
  url: r.url,
  isEnabled: r.is_enabled === 1,
  engine: r.engine,
  lastCheckedAt: r.last_checked_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});

function parseJson<T>(json: string | null, fallback: T): T {
  if (!json) return fallback;
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

const toContainer = (r: ContainerRow): DockerContainer => ({
  id: r.id,
  source: r.target_id !== null ? { kind: 'target', id: r.target_id } : { kind: 'endpoint', id: r.endpoint_id! },
  name: r.name,
  containerId: r.container_id,
  image: r.image,
  imageId: r.image_id,
  state: r.state,
  repoDigests: parseJson<string[]>(r.repo_digests, []),
  labels: parseJson<Record<string, string>>(r.labels, {}),
  present: r.present === 1,
  ignored: r.ignored === 1,
  linkAuto: r.link_auto === 1,
  repositoryId: r.repository_id,
  labelRepository: r.label_repository,
  installedVersion: r.installed_version,
  firstSeenAt: r.first_seen_at,
  lastSeenAt: r.last_seen_at,
});

const sourceColumns = (source: DockerSource): [number | null, number | null] =>
  source.kind === 'target' ? [source.id, null] : [null, source.id];

/** A watched repository as containers see it. */
export type RepositoryLink = Pick<WatchedRepository, 'id' | 'owner' | 'name' | 'lastSeenTag' | 'icon'>;

/** Fields of a listed container written by {@link DockerStore.replaceListing}. */
export interface ListedContainer extends EngineContainer {
  labelRepository: string | null;
  /** Ignored when first seen (the `releasewatcher.ignore` label). */
  ignoredByLabel: boolean;
}

/** SQLite persistence of Docker endpoints, listed containers and registry data (tables created by `RepositoryStore`). */
export class DockerStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  // --- Endpoints ---

  listEndpoints(): DockerEndpoint[] {
    return this.db.query<EndpointRow, []>('SELECT * FROM docker_endpoints ORDER BY name COLLATE NOCASE, id').all().map(toEndpoint);
  }

  getEndpoint(id: number): DockerEndpoint | null {
    const row = this.db.query<EndpointRow, [number]>('SELECT * FROM docker_endpoints WHERE id = ?').get(id);
    return row ? toEndpoint(row) : null;
  }

  addEndpoint(name: string, url: string): DockerEndpoint {
    const result = this.db
      .query('INSERT INTO docker_endpoints (name, url, created_at) VALUES (?, ?, ?)')
      .run(name, url, new Date().toISOString());
    return this.getEndpoint(Number(result.lastInsertRowid))!;
  }

  saveEndpoint(e: DockerEndpoint): void {
    this.db
      .query('UPDATE docker_endpoints SET name = ?, url = ?, is_enabled = ?, engine = ?, last_checked_at = ?, last_error = ? WHERE id = ?')
      .run(e.name, e.url, e.isEnabled ? 1 : 0, e.engine, e.lastCheckedAt, e.lastError, e.id);
  }

  deleteEndpoint(id: number): boolean {
    return this.db.query('DELETE FROM docker_endpoints WHERE id = ?').run(id).changes > 0;
  }

  // --- Containers ---

  /** Containers of every source (or one source), present and kept ones. */
  listContainers(source?: DockerSource): DockerContainer[] {
    if (!source) {
      return this.db.query<ContainerRow, []>('SELECT * FROM docker_containers ORDER BY name COLLATE NOCASE').all().map(toContainer);
    }
    const column = source.kind === 'target' ? 'target_id' : 'endpoint_id';
    return this.db
      .query<ContainerRow, [number]>(`SELECT * FROM docker_containers WHERE ${column} = ? ORDER BY name COLLATE NOCASE`)
      .all(source.id)
      .map(toContainer);
  }

  getContainer(id: number): DockerContainer | null {
    const row = this.db.query<ContainerRow, [number]>('SELECT * FROM docker_containers WHERE id = ?').get(id);
    return row ? toContainer(row) : null;
  }

  /**
   * Stores the containers a source lists right now (matched by name). Containers no longer listed are removed, except
   * ones the user ignored or linked by hand – they are kept as not present so the choice survives a re-creation.
   */
  replaceListing(source: DockerSource, listed: readonly ListedContainer[], now: Date): void {
    const [targetId, endpointId] = sourceColumns(source);
    const at = now.toISOString();
    const upsert = this.db.query(
      `INSERT INTO docker_containers (target_id, endpoint_id, name, container_id, image, image_id, state, repo_digests, labels,
                                      label_repository, ignored, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (IFNULL(target_id, 0), IFNULL(endpoint_id, 0), name) DO UPDATE SET
         container_id = excluded.container_id, image = excluded.image, image_id = excluded.image_id, state = excluded.state,
         repo_digests = excluded.repo_digests, labels = excluded.labels, label_repository = excluded.label_repository,
         present = 1, last_seen_at = excluded.last_seen_at`,
    );
    const write = this.db.transaction(() => {
      for (const c of listed) {
        upsert.run(
          targetId,
          endpointId,
          c.name,
          c.id,
          c.image,
          c.imageId || null,
          c.state,
          c.repoDigests.length > 0 ? JSON.stringify(c.repoDigests) : null,
          Object.keys(c.labels).length > 0 ? JSON.stringify(c.labels) : null,
          c.labelRepository,
          c.ignoredByLabel ? 1 : 0,
          at,
          at,
        );
      }
      const column = source.kind === 'target' ? 'target_id' : 'endpoint_id';
      const names = JSON.stringify(listed.map((c) => c.name));
      const stale = `${column} = ? AND name NOT IN (SELECT value FROM json_each(?))`;
      this.db.query(`DELETE FROM docker_containers WHERE ${stale} AND ignored = 0 AND link_auto = 1`).run(source.id, names);
      this.db.query(`UPDATE docker_containers SET present = 0 WHERE ${stale}`).run(source.id, names);
    });
    write();
  }

  /** Removes every container of a source (Docker switched off on the target, or nothing found any more). */
  clearSource(source: DockerSource): void {
    const column = source.kind === 'target' ? 'target_id' : 'endpoint_id';
    this.db.query(`DELETE FROM docker_containers WHERE ${column} = ?`).run(source.id);
  }

  /** The user's choices: hide the container, link it through its labels (`linkAuto`) or to `repositoryId` (null = none). */
  saveChoices(c: Pick<DockerContainer, 'id' | 'ignored' | 'linkAuto' | 'repositoryId'>): void {
    this.db
      .query('UPDATE docker_containers SET ignored = ?, link_auto = ?, repository_id = ? WHERE id = ?')
      .run(c.ignored ? 1 : 0, c.linkAuto ? 1 : 0, c.linkAuto ? null : c.repositoryId, c.id);
  }

  /** Stores derived installed versions (read by vulnerability impacts and repository DTOs); skips unchanged rows. */
  saveInstalledVersions(versions: ReadonlyMap<number, string | null>): void {
    const update = this.db.query('UPDATE docker_containers SET installed_version = ? WHERE id = ? AND installed_version IS NOT ?');
    this.db.transaction(() => {
      for (const [id, version] of versions) {
        update.run(version, id, version);
      }
    })();
  }

  /** Installed versions of the shown containers linked to a repository (by hand or through their labels). */
  linkedVersions(repositoryId: number): (string | null)[] {
    return this.db
      .query<{ installed_version: string | null }, [number]>(
        `SELECT d.installed_version FROM docker_containers d
          WHERE d.present = 1 AND d.ignored = 0 AND (
            (d.link_auto = 0 AND d.repository_id = ?1) OR
            (d.link_auto = 1 AND d.label_repository = (SELECT lower(owner || '/' || name) FROM watched_repositories WHERE id = ?1)))`,
      )
      .all(repositoryId)
      .map((r) => r.installed_version);
  }

  /** Installed version of every shown container linked to a repository (by hand or through its labels). */
  listLinkedVersions(): { repositoryId: number; installedVersion: string | null }[] {
    return this.db
      .query<{ repository_id: number; installed_version: string | null }, []>(
        `SELECT IIF(d.link_auto = 1, r.id, d.repository_id) AS repository_id, d.installed_version
           FROM docker_containers d
           LEFT JOIN watched_repositories r ON d.link_auto = 1 AND lower(r.owner || '/' || r.name) = d.label_repository
          WHERE d.present = 1 AND d.ignored = 0 AND IIF(d.link_auto = 1, r.id, d.repository_id) IS NOT NULL`,
      )
      .all()
      .map((r) => ({ repositoryId: r.repository_id, installedVersion: r.installed_version }));
  }

  /** Watched repositories with only the fields containers are matched and compared with (no secrets decrypted). */
  listRepositoryLinks(): RepositoryLink[] {
    return this.db
      .query<{ id: number; owner: string; name: string; last_seen_tag: string | null; icon: string | null }, []>(
        'SELECT id, owner, name, last_seen_tag, icon FROM watched_repositories',
      )
      .all()
      .map((r) => ({ id: r.id, owner: r.owner, name: r.name, lastSeenTag: r.last_seen_tag, icon: r.icon }));
  }

  // --- Registry data ---

  listTagStates(): Map<string, ImageTagState> {
    const rows = this.db.query<TagRow, []>('SELECT * FROM docker_image_tags').all();
    return new Map(rows.map((r) => [r.key, toTagState(r)]));
  }

  getTagState(key: string): ImageTagState | null {
    const r = this.db.query<TagRow, [string]>('SELECT * FROM docker_image_tags WHERE key = ?').get(key);
    return r ? toTagState(r) : null;
  }

  /** Records a registry check of a tag; an error keeps the digest of the last successful check. */
  saveTagState(key: string, result: { remoteDigest: string } | { error: string }, now: Date): void {
    if ('remoteDigest' in result) {
      this.db
        .query(
          `INSERT INTO docker_image_tags (key, remote_digest, checked_at, error) VALUES (?, ?, ?, NULL)
           ON CONFLICT (key) DO UPDATE SET remote_digest = excluded.remote_digest, checked_at = excluded.checked_at, error = NULL`,
        )
        .run(key, result.remoteDigest, now.toISOString());
    } else {
      this.db
        .query(
          `INSERT INTO docker_image_tags (key, checked_at, error) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET checked_at = excluded.checked_at, error = excluded.error`,
        )
        .run(key, now.toISOString(), result.error.slice(0, 500));
    }
  }

  /** Records that the image `digest` of a tag was reported (or found while notifications were off). */
  markTagNotified(key: string, digest: string): void {
    this.db.query('UPDATE docker_image_tags SET notified_digest = ? WHERE key = ?').run(digest, key);
  }

  /** Removes registry data no stored container uses any more (`keys` = tag keys still in use). */
  pruneTagStates(keys: readonly string[]): void {
    this.db.query('DELETE FROM docker_image_tags WHERE key NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(keys));
  }

  /** Version tags resolved for digests of an image repository; `version` null = searched and none found. */
  digestVersions(repository: string): Map<string, { version: string | null; checkedAt: string }> {
    const rows = this.db
      .query<{ digest: string; version: string | null; checked_at: string }, [string]>(
        'SELECT digest, version, checked_at FROM docker_digest_versions WHERE repository = ?',
      )
      .all(repository);
    return new Map(rows.map((r) => [r.digest, { version: r.version, checkedAt: r.checked_at }]));
  }

  /** Every resolved digest → version (all repositories), keyed `repository@digest`. */
  allDigestVersions(): Map<string, string | null> {
    const rows = this.db
      .query<{ repository: string; digest: string; version: string | null }, []>('SELECT repository, digest, version FROM docker_digest_versions')
      .all();
    return new Map(rows.map((r) => [`${r.repository}@${r.digest}`, r.version]));
  }

  saveDigestVersion(repository: string, digest: string, version: string | null, now: Date): void {
    this.db
      .query(
        `INSERT INTO docker_digest_versions (repository, digest, version, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (repository, digest) DO UPDATE SET version = excluded.version, checked_at = excluded.checked_at`,
      )
      .run(repository, digest, version, now.toISOString());
  }

  /** Forgets resolved digests no stored container (or registry tag) refers to any more. */
  pruneDigestVersions(keep: readonly string[]): void {
    this.db
      .query("DELETE FROM docker_digest_versions WHERE repository || '@' || digest NOT IN (SELECT value FROM json_each(?))")
      .run(JSON.stringify(keep));
  }
}
