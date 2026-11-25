import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  autoLocator,
  fetchInstalledVersion,
  normalizeLocator,
  readInstalledVersion,
  validateLocator,
  type InstalledVersionLocator,
} from '../src/installed-version.ts';
import { InstalledVersionError } from '../src/version.ts';

const locator = (extra: Partial<InstalledVersionLocator>): InstalledVersionLocator => ({
  format: null,
  field: null,
  pattern: null,
  ...extra,
});

describe('fetchInstalledVersion', () => {
  it('returns the version and a preview', async () => {
    const fetch = (async () => new Response('"1.32.0"', { status: 200 })) as unknown as typeof globalThis.fetch;
    assert.deepEqual(await fetchInstalledVersion('https://vault.lan/api/version', autoLocator(), [], fetch), {
      version: '1.32.0',
      preview: '"1.32.0"',
    });
  });

  it('wraps HTTP errors', async () => {
    const fetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof globalThis.fetch;
    await assert.rejects(fetchInstalledVersion('https://x.lan/v', autoLocator(), [], fetch), /HTTP 401.*authorization/);
  });

  it('sends custom headers', async () => {
    let sent: Headers | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response('{"version":"2.0.0"}');
    }) as unknown as typeof globalThis.fetch;
    await fetchInstalledVersion('https://x.lan/v', autoLocator(), [{ name: 'Authorization', value: 'Bearer abc' }], fetch);
    assert.equal(sent?.get('authorization'), 'Bearer abc');
  });

  it('reads a version from an HTML page with a selector', async () => {
    let accept: string | null = null;
    const fetch = (async (_url: string, init: RequestInit) => {
      accept = new Headers(init.headers).get('accept');
      return new Response('<html><body><footer><span class="ver">Version 4.2.1</span></footer></body></html>', {
        headers: { 'Content-Type': 'text/html' },
      });
    }) as unknown as typeof globalThis.fetch;
    const result = await fetchInstalledVersion('https://app.lan/about', locator({ format: 'html', field: '.ver' }), [], fetch);
    assert.equal(result.version, '4.2.1');
    assert.match(accept ?? '', /^text\/html/);
  });
});

describe('readInstalledVersion', () => {
  it('keeps the auto-detection for the auto format', async () => {
    assert.equal(await readInstalledVersion('{"data":{"version":"3.0.0"}}', autoLocator()), '3.0.0');
    assert.equal(await readInstalledVersion('{"a":{"b":"1.2.3"}}', autoLocator('a.b')), '1.2.3');
  });

  it('finds a version in text with a pattern', async () => {
    const body = 'Build 2026-11-01\nRunning server v2.7.0 (stable), latest 2.8.0';
    assert.equal(await readInstalledVersion(body, locator({ format: 'text', pattern: String.raw`server v(\d+\.\d+\.\d+)` })), '2.7.0');
  });

  it('reads text inside an HTML page without the tags', async () => {
    const body = '<p>Gitea <b>Version:</b> 1.22.3</p>';
    assert.equal(await readInstalledVersion(body, locator({ format: 'text', pattern: String.raw`version:\s*([\d.]+)` })), '1.22.3');
  });

  it('reads a JSON path with array indexes', async () => {
    const body = '{"components":[{"name":"core","version":"5.1.0"}]}';
    assert.equal(await readInstalledVersion(body, locator({ format: 'json', field: 'components[0].version' })), '5.1.0');
  });

  it('uses the pattern on the located element', async () => {
    const body = '<div id="about">Release 3.4 (build 20261101)</div>';
    assert.equal(
      await readInstalledVersion(body, locator({ format: 'html', field: '#about', pattern: String.raw`build (\d+)` })),
      '20261101',
    );
  });

  it('reports a page without a match as an installed-version error', async () => {
    await assert.rejects(
      readInstalledVersion('<p>nothing</p>', locator({ format: 'html', field: '.ver' })),
      (error: unknown) => error instanceof InstalledVersionError && /check the selector/.test(error.message),
    );
    await assert.rejects(
      readInstalledVersion('no version', locator({ format: 'text', pattern: String.raw`v(\d+)` })),
      /check the version pattern/,
    );
    await assert.rejects(readInstalledVersion('{', locator({ format: 'json', field: 'version' })), InstalledVersionError);
  });
});

describe('validateLocator', () => {
  it('accepts the auto format and valid locators', () => {
    assert.equal(validateLocator(autoLocator('version')), null);
    assert.equal(validateLocator(locator({ format: 'json', field: 'data.items[0].version' })), null);
    assert.equal(validateLocator(locator({ format: 'html', field: 'footer .version' })), null);
    assert.equal(validateLocator(locator({ format: 'text', pattern: String.raw`v([\d.]+)` })), null);
  });

  it('names the API fields of the problems', () => {
    assert.deepEqual(Object.keys(validateLocator(locator({ format: 'text' })) ?? {}), ['installedVersionPattern']);
    assert.deepEqual(Object.keys(validateLocator(locator({ format: 'html' })) ?? {}), ['installedVersionField']);
    assert.deepEqual(Object.keys(validateLocator(locator({ format: 'json', field: 'a..b[' })) ?? {}), ['installedVersionField']);
    assert.deepEqual(Object.keys(validateLocator(locator({ format: 'text', pattern: '(' })) ?? {}), ['installedVersionPattern']);
  });
});

describe('normalizeLocator', () => {
  it('trims values and drops what a format does not use', () => {
    assert.deepEqual(normalizeLocator(locator({ format: null, field: ' version ', pattern: 'x' })), autoLocator('version'));
    assert.deepEqual(normalizeLocator(locator({ format: 'text', field: '.x', pattern: String.raw` v(\d+) ` })), {
      format: 'text',
      field: null,
      pattern: String.raw`v(\d+)`,
    });
    assert.deepEqual(normalizeLocator(locator({ format: 'html', field: '', pattern: '' })), locator({ format: 'html' }));
  });
});
