import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { notificationFullName, notificationRepoUrl } from '../src/notifiers/notifier.ts';
import { ProviderReleaseSource } from '../src/release-source.ts';
import { SettingsService } from '../src/settings.ts';
import { MAX_WEB_SOURCE_BYTES, WEB_SOURCE_USER_AGENT } from '../src/web-source/fetch.ts';
import { WebReleaseSource } from '../src/web-source/source.ts';
import { FakeSource, RecordingNotifier } from './helpers.ts';

const fixture = (name: string) => readFileSync(join(import.meta.dir, 'fixtures', 'web-source', name), 'utf8');

const AMP_URL = 'https://discourse.cubecoders.com/c/news/6.rss';
const TRUENAS_URL = 'https://www.truenas.com/docs/softwarestatus/';
const RSS = { format: 'xml', items: 'item', version: 'title', date: 'pubDate', link: 'link', userAgent: null } as const;
const AMP_PATTERN = String.raw`v(\d+\.\d+\.\d+) Release Notes`;

/** A newer AMP release on top of the feed. */
const NEWER_ITEM = `<item><title>AMP 3 Beta 'Neptune' - v3.0.3 Release Notes</title><link>https://discourse.cubecoders.com/t/amp-3-0-3/1</link><pubDate>Wed, 25 Nov 2026 08:00:00 +0000</pubDate></item>`;

interface Page {
  status?: number;
  body: string;
  contentType: string;
  etag?: string;
}

