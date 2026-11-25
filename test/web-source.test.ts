import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { PatternError } from '../src/pattern.ts';
import {
  ATOM_PRESET,
  detectFormat,
  MAX_CANDIDATES,
  parseJsonPath,
  RSS_PRESET,
  scopedSelector,
  selectJsonPath,
  splitSelectorList,
  validateWebSource,
  WebSourceError,
  xmlSelector,
  type WebSourceConfig,
} from '../src/web-source/domain.ts';
import { decodeEntities, extractReleases, parseDate, plainText, prepareXml, resolveLink } from '../src/web-source/extract.ts';

const fixture = (name: string): Promise<string> => Bun.file(`${import.meta.dir}/fixtures/web-source/${name}`).text();

const config = (extra: Partial<WebSourceConfig> = {}): WebSourceConfig => ({
  url: 'https://example.org/releases/',
  format: 'html',
  items: null,
  version: null,
  date: null,
  link: null,
  userAgent: null,
  ...extra,
});

const versions = (releases: { version: string }[]): string[] => releases.map((release) => release.version);

describe('extractReleases – real pages', () => {
  it('reads release notes from an RSS feed (AMP) and skips items the pattern does not match', async () => {
    const releases = await extractReleases(
      await fixture('amp-news.rss'),
      config({ ...RSS_PRESET, url: 'https://discourse.cubecoders.com/c/news/6.rss' }),
      String.raw`v(\d+\.\d+\.\d+) Release Notes`,
    );
    assert.deepEqual(releases, [
      {
        version: '3.0.2',
        title: "AMP 3 Beta 'Neptune' - v3.0.2 Release Notes",
        publishedAt: '2026-11-19T16:40:56.000Z',
        url: 'https://discourse.cubecoders.com/t/amp-3-beta-neptune-v3-0-2-release-notes/43715',
      },
      {
        version: '3.0.1',
        title: "AMP 3 Beta 'Neptune' - v3.0.1 Release Notes",
        publishedAt: '2026-11-13T16:29:29.000Z',
        url: 'https://discourse.cubecoders.com/t/amp-3-beta-neptune-v3-0-1-release-notes/43679',
      },
    ]);
  });

  it('reads every element matching the version selector of an HTML page (TrueNAS)', async () => {
    const releases = await extractReleases(
      await fixture('truenas-status.html'),
      config({ url: 'https://www.truenas.com/docs/softwarestatus/', version: 'dt a.gdoc-props__title' }),
      null,
    );
    assert.deepEqual(versions(releases).slice(0, 4), ['25.04.2.6', '25.04.2.5', '25.04.2.4', '25.04.2.3']);
    assert.ok(versions(releases).includes('25.10.8'));
    assert.equal(releases[0]?.title, '25.04.2.6');
  });

  it('reads items with relative version, date and link selectors (TrueNAS)', async () => {
    const releases = await extractReleases(
      await fixture('truenas-status.html'),
      config({
        url: 'https://www.truenas.com/docs/softwarestatus/',
        items: 'dt',
        version: 'a.gdoc-props__title',
        date: 'span.gdoc-props__tag:not(.note)',
        link: 'a',
      }),
      null,
    );
    assert.equal(releases[0]?.version, '25.04.2.6');
    assert.ok(releases[0]?.publishedAt?.startsWith('2025-10-'));
    assert.equal(
      releases[0]?.url,
      'https://www.truenas.com/docs/scale/25.04/gettingstarted/scalereleasenotes/#250426',
    );
  });

  it('finds versions in the text of a page with the text format (TrueNAS)', async () => {
    const releases = await extractReleases(
      await fixture('truenas-status.html'),
      config({ format: 'text' }),
      String.raw`Latest:\s*([\d.]+)`,
    );
    assert.deepEqual(releases, [
      { version: '25.04.2.6', title: null, publishedAt: null, url: null },
      { version: '25.10.8', title: null, publishedAt: null, url: null },
    ]);
  });

  it('finds versions inside script payloads with the text format (UniFi)', async () => {
    const releases = await extractReleases(
      await fixture('unifi-download.html'),
      config({ format: 'text', url: 'https://www.ui.com/download' }),
      String.raw`UniFi Network Application (\d+\.\d+\.\d+)`,
    );
    assert.deepEqual(versions(releases), ['10.6.109', '10.5.67', '10.4.57']);
  });
});

