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
    });
    assert.equal((await browser.request('GET', '/api/repositories')).status, 401);
    assert.equal((await browser.request('GET', '/api/settings')).status, 401);
    assert.equal((await browser.request('POST', '/api/containers/check-all')).status, 401);
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
