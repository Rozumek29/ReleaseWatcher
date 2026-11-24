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
  validateIcon,
} from '../src/domain.ts';
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