describe('extractReleases – JSON', () => {
  const downloads = config({
    url: 'https://community.ui.com/downloads',
    format: 'json',
    items: 'downloads',
    version: 'version',
    date: 'date_published',
    link: 'release_notes_url',
  });

  it('reads items of an array, dedupes versions and resolves links', async () => {
    const releases = await extractReleases(await fixture('software-downloads.json'), downloads, null);
    assert.deepEqual(releases, [
      {
        version: '10.6.109',
        title: '10.6.109',
        publishedAt: '2026-10-23T00:00:00.000Z',
        url: 'https://community.ui.com/releases/r/network/10.6.109',
      },
      {
        version: '10.5.67',
        title: '10.5.67',
        publishedAt: '2026-08-07T00:00:00.000Z',
        url: 'https://community.ui.com/releases/r/network/10.5.67',
      },
      // A number version and a Unix timestamp; a null link stays null.
      { version: '6.1', title: '6.1', publishedAt: '2025-10-23T00:00:00.000Z', url: null },
    ]);
  });

  it('accepts [*] in the items path and a pattern on another field', async () => {
    const releases = await extractReleases(
      await fixture('software-downloads.json'),
      { ...downloads, items: 'downloads[*]', version: 'name' },
      String.raw`for (\w+)`,
    );
    assert.deepEqual(versions(releases), ['Debian', 'Windows', 'UniFi']);
    assert.equal(releases[0]?.title, 'UniFi Network Application for Debian/Ubuntu Linux');
  });

  it('without items, takes every value of the version path and gives the date to the first one', async () => {
    const releases = await extractReleases(
      await fixture('software-downloads.json'),
      config({ format: 'json', version: 'downloads[*].version', date: 'downloads[0].date_published' }),
      null,
    );
    assert.deepEqual(versions(releases), ['10.6.109', '10.5.67', '6.1']);
    assert.equal(releases[0]?.publishedAt, '2026-10-23T00:00:00.000Z');
    assert.equal(releases[1]?.publishedAt, null);
  });

  it('reads a plain JSON value and a single object', async () => {
    assert.deepEqual(versions(await extractReleases('"1.32.0"', config({ format: 'json' }), null)), ['1.32.0']);
    const single = await extractReleases(
      '{"tag_name":"v2.0.1","published_at":"2026-01-02T03:04:05Z","html_url":"/r/2.0.1"}',
      config({ format: 'json', version: 'tag_name', date: 'published_at', link: 'html_url' }),
      null,
    );
    assert.deepEqual(single, [
      {
        version: 'v2.0.1',
        title: 'v2.0.1',
        publishedAt: '2026-01-02T03:04:05.000Z',
        url: 'https://example.org/r/2.0.1',
      },
    ]);
  });

  it('rejects a body that is not JSON', async () => {
    await assert.rejects(extractReleases('<html></html>', config({ format: 'json' }), null), WebSourceError);
  });
});

