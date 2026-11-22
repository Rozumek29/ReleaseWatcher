import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { iconUrls, MAX_NOTIFICATIONS_PER_CHECK, parseRepositoryName, selectNewReleases, validateIcon } from '../src/domain.ts';
import { dayIso, release } from './helpers.ts';

describe('parseRepositoryName', () => {
  const valid: [string, string, string][] = [
    ['dotnet/runtime', 'dotnet', 'runtime'],
    ['  angular/angular  ', 'angular', 'angular'],
    ['https://github.com/dotnet/aspire', 'dotnet', 'aspire'],
    ['http://www.github.com/foo-bar/baz.js/', 'foo-bar', 'baz.js'],
    ['github.com/owner/repo.git', 'owner', 'repo'],
    ['owner/repo_name-1', 'owner', 'repo_name-1'],
  ];
  for (const [input, owner, name] of valid) {
    it(`parses "${input}"`, () => assert.deepEqual(parseRepositoryName(input), { owner, name }));
  }

  for (const input of [null, '', 'just-owner', 'a/b/c', 'https://gitlab.com/owner/repo', 'owner/..', '-owner/repo', 'own er/repo']) {
    it(`rejects ${JSON.stringify(input)}`, () => assert.equal(parseRepositoryName(input), null));
  }
});

describe('selectNewReleases', () => {
  const base = { includePrereleases: false, lastCheckedAt: dayIso(0), lastSeenPublishedAt: null, lastSeenTag: null };
  const tags = (r: { newReleases: { tag: string }[] }) => r.newReleases.map((x) => x.tag);

  it('establishes a baseline on the first check without notifying', () => {
    const result = selectNewReleases({ ...base, lastCheckedAt: null }, [release('v2', 2), release('v1', 1)]);
    assert.deepEqual(tags(result), []);
    assert.equal(result.newest?.tag, 'v2');
  });

  it('returns only releases newer than the baseline, oldest first', () => {
    const repo = { ...base, lastSeenTag: 'v1', lastSeenPublishedAt: dayIso(1) };
    const result = selectNewReleases(repo, [release('v3', 3), release('v2', 2), release('v1', 1)]);
    assert.deepEqual(tags(result), ['v2', 'v3']);
    assert.equal(result.newest?.tag, 'v3');
  });

  it('skips pre-releases unless enabled', () => {
    const releases = [release('v2-rc', 2, true), release('v1', 1)];
    assert.deepEqual(tags(selectNewReleases({ ...base, lastSeenPublishedAt: dayIso(1) }, releases)), []);
    assert.deepEqual(
      tags(selectNewReleases({ ...base, includePrereleases: true, lastSeenPublishedAt: dayIso(1) }, releases)),
      ['v2-rc'],
    );
  });

  it('notifies about the first release of a repository that had none', () => {
    assert.deepEqual(tags(selectNewReleases(base, [release('v1', 1)])), ['v1']);
  });

  it('caps the number of notifications, keeping the newest', () => {
    const releases = Array.from({ length: 8 }, (_, i) => release(`v${i + 1}`, i + 1));
    const result = selectNewReleases({ ...base, lastSeenPublishedAt: dayIso(0) }, releases);
    assert.equal(result.newReleases.length, MAX_NOTIFICATIONS_PER_CHECK);
    assert.equal(result.newReleases.at(-1)?.tag, 'v8');
  });
});

describe('custom icons', () => {
  const cdn = 'https://cdn.jsdelivr.net/gh/selfhst/icons';

  it('resolves the selfh.st shorthand to the CDN, SVG first', () => {
    assert.deepEqual(iconUrls('sh:frigate'), [`${cdn}/svg/frigate.svg`, `${cdn}/png/frigate.png`, `${cdn}/webp/frigate.webp`]);
    assert.deepEqual(iconUrls('SH:Home-Assistant-Dark'), [
      `${cdn}/svg/home-assistant-dark.svg`,
      `${cdn}/png/home-assistant-dark.png`,
      `${cdn}/webp/home-assistant-dark.webp`,
    ]);
  });

  it('uses only an explicit format', () => {
    assert.deepEqual(iconUrls('sh:frigate.png'), [`${cdn}/png/frigate.png`]);
  });

  it('passes image URLs through and ignores missing or invalid icons', () => {
    assert.deepEqual(iconUrls('https://example.com/a.svg'), ['https://example.com/a.svg']);
    assert.deepEqual(iconUrls(null), []);
    assert.deepEqual(iconUrls('javascript:alert(1)'), []);
  });

  it('validates icons', () => {
    assert.equal(validateIcon('sh:frigate-light'), null);
    assert.equal(validateIcon('http://nas.lan/icon.png'), null);
    assert.match(validateIcon('sh:../etc') ?? '', /selfh\.st icon name/);
    assert.match(validateIcon('data:image/png;base64,AAAA') ?? '', /http:\/\/ or https:\/\//);
    assert.match(validateIcon('https://user:pw@example.com/a.png') ?? '', /credentials/);
    assert.match(validateIcon('frigate') ?? '', /image URL/);
    assert.match(validateIcon(`https://example.com/${'a'.repeat(2000)}`) ?? '', /at most/);
  });
});
