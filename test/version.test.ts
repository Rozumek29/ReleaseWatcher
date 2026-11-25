import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  compareVersions,
  extractVersion,
  InstalledVersionError,
  localVersionUrl,
  parseVersion,
  validateHeaders,
} from '../src/version.ts';

describe('localVersionUrl', () => {
  it('uses the loopback address for a wildcard bind and keeps a specific one', () => {
    assert.equal(localVersionUrl('0.0.0.0', 8080), 'http://127.0.0.1:8080/api/version');
    assert.equal(localVersionUrl('::', 9000), 'http://127.0.0.1:9000/api/version');
    assert.equal(localVersionUrl('192.168.1.5', 8080), 'http://192.168.1.5:8080/api/version');
    assert.equal(localVersionUrl('fd00::5', 8080), 'http://[fd00::5]:8080/api/version');
  });
});

describe('parseVersion', () => {
  it('reads a patch level after the numbers as one more number', () => {
    assert.deepEqual(parseVersion('v2.5.0p21'), { numbers: [2, 5, 0, 21], prerelease: '' });
    assert.deepEqual(parseVersion('TrueNAS-9.10.2-U5'), { numbers: [9, 10, 2, 5], prerelease: '' });
    assert.deepEqual(parseVersion('v2.5.0p21-rc1+security'), { numbers: [2, 5, 0, 21], prerelease: 'rc1' });
    assert.deepEqual(parseVersion('1.4-beta'), { numbers: [1, 4], prerelease: 'beta' });
    assert.deepEqual(parseVersion('1.4-preview2'), { numbers: [1, 4], prerelease: 'preview2' });
  });
});

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
    ['v2.5.0p21', 'v2.5.0', '>'],
    ['v2.5.0p21', 'v2.5.0p20', '>'],
    ['v2.5.0p21+security', 'v2.5.0p21', '='],
    ['v2.5.0p21-rc1+security', 'v2.5.0p21', '<'],
    ['v2.5.0p21-rc1+security', 'v2.5.0p20', '>'],
    ['v2.5.1', 'v2.5.0p21', '>'],
    ['TrueNAS-9.10.2-U5', 'TrueNAS-9.10.2-U2', '>'],
    ['TrueNAS-9.10.2-U2', 'TrueNAS-9.10.2', '>'],
    ['1.2.3_patch4', '1.2.3', '>'],
    ['1.2.3-update', '1.2.3', '='],
    ['1.2.3-u12a', '1.2.3', '='],
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

describe('validateHeaders', () => {
  it('accepts normal headers and rejects invalid ones', () => {
    assert.equal(validateHeaders([{ name: 'X-Api-Key', value: 'k' }]), null);
    assert.match(validateHeaders([{ name: 'Bad Name', value: 'x' }])!, /not a valid header name/);
    assert.match(validateHeaders([{ name: 'X', value: 'a\r\nInjected: 1' }])!, /invalid/);
    assert.match(validateHeaders([{ name: 'X', value: '1' }, { name: 'x', value: '2' }])!, /twice/);
  });
});
