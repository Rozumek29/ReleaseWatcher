import type { Database } from 'bun:sqlite';

/** The single admin account. */
export interface Account {
  username: string;
  passwordHash: string;
  /** Random WebAuthn user handle (base64url) – stable for the lifetime of the account. */
  webauthnUserId: string;
  createdAt: string;
  passwordChangedAt: string;
  /** False = passkeys only: the password no longer signs in (it still confirms account changes). */
  passwordLogin: boolean;
}

export interface Passkey {
  /** Credential ID (base64url). */
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export type LoginMethod = 'password' | 'passkey' | 'setup';

export interface Session {
  /** SHA-256 of the session token (the token itself is only in the browser's cookie). */
  id: string;
  method: LoginMethod;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** What an API token may do: `read` = GET/HEAD only, `full` = every method (never the account routes). */
export type ApiTokenScope = 'read' | 'full';

export interface ApiToken {
  id: number;
  name: string;
  scope: ApiTokenScope;
  /** Beginning of the token (e.g. `rw_AbCd1234`) so it can be recognised; the rest is never stored. */
  prefix: string;
  createdAt: string;
  /** null = never expires. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

interface ApiTokenRow {
  id: number;
  name: string;
  scope: string;
  prefix: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  last_used_ip: string | null;
}

const toApiToken = (r: ApiTokenRow): ApiToken => ({
  id: r.id,
  name: r.name,
  scope: r.scope === 'full' ? 'full' : 'read',
  prefix: r.prefix,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  lastUsedIp: r.last_used_ip,
});

const API_TOKEN_COLUMNS = 'id, name, scope, prefix, created_at, expires_at, last_used_at, last_used_ip';

interface AccountRow {
  username: string;
  password_hash: string;
  webauthn_user_id: string;
  created_at: string;
  password_changed_at: string;
  password_login: number;
}

interface PasskeyRow {
  id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  device_type: string | null;
  backed_up: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

interface SessionRow {
  id: string;
  method: string;
  user_agent: string | null;
  ip: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
}

const toPasskey = (r: PasskeyRow): Passkey => ({
  id: r.id,
  publicKey: new Uint8Array(r.public_key),
  counter: r.counter,
  transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
  deviceType: r.device_type,
  backedUp: r.backed_up === 1,
  name: r.name,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

const toSession = (r: SessionRow): Session => ({
  id: r.id,
  method: r.method as LoginMethod,
  userAgent: r.user_agent,
  ip: r.ip,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
  expiresAt: r.expires_at,
});

/** Persistence of the account, its passkeys and sessions (tables created by `RepositoryStore`). */
export class AuthStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getAccount(): Account | null {
    const r = this.db.query<AccountRow, []>('SELECT * FROM account WHERE id = 1').get();
    return r
      ? {
          username: r.username,
          passwordHash: r.password_hash,
          webauthnUserId: r.webauthn_user_id,
          createdAt: r.created_at,
          passwordChangedAt: r.password_changed_at,
          passwordLogin: r.password_login === 1,
        }
      : null;
  }

  createAccount(username: string, passwordHash: string, webauthnUserId: string): void {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO account (id, username, password_hash, webauthn_user_id, created_at, password_changed_at)
         VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(username, passwordHash, webauthnUserId, now, now);
  }

  updateUsername(username: string): void {
    this.db.query('UPDATE account SET username = ? WHERE id = 1').run(username);
  }

  updatePassword(passwordHash: string): void {
    this.db
      .query('UPDATE account SET password_hash = ?, password_changed_at = ? WHERE id = 1')
      .run(passwordHash, new Date().toISOString());
  }

  setPasswordLogin(enabled: boolean): void {
    this.db.query('UPDATE account SET password_login = ? WHERE id = 1').run(enabled ? 1 : 0);
  }

  /** Removes the account with all passkeys, sessions and API tokens (`--reset-login`). */
  resetAll(): void {
    this.db.transaction(() => {
      this.db.run('DELETE FROM api_tokens');
      this.db.run('DELETE FROM sessions');
      this.db.run('DELETE FROM passkeys');
      this.db.run('DELETE FROM account');
    })();
  }

