import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Logger } from '../log.ts';
import type { ApiToken, ApiTokenScope, AuthStore, LoginMethod, Passkey, Session } from './store.ts';

export const SESSION_COOKIE = 'rw_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
/** Sliding expiry is written at most this often per session. */
const SESSION_TOUCH_MS = 60 * 60_000;
const CHALLENGE_TTL_MS = 5 * 60_000;
/** API tokens start with this, so they are easy to recognise (and to find with secret scanners). */
export const API_TOKEN_PREFIX = 'rw_';
export const MAX_API_TOKEN_DAYS = 3650;
/** The last use of an API token is written at most this often. */
const API_TOKEN_TOUCH_MS = 60_000;
const MAX_PENDING_CHALLENGES = 1000;

export const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 256;
const USERNAME_PATTERN = /^[A-Za-z0-9._@-]{1,64}$/;

/** An authentication failure with the HTTP status and (optionally) the form field it belongs to. */
export class AuthError extends Error {
  override name = 'AuthError';
  readonly status: number;
  readonly field: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(status: number, message: string, field: string | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.status = status;
    this.field = field;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Where the request came from – used for sessions and for WebAuthn's origin/RP ID checks. */
export interface RequestContext {
  /** Client address: the socket address, or the first X-Forwarded-For entry when the proxy is trusted. */
  ip: string | null;
  userAgent: string | null;
  /** e.g. https://watcher.example.com */
  origin: string;
  /** Host name without port (WebAuthn relying party ID). */
  rpID: string;
}

export interface AuthState {
  /** No account yet – the setup screen (with the setup code) creates it. */
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
  hasPasskeys: boolean;
  /** False when only passkeys sign in (the login screen then starts the passkey prompt right away). */
  passwordLogin: boolean;
}

/** Blocks a client after repeated failed logins (exponential lock, per key – usually the IP address). */
class LoginThrottle {
  private readonly entries = new Map<string, { failures: number; lockedUntil: number; lastFailure: number }>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  /** Seconds until the next attempt is allowed (0 = allowed). */
  retryAfter(key: string): number {
    const entry = this.entries.get(key);
    return entry && entry.lockedUntil > this.now() ? Math.ceil((entry.lockedUntil - this.now()) / 1000) : 0;
  }

  fail(key: string): void {
    const now = this.now();
    const entry = this.entries.get(key);
    // Failures older than 15 minutes are forgotten.
    const failures = entry && now - entry.lastFailure < 15 * 60_000 ? entry.failures + 1 : 1;
    const lockMs = failures < 5 ? 0 : Math.min(15 * 60_000, 30_000 * 2 ** (failures - 5));
    this.entries.set(key, { failures, lastFailure: now, lockedUntil: now + lockMs });
    if (this.entries.size > 10_000) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

/** Setup code alphabet without look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

function newSetupCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]!);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

function equalStrings(a: string, b: string): boolean {
  const left = Buffer.from(sha256(a));
  const right = Buffer.from(sha256(b));
  return timingSafeEqual(left, right);
}

function validateUsername(username: string): string {
  const value = username.trim();
  if (!USERNAME_PATTERN.test(value)) {
    throw new AuthError(400, 'Use 1–64 letters, digits or . _ @ -', 'username');
  }
  return value;
}

function validatePassword(password: string, field = 'password'): string {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new AuthError(400, `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`, field);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new AuthError(400, `The password can have at most ${MAX_PASSWORD_LENGTH} characters.`, field);
  }
  return password;
}

export interface AuthServiceOptions {
  /** Directory where the setup code file is written (null = only logged, e.g. in-memory tests). */
  dataDir: string | null;
  log: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

/** Single-account login: password + passkeys, sessions in the database, first-run setup with a one-time code. */
export class AuthService {
  private readonly store: AuthStore;
  private readonly options: AuthServiceOptions;
  private readonly now: () => Date;
  private readonly throttle: LoginThrottle;
  private setupCode: string | null = null;
  /** Pending passkey registrations per session ID. */
  private readonly registrations = new Map<string, { challenge: string; expires: number }>();
  /** Pending passkey logins per challenge ID (no session yet). */
  private readonly logins = new Map<string, { challenge: string; expires: number }>();

  constructor(store: AuthStore, options: AuthServiceOptions) {
    this.store = store;
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.throttle = new LoginThrottle(() => this.now().getTime());
  }

  get accountExists(): boolean {
    return this.store.getAccount() !== null;
  }

  /** Passkeys only: user verification (PIN, biometrics) is required, so a passkey is never a single factor. */
  private get passkeysOnly(): boolean {
    return this.store.getAccount()?.passwordLogin === false;
  }

  /**
   * Creates the account from configured credentials when none exists (migration from the former
   * BASIC_AUTH_USERNAME / BASIC_AUTH_PASSWORD). Returns true when an account was created.
   */
  async bootstrap(credentials: { username: string; password: string } | null): Promise<boolean> {
    if (!credentials || this.accountExists) {
      return false;
    }
    const username = validateUsername(credentials.username);
    this.store.createAccount(username, await Bun.password.hash(credentials.password), randomToken());
    this.clearSetupCode();
    this.options.log.info({ username }, 'Account created from BASIC_AUTH_USERNAME / BASIC_AUTH_PASSWORD');
    return true;
  }

  /** Makes sure a setup code exists while there is no account; logs it and writes it to `<data dir>/setup-code`. */
  ensureSetupCode(): string | null {
    if (this.accountExists) {
      this.clearSetupCode();
      return null;
    }
    if (!this.setupCode) {
      this.setupCode = newSetupCode();
      this.options.log.warn(
        { setupCode: this.setupCode },
        'No account yet – open the UI and create it with this setup code',
      );
      if (this.options.dataDir) {
        try {
          writeFileSync(join(this.options.dataDir, 'setup-code'), `${this.setupCode}\n`, { mode: 0o600 });
        } catch (error) {
          this.options.log.warn({ err: error }, 'Could not write the setup-code file');
        }
      }
    }
    return this.setupCode;
  }

  private clearSetupCode(): void {
    this.setupCode = null;
    if (this.options.dataDir) {
      rmSync(join(this.options.dataDir, 'setup-code'), { force: true });
    }
  }

  state(session: Session | null): AuthState {
    const account = this.store.getAccount();
    if (!account) {
      this.ensureSetupCode();
    }
    return {
      setupRequired: account === null,
      authenticated: account !== null && session !== null,
      username: session && account ? account.username : null,
      hasPasskeys: account !== null && this.store.listPasskeys().length > 0,
      passwordLogin: account?.passwordLogin ?? true,
    };
  }

  /** First run: creates the account (requires the setup code) and signs in. Returns the session token. */
  async setup(code: string, username: string, password: string, ctx: RequestContext): Promise<string> {
    if (this.accountExists) {
      throw new AuthError(409, 'The account already exists – sign in instead.');
    }
    this.checkThrottle(ctx);
    const expected = this.ensureSetupCode();
    if (!expected || !equalStrings(normalizeCode(code), normalizeCode(expected))) {
      this.throttle.fail(this.throttleKey(ctx));
      throw new AuthError(401, 'Wrong setup code – see the server log or the setup-code file.', 'code');
    }
    const name = validateUsername(username);
    validatePassword(password);
    this.store.createAccount(name, await Bun.password.hash(password), randomToken());
    this.clearSetupCode();
    this.throttle.succeed(this.throttleKey(ctx));
    this.options.log.info({ username: name }, 'Account created');
    return this.createSession('setup', ctx);
  }

  async loginWithPassword(username: string, password: string, ctx: RequestContext): Promise<string> {
    this.checkThrottle(ctx);
    const account = this.store.getAccount();
    if (account && !account.passwordLogin) {
      throw new AuthError(409, 'Password sign-in is turned off – sign in with a passkey.');
    }
    // Always verify a hash, so response times don't reveal whether the user name exists.
    const hash = account?.passwordHash ?? (await this.dummyHash());
    const passwordOk = await Bun.password.verify(password, hash);
    if (!account || !passwordOk || !equalStrings(username.trim().toLowerCase(), account.username.toLowerCase())) {
      this.throttle.fail(this.throttleKey(ctx));
      this.options.log.warn({ ip: ctx.ip }, 'Failed login');
      throw new AuthError(401, 'Wrong user name or password.');
    }
    this.throttle.succeed(this.throttleKey(ctx));
    return this.createSession('password', ctx);
  }

  /** Returns the valid session for a cookie token (and extends it), or null. */
  sessionFromToken(token: string | null): Session | null {
    if (!token) {
      return null;
    }
    const session = this.store.getSession(sha256(token));
    if (!session) {
      return null;
    }
    const now = this.now();
    if (Date.parse(session.expiresAt) <= now.getTime()) {
      this.store.deleteSession(session.id);
      return null;
    }
    if (now.getTime() - Date.parse(session.lastSeenAt) > SESSION_TOUCH_MS) {
      session.lastSeenAt = now.toISOString();
      session.expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
      this.store.touchSession(session.id, session.lastSeenAt, session.expiresAt);
    }
    return session;
  }

  logout(session: Session): void {
    this.store.deleteSession(session.id);
    this.registrations.delete(session.id);
  }

  listSessions(current: Session): (Omit<Session, 'id'> & { id: string; current: boolean })[] {
    this.store.deleteExpiredSessions(this.now().toISOString());
    // The stored ID is a hash of the cookie; exposing a shortened form of it is harmless and lets the UI address it.
    return this.store.listSessions().map((s) => ({ ...s, id: s.id.slice(0, 16), current: s.id === current.id }));
  }

  /** Ends the sessions whose shortened ID matches, or all other sessions when `id` is null. */
  endSessions(current: Session, id: string | null): number {
    if (id === null) {
      return this.store.deleteOtherSessions(current.id);
    }
    const target = this.store.listSessions().find((s) => s.id.slice(0, 16) === id && s.id !== current.id);
    return target && this.store.deleteSession(target.id) ? 1 : 0;
  }

  /**
   * Changes the user name, the password and/or whether the password signs in; the current password is always
   * required. A new password signs out other sessions; turning password sign-in off signs out the other sessions
   * that were not opened with a passkey.
   */
  async updateAccount(
    session: Session,
    change: { currentPassword: string; username?: string | null; newPassword?: string | null; passwordLogin?: boolean | null },
  ): Promise<void> {
    const account = this.store.getAccount();
    if (!account) {
      throw new AuthError(401, 'Not signed in.');
    }
    if (!(await Bun.password.verify(change.currentPassword, account.passwordHash))) {
      throw new AuthError(400, 'The current password is wrong.', 'currentPassword');
    }
    const passwordLogin = change.passwordLogin ?? account.passwordLogin;
    if (!passwordLogin && this.store.listPasskeys().length === 0) {
      throw new AuthError(409, 'Add a passkey before turning off password sign-in.');
    }
    if (change.username !== undefined && change.username !== null && change.username.trim() !== account.username) {
      this.store.updateUsername(validateUsername(change.username));
    }
    if (change.newPassword) {
      this.store.updatePassword(await Bun.password.hash(validatePassword(change.newPassword, 'newPassword')));
      this.store.deleteOtherSessions(session.id);
      this.options.log.info({}, 'Password changed – other sessions signed out');
    }
    if (passwordLogin !== account.passwordLogin) {
      this.store.setPasswordLogin(passwordLogin);
      if (!passwordLogin) {
        this.store.deleteOtherNonPasskeySessions(session.id);
      }
      this.options.log.info({ passwordLogin }, passwordLogin ? 'Password sign-in turned on' : 'Password sign-in turned off – passkeys only');
    }
  }

  // --- Passkeys ---

  listPasskeys(): Omit<Passkey, 'publicKey' | 'counter'>[] {
    return this.store.listPasskeys().map(({ publicKey: _, counter: __, ...rest }) => rest);
  }

  async passkeyRegistrationOptions(session: Session, ctx: RequestContext): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const account = this.store.getAccount();
    if (!account) {
      throw new AuthError(401, 'Not signed in.');
    }
    const options = await generateRegistrationOptions({
      rpName: 'ReleaseWatcher',
      rpID: ctx.rpID,
      userName: account.username,
      userID: new Uint8Array(Buffer.from(account.webauthnUserId, 'base64url')),
      attestationType: 'none',
      excludeCredentials: this.store.listPasskeys().map((p) => ({ id: p.id, transports: p.transports })),
      // Discoverable credentials: signing in needs no user name.
      authenticatorSelection: { residentKey: 'required', userVerification: this.passkeysOnly ? 'required' : 'preferred' },
    });
    this.remember(this.registrations, session.id, options.challenge);
    return options;
  }

  async registerPasskey(session: Session, response: RegistrationResponseJSON, name: string, ctx: RequestContext): Promise<void> {
    const pending = this.take(this.registrations, session.id);
    if (!pending) {
      throw new AuthError(400, 'The passkey request expired – try again.');
    }
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: pending,
        expectedOrigin: ctx.origin,
        expectedRPID: ctx.rpID,
        requireUserVerification: false,
      });
    } catch (error) {
      throw new AuthError(400, `The passkey could not be verified: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!verification.verified) {
      throw new AuthError(400, 'The passkey could not be verified.');
    }
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    if (this.store.getPasskey(credential.id)) {
      throw new AuthError(409, 'This passkey is already registered.');
    }
    this.store.addPasskey({
      id: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      name: name.trim().slice(0, 100) || 'Passkey',
    });
    this.options.log.info({ name }, 'Passkey added');
  }

  async passkeyLoginOptions(ctx: RequestContext): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }> {
    if (!this.accountExists) {
      throw new AuthError(409, 'Create the account first.');
    }
    const options = await generateAuthenticationOptions({
      rpID: ctx.rpID,
      userVerification: this.passkeysOnly ? 'required' : 'preferred',
    });
    const challengeId = randomToken(16);
    this.remember(this.logins, challengeId, options.challenge);
    return { challengeId, options };
  }

  async loginWithPasskey(challengeId: string, response: AuthenticationResponseJSON, ctx: RequestContext): Promise<string> {
    this.checkThrottle(ctx);
    const challenge = this.take(this.logins, challengeId);
    const passkey = this.store.getPasskey(response.id);
    if (!challenge || !passkey) {
      this.throttle.fail(this.throttleKey(ctx));
      throw new AuthError(401, challenge ? 'This passkey is not registered here.' : 'The sign-in request expired – try again.');
    }
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: ctx.origin,
        expectedRPID: ctx.rpID,
        credential: { id: passkey.id, publicKey: passkey.publicKey, counter: passkey.counter, transports: passkey.transports as never },
        requireUserVerification: this.passkeysOnly,
      });
    } catch (error) {
      this.throttle.fail(this.throttleKey(ctx));
      throw new AuthError(401, `Passkey sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!verification.verified) {
      this.throttle.fail(this.throttleKey(ctx));
      throw new AuthError(401, 'Passkey sign-in failed.');
    }
    this.store.markPasskeyUsed(passkey.id, verification.authenticationInfo.newCounter);
    this.throttle.succeed(this.throttleKey(ctx));
    return this.createSession('passkey', ctx);
  }

  renamePasskey(id: string, name: string): boolean {
    return this.store.renamePasskey(id, name.trim().slice(0, 100) || 'Passkey');
  }

  /** Removes a passkey (false = unknown); the last one cannot go while password sign-in is off. */
  deletePasskey(id: string): boolean {
    if (!this.store.getPasskey(id)) {
      return false;
    }
    if (this.passkeysOnly && this.store.listPasskeys().length === 1) {
      throw new AuthError(409, 'This is the last passkey – turn on password sign-in before removing it.');
    }
    return this.store.deletePasskey(id);
  }

  // --- API tokens ---

  listApiTokens(): (ApiToken & { expired: boolean })[] {
    const now = this.now().getTime();
    return this.store.listApiTokens().map((t) => ({ ...t, expired: t.expiresAt !== null && Date.parse(t.expiresAt) <= now }));
  }

  /** Creates an API token; its value is returned only here (the database keeps a SHA-256 of it). */
  createApiToken(change: { name: string; scope: ApiTokenScope; expiresInDays: number | null }): { token: ApiToken; value: string } {
    const name = change.name.trim().slice(0, 100);
    if (!name) {
      throw new AuthError(400, 'Enter a name for the token.', 'name');
    }
    if (change.scope !== 'read' && change.scope !== 'full') {
      throw new AuthError(400, 'The access must be "read" or "full".', 'scope');
    }
    if (change.expiresInDays !== null && (change.expiresInDays < 1 || change.expiresInDays > MAX_API_TOKEN_DAYS)) {
      throw new AuthError(400, `Choose between 1 and ${MAX_API_TOKEN_DAYS} days.`, 'expiresInDays');
    }
    const value = `${API_TOKEN_PREFIX}${randomToken()}`;
    const now = this.now();
    const token = this.store.createApiToken({
      name,
      scope: change.scope,
      tokenHash: sha256(value),
      prefix: value.slice(0, API_TOKEN_PREFIX.length + 8),
      createdAt: now.toISOString(),
      expiresAt: change.expiresInDays === null ? null : new Date(now.getTime() + change.expiresInDays * 86_400_000).toISOString(),
    });
    this.options.log.info({ name, scope: change.scope, expiresAt: token.expiresAt }, 'API token created');
    return { token, value };
  }

  deleteApiToken(id: number): boolean {
    const deleted = this.store.deleteApiToken(id);
    if (deleted) {
      this.options.log.info({ id }, 'API token revoked');
    }
    return deleted;
  }

  /** Returns the valid (known, not expired) API token for a header value, or null; records its use. */
  apiTokenFromValue(value: string, ip: string | null): ApiToken | null {
    const token = this.store.getApiTokenByHash(sha256(value));
    if (!token) {
      return null;
    }
    const now = this.now();
    if (token.expiresAt && Date.parse(token.expiresAt) <= now.getTime()) {
      return null;
    }
    // Dashboards poll often: the last use is written at most once a minute (or when the address changes).
    if (!token.lastUsedAt || now.getTime() - Date.parse(token.lastUsedAt) > API_TOKEN_TOUCH_MS || token.lastUsedIp !== ip) {
      token.lastUsedAt = now.toISOString();
      token.lastUsedIp = ip;
      this.store.markApiTokenUsed(token.id, token.lastUsedAt, ip);
    }
    return token;
  }

  // --- helpers ---

  private createSession(method: LoginMethod, ctx: RequestContext): string {
    const token = randomToken();
    const now = this.now();
    this.store.createSession({
      id: sha256(token),
      method,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      ip: ctx.ip,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    });
    this.store.deleteExpiredSessions(now.toISOString());
    return token;
  }

  private throttleKey(ctx: RequestContext): string {
    return ctx.ip ?? 'unknown';
  }

  private checkThrottle(ctx: RequestContext): void {
    const retryAfter = this.throttle.retryAfter(this.throttleKey(ctx));
    if (retryAfter > 0) {
      throw new AuthError(429, `Too many failed attempts – try again in ${retryAfter} s.`, null, retryAfter);
    }
  }

  private remember(map: Map<string, { challenge: string; expires: number }>, key: string, challenge: string): void {
    const now = this.now().getTime();
    for (const [k, v] of map) {
      if (v.expires <= now) map.delete(k);
    }
    if (map.size >= MAX_PENDING_CHALLENGES) {
      map.delete(map.keys().next().value!);
    }
    map.set(key, { challenge, expires: now + CHALLENGE_TTL_MS });
  }

  private take(map: Map<string, { challenge: string; expires: number }>, key: string): string | null {
    const entry = map.get(key);
    map.delete(key);
    return entry && entry.expires > this.now().getTime() ? entry.challenge : null;
  }

  private dummy: Promise<string> | null = null;
  private dummyHash(): Promise<string> {
    this.dummy ??= Bun.password.hash(randomToken());
    return this.dummy;
  }
}

/** Reads the session token from the Cookie header. */
export function sessionTokenFrom(req: Request): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      return value.join('=') || null;
    }
  }
  return null;
}

