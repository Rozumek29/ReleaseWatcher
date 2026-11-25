import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { displayName, setWebSource, webSourceHost, type WatchedRepository } from '../src/domain.ts';
import { ReleaseSourceError } from '../src/release-source.ts';
import type { WebSourceConfig } from '../src/web-source/domain.ts';
import { fetchWebDocument } from '../src/web-source/fetch.ts';
import { webReleaseOrder } from '../src/web-source/source.ts';
import { release } from './helpers.ts';

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

  it('orders by date only when every entry has one', () => {
    assert.equal(webReleaseOrder([release('1.0.0', 1), release('1.1.0', 2)]), 'date');
    assert.equal(webReleaseOrder([release('1.0.0', 1), { ...release('1.1.0', 2), publishedAt: '' }]), 'version');
    assert.equal(webReleaseOrder([]), 'version');
  });
});
