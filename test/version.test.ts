import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { compareVersions, extractVersion, fetchInstalledVersion, InstalledVersionError, validateHeaders } from '../src/version.ts';

describe('compareVersions', () => {
  const cases: [string, string, '<' | '=' | '>'][] = [
    ['1.32.0', '1.31.0', '>'],
    ['v1.32.0', '1.32.0', '='],
    ['1.32', '1.32.0', '='],
    ['1.10.0', '1.9.9', '>'],
    ['2.0.0-rc.1', '2.0.0', '<'],
    ['2.0.0-rc.2', '2.0.0-rc.10', '<'],
    ['release-2024.10.1', '2024.9.30', '>'],
    ['jellyfin v10.10.3', '10.10.2', '>'],
  ];
  for (const [a, b, expected] of cases) {
    it(`${a} ${expected} ${b}`, () => {
      const result = compareVersions(a, b)!;
      assert.equal(Math.sign(result), expected === '<' ? -1 : expected === '=' ? 0 : 1);
    });
  }

  it('returns null for unparsable input', () => {
    assert.equal(compareVersions('latest', '1.0.0'), null);
  });
});

describe('extractVersion', () => {
  it('reads a plain JSON string (Vaultwarden /api/version)', () => {
    assert.equal(extractVersion('"1.32.0"', null), '1.32.0');
  });

  it('auto-detects common JSON keys', () => {
    assert.equal(extractVersion('{"status":"ok","version":"2.4.1"}', null), '2.4.1');
    assert.equal(extractVersion('{"data":{"version":"3.0.0"}}', null), '3.0.0');
  });

  it('reads an explicit dot path', () => {
    assert.equal(extractVersion('{"server":{"build":{"semver":"1.2.3"}}}', 'server.build.semver'), '1.2.3');
  });

  it('falls back to a version-looking token in plain text', () => {
    assert.equal(extractVersion('Gitea version 1.22.3 built with go1.23', null), '1.22.3');
  });

  it('reports a missing field', () => {
    assert.throws(() => extractVersion('{"a":1}', 'version'), InstalledVersionError);
    assert.throws(() => extractVersion('{"a":1}', null), /No version found/);
  });
});

describe('fetchInstalledVersion', () => {
  it('returns the version and a preview', async () => {
    const fetch = (async () => new Response('"1.32.0"', { status: 200 })) as unknown as typeof globalThis.fetch;
    assert.deepEqual(await fetchInstalledVersion('https://vault.lan/api/version', null, [], fetch), {
      version: '1.32.0',
      preview: '"1.32.0"',
    });
  });

  it('wraps HTTP errors', async () => {
    const fetch = (async () => new Response('nope', { status: 401 })) as unknown as typeof globalThis.fetch;
    await assert.rejects(fetchInstalledVersion('https://x.lan/v', null, [], fetch), /HTTP 401.*authorization/);
  });

  it('sends custom headers', async () => {
    let sent: Headers | undefined;
    const fetch = (async (_url: string, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response('{"version":"2.0.0"}');
    }) as unknown as typeof globalThis.fetch;
    await fetchInstalledVersion('https://x.lan/v', null, [{ name: 'Authorization', value: 'Bearer abc' }], fetch);
    assert.equal(sent?.get('authorization'), 'Bearer abc');
  });
});

describe('validateHeaders', () => {
  it('accepts normal headers and rejects invalid ones', () => {
    assert.equal(validateHeaders([{ name: 'X-Api-Key', value: 'k' }]), null);
    assert.match(validateHeaders([{ name: 'Bad Name', value: 'x' }])!, /not a valid header name/);
    assert.match(validateHeaders([{ name: 'X', value: 'a\r\nInjected: 1' }])!, /invalid/);
    assert.match(validateHeaders([{ name: 'X', value: '1' }, { name: 'x', value: '2' }])!, /twice/);
  });
});