/**
 * Reads an API token from `Authorization: Bearer <token>` or `X-API-Key: <token>` (null = none sent).
 * Other Authorization schemes (e.g. Basic auth of a reverse proxy) are ignored.
 */
export function apiTokenFrom(req: Request): string | null {
  const authorization = req.headers.get('authorization')?.trim();
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  const value = bearer ?? req.headers.get('x-api-key')?.trim();
  return value ? value : null;
}

/** Whether the client reached us over HTTPS (directly or through a reverse proxy). */
export function isHttps(req: Request): boolean {
  return new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
}

export function sessionCookie(req: Request, token: string | null): string {
  const attributes = ['Path=/', 'HttpOnly', 'SameSite=Strict', ...(isHttps(req) ? ['Secure'] : [])];
  return token
    ? [`${SESSION_COOKIE}=${token}`, `Max-Age=${SESSION_TTL_MS / 1000}`, ...attributes].join('; ')
    : [`${SESSION_COOKIE}=`, 'Max-Age=0', ...attributes].join('; ');
}

/**
 * Origin and relying party of the request. `publicUrl` (PUBLIC_URL) pins them; otherwise they come from the
 * Host / X-Forwarded-* headers (as seen by the browser).
 */
export function requestContext(
  req: Request,
  socketIp: string | null,
  options: { publicUrl: string | null; trustProxy: boolean },
): RequestContext {
  const publicUrl = options.publicUrl;
  let origin: string;
  if (publicUrl) {
    origin = new URL(publicUrl).origin;
  } else {
    const url = new URL(req.url);
    const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.replace(':', '');
    const host = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || req.headers.get('host') || url.host;
    origin = `${proto}://${host}`;
  }
  // X-Forwarded-For is set by the client unless a reverse proxy overwrites it – only trusted when configured,
  // otherwise it could be used to dodge the login throttle.
  const forwardedFor = options.trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() : undefined;
  return {
    ip: forwardedFor || socketIp,
    userAgent: req.headers.get('user-agent'),
    origin,
    rpID: new URL(origin).hostname,
  };
}