describe('extractReleases – HTML and XML', () => {
  it('reads an Atom feed with the preset (CDATA, link href, published before updated)', async () => {
    const releases = await extractReleases(
      await fixture('atom.xml'),
      config({ ...ATOM_PRESET, url: 'https://example.org/feed.atom' }),
      String.raw`\d+\.\d+\.\d+`,
    );
    assert.deepEqual(releases, [
      {
        version: '2.1.0',
        title: 'Example 2.1.0 <em>&</em> friends',
        publishedAt: '2026-11-19T08:30:00.000Z',
        url: 'https://example.org/releases/2.1.0',
      },
      {
        version: '2.0.0',
        title: 'Example 2.0.0',
        publishedAt: '2026-10-01T10:00:00.000Z',
        url: 'https://example.org/releases/2.0.0',
      },
    ]);
  });

  it('keeps a feed item without a pattern when its title holds a dotted version; drops bad dates and javascript: links', async () => {
    const releases = await extractReleases(await fixture('atom.xml'), config({ ...ATOM_PRESET }), null);
    assert.deepEqual(releases[2], { version: 'Roadmap for 2027.1', title: 'Roadmap for 2027.1', publishedAt: null, url: null });
  });

  it('skips texts without a dotted version when there is no pattern', async () => {
    const html = '<a class="t">28 Nightlies</a><a class="t">27-RC.1</a><a class="t">25.10.8</a><a class="t">22.02.4 (Angelfish)</a>';
    assert.deepEqual(versions(await extractReleases(html, config({ version: '.t' }), null)), ['25.10.8', '22.02.4 (Angelfish)']);
  });

  it('selects namespaced XML elements with a colon or a dash', async () => {
    const atom = await fixture('atom.xml');
    for (const version of ['media:title', 'media-title']) {
      const releases = await extractReleases(atom, config({ format: 'xml', items: 'entry', version }), null);
      assert.deepEqual(versions(releases), ['2.1.0', '2.0.0']);
    }
  });

  it('reads a child selector relative to the items', async () => {
    const xml = '<rss><channel><title>9.9.9</title><item><title>1.0.0</title></item></channel></rss>';
    const releases = await extractReleases(xml, config({ format: 'xml', items: 'channel', version: '> title' }), null);
    assert.deepEqual(versions(releases), ['9.9.9']);
  });

  it('decodes entities and collapses whitespace in titles', async () => {
    const html = `<div class="r"><h2>Release&nbsp;1.2.3 &#8211; &quot;Fox&quot; &amp;
      friends</h2></div>`;
    const [release] = await extractReleases(html, config({ items: '.r', version: 'h2' }), String.raw`\d+\.\d+\.\d+`);
    assert.equal(release?.title, 'Release 1.2.3 – "Fox" & friends');
  });

  it('uses the item text without a version selector and ends implied items', async () => {
    const html = '<ul><li>1.0<li>2.0 <b>beta</b></ul>';
    assert.deepEqual(versions(await extractReleases(html, config({ items: 'li' }), null)), ['1.0', '2.0 beta']);
  });

  it('prefers the earlier selector of a date or link list, wherever its element is', async () => {
    const atom = `<feed><entry><title>3.1.0</title><updated>2026-11-20T10:00:00Z</updated>
        <link rel="related" href="/notes/3.1.0"/><published>2026-11-01T08:00:00Z</published>
        <link rel="alternate" href="/releases/3.1.0"/></entry>
      <entry><title>3.0.0</title><updated>2026-10-02T10:00:00Z</updated><link href="/releases/3.0.0"/></entry></feed>`;
    const releases = await extractReleases(
      atom,
      config({ ...ATOM_PRESET, url: 'https://example.org/feed', link: 'link[rel=alternate], link' }),
      null,
    );
    assert.deepEqual(
      releases.map(({ version, publishedAt, url }) => ({ version, publishedAt, url })),
      [
        { version: '3.1.0', publishedAt: '2026-11-01T08:00:00.000Z', url: 'https://example.org/releases/3.1.0' },
        { version: '3.0.0', publishedAt: '2026-10-02T10:00:00.000Z', url: 'https://example.org/releases/3.0.0' },
      ],
    );
    // Without items, the same order applies to the document.
    const html = '<p class="v">1.2.0</p><span class="d">2026-01-01</span><time datetime="2026-02-03">Feb 3</time>';
    const [single] = await extractReleases(html, config({ version: '.v', date: 'time, .d' }), null);
    assert.equal(single?.publishedAt, '2026-02-03T00:00:00.000Z');
  });

  it('ignores nested items and takes the first matching field', async () => {
    const html = `<div class="rel"><span class="v">1.1</span><div class="rel"><span class="v">0.9</span></div></div>
      <div class="rel"><time datetime="2026-02-03">Feb 3</time><span class="v">1.2</span><span class="v">1.3</span></div>`;
    const releases = await extractReleases(html, config({ items: '.rel', version: '.v', date: 'time' }), null);
    assert.deepEqual(versions(releases), ['1.1', '1.2']);
    assert.equal(releases[1]?.publishedAt, '2026-02-03T00:00:00.000Z');
  });

  it('reduces a long text to its version without a pattern and skips texts without one', async () => {
    const long = `Version 4.5.6 is here with ${'many '.repeat(20)}changes`;
    const html = `<p class="v">${long}</p><p class="v">No version here</p>`;
    assert.deepEqual(versions(await extractReleases(html, config({ version: '.v' }), null)), ['4.5.6']);
  });

  it('caps the number of candidates', async () => {
    const html = Array.from({ length: MAX_CANDIDATES + 20 }, (_, i) => `<i>1.${i}</i>`).join('');
    assert.equal((await extractReleases(html, config({ version: 'i' }), null)).length, MAX_CANDIDATES);
  });

  it('rejects a text source without a pattern and a failing pattern', async () => {
    await assert.rejects(extractReleases('1.0', config({ format: 'text' }), null), WebSourceError);
    await assert.rejects(extractReleases('<p>1.0</p>', config({ version: 'p' }), '(a'), PatternError);
  });
});

