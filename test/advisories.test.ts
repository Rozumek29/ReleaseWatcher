import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  advisoriesDue,
  advisoryAffects,
  advisoryImpact,
  effectiveRange,
  normalizeRange,
  installedVersions,
  normalizeSeverity,
  sortAdvisories,
  summarizeAdvisories,
  versionInRange,
} from '../src/advisories.ts';
import { parseCron } from '../src/cron.ts';
import { GitHubReleaseSource } from '../src/github.ts';
import { fromOsv, OsvApiClient, rangeFromEvents } from '../src/osv.ts';
import { advisory } from './helpers.ts';

describe('versionInRange', () => {
  it('handles GitHub range syntax', () => {
    assert.equal(versionInRange('1.2.2', '< 1.2.3'), true);
    assert.equal(versionInRange('v1.2.3', '< 1.2.3'), false);
    assert.equal(versionInRange('1.2.3', '<= 1.2.3'), true);
    assert.equal(versionInRange('1.4.0', '>= 1.0.0, < 1.5.0'), true);
    assert.equal(versionInRange('0.9.0', '>= 1.0.0, < 1.5.0'), false);
    assert.equal(versionInRange('2.0.0', '= 2.0.0'), true);
    assert.equal(versionInRange('2.0.0', '2.0.0'), true);
    assert.equal(versionInRange('2.0.1', '> 2.0.0'), true);
    assert.equal(versionInRange('3.1.0', '< 2.0.0 || >= 3.0.0, < 3.2.0'), true);
    assert.equal(versionInRange('1.5.0-rc.1', '< 1.5.0'), true);
  });

  it('returns null when versions cannot be compared', () => {
    assert.equal(versionInRange('latest', '< 1.0.0'), null);
    assert.equal(versionInRange('1.0.0', '< main'), null);
    assert.equal(versionInRange('1.0.0', ''), null);
  });
});

describe('advisoryAffects', () => {
  it('is true when any range matches, false only when all ranges were compared', () => {
    const a = advisory('GHSA-a', 1, '< 2.0.0');
    assert.equal(advisoryAffects(a, '1.9.9'), true);
    assert.equal(advisoryAffects(a, '2.0.0'), false);
    assert.equal(advisoryAffects(a, null), null);
    assert.equal(advisoryAffects(advisory('GHSA-b', 1, null), '1.0.0'), null);
    const mixed = advisory('GHSA-c', 1, '< 1.0.0', {
      vulnerabilities: [
        { packageName: 'a', vulnerableRange: '< 1.0.0', patchedVersions: '1.0.0' },
        { packageName: 'b', vulnerableRange: null, patchedVersions: null },
      ],
    });
    assert.equal(advisoryAffects(mixed, '1.2.0'), null);
    assert.equal(advisoryAffects(mixed, '0.5.0'), true);
  });
});

