import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { AuthStore } from '../src/auth/store.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeSource } from './helpers.ts';

// --- A software passkey (ES256), producing real WebAuthn responses ---

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/** Minimal CBOR encoder: unsigned/negative integers, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), value]);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

/** Raw ECDSA signature (r‖s) → ASN.1 DER, as authenticators send it. */
function derSignature(raw: Uint8Array): Buffer {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const trimmed = bytes.slice(i);
    const value = trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([int(raw.slice(0, 32)), int(raw.slice(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

class SoftwarePasskey {
  readonly credentialId = randomBytes(16);
  private counter = 0;
  private keys!: CryptoKeyPair;
  userHandle = '';

  async init(): Promise<this> {
    this.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return this;
  }

  async register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const idLength = Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = Buffer.concat([
      sha256(options.rp.id!),
      Buffer.from([0x45]), // user present + user verified + attested credential data
      Buffer.alloc(4),
      Buffer.alloc(16), // AAGUID
      idLength,
      this.credentialId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  async authenticate(options: { challenge: string; rpId?: string }, origin: string) {
    this.counter++;
    const authData = Buffer.concat([
      sha256(options.rpId!),
      Buffer.from([0x05]), // user present + user verified
      Buffer.from([0, 0, 0, this.counter]),
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keys.privateKey,
        Buffer.concat([authData, sha256(clientDataJSON)]),
      ),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}

// --- Test client with a cookie jar ---

const PUBLIC_URL = 'https://watcher.test';

describe('login', () => {
  let app: App;
  let store: RepositoryStore;
  let baseUrl: URL;

  const start = async (auth: Parameters<typeof buildApp>[0]['auth'] = {}) => {
    store = new RepositoryStore(':memory:');
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source: new FakeSource(),
      notifiers: [],
      log: silentLogger,
      auth,
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  };

  afterEach(() => app.close());

  /** A browser: keeps the session cookie between requests. */
  const client = () => {
    let cookie = '';
    const request = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) {
        const pair = setCookie.split(';')[0]!;
        cookie = pair.endsWith('=') ? '' : pair;
      }
      const text = await response.text();
      return { status: response.status, headers: response.headers, setCookie, json: () => JSON.parse(text) };
    };
    return { request, get cookie() { return cookie; } };
  };

  const setupAccount = async (browser = client(), password = 'correct horse battery') => {
    const code = app.auth.ensureSetupCode()!;
    const response = await browser.request('POST', '/api/auth/setup', { code, username: 'admin', password });
    assert.equal(response.status, 200);
    return browser;
  };

  it('starts in setup mode: only the UI, /health and the auth endpoints are public', async () => {
    await start();
    const browser = client();
    assert.deepEqual((await browser.request('GET', '/api/auth/state')).json(), {
      setupRequired: true,
      authenticated: false,
      username: null,
      hasPasskeys: false,
    });
    assert.equal((await browser.request('GET', '/api/repositories')).status, 401);
    assert.equal((await browser.request('GET', '/api/settings')).status, 401);
    assert.equal((await browser.request('POST', '/api/containers/check-all')).status, 401);
    assert.equal((await browser.request('GET', '/health')).status, 200);
  });

  it('creates the account only with the setup code, then signs in', async () => {
    await start();
    const browser = client();
    const wrong = await browser.request('POST', '/api/auth/setup', { code: 'AAAA-AAAA', username: 'admin', password: 'correct horse battery' });
    assert.equal(wrong.status, 400);
    assert.ok(wrong.json().errors.code);

    const code = app.auth.ensureSetupCode()!;
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const short = await browser.request('POST', '/api/auth/setup', { code, username: 'admin', password: 'short' });
    assert.ok(short.json().errors.password);

    // The code is accepted in lower case and without the dash.
    const ok = await browser.request('POST', '/api/auth/setup', {
      code: code.toLowerCase().replace('-', ''),
      username: 'admin',
      password: 'correct horse battery',
    });
    assert.equal(ok.status, 200);
    assert.match(ok.setCookie ?? '', /^rw_session=[\w-]{20,}; Max-Age=\d+; Path=\/; HttpOnly; SameSite=Strict$/);
    assert.equal(ok.json().authenticated, true);
    assert.equal((await browser.request('GET', '/api/repositories')).status, 200);

    // Setup is closed once the account exists.
    assert.equal((await client().request('POST', '/api/auth/setup', { code, username: 'x', password: 'correct horse battery' })).status, 409);
    assert.equal(app.auth.ensureSetupCode(), null);
  });

  it('signs in and out with the password', async () => {
    await start();
    await setupAccount();
    const browser = client();
    assert.equal((await browser.request('POST', '/api/auth/login', { username: 'admin', password: 'wrong password!' })).status, 401);
    assert.equal((await browser.request('POST', '/api/auth/login', { username: 'nobody', password: 'correct horse battery' })).status, 401);
    const ok = await browser.request('POST', '/api/auth/login', { username: 'Admin', password: 'correct horse battery' });
    assert.equal(ok.status, 200);
    assert.equal(ok.json().username, 'admin');
    assert.equal((await browser.request('GET', '/api/settings')).status, 200);

    const token = browser.cookie;
    assert.equal((await browser.request('POST', '/api/auth/logout')).status, 204);
    assert.equal(browser.cookie, '');
    // The old cookie no longer works either.
    assert.equal((await client().request('GET', '/api/settings', undefined, { cookie: token })).status, 401);
  });

  it('locks out repeated failed logins', async () => {
    await start();
    await setupAccount();
    const browser = client();
    for (let i = 0; i < 5; i++) {
      await browser.request('POST', '/api/auth/login', { username: 'admin', password: 'wrong password!' });
    }
    const locked = await browser.request('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  });

  it('refuses cross-site requests', async () => {
    await start();
    const browser = await setupAccount();
    assert.equal(
      (await browser.request('POST', '/api/containers/check-all', undefined, { origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal(
      (await browser.request('POST', '/api/auth/login', { username: 'admin', password: 'x' }, { origin: 'https://evil.example' })).status,
      403,
    );
    assert.equal((await browser.request('GET', '/api/settings', undefined, { origin: 'https://evil.example' })).status, 200);
    assert.notEqual((await browser.request('POST', '/api/check-all', undefined, { origin: baseUrl.origin })).status, 403);
  });

  it('changes the password and signs out the other sessions', async () => {
    await start();
    const first = await setupAccount();
    const second = client();
    await second.request('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' });
    assert.equal((await first.request('GET', '/api/auth/sessions')).json().length, 2);

    const wrong = await first.request('PUT', '/api/auth/account', { currentPassword: 'nope', newPassword: 'another long password' });
    assert.ok(wrong.json().errors.currentPassword);
    const ok = await first.request('PUT', '/api/auth/account', {
      currentPassword: 'correct horse battery',
      newPassword: 'another long password',
      username: 'szymon',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json().username, 'szymon');
    assert.equal((await second.request('GET', '/api/settings')).status, 401);
    assert.equal((await first.request('GET', '/api/settings')).status, 200);
    assert.equal((await client().request('POST', '/api/auth/login', { username: 'szymon', password: 'another long password' })).status, 200);
  });

  it('expires sessions', async () => {
    await start();
    const browser = await setupAccount();
    store.database.run("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
    assert.equal((await browser.request('GET', '/api/settings')).status, 401);
  });

  it('creates the account from the former Basic auth credentials', async () => {
    await start({ bootstrap: { username: 'admin', password: 'from the env file' } });
    const browser = client();
    assert.equal((await browser.request('GET', '/api/auth/state')).json().setupRequired, false);
    assert.equal((await browser.request('POST', '/api/auth/login', { username: 'admin', password: 'from the env file' })).status, 200);
  });

  it('resets the login (account, passkeys, sessions) for --reset-login', async () => {
    await start();
    const browser = await setupAccount();
    new AuthStore(store.database).resetAll();
    assert.equal((await browser.request('GET', '/api/settings')).status, 401);
    assert.equal((await browser.request('GET', '/api/auth/state')).json().setupRequired, true);
    assert.ok(app.auth.ensureSetupCode());
  });

  it('registers a passkey and signs in with it', async () => {
    await start({ publicUrl: PUBLIC_URL });
    const browser = await setupAccount();
    const passkey = await new SoftwarePasskey().init();

    const creation = (await browser.request('POST', '/api/auth/passkeys/options')).json();
    assert.equal(creation.rp.id, 'watcher.test');
    assert.equal(creation.authenticatorSelection.residentKey, 'required');
    const registered = await browser.request('POST', '/api/auth/passkeys', {
      name: 'Laptop',
      response: await passkey.register(creation, PUBLIC_URL),
    });
    assert.equal(registered.status, 201);
    assert.deepEqual(
      registered.json().map((p: { name: string; transports: string[] }) => [p.name, p.transports]),
      [['Laptop', ['internal']]],
    );
    assert.equal('publicKey' in registered.json()[0], false);

    // Sign in from another browser with the passkey only.
    const other = client();
    assert.equal((await other.request('GET', '/api/auth/state')).json().hasPasskeys, true);
    const { challengeId, options } = (await other.request('POST', '/api/auth/passkey/options')).json();
    assert.equal(options.rpId, 'watcher.test');
    const login = await other.request('POST', '/api/auth/passkey/login', {
      challengeId,
      response: await passkey.authenticate(options, PUBLIC_URL),
    });
    assert.equal(login.status, 200);
    assert.equal(login.json().authenticated, true);
    assert.equal((await other.request('GET', '/api/settings')).status, 200);
    assert.equal((await other.request('GET', '/api/auth/sessions')).json().find((s: { current: boolean }) => s.current).method, 'passkey');

    // A challenge can be used once; an assertion for another origin is rejected.
    const replay = await client().request('POST', '/api/auth/passkey/login', {
      challengeId,
      response: await passkey.authenticate(options, PUBLIC_URL),
    });
    assert.equal(replay.status, 401);
    const second = (await client().request('POST', '/api/auth/passkey/options')).json();
    const phished = await client().request('POST', '/api/auth/passkey/login', {
      challengeId: second.challengeId,
      response: await passkey.authenticate(second.options, 'https://evil.example'),
    });
    assert.equal(phished.status, 401);

    // Removing the passkey disables it.
    const id = registered.json()[0].id;
    assert.equal((await browser.request('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}`)).status, 204);
    const third = (await client().request('POST', '/api/auth/passkey/options')).json();
    const removed = await client().request('POST', '/api/auth/passkey/login', {
      challengeId: third.challengeId,
      response: await passkey.authenticate(third.options, PUBLIC_URL),
    });
    assert.equal(removed.status, 401);
  });

  it('needs a session to add a passkey', async () => {
    await start({ publicUrl: PUBLIC_URL });
    await setupAccount();
    assert.equal((await client().request('POST', '/api/auth/passkeys/options')).status, 401);
  });
});
