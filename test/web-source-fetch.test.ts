import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  displayName,
  selectNewReleases,
  setWebSource,
  webSourceHost,
  webSourceNameError,
  type ReleaseInfo,
  type WatchedRepository,
} from '../src/domain.ts';
import { ReleaseSourceError } from '../src/release-source.ts';
import type { WebSourceConfig } from '../src/web-source/domain.ts';
import { fetchWebDocument } from '../src/web-source/fetch.ts';
import { webReleaseOrder } from '../src/web-source/source.ts';

const respond = (response: () => Response, seen: Headers[] = []) =>
  (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return response();
  }) as typeof fetch;

describe('fetchWebDocument', () => {
  it('keeps Last-Modified as the validator when there is no ETag and sends it back', async () => {
    const seen: Headers[] = [];
    const first = await fetchWebDocument(
      respond(() => new Response('v1.2.3', { headers: { 'last-modified': 'Tue, 24 Nov 2026 06:47:09 GMT', 'content-type': 'text/plain' } }), seen),
      'https://example.com/',
    );
    assert.equal(first.notModified, false);
    assert.equal(first.validator, 'last-modified:Tue, 24 Nov 2026 06:47:09 GMT');

    const second = await fetchWebDocument(respond(() => new Response(null, { status: 304 }), seen), 'https://example.com/', { validator: first.validator });
    assert.deepEqual(second, { notModified: true, validator: first.validator });
    assert.equal(seen[1]?.get('if-modified-since'), 'Tue, 24 Nov 2026 06:47:09 GMT');
    assert.equal(seen[1]?.get('if-none-match'), null);
  });

  it('decodes the charset of the page and leaves HTML error pages out of the message', async () => {
    const latin2 = new Uint8Array([0x5a, 0xb3, 0xf3, 0x74, 0x79, 0x20, 0x31, 0x2e, 0x32]); // "Złóty 1.2" in ISO-8859-2
    const page = await fetchWebDocument(respond(() => new Response(latin2, { headers: { 'content-type': 'text/plain; charset=ISO-8859-2' } })), 'https://example.com/');
    assert.equal(page.notModified ? null : page.body, 'Złóty 1.2');

    const cloudflare = respond(() => new Response('<!DOCTYPE html><html>Just a moment…</html>', { status: 403, headers: { 'content-type': 'text/html' } }));
    await assert.rejects(fetchWebDocument(cloudflare, 'https://example.com/'), (error: unknown) => {
      assert.equal((error as Error).message, 'https://example.com/ answered 403. The site may block automated requests.');
      return true;
    });
  });

  it('refuses a body whose declared length is over the limit', async () => {
    const fetcher = respond(() => new Response('x', { headers: { 'content-length': String(100 * 1024 * 1024) } }));
    await assert.rejects(fetchWebDocument(fetcher, 'https://example.com/'), /larger than/);
  });

  it('turns network errors into a message for the user', async () => {
    const fetcher = (async () => {
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    await assert.rejects(fetchWebDocument(fetcher, 'https://example.com/'), (error: unknown) => {
      assert.ok(error instanceof ReleaseSourceError);
      assert.match(error.message, /could not be reached: connect ECONNREFUSED/);
      return true;
    });
  });
});

describe('web source domain', () => {
  const config: WebSourceConfig = { url: 'https://www.ui.com/download', format: 'text', items: null, version: null, date: null, link: null, userAgent: null };
  const source = (): WatchedRepository =>
    ({
      provider: 'web',
      host: 'ui.com',
      owner: 'web',
      name: 'UniFi Network',
      webSource: config,
      versionPattern: '(\\d+)',
      lastSeenTag: '10.6.109',
      lastSeenPublishedAt: '2026-11-01T00:00:00.000Z',
      lastCheckedAt: '2026-11-01T00:00:00.000Z',
      releasesEtag: '"x"',
    }) as WatchedRepository;

  it('refuses names with a slash (part of the key)', () => {
    assert.equal(webSourceNameError('UniFi Network'), null);
    assert.match(webSourceNameError('UniFi/Network') ?? '', /slash/);
    assert.match(webSourceNameError(null) ?? '', /Enter a name/);
  });

  it('stores the host without www and shows the given name', () => {
    assert.equal(webSourceHost('https://WWW.ui.com/download'), 'ui.com');
    assert.equal(webSourceHost('http://git.example.com:3000/x'), 'git.example.com:3000');
    assert.equal(displayName(source()), 'UniFi Network');
    assert.equal(displayName({ provider: 'gitea', host: 'codeberg.org', owner: 'forgejo', name: 'forgejo' }), 'codeberg.org/forgejo/forgejo');
  });

  it('sets a new baseline when what is read changes, but not for the User-Agent alone', () => {
    const repo = source();
    assert.equal(setWebSource(repo, { ...config }, '(\\d+)'), false);

    assert.equal(setWebSource(repo, { ...config, userAgent: 'Mozilla/5.0' }, '(\\d+)'), true);
    assert.equal(repo.lastSeenTag, '10.6.109');
    assert.equal(repo.releasesEtag, null);

    assert.equal(setWebSource(repo, { ...config, userAgent: 'Mozilla/5.0' }, 'Network (\\d+)'), true);
    assert.equal(repo.lastSeenTag, null);
    assert.equal(repo.lastCheckedAt, null);
  });

  it('orders by date when the source locates dates, otherwise by version', () => {
    assert.equal(webReleaseOrder({ format: 'xml', date: 'pubDate' }), 'date');
    assert.equal(webReleaseOrder({ format: 'html', date: null }), 'version');
    assert.equal(webReleaseOrder({ format: 'text', date: 'ignored' }), 'version');
  });
});

describe('selectNewReleases with dates of a day', () => {
  const day = (tag: string, date = '2026-10-23'): ReleaseInfo => ({
    tag,
    name: null,
    htmlUrl: 'https://example.com/',
    body: null,
    isPrerelease: false,
    publishedAt: new Date(date).toISOString(),
    authorLogin: null,
    authorAvatarUrl: null,
  });
  const checked = { includePrereleases: false, lastCheckedAt: '2026-10-24T00:00:00.000Z' };

  it('takes the higher version of the same date as the newest', () => {
    const { newest } = selectNewReleases({ ...checked, lastCheckedAt: null, lastSeenPublishedAt: null, lastSeenTag: null }, [day('10.6.109'), day('10.6.108')]);
    assert.equal(newest?.tag, '10.6.109');
  });

  it('announces a hotfix of the same date as the baseline, but not the baseline or older ones', () => {
    const baseline = { ...checked, lastSeenTag: '10.6.109', lastSeenPublishedAt: new Date('2026-10-23').toISOString() };
    const { newReleases, newest } = selectNewReleases(baseline, [day('10.6.110'), day('10.6.109'), day('10.6.108'), day('10.6.107', '2026-10-01')]);
    assert.deepEqual(newReleases.map((r) => r.tag), ['10.6.110']);
    assert.equal(newest?.tag, '10.6.110');
  });
});
