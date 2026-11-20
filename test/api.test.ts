import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { APP_VERSION } from '../src/app-version.ts';
import { buildApp, type App } from '../src/app.ts';
import { silentLogger } from '../src/log.ts';
import { RepositoryStore } from '../src/db.ts';
import { loadConfig } from '../src/config.ts';
import { SettingsService } from '../src/settings.ts';
import { advisory, FakeSource, RecordingNotifier, release } from './helpers.ts';

describe('HTTP API', () => {
  let app: App;
  let source: FakeSource;
  let notifier: RecordingNotifier;
  let store: RepositoryStore;
  let lastHeaders: readonly { name: string; value: string }[] = [];
  let baseUrl: URL;

  /** Sends a request to the running server (the shape mirrors Fastify's former `inject`). */
  const inject = async (options: string | { method?: string; url: string; payload?: unknown }) => {
    const { method = 'GET', url, payload } = typeof options === 'string' ? { url: options } : options;
    const response = await fetch(new URL(url, baseUrl), {
      method,
      ...(payload === undefined
        ? {}
        : { body: typeof payload === 'string' ? payload : JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
    const body = await response.text();
    return { statusCode: response.status, headers: response.headers, body, json: () => JSON.parse(body) };
  };

  beforeEach(async () => {
    source = new FakeSource();
    source.releases = [release('v1', 1)];
    notifier = new RecordingNotifier();
    store = new RepositoryStore(':memory:');
    const settings = new SettingsService(store, loadConfig({ POLL_INTERVAL_MINUTES: '15' }));
    app = await buildApp({
      store,
      settings,
      source,
      notifiers: [notifier],
      log: silentLogger,
      auth: { requireAuth: false },
      fetchInstalledVersion: async (url, _field, headers) => {
        lastHeaders = headers;
        if (url.includes('down')) {
          const { InstalledVersionError } = await import('../src/version.ts');
          throw new InstalledVersionError('Could not reach it');
        }
        return { version: '0.9.0', preview: '"0.9.0"' };
      },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  const add = (repository: string) =>
    inject({ method: 'POST', url: '/api/repositories', payload: { repository } });

  it('lists security advisories with their impact on the installed version', async () => {
    source.advisories = [advisory('GHSA-old1-0000-0000', 1, '< 0.5.0'), advisory('GHSA-new1-0000-0000', 2, '< 1.0.0', { severity: 'critical' })];
    const created = (await add('acme/widget')).json();
    // The first fetch only sets the baseline – no notifications.
    assert.equal(notifier.vulnerabilitiesSent.length, 0);
    assert.deepEqual(created.advisories, { total: 2, affecting: 0, highestSeverity: 'critical', checkedAt: created.advisories.checkedAt, error: null });

    await inject({ method: 'PUT', url: `/api/repositories/${created.id}`, payload: { includePrereleases: false, isEnabled: true, installedVersionUrl: 'https://widget.lan/version' } });
    const repo = (await inject(`/api/repositories/${created.id}`)).json();
    assert.equal(repo.installedVersion, '0.9.0');
    assert.deepEqual([repo.advisories.total, repo.advisories.affecting, repo.advisories.highestSeverity], [2, 1, 'critical']);

    const list = (await inject(`/api/repositories/${created.id}/advisories`)).json();
    assert.deepEqual(
      list.map((a: { id: string; affectsInstalled: boolean | null }) => [a.id, a.affectsInstalled]),
      [['GHSA-new1-0000-0000', true], ['GHSA-old1-0000-0000', false]],
    );
    assert.equal(list[0].vulnerabilities[0].patchedVersions, '2.0.0');
    assert.equal((await inject('/api/repositories/999/advisories')).statusCode, 404);

    // A manual check fetches advisories right away and notifies about a new one affecting 0.9.0.
    source.advisories = [...source.advisories, advisory('GHSA-fresh-0000-0000', 3, '>= 0.8.0, < 0.9.1')];
    const checked = (await inject({ method: 'POST', url: `/api/repositories/${created.id}/check` })).json();
    assert.equal(checked.notifiedCount, 1);
    assert.equal(notifier.vulnerabilitiesSent[0]?.advisory.id, 'GHSA-fresh-0000-0000');
    assert.equal(notifier.vulnerabilitiesSent[0]?.affectsInstalled, true);
    assert.equal(checked.repository.advisories.affecting, 2);
    assert.equal((await inject('/api/repositories')).json()[0].advisories.total, 3);

    const all = (await inject('/api/advisories')).json();
    assert.equal(all.length, 3);
    assert.deepEqual(all[0].repository, {
      id: created.id,
      fullName: 'acme/widget',
      owner: 'acme',
      url: 'https://github.com/acme/widget',
      avatarUrl: 'https://avatars.githubusercontent.com/acme?s=64',
      installedVersion: '0.9.0',
    });
    assert.deepEqual((await inject('/api/status')).json().advisories, { total: 3, affecting: 2 });
  });

  it('configures advisory sources and the OSV.dev package of a repository', async () => {
    const settings = (await inject('/api/settings')).json();
    assert.deepEqual(settings.advisories.github, true);
    assert.deepEqual(settings.advisories.osv, true);
    assert.ok(settings.advisories.osvEcosystems.includes('npm'));
    const updated = (await inject({ method: 'PUT', url: '/api/settings', payload: { advisoriesOsv: false } })).json();
    assert.equal(updated.advisories.osv, false);

    const created = (await add('acme/widget')).json();
    assert.equal(created.osvEcosystem, null);
    const put = (payload: object) =>
      inject({ method: 'PUT', url: `/api/repositories/${created.id}`, payload: { includePrereleases: false, isEnabled: true, ...payload } });

    const half = await put({ osvEcosystem: 'npm' });
    assert.equal(half.statusCode, 400);
    assert.match(half.body, /both the ecosystem and the package name/);
    assert.equal((await put({ osvEcosystem: 'cobol', osvPackage: 'x' })).statusCode, 400);

    const saved = (await put({ osvEcosystem: 'npm', osvPackage: ' widget ' })).json();
    assert.deepEqual([saved.osvEcosystem, saved.osvPackage], ['npm', 'widget']);
    // Omitted = keep, null = remove.
    assert.equal((await put({})).json().osvPackage, 'widget');
    assert.equal((await put({ osvEcosystem: null, osvPackage: null })).json().osvEcosystem, null);
  });

  it('marks API responses as not cacheable', async () => {
    assert.equal((await inject('/api/repositories')).headers.get('cache-control'), 'no-store');
    assert.equal((await add('not a repository')).headers.get('cache-control'), 'no-store');
    assert.equal((await inject('/api/nope')).headers.get('cache-control'), 'no-store');
  });

  it('uses a repository token for a private repository and never returns it', async () => {
    source.privateRepos.set('other/private-app', 'github_pat_other_owner_1234');

    const withoutToken = await add('other/private-app');
    assert.equal(withoutToken.statusCode, 400);
    assert.match(withoutToken.body, /needs a token/);

    const response = await inject({
      method: 'POST',
      url: '/api/repositories',
      payload: { repository: 'other/private-app', githubToken: 'github_pat_other_owner_1234' },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.body.includes('github_pat_other_owner_1234'), false);
    const body = response.json();
    assert.equal(body.hasOwnToken, true);
    assert.equal(body.githubTokenMasked, 'gith…1234');
    // The baseline check already used the repository's token.
    assert.equal(source.lastToken, 'github_pat_other_owner_1234');

    // Keep the token when it is omitted, remove it with null.
    const kept = await inject({
      method: 'PUT',
      url: `/api/repositories/${body.id}`,
      payload: { includePrereleases: false, isEnabled: true },
    });
    assert.equal(kept.json().hasOwnToken, true);
    const removed = await inject({
      method: 'PUT',
      url: `/api/repositories/${body.id}`,
      payload: { includePrereleases: false, isEnabled: true, githubToken: null },
    });
    assert.equal(removed.json().hasOwnToken, false);
    await inject({ method: 'POST', url: `/api/repositories/${body.id}/check` });
    assert.equal(source.lastToken, null);
  });

  it('adds a repository and establishes the baseline', async () => {
    const response = await add('https://github.com/acme/widget');
    assert.equal(response.statusCode, 201);
    const body = response.json();
    assert.equal(body.fullName, 'acme/widget');
    assert.equal(body.avatarUrl, 'https://avatars.githubusercontent.com/acme?s=64');
    assert.equal(body.lastSeenTag, 'v1');
    assert.equal('etag' in body, false);
    assert.equal(notifier.sent.length, 0);
  });

  it('lists repositories by repository name, not by owner', async () => {
    const names = ['zeta/alpha', 'acme/Widget', 'aaa/middle', 'beta/widget'];
    names.forEach((n) => source.existing.add(n.toLowerCase()));
    for (const name of names) {
      assert.equal((await add(name)).statusCode, 201);
    }
    const list = (await inject({ method: 'GET', url: '/api/repositories' })).json();
    assert.deepEqual(
      list.map((r: { fullName: string }) => r.fullName),
      ['zeta/alpha', 'aaa/middle', 'acme/Widget', 'beta/widget'],
    );
  });

  it('rejects duplicates case-insensitively', async () => {
    await add('acme/widget');
    const response = await add('ACME/Widget');
    assert.equal(response.statusCode, 409);
  });

  it('validates the repository name and existence', async () => {
    assert.equal((await add('not a repo')).json().errors.repository.length, 1);
    const missing = await add('acme/missing');
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().errors.repository[0], /not found/);
  });

  it('updates, checks and deletes a repository', async () => {
    const { id } = (await add('acme/widget')).json();

    const updated = await inject({
      method: 'PUT',
      url: `/api/repositories/${id}`,
      payload: { includePrereleases: true, isEnabled: false },
    });
    assert.equal(updated.json().isEnabled, false);

    source.releases = [release('v2', 2), release('v1', 1)];
    const check = await inject({ method: 'POST', url: `/api/repositories/${id}/check` });
    assert.equal(check.json().notifiedCount, 1);

    assert.equal((await inject({ method: 'DELETE', url: `/api/repositories/${id}` })).statusCode, 204);
    assert.equal((await inject({ method: 'DELETE', url: `/api/repositories/${id}` })).statusCode, 404);
  });

  it('lists notifiers and sends a test notification', async () => {
    assert.deepEqual((await inject('/api/notifiers')).json(), [{ name: 'recording', isEnabled: true }]);
    const test = await inject({ method: 'POST', url: '/api/notifiers/test' });
    assert.deepEqual(test.json(), { sent: ['recording'], failed: [] });
  });

  it('reads and updates settings, masking secrets', async () => {
    const initial = (await inject('/api/settings')).json();
    assert.equal(initial.discord.webhookConfigured, false);
    assert.equal(initial.polling.intervalMinutes, 15);
    assert.equal(initial.polling.intervalSource, 'env');

    const webhook = 'https://discord.com/api/webhooks/123456789/secret-token-value';
    const updated = await inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { discordWebhookUrl: webhook, githubToken: 'ghp_abcdefghijklmnop', pollIntervalMinutes: 5 },
    });
    assert.equal(updated.statusCode, 200);
    const body = updated.json();
    assert.equal(body.discord.webhookConfigured, true);
    assert.equal(body.discord.webhookSource, 'ui');
    assert.ok(!JSON.stringify(body).includes('secret-token-value'));
    assert.ok(!JSON.stringify(body).includes('ghp_abcdefghijklmnop'));
    assert.equal(body.polling.intervalMinutes, 5);

    const cleared = await inject({ method: 'PUT', url: '/api/settings', payload: { pollIntervalMinutes: null } });
    assert.equal(cleared.json().polling.intervalMinutes, 15);
  });

  it('validates settings', async () => {
    const badUrl = await inject({ method: 'PUT', url: '/api/settings', payload: { discordWebhookUrl: 'nope' } });
    assert.equal(badUrl.statusCode, 400);
    assert.ok(badUrl.json().errors.discordWebhookUrl);

    const badInterval = await inject({ method: 'PUT', url: '/api/settings', payload: { pollIntervalMinutes: 0 } });
    assert.ok(badInterval.json().errors.pollIntervalMinutes);
  });

  it('saves e-mail and notification settings without returning the SMTP password', async () => {
    const initial = (await inject('/api/settings')).json();
    assert.equal(initial.email.configured, false);
    assert.equal(initial.email.smtpPort, 587);
    assert.equal(initial.email.smtpSecurity, 'starttls');
    assert.deepEqual(initial.notifications, {
      digest: false,
      digestSource: 'env',
      releases: true,
      vulnerabilities: true,
      appUpdates: true,
      aptUpdates: true,
      updateSucceeded: false,
      updateFailed: false,
    });

    const updated = await inject({
      method: 'PUT',
      url: '/api/settings',
      payload: {
        smtpHost: 'smtp.example.com',
        smtpPort: 465,
        smtpSecurity: 'tls',
        smtpUsername: 'alerts',
        smtpPassword: 'smtp-secret-value',
        emailFrom: 'ReleaseWatcher <alerts@example.com>',
        emailTo: 'me@example.com, you@example.com',
        notificationDigest: true,
        notifyAptUpdates: false,
      },
    });
    assert.equal(updated.statusCode, 200);
    const body = updated.json();
    assert.equal(JSON.stringify(body).includes('smtp-secret-value'), false);
    assert.equal(body.email.smtpPasswordConfigured, true);
    assert.equal(body.email.smtpPasswordSource, 'ui');
    assert.equal(body.email.to, 'me@example.com, you@example.com');
    assert.equal(body.notifications.digest, true);
    assert.equal(body.notifications.aptUpdates, false);
    // Encrypted at rest.
    const stored = store.database.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'smtpPassword'").get();
    assert.ok(stored && !stored.value.includes('smtp-secret-value'));

    // Omitted = keep, null = remove.
    const kept = (await inject({ method: 'PUT', url: '/api/settings', payload: { smtpPort: 587 } })).json();
    assert.equal(kept.email.smtpPasswordConfigured, true);
    const removed = (await inject({ method: 'PUT', url: '/api/settings', payload: { smtpPassword: null } })).json();
    assert.equal(removed.email.smtpPasswordConfigured, false);
  });

  it('validates e-mail settings', async () => {
    const put = (payload: object) => inject({ method: 'PUT', url: '/api/settings', payload });
    assert.ok((await put({ emailTo: 'me@example.com, nope' })).json().errors.emailTo);
    assert.ok((await put({ emailFrom: 'x' })).json().errors.emailFrom);
    assert.ok((await put({ smtpSecurity: 'ssl' })).json().errors.smtpSecurity);
    assert.ok((await put({ smtpPort: 70000 })).json().errors.smtpPort);
  });

  it('tests a single notification channel', async () => {
    const one = await inject({ method: 'POST', url: '/api/notifiers/test', payload: { notifier: 'recording' } });
    assert.deepEqual(one.json(), { sent: ['recording'], failed: [] });
    const missing = await inject({ method: 'POST', url: '/api/notifiers/test', payload: { notifier: 'email' } });
    assert.equal(missing.statusCode, 409);
  });

  it('sends the releases of one check run as a digest', async () => {
    await inject({ method: 'PUT', url: '/api/settings', payload: { notificationDigest: true } });
    await add('acme/widget');
    source.releases = [release('v3', 3), release('v2', 2), release('v1', 1)];
    await inject({ method: 'POST', url: '/api/check-all' });
    assert.equal(notifier.sent.length, 0);
    assert.equal(notifier.digests.length, 1);
    assert.deepEqual(
      notifier.digests[0]?.map((e) => (e.type === 'release' ? e.release.release.tag : e.type)),
      ['v2', 'v3'],
    );
  });

  it('reports status and runs a check of all repositories', async () => {
    await add('acme/widget');
    source.releases = [release('v2', 2), release('v1', 1)];
    const status = (await inject({ method: 'POST', url: '/api/check-all' })).json();
    assert.equal(status.repositories.total, 1);
    assert.ok(status.poller.lastRunFinishedAt);
    assert.equal(notifier.sent.length, 1);
  });

  it('configures an installed-version URL and reports available updates', async () => {
    const { id } = (await add('acme/widget')).json();

    const invalid = await inject({
      method: 'PUT',
      url: `/api/repositories/${id}`,
      payload: { includePrereleases: false, isEnabled: true, installedVersionUrl: 'not a url' },
    });
    assert.equal(invalid.statusCode, 400);

    const updated = await inject({
      method: 'PUT',
      url: `/api/repositories/${id}`,
      payload: { includePrereleases: false, isEnabled: true, installedVersionUrl: 'https://widget.lan/api/version' },
    });
    const body = updated.json();
    assert.equal(body.installedVersion, '0.9.0');
    assert.equal(body.updateAvailable, true); // latest release is v1

    const status = (await inject('/api/status')).json();
    assert.equal(status.repositories.updatesAvailable, 1);
    assert.equal(status.version, APP_VERSION);

    // Omitting the fields keeps them.
    const kept = await inject({
      method: 'PUT',
      url: `/api/repositories/${id}`,
      payload: { includePrereleases: true, isEnabled: true },
    });
    assert.equal(kept.json().installedVersionUrl, 'https://widget.lan/api/version');
  });

  it('tests an installed-version URL without saving it', async () => {
    const ok = await inject({ method: 'POST', url: '/api/installed-version/test', payload: { url: 'https://a.lan/v' } });
    assert.deepEqual(ok.json(), { version: '0.9.0', preview: '"0.9.0"' });

    const down = await inject({ method: 'POST', url: '/api/installed-version/test', payload: { url: 'https://down.lan/v' } });
    assert.equal(down.statusCode, 422);
    assert.match(down.json().title, /Could not reach/);
  });

  it('stores headers without ever returning their values', async () => {
    const { id } = (await add('acme/widget')).json();
    const put = (payload: object) =>
      inject({ method: 'PUT', url: `/api/repositories/${id}`, payload: { includePrereleases: false, isEnabled: true, ...payload } });

    const saved = await put({
      installedVersionUrl: 'https://widget.lan/api/version',
      installedVersionHeaders: [{ name: 'Authorization', value: 'Bearer s3cret' }],
    });
    assert.equal(saved.statusCode, 200);
    assert.deepEqual(saved.json().installedVersionHeaders, [{ name: 'Authorization', hasValue: true }]);
    assert.ok(!saved.body.includes('s3cret'));
    assert.deepEqual(lastHeaders, [{ name: 'Authorization', value: 'Bearer s3cret' }]);

    // Re-sending the header without a value keeps the stored secret; a new header needs a value.
    await put({ installedVersionHeaders: [{ name: 'Authorization' }, { name: 'X-Extra', value: '1' }] });
    const test = await inject({
      method: 'POST',
      url: '/api/installed-version/test',
      payload: { url: 'https://widget.lan/api/version', headers: [{ name: 'Authorization' }], repositoryId: id },
    });
    assert.equal(test.statusCode, 200);
    assert.deepEqual(lastHeaders, [{ name: 'Authorization', value: 'Bearer s3cret' }]);

    const missing = await put({ installedVersionHeaders: [{ name: 'X-New' }] });
    assert.equal(missing.statusCode, 400);
    assert.match(missing.json().errors.installedVersionHeaders[0], /value/);

    const cleared = await put({ installedVersionHeaders: [] });
    assert.deepEqual(cleared.json().installedVersionHeaders, []);
  });

  it('rejects malformed requests with a validation problem', async () => {
    const wrongType = await inject({ method: 'POST', url: '/api/repositories', payload: { repository: 42 } });
    assert.equal(wrongType.statusCode, 400);
    assert.equal(wrongType.headers.get('content-type'), 'application/problem+json');
    assert.deepEqual(wrongType.json().errors, { request: ['body/repository must be string'] });

    const missing = await inject({ method: 'PUT', url: '/api/repositories/1', payload: { isEnabled: true } });
    assert.match(missing.json().errors.request[0], /required property 'includePrereleases'/);

    const badJson = await inject({ method: 'POST', url: '/api/repositories', payload: '{oops' });
    assert.equal(badJson.statusCode, 400);

    const badId = await inject('/api/repositories/abc');
    assert.equal(badId.statusCode, 400);
    assert.equal((await inject('/api/repositories/0')).statusCode, 400);
  });

  it('ignores unknown settings properties', async () => {
    const response = await inject({ method: 'PUT', url: '/api/settings', payload: { unknown: 1, pollIntervalMinutes: 7 } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().polling.intervalMinutes, 7);
  });

  it('answers unknown routes with a 404 problem when no UI is built', async () => {
    assert.equal((await inject('/api/nope')).statusCode, 404);
    assert.equal((await inject('/some/page')).json().title, 'Not found.');
  });
});

describe('UI hosting', () => {
  const bigScript = `console.log(${JSON.stringify('x'.repeat(4000))});`;
  let app: App;
  let baseUrl: URL;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'releasewatcher-ui-'));
    mkdirSync(join(dir, 'public'));
    writeFileSync(join(dir, 'public', 'index.html'), '<app-root></app-root>');
    writeFileSync(join(dir, 'public', 'main.js'), 'console.log(1);');
    writeFileSync(join(dir, 'public', 'chunk-AB12cd34.js'), 'export const a = 1;');
    writeFileSync(join(dir, 'public', 'big.js'), bigScript);
    writeFileSync(join(dir, 'secret.txt'), 'top secret');
    const store = new RepositoryStore(':memory:');
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source: new FakeSource(),
      notifiers: [],
      publicDir: join(dir, 'public'),
      log: silentLogger,
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const get = (path: string) => fetch(new URL(path, baseUrl));

  it('serves static files with a content type', async () => {
    const response = await get('/main.js');
    assert.equal(await response.text(), 'console.log(1);');
    assert.match(response.headers.get('content-type') ?? '', /javascript/);
  });

  it('falls back to index.html for client-side routes but not for the API', async () => {
    assert.equal(await (await get('/')).text(), '<app-root></app-root>');
    assert.equal(await (await get('/settings')).text(), '<app-root></app-root>');
    // The UI is public, the API is not: without a session unknown API paths are 401, not the SPA.
    assert.equal((await get('/api/nope')).status, 401);
  });

  it('caches hashed assets forever and revalidates everything else', async () => {
    assert.equal((await get('/chunk-AB12cd34.js')).headers.get('cache-control'), 'public, max-age=31536000, immutable');
    for (const path of ['/', '/index.html', '/settings', '/main.js']) {
      assert.equal((await get(path)).headers.get('cache-control'), 'no-cache', path);
    }
  });

  it('answers a matching If-None-Match with 304', async () => {
    const first = await get('/settings');
    const etag = first.headers.get('etag');
    assert.ok(etag);
    const again = await fetch(new URL('/', baseUrl), { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.headers.get('etag'), etag);
    assert.equal(await again.text(), '');
    const changed = await fetch(new URL('/', baseUrl), { headers: { 'if-none-match': '"other"' } });
    assert.equal(changed.status, 200);
  });

  it('serves zstd to browsers that accept it, with its own ETag', async () => {
    const script = bigScript;
    const url = new URL('/big.js', baseUrl);

    const zstd = await fetch(url, { headers: { 'accept-encoding': 'gzip, br, zstd' }, decompress: false });
    assert.equal(zstd.headers.get('content-encoding'), 'zstd');
    assert.equal(zstd.headers.get('vary'), 'Accept-Encoding');
    assert.match(zstd.headers.get('content-type') ?? '', /javascript/);
    const body = new Uint8Array(await zstd.arrayBuffer());
    assert.ok(body.length < script.length / 10);
    assert.equal(new TextDecoder().decode(Bun.zstdDecompressSync(body)), script);

    const plain = await fetch(url, { headers: { 'accept-encoding': 'gzip, br' }, decompress: false });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.equal(await plain.text(), script);
    assert.notEqual(plain.headers.get('etag'), zstd.headers.get('etag'));
  });

  it('answers HEAD requests without a body', async () => {
    const response = await fetch(new URL('/main.js', baseUrl), { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.ok(response.headers.get('etag'));
    assert.equal(await response.text(), '');
  });

  it('returns 404 instead of index.html for missing files, e.g. chunks of an older build', async () => {
    const response = await get('/chunk-OLD12345.js');
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  });

  it('never serves files outside the UI directory', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/%2e%2e%5csecret.txt']) {
      assert.ok(!(await (await get(path)).text()).includes('top secret'), path);
    }
  });
});

describe('UI embedded in a compiled executable', () => {
  it('serves files from the embedded map with an index.html fallback', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-embedded-'));
    writeFileSync(join(dir, 'index-abc.html'), '<app-root></app-root>');
    writeFileSync(join(dir, 'main-abc.js'), 'console.log(1);');
    const store = new RepositoryStore(':memory:');
    const app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source: new FakeSource(),
      notifiers: [],
      embeddedUi: new Map([
        ['/index.html', join(dir, 'index-abc.html')],
        ['/main.js', join(dir, 'main-abc.js')],
      ]),
      publicDir: join(dir, 'does-not-matter'),
      log: silentLogger,
    });
    const baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
    try {
      const js = await fetch(new URL('/main.js', baseUrl));
      assert.equal(await js.text(), 'console.log(1);');
      assert.match(js.headers.get('content-type') ?? '', /javascript/);
      assert.equal(await (await fetch(new URL('/repositories', baseUrl))).text(), '<app-root></app-root>');
      assert.equal((await fetch(new URL('/api/nope', baseUrl))).status, 401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
