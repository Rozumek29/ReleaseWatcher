import type { Database } from 'bun:sqlite';
import type { SecretBox } from '../secret-box.ts';
import type { GitHostProvider, GitHostToken } from './domain.ts';

interface Row {
  id: number;
  provider: string;
  host: string;
  token: string;
  created_at: string;
  updated_at: string;
  repository_count: number;
}

const SELECT = `SELECT t.*,
                       (SELECT count(*) FROM watched_repositories r
                         WHERE r.provider = t.provider AND r.host = t.host AND r.access_token IS NULL) AS repository_count
                FROM git_host_tokens t`;

/** SQLite persistence of the access tokens of Gitea/Forgejo and GitLab instances (encrypted; table from `RepositoryStore`). */
export class GitHostTokenStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;

  constructor(db: Database, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  list(): GitHostToken[] {
    return this.db.query<Row, []>(`${SELECT} ORDER BY t.host, t.provider`).all().map(this.toEntity);
  }

  get(id: number): GitHostToken | null {
    const r = this.db.query<Row, [number]>(`${SELECT} WHERE t.id = ?`).get(id);
    return r ? this.toEntity(r) : null;
  }

  /** The decrypted token of a host, or null when none is saved for it. */
  tokenFor(provider: GitHostProvider, host: string): string | null {
    const r = this.db
      .query<Pick<Row, 'token'>, [string, string]>('SELECT token FROM git_host_tokens WHERE provider = ? AND host = ?')
      .get(provider, host.toLowerCase());
    return r ? this.secrets.decrypt(r.token) : null;
  }

  /** Id of the token saved for a host, or null. */
  idOf(provider: GitHostProvider, host: string): number | null {
    return (
      this.db
        .query<{ id: number }, [string, string]>('SELECT id FROM git_host_tokens WHERE provider = ? AND host = ?')
        .get(provider, host.toLowerCase())?.id ?? null
    );
  }

  add(provider: GitHostProvider, host: string, token: string): GitHostToken {
    const now = new Date().toISOString();
    const result = this.db
      .query('INSERT INTO git_host_tokens (provider, host, token, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(provider, host.toLowerCase(), this.secrets.encrypt(token), now, now);
    return this.get(Number(result.lastInsertRowid))!;
  }

  /** Changes the host, provider or token (null = keep the token). */
  update(id: number, provider: GitHostProvider, host: string, token: string | null): GitHostToken | null {
    const now = new Date().toISOString();
    if (token === null) {
      this.db
        .query('UPDATE git_host_tokens SET provider = ?, host = ?, updated_at = ? WHERE id = ?')
        .run(provider, host.toLowerCase(), now, id);
    } else {
      this.db
        .query('UPDATE git_host_tokens SET provider = ?, host = ?, token = ?, updated_at = ? WHERE id = ?')
        .run(provider, host.toLowerCase(), this.secrets.encrypt(token), now, id);
    }
    return this.get(id);
  }

  delete(id: number): boolean {
    return this.db.query('DELETE FROM git_host_tokens WHERE id = ?').run(id).changes > 0;
  }

  private readonly toEntity = (r: Row): GitHostToken => ({
    id: r.id,
    provider: r.provider as GitHostProvider,
    host: r.host,
    token: this.secrets.decrypt(r.token),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    repositoryCount: r.repository_count,
  });
}
