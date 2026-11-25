import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  fullName,
  iconUrls,
  MAX_NOTIFICATIONS_PER_CHECK,
  parseRepositoryName,
  parseRepositoryReference,
  repositoryAvatarUrl,
  repositoryUrl,
  selectNewReleases,
  selectNewVersions,
  releasePageUrl,
  lastSeenUrl,
  setReleaseSource,
  validateIcon,
} from '../src/domain.ts';
import { RepositoryStore } from '../src/db.ts';
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

describe('parseRepositoryReference', () => {
  const valid: [string, string | null, string, string, string | null][] = [
    ['dotnet/runtime', null, 'dotnet', 'runtime', 'github'],
    ['https://github.com/dotnet/aspire', null, 'dotnet', 'aspire', 'github'],
    ['https://codeberg.org/forgejo/forgejo', 'codeberg.org', 'forgejo', 'forgejo', 'gitea'],
    ['codeberg.org/forgejo/forgejo/releases', 'codeberg.org', 'forgejo', 'forgejo', 'gitea'],
    ['https://code.forgejo.org/forgejo/runner.git', 'code.forgejo.org', 'forgejo', 'runner', 'gitea'],
    ['git+https://Codeberg.org/forgejo/forgejo#main', 'codeberg.org', 'forgejo', 'forgejo', 'gitea'],
    ['https://gitlab.com/gitlab-org/gitlab-runner', 'gitlab.com', 'gitlab-org', 'gitlab-runner', 'gitlab'],
    ['https://gitlab.com/group/sub/project/-/releases', 'gitlab.com', 'group/sub', 'project', 'gitlab'],
    ['https://git.example.com:3000/me/app', 'git.example.com:3000', 'me', 'app', null],
    ['git.lan/me/app/', 'git.lan', 'me', 'app', null],
  ];
  for (const [input, host, owner, name, provider] of valid) {
    it(`parses "${input}"`, () => assert.deepEqual(parseRepositoryReference(input), { host, owner, name, provider }));
  }

  for (const input of [
    null,
    '',
    'just-owner',
    'http://codeberg.org/forgejo/forgejo',
    'ssh://git@codeberg.org/forgejo/forgejo',
    'https://user:secret@git.lan/me/app',
    'https://codeberg.org/forgejo',
    'https://git.lan/me/..',
    'https://git.lan/me/bad name',
    'https://github.com/a/b/c',
  ]) {
    it(`rejects ${JSON.stringify(input)}`, () => assert.equal(parseRepositoryReference(input), null));
  }

  it('names, links and shows repositories of every provider', () => {
    const codeberg = { provider: 'gitea', host: 'codeberg.org', owner: 'forgejo', name: 'forgejo' } as const;
    const gitlab = { provider: 'gitlab', host: 'gitlab.com', owner: 'group/sub', name: 'project' } as const;
    const github = { provider: 'github', host: null, owner: 'acme', name: 'widget' } as const;
    assert.deepEqual([fullName(github), fullName(codeberg), fullName(gitlab)], [
      'acme/widget',
      'codeberg.org/forgejo/forgejo',
      'gitlab.com/group/sub/project',
    ]);
    assert.equal(repositoryUrl(github), 'https://github.com/acme/widget');
    assert.equal(repositoryUrl(gitlab), 'https://gitlab.com/group/sub/project');
    assert.equal(repositoryAvatarUrl(github), 'https://avatars.githubusercontent.com/acme?s=64');
    assert.equal(repositoryAvatarUrl(codeberg), 'https://codeberg.org/user/avatar/forgejo/64');
    assert.equal(repositoryAvatarUrl(gitlab), null);
  });
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

describe('selectNewVersions', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const base = { includePrereleases: false, lastCheckedAt: dayIso(0), lastSeenTag: null };
  const tag = (name: string, isPrerelease = false) => ({ ...release(name, 1, isPrerelease), publishedAt: '' });
  const tags = (r: { newReleases: { tag: string }[] }) => r.newReleases.map((x) => x.tag);
  // Real Checkmk/checkmk tags, in GitHub's order (by name).
  const checkmk = [
    tag('v2.5.0'),
    tag('v2.5.0p21'),
    tag('v2.5.0p21+security'),
    tag('v2.5.0p21-rc1+security', true),
    tag('v2.5.0p20'),
    tag('nightly'),
  ];

  it('establishes a baseline by version on the first check, dating undated tags now', () => {
    const result = selectNewVersions({ ...base, lastCheckedAt: null }, checkmk, now);
    assert.deepEqual(tags(result), []);
    assert.equal(result.newest?.tag, 'v2.5.0p21');
    assert.equal(result.newest?.publishedAt, now.toISOString());
  });

  it('returns versions above the baseline, ascending, each version once', () => {
    const result = selectNewVersions({ ...base, lastSeenTag: 'v2.5.0' }, checkmk, now);
    assert.deepEqual(tags(result), ['v2.5.0p20', 'v2.5.0p21']);
  });

  it('includes pre-releases only when enabled and prefers the stable tag of a version', () => {
    const repo = { ...base, includePrereleases: true, lastSeenTag: 'v2.5.0p20' };
    assert.deepEqual(tags(selectNewVersions(repo, checkmk, now)), ['v2.5.0p21-rc1+security', 'v2.5.0p21']);
    // The pattern picked the same version from `v3.0.0-rc1` (a pre-release) and `v3.0.0`.
    const same = selectNewVersions(repo, [tag('3.0.0', true), { ...tag('3.0.0'), htmlUrl: 'stable' }], now);
    assert.deepEqual([tags(same), same.newest?.htmlUrl], [['3.0.0'], 'stable']);
    assert.deepEqual(tags(selectNewVersions({ ...repo, lastSeenTag: '1.0' }, [tag('2.0-beta', true), tag('2.0', false)], now)), [
      '2.0-beta',
      '2.0',
    ]);
  });

  it('reports only the newest version when the baseline is no version', () => {
    assert.deepEqual(tags(selectNewVersions(base, checkmk, now)), ['v2.5.0p21']);
    assert.deepEqual(tags(selectNewVersions({ ...base, lastSeenTag: 'latest' }, checkmk, now)), ['v2.5.0p21']);
  });

  it('keeps a known date and limits the notifications', () => {
    const many = Array.from({ length: 9 }, (_, i) => release(`1.${i}.0`, i));
    const result = selectNewVersions({ ...base, lastSeenTag: '0.1' }, many, now);
    assert.deepEqual(tags(result), ['1.4.0', '1.5.0', '1.6.0', '1.7.0', '1.8.0']);
    assert.equal(result.newest?.publishedAt, dayIso(8));
  });
});

describe('setReleaseSource', () => {
  it('resets the baseline only when the source or the pattern changes', () => {
    const repo = new RepositoryStore(':memory:').add('acme', 'widget', false);
    Object.assign(repo, { lastSeenTag: 'v1', lastSeenPublishedAt: dayIso(1), releasesEtag: '"e"', lastCheckedAt: dayIso(1) });
    assert.equal(setReleaseSource(repo, 'releases', null), false);
    assert.equal(repo.lastSeenTag, 'v1');
    assert.equal(setReleaseSource(repo, 'tags', '^v(.+)$'), true);
    assert.deepEqual(
      [repo.releaseSource, repo.versionPattern, repo.lastSeenTag, repo.lastSeenPublishedAt, repo.releasesEtag, repo.lastCheckedAt],
      ['tags', '^v(.+)$', null, null, null, null],
    );
  });
});

describe('releasePageUrl / lastSeenUrl', () => {
  const ref = (provider: 'github' | 'gitea' | 'gitlab', host: string | null) => ({ provider, host, owner: 'o', name: 'r' });

  it('links the page of a release or tag per provider, encoding the tag', () => {
    assert.equal(releasePageUrl(ref('github', null), 'v1.0#x'), 'https://github.com/o/r/releases/tag/v1.0%23x');
    assert.equal(releasePageUrl({ ...ref('github', null), releaseSource: 'tags' }, 'a/b'), 'https://github.com/o/r/releases/tag/a/b');
    assert.equal(releasePageUrl(ref('gitea', 'codeberg.org'), 'v1'), 'https://codeberg.org/o/r/releases/tag/v1');
    assert.equal(releasePageUrl({ ...ref('gitea', 'codeberg.org'), releaseSource: 'tags' }, 'v1'), 'https://codeberg.org/o/r/src/tag/v1');
    assert.equal(releasePageUrl(ref('gitlab', 'gitlab.com'), 'v1'), 'https://gitlab.com/o/r/-/releases/v1');
    assert.equal(releasePageUrl({ ...ref('gitlab', 'gitlab.com'), releaseSource: 'tags' }, 'v1'), 'https://gitlab.com/o/r/-/tags/v1');
  });

  it('has no link without a release or for a version picked by a pattern from tags', () => {
    const repo = { ...ref('gitlab', 'gitlab.com'), releaseSource: 'tags' as const, versionPattern: null, lastSeenTag: 'v1' };
    assert.equal(lastSeenUrl(repo), 'https://gitlab.com/o/r/-/tags/v1');
    assert.equal(lastSeenUrl({ ...repo, lastSeenTag: null }), null);
    assert.equal(lastSeenUrl({ ...repo, versionPattern: '^v(.+)$' }), null);
    assert.equal(lastSeenUrl({ ...repo, releaseSource: 'releases', versionPattern: '^v' }), 'https://gitlab.com/o/r/-/releases/v1');
  });
});