describe('range notations (louislam/uptime-kuma advisories)', () => {
  it('normalizes them to the GitHub syntax', () => {
    assert.equal(normalizeRange('>= 2.0.0 && <= 2.1.3 '), '>= 2.0.0, <= 2.1.3');
    assert.equal(normalizeRange('<=2.5.3'), '<= 2.5.3');
    assert.equal(normalizeRange('>= 1.0.0 < 2.0.0'), '>= 1.0.0, < 2.0.0');
    assert.equal(normalizeRange('1.23.0 - 1.23.15'), '>= 1.23.0, <= 1.23.15');
    assert.equal(normalizeRange('2.0.0-beta.0, 2.0.0-beta.1'), '= 2.0.0-beta.0 || = 2.0.0-beta.1');
    assert.equal(normalizeRange('*'), '>= 0');
    assert.equal(normalizeRange('>= 1.0.0, < 1.5.0 || == 2.0.0'), '>= 1.0.0, < 1.5.0 || = 2.0.0');
  });

  it('compares versions with them', () => {
    assert.equal(versionInRange('2.5.12', '>= 2.0.0 && <= 2.1.3'), false);
    assert.equal(versionInRange('2.1.0', '>= 2.0.0 && <= 2.1.3'), true);
    assert.equal(versionInRange('2.5.12', '<=2.5.3'), false);
    assert.equal(versionInRange('1.23.10', '1.23.0 - 1.23.15'), true);
    assert.equal(versionInRange('1.23.16', '1.23.0 - 1.23.15'), false);
    assert.equal(versionInRange('2.0.0-beta.1', '2.0.0-beta.0, 2.0.0-beta.1'), true);
    assert.equal(versionInRange('2.0.0', '2.0.0-beta.0, 2.0.0-beta.1'), false);
    assert.equal(versionInRange('2.5.12', '*'), true);
    assert.equal(versionInRange('1.23.3', '<= v1.23.2'), false);
  });

  it('does not flag 2.5.12 for GHSA-c7hf-c5p5-5g6h', () => {
    const a = advisory('GHSA-c7hf-c5p5-5g6h', 1, null, {
      vulnerabilities: [{ packageName: 'uptime-kuma', vulnerableRange: '>= 2.0.0 && <= 2.1.3 ', patchedVersions: '2.2.0' }],
    });
    assert.equal(advisoryAffects(a, '2.5.12'), false);
    assert.equal(advisoryAffects(a, '2.1.3'), true);
  });
});

describe('patched versions', () => {
  it('cap a vulnerable range without an upper bound', () => {
    assert.equal(effectiveRange('>= 0.104.0', '0.135.0'), '>= 0.104.0, < 0.135.0');
    assert.equal(effectiveRange('>= 0.35.0', '>= 0.120.0'), '>= 0.35.0, < 0.120.0');
    assert.equal(effectiveRange('>= 0.1.0', '>0.45.0'), '>= 0.1.0, <= 0.45.0');
    assert.equal(effectiveRange('>= 1.0.0, < 1.5.0', '1.4.0'), '>= 1.0.0, < 1.5.0');
    assert.equal(effectiveRange('< 1.0.0 || >= 2.0.0', '2.3.0'), '< 1.0.0 || >= 2.0.0, < 2.3.0');
    assert.equal(effectiveRange('>= 1.0.0', null), '>= 1.0.0');
    assert.equal(effectiveRange('>= 1.0.0', '1.2.5, 2.0.3'), '>= 1.0.0');
  });

  it('do not flag versions at or above the fix (clidey/whodb GHSA-x3h5-pr45-fx4r)', () => {
    const a = advisory('GHSA-x3h5-pr45-fx4r', 1, '>= 0.104.0', {
      vulnerabilities: [{ packageName: 'github.com/clidey/whodb/core', vulnerableRange: '>= 0.104.0', patchedVersions: '0.135.0' }],
    });
    assert.equal(advisoryAffects(a, '0.139.0'), false);
    assert.equal(advisoryAffects(a, '0.135.0'), false);
    assert.equal(advisoryAffects(a, '0.134.2'), true);
    assert.equal(advisoryAffects(a, '0.103.0'), false);
    const unfixed = advisory('GHSA-open', 1, '>= 1.0.0', {
      vulnerabilities: [{ packageName: 'app', vulnerableRange: '>= 1.0.0', patchedVersions: null }],
    });
    assert.equal(advisoryAffects(unfixed, '9.0.0'), true);
  });

  it('use a list of fixes per release line (grafana/grafana)', () => {
    const affects = (vulnerableRange: string, patchedVersions: string, version: string) =>
      advisoryAffects(
        advisory('GHSA-grafana', 1, vulnerableRange, {
          vulnerabilities: [{ packageName: 'grafana', vulnerableRange, patchedVersions }],
        }),
        version,
      );
    // GHSA-2j8f-6whh-frc8: open range, fixed in 9.3.4 and 9.2.10.
    assert.equal(affects('>=8.3.0-beta1', '9.3.4, 9.2.10', '13.3.1'), false);
    assert.equal(affects('>=8.3.0-beta1', '9.3.4, 9.2.10', '9.3.4'), false);
    assert.equal(affects('>=8.3.0-beta1', '9.3.4, 9.2.10', '9.2.12'), false);
    assert.equal(affects('>=8.3.0-beta1', '9.3.4, 9.2.10', '9.2.9'), true);
    assert.equal(affects('>=8.3.0-beta1', '9.3.4, 9.2.10', '9.3.1'), true);
    assert.equal(affects('>=8.3.0-beta1', '9.3.4, 9.2.10', '8.2.0'), false);
    // Unreadable ranges.
    assert.equal(affects('<9.x, <8.x', '9.2.4, 8.5.15', '13.3.1'), false);
    assert.equal(affects('<= 9.+,  <= 8.+', '9.1.8, 8.5.14', '8.5.14'), false);
    assert.equal(affects('6.3.0-beta1 - 9.3.1', '9.3.2, 9.2.8, 8.5.16', '8.5.20'), false);
    assert.equal(affects('6.3.0-beta1 - 9.3.1', '9.3.2, 9.2.8, 8.5.16', '8.5.15'), true);
  });

  it('keep a range that opens again above the newest fix (OSV)', () => {
    const a = advisory('OSV-reopened', 1, '< 1.0.0 || >= 2.0.0, < 2.1.0 || >= 3.0.0', {
      vulnerabilities: [{ packageName: 'app', vulnerableRange: '< 1.0.0 || >= 2.0.0, < 2.1.0 || >= 3.0.0', patchedVersions: '1.0.0, 2.1.0' }],
    });
    assert.equal(advisoryAffects(a, '3.5.0'), true);
    assert.equal(advisoryAffects(a, '2.5.0'), false);
    assert.equal(advisoryAffects(a, '2.0.5'), true);
  });
});