describe('web sources (provider web)', () => {
  let app: App;
  let store: RepositoryStore;
  let notifier: RecordingNotifier;
  let pages: Map<string, Page>;
  let requests: { url: string; headers: Headers }[];
  let baseUrl: URL;

  /** Serves `pages` by URL; answers 304 when the request carries the page's ETag. */
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    requests.push({ url, headers });
    const page = pages.get(url);
    if (!page) {
      return new Response('Not found', { status: 404 });
    }
    if (page.etag && headers.get('if-none-match') === page.etag) {
      return new Response(null, { status: 304 });
    }
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { 'content-type': page.contentType, ...(page.etag ? { etag: page.etag } : {}) },
    });
  }) as typeof fetch;

  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const startApp = async (repositoryStore: RepositoryStore) => {
    const settings = new SettingsService(repositoryStore, loadConfig({}));
    const git = new FakeSource();
    const instance = await buildApp({
      store: repositoryStore,
      settings,
      source: new ProviderReleaseSource({ github: git, gitea: git, gitlab: git, web: new WebReleaseSource({ fetch: fakeFetch }) }),
      notifiers: [notifier],
      log: silentLogger,
      auth: { requireAuth: false },
      fetchWebSource: fakeFetch,
    });
    return { instance, url: instance.listen({ port: 0, hostname: '127.0.0.1' }).url };
  };

  beforeEach(async () => {
    pages = new Map([
      [AMP_URL, { body: fixture('amp-news.rss'), contentType: 'application/rss+xml; charset=utf-8', etag: '"feed-1"' }],
      [TRUENAS_URL, { body: fixture('truenas-status.html'), contentType: 'text/html; charset=utf-8' }],
    ]);
    requests = [];
    notifier = new RecordingNotifier();
    store = new RepositoryStore(':memory:');
    const started = await startApp(store);
    app = started.instance;
    baseUrl = started.url;
  });

  afterEach(() => app.close());

  const addAmp = (extra: Record<string, unknown> = {}) =>
    request('POST', '/api/repositories', { name: 'AMP', webSource: { url: AMP_URL, ...RSS }, versionPattern: AMP_PATTERN, ...extra });

  it('adds a web source and sets the baseline without notifying', async () => {
    const created = await addAmp();
    assert.equal(created.status, 201);
    assert.equal(created.body.provider, 'web');
    assert.equal(created.body.host, 'discourse.cubecoders.com');
    assert.equal(created.body.owner, 'web');
    assert.equal(created.body.name, 'AMP');
    assert.equal(created.body.url, AMP_URL);
    assert.equal(created.body.avatarUrl, null);
    assert.deepEqual(created.body.webSource, { url: AMP_URL, ...RSS });
    assert.equal(created.body.versionPattern, AMP_PATTERN);
    assert.equal(created.body.lastSeenTag, '3.0.2');
    assert.equal(created.body.lastSeenUrl, AMP_URL);
    assert.equal(created.body.lastError, null);
    assert.equal(notifier.sent.length, 0);
    assert.equal(requests[0]?.headers.get('user-agent'), WEB_SOURCE_USER_AGENT);
  });

  it('notifies about a new entry with the source name and page, and asks conditionally', async () => {
    const { body: repo } = await addAmp();
    // Unchanged feed: the ETag makes it a 304.
    assert.equal((await request('POST', `/api/repositories/${repo.id}/check`)).status, 200);
    assert.equal(requests.at(-1)?.headers.get('if-none-match'), '"feed-1"');
    assert.equal(notifier.sent.length, 0);

    const feed = fixture('amp-news.rss').replace('<item>', `${NEWER_ITEM}<item>`);
    pages.set(AMP_URL, { body: feed, contentType: 'application/rss+xml', etag: '"feed-2"' });
    await request('POST', `/api/repositories/${repo.id}/check`);

    assert.equal(notifier.sent.length, 1);
    const sent = notifier.sent[0]!;
    assert.equal(sent.release.tag, '3.0.3');
    assert.equal(sent.release.htmlUrl, 'https://discourse.cubecoders.com/t/amp-3-0-3/1');
    assert.equal(notificationFullName(sent), 'AMP');
    assert.equal(notificationRepoUrl(sent), AMP_URL);
    assert.equal((await request('GET', `/api/repositories/${repo.id}`)).body.lastSeenTag, '3.0.3');
  });

  it('keeps the order of a dated source when an entry has no date yet', async () => {
    const item = (version: string, date: string | null) =>
      `<item><title>v${version} Release Notes</title><link>https://discourse.cubecoders.com/t/${version}</link>${date ? `<pubDate>${date}</pubDate>` : ''}</item>`;
    const feed = (...items: string[]) => `<rss><channel>${items.join('')}</channel></rss>`;
    const backport = item('1.9.5', 'Sat, 10 Jan 2026 10:00:00 +0000');
    const major = item('2.0.0', 'Mon, 05 Jan 2026 10:00:00 +0000');
    pages.set(AMP_URL, { body: feed(backport, major), contentType: 'application/rss+xml' });
    const { body: repo } = await addAmp();
    assert.equal(repo.lastSeenTag, '1.9.5');

    // A new entry without a date is left out (no flip to "by version", which would announce 2.0.0 again).
    pages.set(AMP_URL, { body: feed(item('2.1.0', null), backport, major), contentType: 'application/rss+xml' });
    await request('POST', `/api/repositories/${repo.id}/check`);
    assert.equal(notifier.sent.length, 0);

    // Once dated, it is announced; a later release still is.
    pages.set(AMP_URL, { body: feed(item('2.1.0', 'Mon, 12 Jan 2026 10:00:00 +0000'), backport, major), contentType: 'application/rss+xml' });
    await request('POST', `/api/repositories/${repo.id}/check`);
    pages.set(AMP_URL, {
      body: feed(item('2.1.1', 'Tue, 13 Jan 2026 10:00:00 +0000'), item('2.1.0', 'Mon, 12 Jan 2026 10:00:00 +0000'), backport, major),
      contentType: 'application/rss+xml',
    });
    await request('POST', `/api/repositories/${repo.id}/check`);
    assert.deepEqual(notifier.sent.map((n) => n.release.tag), ['2.1.0', '2.1.1']);
  });

  it('sends a custom User-Agent', async () => {
    await addAmp({ webSource: { url: AMP_URL, ...RSS, userAgent: 'Mozilla/5.0 Test' } });
    assert.equal(requests[0]?.headers.get('user-agent'), 'Mozilla/5.0 Test');
  });

  it('validates the name, the source and the pattern', async () => {
    const noName = await request('POST', '/api/repositories', { name: ' ', webSource: { url: AMP_URL, ...RSS } });
    assert.equal(noName.status, 400);
    assert.ok(noName.body.errors.name);

    const badUrl = await request('POST', '/api/repositories', { name: 'X', webSource: { ...RSS, url: 'ftp://example.com' } });
    assert.equal(badUrl.status, 400);
    assert.ok(badUrl.body.errors['webSource.url']);

    const textWithoutPattern = await request('POST', '/api/repositories', { name: 'X', webSource: { url: TRUENAS_URL, format: 'text' } });
    assert.equal(textWithoutPattern.status, 400);
    assert.ok(textWithoutPattern.body.errors.versionPattern);

    const badPattern = await addAmp({ versionPattern: '(' });
    assert.equal(badPattern.status, 400);
    assert.ok(badPattern.body.errors.versionPattern);
    assert.equal(store.list().length, 0);
  });

  it('refuses a second source with the same name on the same host', async () => {
    await addAmp();
    const again = await request('POST', '/api/repositories', { name: 'amp', webSource: { url: 'https://discourse.cubecoders.com/latest.rss', ...RSS } });
    assert.equal(again.status, 409);
  });

  it('renames a source, moves it to another page and sets a new baseline', async () => {
    const { body: repo } = await addAmp();
    const base = { includePrereleases: false, isEnabled: true };
    const updated = await request('PUT', `/api/repositories/${repo.id}`, {
      ...base,
      name: 'TrueNAS',
      webSource: { url: TRUENAS_URL, format: 'text' },
      versionPattern: String.raw`Latest:\s*([\d.]+)`,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, 'TrueNAS');
    assert.equal(updated.body.host, 'truenas.com');
    assert.equal(updated.body.fullName, 'truenas.com/web/TrueNAS');
    // Checked right away: highest version on the page, no notification for the new baseline.
    assert.equal(updated.body.lastSeenTag, '25.10.8');
    assert.equal(notifier.sent.length, 0);

    const github = await request('POST', '/api/repositories', { repository: 'acme/widget' });
    const renamed = await request('PUT', `/api/repositories/${github.body.id}`, { ...base, name: 'Widget' });
    assert.equal(renamed.status, 400);
  });

  it('previews a source without saving it', async () => {
    const preview = await request('POST', '/api/web-sources/preview', {
      webSource: { url: TRUENAS_URL, format: 'html', version: 'dt a.gdoc-props__title' },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.detectedFormat, 'html');
    assert.equal(preview.body.order, 'version');
    assert.equal(preview.body.newest, '25.10.8');
    assert.ok(preview.body.releases.some((r: { version: string }) => r.version === '25.04.2.6'));
    assert.equal(store.list().length, 0);

    const feed = await request('POST', '/api/web-sources/preview', { webSource: { url: AMP_URL, ...RSS }, versionPattern: AMP_PATTERN });
    assert.equal(feed.body.order, 'date');
    assert.deepEqual(
      feed.body.releases.map((r: { version: string }) => r.version),
      ['3.0.2', '3.0.1'],
    );
    assert.equal(feed.body.releases[0].title, "AMP 3 Beta 'Neptune' - v3.0.2 Release Notes");
    assert.equal(feed.body.newest, '3.0.2');
  });

  it('reports pages that cannot be read', async () => {
    pages.set('https://blocked.example/', { status: 403, body: 'Forbidden', contentType: 'text/plain' });
    const blocked = await request('POST', '/api/web-sources/preview', { webSource: { url: 'https://blocked.example/', format: 'text' }, versionPattern: '(\\d+)' });
    assert.equal(blocked.status, 502);
    assert.match(blocked.body.detail, /block automated requests/);

    pages.set('https://json.example/', { body: '<html>', contentType: 'text/html' });
    const notJson = await request('POST', '/api/web-sources/preview', { webSource: { url: 'https://json.example/', format: 'json', version: 'version' } });
    assert.equal(notJson.status, 400);
    assert.ok(notJson.body.errors['webSource.format']);

    pages.set('https://huge.example/', { body: 'x'.repeat(MAX_WEB_SOURCE_BYTES + 1), contentType: 'text/plain' });
    const huge = await request('POST', '/api/web-sources/preview', { webSource: { url: 'https://huge.example/', format: 'text' }, versionPattern: '(\\d+)' });
    assert.equal(huge.status, 502);
    assert.match(huge.body.detail, /larger than/);
  });

  it('keeps an error of a failed check on the source', async () => {
    const { body: repo } = await addAmp();
    pages.delete(AMP_URL);
    await request('POST', `/api/repositories/${repo.id}/check`);
    assert.match((await request('GET', `/api/repositories/${repo.id}`)).body.lastError, /answered 404/);
  });

  it('exports web sources and imports them into another installation', async () => {
    await addAmp();
    const backup = (await request('GET', '/api/backup/export')).body;
    const exported = backup.repositories.find((r: { provider: string }) => r.provider === 'web');
    assert.deepEqual(exported.webSource, { url: AMP_URL, ...RSS });

    const other = new RepositoryStore(':memory:');
    const started = await startApp(other);
    try {
      const response = await fetch(new URL('/api/backup/import', started.url), {
        method: 'POST',
        body: JSON.stringify({ backup, mode: 'merge' }),
        headers: { 'content-type': 'application/json' },
      });
      assert.equal(response.status, 200, await response.clone().text());
      const imported = other.list().find((r) => r.provider === 'web');
      assert.equal(imported?.name, 'AMP');
      assert.equal(imported?.host, 'discourse.cubecoders.com');
      assert.deepEqual(imported?.webSource, { url: AMP_URL, ...RSS });
      assert.equal(imported?.versionPattern, AMP_PATTERN);
    } finally {
      started.instance.close();
    }
  });
});