  listPasskeys(): Passkey[] {
    return this.db.query<PasskeyRow, []>('SELECT * FROM passkeys ORDER BY created_at').all().map(toPasskey);
  }

  getPasskey(id: string): Passkey | null {
    const r = this.db.query<PasskeyRow, [string]>('SELECT * FROM passkeys WHERE id = ?').get(id);
    return r ? toPasskey(r) : null;
  }

  addPasskey(p: Omit<Passkey, 'createdAt' | 'lastUsedAt'>): void {
    this.db
      .query(
        `INSERT INTO passkeys (id, public_key, counter, transports, device_type, backed_up, name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id,
        p.publicKey,
        p.counter,
        JSON.stringify(p.transports),
        p.deviceType,
        p.backedUp ? 1 : 0,
        p.name,
        new Date().toISOString(),
      );
  }

  markPasskeyUsed(id: string, counter: number): void {
    this.db
      .query('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?')
      .run(counter, new Date().toISOString(), id);
  }

  renamePasskey(id: string, name: string): boolean {
    return this.db.query('UPDATE passkeys SET name = ? WHERE id = ?').run(name, id).changes > 0;
  }

  deletePasskey(id: string): boolean {
    return this.db.query('DELETE FROM passkeys WHERE id = ?').run(id).changes > 0;
  }

  createSession(s: Session): void {
    this.db
      .query(
        `INSERT INTO sessions (id, method, user_agent, ip, created_at, last_seen_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.id, s.method, s.userAgent, s.ip, s.createdAt, s.lastSeenAt, s.expiresAt);
  }

  getSession(id: string): Session | null {
    const r = this.db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(id);
    return r ? toSession(r) : null;
  }

  touchSession(id: string, lastSeenAt: string, expiresAt: string): void {
    this.db.query('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(lastSeenAt, expiresAt, id);
  }

  listSessions(): Session[] {
    return this.db.query<SessionRow, []>('SELECT * FROM sessions ORDER BY last_seen_at DESC').all().map(toSession);
  }

  deleteSession(id: string): boolean {
    return this.db.query('DELETE FROM sessions WHERE id = ?').run(id).changes > 0;
  }

  /** Deletes every session except `keepId` (null = all). */
  deleteOtherSessions(keepId: string | null): number {
    return this.db.query('DELETE FROM sessions WHERE id IS NOT ?').run(keepId).changes;
  }

  /** Deletes every session not signed in with a passkey, except `keepId`. */
  deleteOtherNonPasskeySessions(keepId: string): number {
    return this.db.query("DELETE FROM sessions WHERE id IS NOT ? AND method <> 'passkey'").run(keepId).changes;
  }

  deleteExpiredSessions(now: string): number {
    return this.db.query('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes;
  }

  listApiTokens(): ApiToken[] {
    return this.db
      .query<ApiTokenRow, []>(`SELECT ${API_TOKEN_COLUMNS} FROM api_tokens ORDER BY created_at DESC, id DESC`)
      .all()
      .map(toApiToken);
  }

  getApiTokenByHash(tokenHash: string): ApiToken | null {
    const r = this.db
      .query<ApiTokenRow, [string]>(`SELECT ${API_TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?`)
      .get(tokenHash);
    return r ? toApiToken(r) : null;
  }

  createApiToken(t: { name: string; scope: ApiTokenScope; tokenHash: string; prefix: string; createdAt: string; expiresAt: string | null }): ApiToken {
    const { lastInsertRowid } = this.db
      .query('INSERT INTO api_tokens (name, scope, token_hash, prefix, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(t.name, t.scope, t.tokenHash, t.prefix, t.createdAt, t.expiresAt);
    return toApiToken(
      this.db.query<ApiTokenRow, [number]>(`SELECT ${API_TOKEN_COLUMNS} FROM api_tokens WHERE id = ?`).get(Number(lastInsertRowid))!,
    );
  }

  markApiTokenUsed(id: number, at: string, ip: string | null): void {
    this.db.query('UPDATE api_tokens SET last_used_at = ?, last_used_ip = ? WHERE id = ?').run(at, ip, id);
  }

  deleteApiToken(id: number): boolean {
    return this.db.query('DELETE FROM api_tokens WHERE id = ?').run(id).changes > 0;
  }
}
