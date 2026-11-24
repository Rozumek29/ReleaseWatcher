import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, it } from 'bun:test';
import { type CryptoKey, type JWTPayload, SignJWT, exportJWK, generateKeyPair } from 'jose';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { type FetchLike, OidcClient, OidcError } from '../src/auth/oidc.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeSource } from './helpers.ts';

const PUBLIC_URL = 'https://watcher.test';
const PASSWORD = 'correct horse battery';
const CLIENT_ID = 'release-watcher';
const CLIENT_SECRET = 'top-secret-client-value';

/** A small OpenID provider: discovery, JWKS, token endpoint; `authorize()` plays the user signing in. */
class FakeProvider {
  readonly issuer: string;
  subject = 'user-1';
  claims: JWTPayload = { preferred_username: 'alex' };
  /** Overrides of the ID token (e.g. another audience). */
  tokenOverrides: { audience?: string; nonce?: string } = {};
  authMethods: string[] | undefined = undefined;
  down = false;
  readonly tokenRequests: { authorization: string | null; body: URLSearchParams }[] = [];
  private readonly codes = new Map<string, { nonce: string; challenge: string; redirectUri: string; clientId: string; subject: string }>();
  private privateKey!: CryptoKey;
  private jwk!: Record<string, unknown>;

  constructor(issuer = 'https://id.example.test') {
    this.issuer = issuer;
  }