describe('text helpers', () => {
  it('decodes numeric and named entities and keeps unknown ones', () => {
    assert.equal(decodeEntities('&#39;a&#x27; &lt;b&gt; &AMP; &unknown; &amp'), "'a' <b> & &unknown; &amp");
  });

  it('turns markup into text, keeping script contents', async () => {
    const html = '<html><body><p>Latest:</p><p>1.2</p><script>var v = "3.4";</script></body></html>';
    assert.equal(await plainText(html), 'Latest: 1.2 var v = "3.4";');
    assert.equal(await plainText('plain 1.0 < 2.0'), 'plain 1.0 < 2.0');
    assert.equal(await plainText('<?xml version="1.0"?><a><b><![CDATA[x <y>]]></b></a>'), 'x <y>');
  });

  it('prepares XML for the HTML parser', () => {
    assert.equal(
      prepareXml('<item><link>https://x</link><link href="/a"/><dc:creator><![CDATA[A & <B>]]></dc:creator></item>'),
      '<item><rw-link>https://x</rw-link><rw-link href="/a"></rw-link><dc-creator>A &amp; &lt;B&gt;</dc-creator></item>',
    );
  });

  it('parses dates and resolves links', () => {
    assert.equal(parseDate('Thu, 19 Nov 2026 16:40:56 +0000'), '2026-11-19T16:40:56.000Z');
    assert.equal(parseDate('1761177600'), '2025-10-23T00:00:00.000Z');
    assert.equal(parseDate('1761177600000'), '2025-10-23T00:00:00.000Z');
    assert.equal(parseDate('soon'), null);
    assert.equal(parseDate(null), null);
    assert.equal(resolveLink('../b?x=1', 'https://e.org/a/c/'), 'https://e.org/a/b?x=1');
    assert.equal(resolveLink('mailto:a@b.c', 'https://e.org/'), null);
    assert.equal(resolveLink(' ', 'https://e.org/'), null);
  });
});

describe('selectors and paths', () => {
  it('rewrites type selectors for XML and keeps attributes, strings and pseudo-classes', () => {
    assert.equal(xmlSelector('item > link'), 'item > rw-link');
    assert.equal(xmlSelector('media:title'), 'media-title');
    assert.equal(xmlSelector('title:first-child'), 'rw-title:first-child');
    assert.equal(xmlSelector('entry:not(link) [rel="link title"].link'), 'entry:not(rw-link) [rel="link title"].link');
  });

  it('splits selector lists and scopes them to the items', () => {
    assert.deepEqual(splitSelectorList('a, b[x="1,2"], :not(c, d)'), ['a', 'b[x="1,2"]', ':not(c, d)']);
    assert.equal(scopedSelector('item, entry', 'updated, > published'), 'item updated, item > published, entry updated, entry > published');
  });

  it('parses and evaluates JSON paths', () => {
    assert.deepEqual(parseJsonPath('a.b[0][*].c'), [{ key: 'a' }, { key: 'b' }, { index: 0 }, { any: true }, { key: 'c' }]);
    assert.deepEqual(parseJsonPath('[*].tag_name'), [{ any: true }, { key: 'tag_name' }]);
    for (const invalid of ['', 'a..b', 'a[x]', 'a[', '.']) assert.equal(parseJsonPath(invalid), null, invalid);
    const data = { a: [{ v: 1 }, { v: 2 }, { w: 3 }] };
    assert.deepEqual(selectJsonPath(data, parseJsonPath('a[*].v') ?? []), [1, 2]);
    assert.deepEqual(selectJsonPath(data, parseJsonPath('a[5].v') ?? []), []);
    assert.deepEqual(selectJsonPath(data, parseJsonPath('toString') ?? []), []);
  });
});

describe('detectFormat', () => {
  it('uses the content type first, then the body', () => {
    assert.equal(detectFormat('application/json; charset=utf-8', ''), 'json');
    assert.equal(detectFormat('application/rss+xml', ''), 'xml');
    assert.equal(detectFormat('application/atom+xml', ''), 'xml');
    assert.equal(detectFormat('text/xml', ''), 'xml');
    assert.equal(detectFormat('application/xhtml+xml', ''), 'html');
    assert.equal(detectFormat('text/html', '<rss>'), 'html');
    assert.equal(detectFormat('text/plain', ' {"a":1}'), 'json');
    assert.equal(detectFormat('', '{not json'), 'text');
    assert.equal(detectFormat('application/octet-stream', '<?xml version="1.0"?><feed>'), 'xml');
    assert.equal(detectFormat('', '<rss version="2.0">'), 'xml');
    assert.equal(detectFormat('', '<!DOCTYPE html><html>'), 'html');
    assert.equal(detectFormat('text/plain', 'Version 1.2.3'), 'text');
  });
});