describe('installed versions', () => {
  it('combines the own version with those of linked container apps', () => {
    assert.deepEqual(installedVersions(null), []);
    assert.deepEqual(installedVersions(' 1.0.0 ', ['1.0.0', null, '', '1.1.0']), ['1.0.0', '1.1.0']);
    assert.deepEqual(installedVersions(null, ['2.0.0']), ['2.0.0']);
  });

  it('is affected when any version is, safe only when every version is known to be safe', () => {
    const a = advisory('GHSA-a', 1, '< 2.0.0');
    assert.deepEqual(advisoryImpact(a, []), { affects: null, affectedVersions: [] });
    assert.deepEqual(advisoryImpact(a, ['2.1.0', '1.5.0']), { affects: true, affectedVersions: ['1.5.0'] });
    assert.deepEqual(advisoryImpact(a, ['2.1.0', '3.0.0']), { affects: false, affectedVersions: [] });
    assert.deepEqual(advisoryImpact(a, ['2.1.0', 'latest']), { affects: null, affectedVersions: [] });
  });
});

describe('summaries', () => {
  it('counts affecting advisories and picks the highest relevant severity', () => {
    const list = [
      advisory('GHSA-crit', 1, '< 1.0.0', { severity: 'critical' }),
      advisory('GHSA-low', 2, '< 3.0.0', { severity: 'low' }),
    ];
    assert.deepEqual(summarizeAdvisories(list, ['2.0.0']), { total: 2, affecting: 1, highestSeverity: 'low' });
    assert.deepEqual(summarizeAdvisories(list, ['5.0.0']), { total: 2, affecting: 0, highestSeverity: 'critical' });
    assert.deepEqual(summarizeAdvisories(list, ['5.0.0', '0.9.0']), { total: 2, affecting: 2, highestSeverity: 'critical' });
    assert.deepEqual(summarizeAdvisories([], []), { total: 0, affecting: 0, highestSeverity: null });
  });

  it('sorts newest first', () => {
    assert.deepEqual(sortAdvisories([advisory('a', 1), advisory('b', 3), advisory('c', 2)]).map((a) => a.id), ['b', 'c', 'a']);
  });

  it('normalizes GitHub severities', () => {
    assert.equal(normalizeSeverity('moderate'), 'medium');
    assert.equal(normalizeSeverity('HIGH'), 'high');
    assert.equal(normalizeSeverity(null), 'unknown');
    assert.equal(normalizeSeverity('weird'), 'unknown');
  });

  it('is due without a previous fetch or when a scheduled time passed since the last one', () => {
    const everySixHours = parseCron('0 */6 * * *');
    const now = new Date(2026, 10, 20, 12, 0, 30);
    assert.equal(advisoriesDue(null, everySixHours, now), true);
    // Fetched at 11:00 – the 12:00 run has come.
    assert.equal(advisoriesDue(new Date(2026, 10, 20, 11, 0).toISOString(), everySixHours, now), true);
    // Fetched at 12:00:10 (by this run or a manual check) – next run at 18:00.
    assert.equal(advisoriesDue(new Date(2026, 10, 20, 12, 0, 10).toISOString(), everySixHours, now), false);
    // Missed runs (e.g. the app was down) are caught up.
    assert.equal(advisoriesDue(new Date(2026, 10, 19, 1, 0).toISOString(), everySixHours, new Date(2026, 10, 20, 9, 0)), true);
    // An invalid schedule never makes them due.
    assert.equal(advisoriesDue(new Date(2026, 10, 1).toISOString(), null, now), false);
  });
});