  async init(): Promise<this> {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'key-1', alg: 'ES256', use: 'sig' };
    return this;
  }

  readonly fetch: FetchLike = async (input, init) => {
    if (this.down) {
      throw new Error('connect ECONNREFUSED');
    }
    const url = new URL(input);
    if (url.href === `${this.issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        ...(this.authMethods ? { token_endpoint_auth_methods_supported: this.authMethods } : {}),
      });
    }
    if (url.href === `${this.issuer}/jwks`) {
      return Response.json({ keys: [this.jwk] });
    }
    if (url.href === `${this.issuer}/token` && init?.method === 'POST') {
      const body = new URLSearchParams(String(init.body));
      const authorization = new Headers(init.headers).get('authorization');
      this.tokenRequests.push({ authorization, body });
      const grant = this.codes.get(body.get('code') ?? '');
      this.codes.delete(body.get('code') ?? '');
      const verifier = body.get('code_verifier') ?? '';
      if (
        !grant ||
        createHash('sha256').update(verifier).digest('base64url') !== grant.challenge ||
        body.get('redirect_uri') !== grant.redirectUri
      ) {
        return Response.json({ error: 'invalid_grant', error_description: 'Invalid code.' }, { status: 400 });
      }
      const idToken = await new SignJWT({ ...this.claims, nonce: this.tokenOverrides.nonce ?? grant.nonce })
        .setProtectedHeader({ alg: 'ES256', kid: 'key-1' })
        .setIssuer(this.issuer)
        .setSubject(grant.subject)
        .setAudience(this.tokenOverrides.audience ?? grant.clientId)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.privateKey);
      return Response.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken });
    }
    return new Response('not found', { status: 404 });
  };

  /** The user signs in at the provider; returns the redirect back to ReleaseWatcher. */
  authorize(authorizationUrl: string, error?: string): string {
    const url = new URL(authorizationUrl);
    assert.equal(url.origin + url.pathname, `${this.issuer}/authorize`);
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('scope'), 'openid profile email');
    const redirectUri = url.searchParams.get('redirect_uri')!;
    const back = new URL(redirectUri);
    back.searchParams.set('state', url.searchParams.get('state')!);
    if (error) {
      back.searchParams.set('error', error);
      back.searchParams.set('error_description', 'The user denied access.');
      return back.href;
    }
    const code = randomBytes(12).toString('hex');
    this.codes.set(code, {
      nonce: url.searchParams.get('nonce')!,
      challenge: url.searchParams.get('code_challenge')!,
      redirectUri,
      clientId: url.searchParams.get('client_id')!,
      subject: this.subject,
    });
    back.searchParams.set('code', code);
    return back.href;
  }
}

describe('single sign-on (OIDC)', () => {
  let app: App;
  let baseUrl: URL;
  let provider: FakeProvider;

  const start = async (env: Record<string, string> = {}) => {
    const store = new RepositoryStore(':memory:');
    provider = await new FakeProvider().init();
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig(env)),
      source: new FakeSource(),
      notifiers: [],
      log: silentLogger,
      auth: { publicUrl: PUBLIC_URL, oidcFetch: provider.fetch },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  };

  afterEach(() => app.close());

  /** A browser with a cookie jar (session + SSO binding cookie). */
  const client = () => {
    const cookies = new Map<string, string>();
    const request = async (method: string, path: string, body?: unknown) => {
      const target = new URL(path, baseUrl);
      const response = await fetch(new URL(target.pathname + target.search, baseUrl), {
        method,
        redirect: 'manual',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(cookies.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';');
        const [name, ...value] = pair!.split('=');
        if (value.join('=')) {
          cookies.set(name!, value.join('='));
        } else {
          cookies.delete(name!);
        }
      }
      const text = await response.text();
      return { status: response.status, headers: response.headers, json: () => JSON.parse(text) };
    };
    return { request, cookies };
  };

  const signedInAdmin = async () => {
    const browser = client();
    const code = app.auth.ensureSetupCode()!;
    assert.equal((await browser.request('POST', '/api/auth/setup', { code, username: 'admin', password: PASSWORD })).status, 200);
    return browser;
  };

  const configure = (browser: ReturnType<typeof client>, extra: Record<string, unknown> = {}) =>
    browser.request('PUT', '/api/auth/oidc', {
      currentPassword: PASSWORD,
      issuer: provider.issuer,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      name: 'Pocket ID',
      ...extra,
    });

  /** Runs the whole round trip: start → provider → callback. Returns the callback response. */
  const roundTrip = async (browser: ReturnType<typeof client>, mode: 'login' | 'link', error?: string) => {
    const started = await browser.request('POST', `/api/auth/oidc/${mode}`);
    assert.equal(started.status, 200, JSON.stringify(started.json()));
    return browser.request('GET', provider.authorize(started.json().url, error));
  };

  const link = async (browser: ReturnType<typeof client>) => {
    const linked = await roundTrip(browser, 'link');
    assert.equal(linked.status, 303);
    assert.equal(linked.headers.get('location'), '/account?sso=linked');
  };

  it('links the account, then signs in with the provider', async () => {
    await start();
    const admin = await signedInAdmin();
    assert.equal((await client().request('POST', '/api/auth/oidc/login')).status, 409);

    // Configure: the secret is never returned in full.
    const saved = await configure(admin);
    assert.equal(saved.status, 200);
    const settings = saved.json();
    assert.equal(settings.configured, true);
    assert.equal(settings.issuer, provider.issuer);
    assert.equal(settings.issuerSource, 'ui');
    assert.equal(settings.hasClientSecret, true);
    assert.equal(settings.clientSecretMasked, 'to…alue');
    assert.equal(settings.redirectUri, `${PUBLIC_URL}/api/auth/oidc/callback`);
    assert.equal(settings.link, null);
    assert.ok(!JSON.stringify(settings).includes(CLIENT_SECRET));

    // Not linked yet: no sign-in button, and signing in is refused.
    assert.equal((await client().request('GET', '/api/auth/state')).json().oidcLogin, null);
    assert.equal((await client().request('POST', '/api/auth/oidc/login')).status, 409);

    // Link: the binding cookie is Lax (the provider's redirect is a cross-site navigation) and limited to the SSO paths.
    const started = await admin.request('POST', '/api/auth/oidc/link');
    assert.match(started.headers.get('set-cookie')!, /^rw_oidc=[\w-]+; Max-Age=600; Path=\/api\/auth\/oidc; HttpOnly; SameSite=Lax$/);
    const linked = await admin.request('GET', provider.authorize(started.json().url));
    assert.equal(linked.status, 303);
    assert.equal(linked.headers.get('location'), '/account?sso=linked');
    assert.equal(admin.cookies.has('rw_oidc'), false);
    const afterLink = (await admin.request('GET', '/api/auth/oidc')).json();
    assert.equal(afterLink.link.issuer, provider.issuer);
    assert.equal(afterLink.link.subject, 'user-1');
    assert.equal(afterLink.link.label, 'alex');

    // The token request used the client secret (Basic) and PKCE.
    const tokenRequest = provider.tokenRequests.at(-1)!;
    assert.equal(tokenRequest.authorization, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
    assert.ok(tokenRequest.body.get('code_verifier'));
    assert.equal(tokenRequest.body.get('client_secret'), null);

    // Sign in from another browser.
    const browser = client();
    assert.equal((await browser.request('GET', '/api/auth/state')).json().oidcLogin, 'Pocket ID');
    const signedIn = await roundTrip(browser, 'login');
    assert.equal(signedIn.status, 303);
    assert.equal(signedIn.headers.get('location'), '/');
    assert.ok(browser.cookies.get('rw_session'));
    const state = (await browser.request('GET', '/api/auth/state')).json();
    assert.equal(state.authenticated, true);
    assert.equal(state.username, 'admin');
    assert.equal((await browser.request('GET', '/api/repositories')).status, 200);
    const sessions = (await browser.request('GET', '/api/auth/sessions')).json() as { method: string; current: boolean }[];
    assert.equal(sessions.find((s) => s.current)?.method, 'oidc');
  });

  it('refuses another identity, a callback in another browser, a replayed state and provider errors', async () => {
    await start();
    const admin = await signedInAdmin();
    await configure(admin);
    await link(admin);

    // Another user at the same provider.
    provider.subject = 'user-2';
    provider.claims = { email: 'eve@example.test' };
    const other = client();
    const refused = await roundTrip(other, 'login');
    assert.equal(refused.status, 303);
    const location = new URL(refused.headers.get('location')!, PUBLIC_URL);
    assert.equal(location.pathname, '/login');
    assert.equal(location.searchParams.get('ssoError'), 'eve@example.test at Pocket ID is not linked to ReleaseWatcher.');
    assert.equal(other.cookies.has('rw_session'), false);
    provider.subject = 'user-1';

    // The redirect opened in a browser that did not start the sign-in (no binding cookie): login CSRF.
    const started = (await client().request('POST', '/api/auth/oidc/login')).json();
    const victim = client();
    const csrf = await victim.request('GET', provider.authorize(started.url));
    assert.match(new URL(csrf.headers.get('location')!, PUBLIC_URL).searchParams.get('ssoError')!, /another browser/);
    assert.equal(victim.cookies.has('rw_session'), false);

    // A state is used only once.
    const browser = client();
    const first = (await browser.request('POST', '/api/auth/oidc/login')).json();
    const callback = provider.authorize(first.url);
    const binding = browser.cookies.get('rw_oidc')!;
    assert.equal((await browser.request('GET', callback)).headers.get('location'), '/');
    browser.cookies.set('rw_oidc', binding);
    browser.cookies.delete('rw_session');
    assert.match((await browser.request('GET', callback)).headers.get('location')!, /^\/login\?ssoError=/);

    // The user cancels at the provider.
    const denied = await roundTrip(client(), 'login', 'access_denied');
    assert.equal(
      new URL(denied.headers.get('location')!, PUBLIC_URL).searchParams.get('ssoError'),
      'The provider refused the sign-in: The user denied access.',
    );

    // An ID token for another client.
    provider.tokenOverrides = { audience: 'someone-else' };
    const audience = await roundTrip(client(), 'login');
    assert.match(new URL(audience.headers.get('location')!, PUBLIC_URL).searchParams.get('ssoError')!, /ID token could not be verified/);
    provider.tokenOverrides = { nonce: 'replayed' };
    const nonce = await roundTrip(client(), 'login');
    assert.match(new URL(nonce.headers.get('location')!, PUBLIC_URL).searchParams.get('ssoError')!, /nonce/);
    provider.tokenOverrides = {};

    // Linking errors go back to the Account page.
    const failedLink = await roundTrip(admin, 'link', 'access_denied');
    assert.match(failedLink.headers.get('location')!, /^\/account\?ssoError=/);

    // Provider unreachable when the code is redeemed (the discovery document is cached).
    const late = client();
    const pending = (await late.request('POST', '/api/auth/oidc/login')).json();
    provider.down = true;
    const down = await late.request('GET', provider.authorize(pending.url));
    assert.match(new URL(down.headers.get('location')!, PUBLIC_URL).searchParams.get('ssoError')!, /token endpoint could not be reached/);
  });

  it('answers 502 when the provider cannot be reached', async () => {
    await start({ OIDC_ISSUER: 'https://id.example.test', OIDC_CLIENT_ID: CLIENT_ID });
    const admin = await signedInAdmin();
    provider.down = true;
    const down = await admin.request('POST', '/api/auth/oidc/link');
    assert.equal(down.status, 502);
    assert.match(down.json().title, /discovery document could not be reached/);
  });

  it('allows turning off the password with single sign-on and protects the last way in', async () => {
    await start();
    const admin = await signedInAdmin();
    await configure(admin);
    await link(admin);
    const passwordBrowser = client();
    await passwordBrowser.request('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
    const ssoBrowser = client();
    await roundTrip(ssoBrowser, 'login');

    const off = await admin.request('PUT', '/api/auth/account', { currentPassword: PASSWORD, passwordLogin: false });
    assert.equal(off.status, 200);
    assert.equal(off.json().passwordLogin, false);
    // Password sessions end, the single sign-on session stays.
    assert.equal((await passwordBrowser.request('GET', '/api/settings')).status, 401);
    assert.equal((await ssoBrowser.request('GET', '/api/settings')).status, 200);

    // Single sign-on is now the only way in: it cannot be unlinked or pointed at another provider.
    assert.equal((await admin.request('DELETE', '/api/auth/oidc/link')).status, 409);
    assert.equal((await configure(admin, { issuer: 'https://other.example.test' })).status, 409);
    assert.equal((await configure(admin, { clientId: null })).status, 409);
    // The client secret or the name can change.
    assert.equal((await configure(admin, { name: 'SSO', clientSecret: 'rotated-secret' })).status, 200);

    // With the password back on, another issuer removes the link and ends the single sign-on sessions.
    await admin.request('PUT', '/api/auth/account', { currentPassword: PASSWORD, passwordLogin: true });
    const moved = await configure(admin, { issuer: 'https://other.example.test/' });
    assert.equal(moved.status, 200);
    assert.equal(moved.json().link, null);
    assert.equal((await ssoBrowser.request('GET', '/api/settings')).status, 401);
    assert.equal((await client().request('GET', '/api/auth/state')).json().oidcLogin, null);
  });

  it('unlinks, validates the settings and takes defaults from OIDC_* variables', async () => {
    await start({ OIDC_ISSUER: 'https://id.example.test', OIDC_CLIENT_ID: CLIENT_ID });
    const admin = await signedInAdmin();
    const defaults = (await admin.request('GET', '/api/auth/oidc')).json();
    assert.equal(defaults.configured, true);
    assert.equal(defaults.issuerSource, 'env');
    assert.equal(defaults.hasClientSecret, false);
    assert.equal(defaults.clientSecretSource, null);

    // A public client: the client ID is sent in the body, no secret.
    await link(admin);
    assert.equal(provider.tokenRequests.at(-1)!.authorization, null);
    assert.equal(provider.tokenRequests.at(-1)!.body.get('client_id'), CLIENT_ID);
    assert.equal((await client().request('GET', '/api/auth/state')).json().oidcLogin, 'OIDC');

    const wrongPassword = await configure(admin, { currentPassword: 'wrong password!' });
    assert.equal(wrongPassword.status, 400);
    assert.ok(wrongPassword.json().errors.currentPassword);
    const badIssuer = await configure(admin, { issuer: 'ftp://id.example.test' });
    assert.equal(badIssuer.status, 400);
    assert.ok(badIssuer.json().errors.issuer);

    assert.equal((await admin.request('DELETE', '/api/auth/oidc/link')).status, 204);
    assert.equal((await admin.request('DELETE', '/api/auth/oidc/link')).status, 404);
    assert.equal((await admin.request('GET', '/api/auth/oidc')).json().link, null);
    // Signed out, the settings and the link endpoint are closed.
    assert.equal((await client().request('GET', '/api/auth/oidc')).status, 401);
    assert.equal((await client().request('POST', '/api/auth/oidc/link')).status, 401);
  });
});

describe('OidcClient', () => {
  const config = { issuer: 'https://id.example.test/', clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, name: 'Test' };

  it('accepts the discovery URL, uses client_secret_post when Basic is not offered and verifies HS256 tokens', async () => {
    const provider = await new FakeProvider('https://id.example.test').init();
    provider.authMethods = ['client_secret_post'];
    let tokenBody: URLSearchParams | null = null;
    const fetch: FetchLike = async (input, init) => {
      if (input.endsWith('/token')) {
        tokenBody = new URLSearchParams(String(init?.body));
        const idToken = await new SignJWT({ nonce: 'n1', email: 'a@example.test' })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('https://id.example.test')
          .setSubject('s1')
          .setAudience(CLIENT_ID)
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode(CLIENT_SECRET));
        return Response.json({ id_token: idToken });
      }
      return provider.fetch(input, init);
    };
    const client = new OidcClient({ fetch });
    const discoveryConfig = { ...config, issuer: 'https://id.example.test/.well-known/openid-configuration' };
    const url = await client.authorizationUrl(discoveryConfig, { redirectUri: 'https://w/cb', state: 's', nonce: 'n1', codeVerifier: 'v' });
    assert.ok(url.startsWith('https://id.example.test/authorize?'));
    const identity = await client.exchange(discoveryConfig, { code: 'c', redirectUri: 'https://w/cb', codeVerifier: 'v', nonce: 'n1' });
    assert.deepEqual(identity, { issuer: 'https://id.example.test', subject: 's1', label: 'a@example.test' });
    assert.equal(tokenBody!.get('client_secret'), CLIENT_SECRET);
  });

  it('refuses a discovery document of another issuer', async () => {
    const provider = await new FakeProvider('https://id.example.test').init();
    const fetch: FetchLike = async (input, init) =>
      provider.fetch(input.replace('https://evil.example.test', 'https://id.example.test'), init);
    const client = new OidcClient({ fetch });
    await assert.rejects(
      client.authorizationUrl({ ...config, issuer: 'https://evil.example.test' }, { redirectUri: 'x', state: 's', nonce: 'n', codeVerifier: 'v' }),
      (error: unknown) => error instanceof OidcError && /reports the issuer https:\/\/id\.example\.test/.test(error.message),
    );
  });
});
