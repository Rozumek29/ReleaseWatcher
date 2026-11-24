import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'bun:test';
import { APP_VERSION } from '../src/app-version.ts';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { AuthStore } from '../src/auth/store.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeSource } from './helpers.ts';
import { SoftwarePasskey } from './webauthn.ts';

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

  it('starts in setup mode: only the UI, /health, /api/version and the auth endpoints are public', async () => {
    await start();
    const browser = client();
    assert.deepEqual((await browser.request('GET', '/api/auth/state')).json(), {
      setupRequired: true,
      authenticated: false,
      username: null,
      hasPasskeys: false,
      passwordLogin: true,
      oidcLogin: null,
    });
    assert.equal((await browser.request('GET', '/api/repositories')).status, 401);
    assert.equal((await browser.request('GET', '/api/settings')).status, 401);
    assert.equal((await browser.request('POST', '/api/targets/check-all')).status, 401);
    assert.equal((await browser.request('GET', '/health')).status, 200);
    const version = await browser.request('GET', '/api/version');
    assert.equal(version.status, 200);
    assert.deepEqual(version.json(), { version: APP_VERSION });
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
      (await browser.request('POST', '/api/targets/check-all', undefined, { origin: 'https://evil.example' })).status,
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

  it('turns off password sign-in (passkeys only) and back on', async () => {
    await start({ publicUrl: PUBLIC_URL });
    const browser = await setupAccount();
    const passwordSession = client();
    await passwordSession.request('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' });
    const off = { currentPassword: 'correct horse battery', passwordLogin: false };

    // Needs a passkey first – otherwise nobody could sign in any more.
    const noPasskey = await browser.request('PUT', '/api/auth/account', off);
    assert.equal(noPasskey.status, 409);
    assert.match(noPasskey.json().title, /Add a passkey/);

    const passkey = await new SoftwarePasskey().init();
    const creation = (await browser.request('POST', '/api/auth/passkeys/options')).json();
    const id = (await browser.request('POST', '/api/auth/passkeys', { response: await passkey.register(creation, PUBLIC_URL) })).json()[0].id;
    const passkeySession = client();
    const first = (await passkeySession.request('POST', '/api/auth/passkey/options')).json();
    await passkeySession.request('POST', '/api/auth/passkey/login', {
      challengeId: first.challengeId,
      response: await passkey.authenticate(first.options, PUBLIC_URL),
    });

    // The current password is still required.
    assert.equal((await browser.request('PUT', '/api/auth/account', { ...off, currentPassword: 'wrong password!' })).status, 400);
    const turnedOff = await browser.request('PUT', '/api/auth/account', off);
    assert.equal(turnedOff.status, 200);
    assert.equal(turnedOff.json().passwordLogin, false);
    assert.equal((await client().request('GET', '/api/auth/state')).json().passwordLogin, false);

    // Other password sessions end; this one and passkey sessions stay.
    assert.equal((await passwordSession.request('GET', '/api/settings')).status, 401);
    assert.equal((await passkeySession.request('GET', '/api/settings')).status, 200);
    assert.equal((await browser.request('GET', '/api/settings')).status, 200);

    // The password no longer signs in – even the right one.
    const login = await client().request('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' });
    assert.equal(login.status, 409);
    assert.match(login.json().title, /Password sign-in is turned off/);

    // Passkey sign-in now requires user verification.
    const second = (await client().request('POST', '/api/auth/passkey/options')).json();
    assert.equal(second.options.userVerification, 'required');
    assert.equal((await client().request('POST', '/api/auth/passkeys/options')).status, 401);
    assert.equal((await browser.request('POST', '/api/auth/passkeys/options')).json().authenticatorSelection.userVerification, 'required');

    // The last passkey cannot be removed while the password is off.
    const removeLast = await browser.request('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}`);
    assert.equal(removeLast.status, 409);
    assert.equal((await browser.request('DELETE', '/api/auth/passkeys/unknown')).status, 404);

    // Turned back on: the password signs in again and the passkey can be removed.
    assert.equal((await browser.request('PUT', '/api/auth/account', { currentPassword: 'correct horse battery', passwordLogin: true })).json().passwordLogin, true);
    assert.equal((await client().request('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' })).status, 200);
    assert.equal((await client().request('POST', '/api/auth/passkey/options')).json().options.userVerification, 'preferred');
    assert.equal((await browser.request('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}`)).status, 204);
  });

  it('brings password sign-in back with --reset-login', async () => {
    await start({ publicUrl: PUBLIC_URL });
    await setupAccount();
    store.database.run('UPDATE account SET password_login = 0');
    new AuthStore(store.database).resetAll();
    await setupAccount();
    assert.equal((await client().request('GET', '/api/auth/state')).json().passwordLogin, true);
    assert.equal((await client().request('POST', '/api/auth/login', { username: 'admin', password: 'correct horse battery' })).status, 200);
  });

  it('needs a session to add a passkey', async () => {
    await start({ publicUrl: PUBLIC_URL });
    await setupAccount();
    assert.equal((await client().request('POST', '/api/auth/passkeys/options')).status, 401);
  });

  describe('API tokens', () => {
    /** A client without cookies that sends the given headers (e.g. a dashboard). */
    const withHeaders = (headers: Record<string, string>) => (method: string, path: string, body?: unknown) =>
      client().request(method, path, body, headers);
    const createToken = async (browser: ReturnType<typeof client>, body: Record<string, unknown>) => {
      const response = await browser.request('POST', '/api/auth/api-tokens', body);
      assert.equal(response.status, 201);
      return response.json() as { id: number; token: string; prefix: string; scope: string; expiresAt: string | null };
    };

    it('creates a token once and lists it without its value', async () => {
      await start();
      const browser = await setupAccount();
      const created = await createToken(browser, { name: 'Homepage', scope: 'read' });
      assert.match(created.token, /^rw_[\w-]{40,}$/);
      assert.equal(created.prefix, created.token.slice(0, 11));
      assert.equal(created.expiresAt, null);

      const list = await browser.request('GET', '/api/auth/api-tokens');
      assert.equal(list.status, 200);
      const [listed] = list.json();
      assert.equal(listed.name, 'Homepage');
      assert.equal(listed.scope, 'read');
      assert.equal(listed.expired, false);
      assert.equal(listed.token, undefined);
      assert.equal(JSON.stringify(list.json()).includes(created.token), false);
      // Only a hash is stored.
      const row = store.database.query<{ token_hash: string }, []>('SELECT token_hash FROM api_tokens').get()!;
      assert.notEqual(row.token_hash, created.token);
      assert.equal(row.token_hash.length, 64);
    });

    it('lets a read token read with either header, but not write', async () => {
      await start();
      const browser = await setupAccount();
      const { token } = await createToken(browser, { name: 'Homepage', scope: 'read' });
      const bearer = withHeaders({ authorization: `Bearer ${token}` });
      const apiKey = withHeaders({ 'x-api-key': token });

      assert.equal((await bearer('GET', '/api/status')).status, 200);
      assert.equal((await apiKey('GET', '/api/repositories')).status, 200);
      const write = await bearer('PUT', '/api/settings', {});
      assert.equal(write.status, 403);
      assert.match(write.json().title, /only read/);
      assert.equal((await apiKey('POST', '/api/targets/check-all')).status, 403);
      // Unknown API paths are a 404 for a valid token.
      assert.equal((await bearer('GET', '/api/nothing-here')).status, 404);

      const [listed] = (await browser.request('GET', '/api/auth/api-tokens')).json();
      assert.ok(listed.lastUsedAt);
      assert.equal(listed.lastUsedIp, '127.0.0.1');
    });

    it('lets a full token write, but never reach the account routes', async () => {
      await start();
      const browser = await setupAccount();
      const { token } = await createToken(browser, { name: 'Script', scope: 'full' });
      const bearer = withHeaders({ authorization: `bearer ${token}` });
      assert.equal((await bearer('PUT', '/api/settings', {})).status, 200);
      assert.equal((await bearer('GET', '/api/auth/api-tokens')).status, 403);
      assert.equal((await bearer('POST', '/api/auth/api-tokens', { name: 'More', scope: 'full' })).status, 403);
      assert.equal((await bearer('GET', '/api/auth/sessions')).status, 403);
      // Public routes stay public; the auth state does not count a token as a session.
      assert.equal((await bearer('GET', '/api/auth/state')).json().authenticated, false);
    });

    it('refuses unknown, revoked and expired tokens and other schemes', async () => {
      await start();
      const browser = await setupAccount();
      const revoked = await createToken(browser, { name: 'Old', scope: 'full' });
      const expiring = await createToken(browser, { name: 'Short', scope: 'read', expiresInDays: 30 });
      assert.ok(Date.parse(expiring.expiresAt!) > Date.now() + 29 * 86_400_000);

      assert.equal((await withHeaders({ authorization: 'Bearer rw_wrong' })('GET', '/api/status')).status, 401);
      assert.equal((await withHeaders({ authorization: `Basic ${btoa('admin:x')}` })('GET', '/api/status')).status, 401);
      assert.equal((await withHeaders({ 'x-api-key': '' })('GET', '/api/status')).status, 401);

      assert.equal((await browser.request('DELETE', `/api/auth/api-tokens/${revoked.id}`)).status, 204);
      assert.equal((await browser.request('DELETE', `/api/auth/api-tokens/${revoked.id}`)).status, 404);
      assert.equal((await withHeaders({ 'x-api-key': revoked.token })('GET', '/api/status')).status, 401);

      assert.equal((await withHeaders({ 'x-api-key': expiring.token })('GET', '/api/status')).status, 200);
      store.database.query('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', expiring.id);
      const expired = await withHeaders({ 'x-api-key': expiring.token })('GET', '/api/status');
      assert.equal(expired.status, 401);
      assert.match(expired.json().title, /invalid, expired or revoked/);
      assert.equal((await browser.request('GET', '/api/auth/api-tokens')).json()[0].expired, true);
    });

    it('validates new tokens and needs a session to manage them', async () => {
      await start();
      const browser = await setupAccount();
      assert.ok((await browser.request('POST', '/api/auth/api-tokens', { name: ' ', scope: 'read' })).json().errors.name);
      assert.ok((await browser.request('POST', '/api/auth/api-tokens', { name: 'X', scope: 'admin' })).json().errors.scope);
      assert.equal((await browser.request('POST', '/api/auth/api-tokens', { name: 'X', scope: 'read', expiresInDays: 0 })).status, 400);
      assert.ok(
        (await browser.request('POST', '/api/auth/api-tokens', { name: 'X', scope: 'read', expiresInDays: 5000 })).json().errors
          .expiresInDays,
      );
      assert.equal((await client().request('GET', '/api/auth/api-tokens')).status, 401);
    });

    it('removes the tokens with --reset-login', async () => {
      await start();
      const browser = await setupAccount();
      const { token } = await createToken(browser, { name: 'Homepage', scope: 'read' });
      new AuthStore(store.database).resetAll();
      assert.equal((await withHeaders({ 'x-api-key': token })('GET', '/api/status')).status, 401);
    });
  });
});