describe('GitHubReleaseSource.getSecurityAdvisories', () => {
  it('maps published advisories, skips withdrawn ones and sends the ETag', async () => {
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const body = [
      {
        ghsa_id: 'GHSA-1111-2222-3333',
        cve_id: 'CVE-2026-1',
        html_url: 'https://github.com/acme/widget/security/advisories/GHSA-1111-2222-3333',
        summary: ' Path traversal ',
        severity: 'moderate',
        cvss_severities: { cvss_v3: { score: 6.5 }, cvss_v4: { score: null } },
        published_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-02T00:00:00Z',
        withdrawn_at: null,
        vulnerabilities: [{ package: { name: 'widget' }, vulnerable_version_range: '< 1.2.0', patched_versions: '1.2.0' }],
      },
      { ghsa_id: 'GHSA-gone', cve_id: null, html_url: '', summary: 'x', severity: 'low', published_at: '2026-09-01T00:00:00Z', updated_at: null, withdrawn_at: '2026-09-02T00:00:00Z', vulnerabilities: [] },
    ];
    const source = new GitHubReleaseSource({
      apiBaseUrl: 'https://api.github.test',
      token: 'ghp_x',
      releasesPerPage: 10,
      fetch: (async (url: URL, init: RequestInit) => {
        requests.push({ url: String(url), headers: init.headers as Record<string, string> });
        return requests.length === 1
          ? Response.json(body, { headers: { etag: '"a1"' } })
          : new Response(null, { status: 304 });
      }) as unknown as typeof fetch,
    });

    const first = await source.getSecurityAdvisories({ provider: 'github', host: null, owner: 'acme', name: 'widget' }, null);
    assert.equal(first.etag, '"a1"');
    assert.deepEqual(first.advisories, [
      {
        id: 'GHSA-1111-2222-3333',
        source: 'github',
        aliases: [],
        cveId: 'CVE-2026-1',
        summary: 'Path traversal',
        severity: 'medium',
        cvssScore: 6.5,
        htmlUrl: 'https://github.com/acme/widget/security/advisories/GHSA-1111-2222-3333',
        publishedAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-02T00:00:00Z',
        vulnerabilities: [{ packageName: 'widget', vulnerableRange: '< 1.2.0', patchedVersions: '1.2.0' }],
      },
    ]);
    assert.match(requests[0]!.url, /\/repos\/acme\/widget\/security-advisories\?state=published/);

    const second = await source.getSecurityAdvisories({ provider: 'github', host: null, owner: 'acme', name: 'widget' }, '"a1"');
    assert.equal(second.notModified, true);
    assert.equal(requests[1]!.headers['If-None-Match'], '"a1"');
  });
});