describe('validateWebSource', () => {
  it('accepts valid sources and the presets', () => {
    assert.equal(validateWebSource(config({ ...RSS_PRESET }), null), null);
    assert.equal(validateWebSource(config({ ...ATOM_PRESET }), String.raw`\d+`), null);
    assert.equal(validateWebSource(config({ version: 'dt a.gdoc-props__title' }), null), null);
    assert.equal(validateWebSource(config({ format: 'text' }), String.raw`Latest:\s*([\d.]+)`), null);
    assert.equal(validateWebSource(config({ format: 'json', items: 'downloads[*]', version: 'version' }), null), null);
    assert.equal(validateWebSource(config({ format: 'json' }), null), null);
    assert.equal(validateWebSource(config({ version: 'p', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), null), null);
  });

  it('needs a version or items selector for HTML and XML', () => {
    assert.deepEqual(validateWebSource(config(), null), {
      version: ['Enter the version selector (or an items selector whose elements hold the version).'],
    });
  });

  it('checks the URL', () => {
    const urlErrors = (url: string): string[] | undefined =>
      validateWebSource(config({ url, version: 'p' }), null)?.url;
    assert.equal(urlErrors('http://example.org/feed?x=1'), undefined);
    assert.match(urlErrors('ftp://example.org/')?.[0] ?? '', /https:\/\/ or http:\/\//);
    assert.match(urlErrors('not a url')?.[0] ?? '', /https:\/\/ or http:\/\//);
    assert.match(urlErrors('https://user:pw@example.org/')?.[0] ?? '', /user name or password/);
    assert.match(urlErrors('')?.[0] ?? '', /Enter the URL/);
    assert.match(urlErrors(`https://e.org/${'a'.repeat(2048)}`)?.[0] ?? '', /at most 2048/);
  });

  it('requires a valid pattern for the text format', () => {
    assert.match(validateWebSource(config({ format: 'text' }), null)?.pattern?.[0] ?? '', /version pattern/);
    assert.match(validateWebSource(config({ format: 'text' }), '(a')?.pattern?.[0] ?? '', /not a valid regular expression/);
  });

  it('checks selectors and paths', () => {
    assert.match(validateWebSource(config({ version: 'a[' }), null)?.version?.[0] ?? '', /version selector is not supported/);
    assert.match(validateWebSource(config({ version: '> a' }), null)?.version?.[0] ?? '', /not supported/);
    assert.equal(validateWebSource(config({ items: 'li', version: '> a' }), null), null);
    assert.match(validateWebSource(config({ items: 'li', date: 'a::before' }), null)?.date?.[0] ?? '', /date selector/);
    assert.deepEqual(Object.keys(validateWebSource(config({ items: 'li[', version: 'a' }), null) ?? {}), ['items']);
    assert.match(validateWebSource(config({ format: 'json', version: 'a..b' }), null)?.version?.[0] ?? '', /path is not valid/);
    assert.match(validateWebSource(config({ items: ' ', version: 'p' }), null)?.items?.[0] ?? '', /Enter the items selector/);
    assert.match(validateWebSource(config({ version: 'p'.repeat(501) }), null)?.version?.[0] ?? '', /at most 500/);
    assert.match(
      validateWebSource({ ...config(), format: 'yaml' as WebSourceConfig['format'] }, null)?.format?.[0] ?? '',
      /text, json, html, xml/,
    );
  });

  it('checks the User-Agent', () => {
    const userAgent = (value: string): string | undefined =>
      validateWebSource(config({ version: 'p', userAgent: value }), null)?.userAgent?.[0];
    assert.equal(userAgent('ReleaseWatcher/1.0 (+https://example.org)'), undefined);
    assert.match(userAgent('a\nb') ?? '', /printable ASCII/);
    assert.match(userAgent('zażółć') ?? '', /printable ASCII/);
    assert.match(userAgent('a'.repeat(301)) ?? '', /at most 300/);
    assert.match(userAgent('  ') ?? '', /Enter a User-Agent/);
  });
});