describe('OSV.dev', () => {
  it('converts range events to the GitHub range syntax', () => {
    assert.equal(rangeFromEvents([{ introduced: '0' }, { fixed: '1.2.3' }]), '< 1.2.3');
    assert.equal(rangeFromEvents([{ introduced: '1.0.0' }, { last_affected: '1.4.0' }]), '>= 1.0.0, <= 1.4.0');
    assert.equal(
      rangeFromEvents([{ introduced: '0' }, { fixed: '1.0.1' }, { introduced: '2.0.0' }, { fixed: '2.0.5' }]),
      '< 1.0.1 || >= 2.0.0, < 2.0.5',
    );
    assert.equal(rangeFromEvents([{ introduced: '3.0.0' }]), '>= 3.0.0');
    assert.equal(rangeFromEvents([]), null);
    assert.equal(versionInRange('2.0.3', '< 1.0.1 || >= 2.0.0, < 2.0.5'), true);
    assert.equal(versionInRange('1.5.0', '< 1.0.1 || >= 2.0.0, < 2.0.5'), false);
  });

  it('maps an OSV record of the queried package', () => {
    const mapped = fromOsv(
      {
        id: 'GHSA-aaaa-bbbb-cccc',
        summary: 'Prototype pollution',
        aliases: ['CVE-2026-42'],
        published: '2026-05-01T00:00:00Z',
        modified: '2026-05-02T00:00:00Z',
        database_specific: { severity: 'MODERATE' },
        affected: [
          { package: { ecosystem: 'npm', name: 'n8n' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.81.0' }] }] },
          { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }] }] },
        ],
      },
      'npm',
      'n8n',
    );
    assert.deepEqual(mapped, {
      id: 'GHSA-aaaa-bbbb-cccc',
      source: 'osv',
      aliases: ['CVE-2026-42'],
      cveId: 'CVE-2026-42',
      summary: 'Prototype pollution',
      severity: 'medium',
      cvssScore: null,
      htmlUrl: 'https://osv.dev/vulnerability/GHSA-aaaa-bbbb-cccc',
      publishedAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-02T00:00:00Z',
      vulnerabilities: [{ packageName: 'n8n', vulnerableRange: '< 1.81.0', patchedVersions: '1.81.0' }],
    });
    // Without a summary the first line of the details is used; no severity means "unknown".
    const go = fromOsv({ id: 'GO-2026-1', details: 'Panic on crafted input.\nMore text.', affected: [] }, 'Go', 'x');
    assert.equal(go.summary, 'Panic on crafted input.');
    assert.equal(go.severity, 'unknown');
  });

  it('queries all pages and skips withdrawn records', async () => {
    const bodies: unknown[] = [];
    const client = new OsvApiClient({
      fetch: (async (_url: URL, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return bodies.length === 1
          ? Response.json({ vulns: [{ id: 'A', summary: 'a' }, { id: 'W', summary: 'w', withdrawn: '2026-01-01T00:00:00Z' }], next_page_token: 't1' })
          : Response.json({ vulns: [{ id: 'B', summary: 'b' }] });
      }) as unknown as typeof fetch,
    });
    const result = await client.queryPackage('npm', 'n8n');
    assert.deepEqual(result.map((a) => a.id), ['A', 'B']);
    assert.deepEqual(bodies, [{ package: { ecosystem: 'npm', name: 'n8n' } }, { package: { ecosystem: 'npm', name: 'n8n' }, page_token: 't1' }]);
  });
});
