import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import type { RepositoryRef } from '../src/domain.ts';
import { GiteaReleaseSource } from '../src/gitea.ts';
import { GitHubReleaseSource } from '../src/github.ts';
import { GitLabReleaseSource } from '../src/gitlab.ts';
import {
  applyVersionPattern,
  ProviderReleaseSource,
  type ReleaseFetchResult,
  type ReleaseSource,
} from '../src/release-source.ts';
import { isPrereleaseTag } from '../src/version.ts';
import { FakeSource, release } from './helpers.ts';

interface Call {
  url: string;
  headers: Headers;
}

/** A fetch answering from a table of URL → response factory (404 for anything else) and recording the calls. */
function fakeFetch(routes: Record<string, () => Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    return routes[url]?.() ?? new Response('Not found', { status: 404 });
  }) as typeof fetch;
  return { fetch: fetcher, calls };
}

const json = (value: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json;charset=utf-8', ...headers } });

const codeberg: RepositoryRef = { provider: 'gitea', host: 'codeberg.org', owner: 'forgejo', name: 'forgejo' };
const gitlab: RepositoryRef = { provider: 'gitlab', host: 'gitlab.com', owner: 'group/sub', name: 'project' };

describe('GiteaReleaseSource', () => {
  const api = 'https://codeberg.org/api/v1/repos/forgejo/forgejo';

  it('reads published releases (drafts left out) with the repository token only', async () => {
    const { fetch, calls } = fakeFetch({
      [`${api}/releases?limit=10`]: () =>
        json(
          [
            {
              tag_name: 'v15.0.1',
              name: 'v15.0.1',
              html_url: 'https://codeberg.org/forgejo/forgejo/releases/tag/v15.0.1',
              body: 'Fixes',
              draft: false,
              prerelease: false,
              published_at: '2026-11-20T10:00:00+01:00',
              created_at: '2026-11-20T09:00:00+01:00',
              author: { login: 'forgejo-release', avatar_url: 'https://codeberg.org/avatars/1' },
            },
            { tag_name: 'v16.0.0-rc1', name: '', html_url: 'x', body: '', draft: false, prerelease: true, published_at: '2026-11-21T00:00:00Z', created_at: null, author: null },
            { tag_name: 'v99', name: null, html_url: 'x', body: null, draft: true, prerelease: false, published_at: null, created_at: null, author: null },
          ],
          { etag: '"e1"' },
        ),
    });
    const source = new GiteaReleaseSource({ releasesPerPage: 10, fetch });

    const result = await source.getRecentReleases(codeberg, null, 'repo-token');
    assert.equal(result.etag, '"e1"');
    assert.deepEqual(
      result.releases.map((r) => [r.tag, r.name, r.isPrerelease, r.publishedAt, r.authorLogin, r.body]),
      [
        ['v15.0.1', 'v15.0.1', false, '2026-11-20T09:00:00.000Z', 'forgejo-release', 'Fixes'],
        ['v16.0.0-rc1', null, true, '2026-11-21T00:00:00.000Z', null, null],
      ],
    );
    assert.equal(calls[0]?.headers.get('authorization'), 'token repo-token');

    await source.getRecentReleases(codeberg, '"e1"');
    assert.equal(calls[1]?.headers.get('authorization'), null);
    assert.equal(calls[1]?.headers.get('if-none-match'), '"e1"');
  });

  it('answers 304 as not modified', async () => {
    const { fetch } = fakeFetch({ [`${api}/releases?limit=10`]: () => new Response(null, { status: 304 }) });
    const result = await new GiteaReleaseSource({ releasesPerPage: 10, fetch }).getRecentReleases(codeberg, '"e1"');
    assert.deepEqual(result, { releases: [], etag: '"e1"', notModified: true, order: 'date' });
  });

  it('finds a repository only when the API answers with JSON', async () => {
    const { fetch } = fakeFetch({
      [api]: () => json({ full_name: 'forgejo/forgejo' }),
      'https://codeberg.org/api/v1/repos/forgejo/html': () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    });
    const source = new GiteaReleaseSource({ releasesPerPage: 10, fetch });
    assert.equal(await source.repositoryExists(codeberg), true);
    assert.equal(await source.repositoryExists({ ...codeberg, name: 'missing' }), false);
    assert.equal(await source.repositoryExists({ ...codeberg, name: 'html' }), false);
  });

  it('reports API errors with the host', async () => {
    const { fetch } = fakeFetch({ [`${api}/releases?limit=10`]: () => new Response('Unauthorized', { status: 401 }) });
    await assert.rejects(
      new GiteaReleaseSource({ releasesPerPage: 10, fetch }).getRecentReleases(codeberg, null),
      /Gitea\/Forgejo \(codeberg\.org\) API returned 401: Unauthorized/,
    );
  });
});

describe('GitLabReleaseSource', () => {
  const api = 'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject';

  it('reads releases, marking pre-release tags and upcoming releases', async () => {
    const { fetch, calls } = fakeFetch({
      [`${api}/releases?per_page=10`]: () =>
        json([
          {
            tag_name: 'v2.0.0',
            name: 'v2.0.0',
            description: 'Notes',
            created_at: '2026-11-19T00:00:00Z',
            released_at: '2026-11-20T00:00:00Z',
            author: { username: 'maintainer', avatar_url: 'https://gitlab.com/a.png' },
            _links: { self: 'https://gitlab.com/group/sub/project/-/releases/v2.0.0' },
          },
          { tag_name: 'v2.1.0-rc.1', name: 'Release candidate', description: null, created_at: '2026-11-21T00:00:00Z', released_at: null, author: null },
          { tag_name: 'v3.0.0', name: null, description: '', created_at: '2026-11-21T00:00:00Z', released_at: '2027-01-01T00:00:00Z', upcoming_release: true, author: null },
        ]),
    });
    const source = new GitLabReleaseSource({ releasesPerPage: 10, fetch });

    const { releases } = await source.getRecentReleases(gitlab, null, 'glpat-x');
    assert.deepEqual(
      releases.map((r) => [r.tag, r.name, r.isPrerelease, r.publishedAt, r.htmlUrl, r.authorLogin]),
      [
        ['v2.0.0', null, false, '2026-11-20T00:00:00.000Z', 'https://gitlab.com/group/sub/project/-/releases/v2.0.0', 'maintainer'],
        ['v2.1.0-rc.1', 'Release candidate', true, '2026-11-21T00:00:00.000Z', 'https://gitlab.com/group/sub/project/-/releases/v2.1.0-rc.1', null],
        ['v3.0.0', null, true, '2027-01-01T00:00:00.000Z', 'https://gitlab.com/group/sub/project/-/releases/v3.0.0', null],
      ],
    );
    assert.equal(calls[0]?.headers.get('private-token'), 'glpat-x');
    assert.equal(calls[0]?.headers.get('authorization'), null);
  });

  it('finds a project by its path', async () => {
    const { fetch } = fakeFetch({ [api]: () => json({ id: 1 }) });
    const source = new GitLabReleaseSource({ releasesPerPage: 10, fetch });
    assert.equal(await source.repositoryExists(gitlab), true);
    assert.equal(await source.repositoryExists({ ...gitlab, name: 'other' }), false);
  });
});

describe('ProviderReleaseSource', () => {
  it('asks the source of the repository provider; only GitHub has advisories', async () => {
    const github = new FakeSource();
    const gitea = new FakeSource();
    const gitlabSource: ReleaseSource = { repositoryExists: async () => true, getRecentReleases: gitea.getRecentReleases.bind(gitea) };
    const source = new ProviderReleaseSource({ github, gitea, gitlab: gitlabSource });

    await source.getRecentReleases(codeberg, null);
    assert.equal(gitea.calls, 1);
    assert.equal(github.calls, 0);
    await source.getSecurityAdvisories({ provider: 'github', host: null, owner: 'acme', name: 'widget' }, null);
    assert.equal(github.advisoryCalls, 1);
    await assert.rejects(source.getSecurityAdvisories(gitlab, null), /GitLab has no security advisories/);
  });
});

describe('tags', () => {
  const truenas = { provider: 'github', host: null, owner: 'truenas', name: 'middleware' } as const;
  // GitHub lists tags by name, newest name first; they have no dates.
  const truenasTags = [
    'TrueNAS-9.10.2-U5',
    'TrueNAS-9.10.2-U2',
    'TrueNAS-9.10-RELEASE',
    'TS-27.0.0-RC.1',
    'TS-26.0.0-BETA.3',
    'TS-25.10.8',
    'TS-25.10.7',
  ];

  it('reads GitHub tags without dates, linking their tag pages', async () => {
    const { fetch, calls } = fakeFetch({
      'https://api.github.com/repos/truenas/middleware/tags?per_page=100': () =>
        json(truenasTags.map((name) => ({ name, commit: { sha: 'x' } })), { etag: '"t1"' }),
    });
    const source = new GitHubReleaseSource({ apiBaseUrl: 'https://api.github.com', token: 'ghp', releasesPerPage: 10, fetch });
    const result = await source.getRecentReleases({ ...truenas, releaseSource: 'tags' }, null);
    assert.equal(result.order, 'version');
    assert.equal(result.etag, '"t1"');
    assert.deepEqual(
      result.releases.map((r) => [r.tag, r.isPrerelease, r.publishedAt]),
      truenasTags.map((t) => [t, /RC|BETA/.test(t), '']),
    );
    assert.equal(result.releases[0]?.htmlUrl, 'https://github.com/truenas/middleware/releases/tag/TrueNAS-9.10.2-U5');
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer ghp');
  });

  it('reads Gitea/Forgejo tags with their commit dates', async () => {
    const { fetch } = fakeFetch({
      'https://codeberg.org/api/v1/repos/forgejo/forgejo/tags?limit=100': () =>
        json([
          { name: 'v15.0.1', message: 'Release\n', commit: { created: '2026-11-20T10:00:00+01:00' } },
          { name: 'feature/x', message: '', commit: null },
        ]),
    });
    const result = await new GiteaReleaseSource({ releasesPerPage: 10, fetch }).getRecentReleases(
      { ...codeberg, releaseSource: 'tags' },
      null,
    );
    assert.equal(result.order, 'version');
    assert.deepEqual(
      result.releases.map((r) => [r.tag, r.htmlUrl, r.body, r.publishedAt]),
      [
        ['v15.0.1', 'https://codeberg.org/forgejo/forgejo/src/tag/v15.0.1', 'Release','2026-11-20T09:00:00.000Z'],
        ['feature/x', 'https://codeberg.org/forgejo/forgejo/src/tag/feature/x', null, ''],
      ],
    );
  });

  it('reads GitLab tags ordered by version', async () => {
    const { fetch } = fakeFetch({
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/repository/tags?per_page=100&order_by=version': () =>
        json([{ name: 'v2.0.0-rc.1', message: null, commit: { committed_date: '2026-11-01T00:00:00Z' } }]),
    });
    const result = await new GitLabReleaseSource({ releasesPerPage: 10, fetch }).getRecentReleases(
      { ...gitlab, releaseSource: 'tags' },
      null,
    );
    assert.deepEqual(
      result.releases.map((r) => [r.tag, r.isPrerelease, r.htmlUrl, r.publishedAt]),
      [['v2.0.0-rc.1', true, 'https://gitlab.com/group/sub/project/-/tags/v2.0.0-rc.1', '2026-11-01T00:00:00.000Z']],
    );
  });

  it('applies the version pattern: with tags the group becomes the version, with releases it only filters', async () => {
    const result = (tags: string[]): ReleaseFetchResult => ({
      releases: tags.map((tag) => release(tag, 1)),
      etag: null,
      notModified: false,
      order: 'version',
    });
    const fromTags = await applyVersionPattern(result(truenasTags), { ...truenas, releaseSource: 'tags', versionPattern: '^TS-(.+)$' });
    assert.deepEqual(
      fromTags.releases.map((r) => [r.tag, r.isPrerelease]),
      [['27.0.0-RC.1', true], ['26.0.0-BETA.3', true], ['25.10.8', false], ['25.10.7', false]],
    );
    const fromReleases = await applyVersionPattern(result(truenasTags), { ...truenas, releaseSource: 'releases', versionPattern: '^TS-' });
    assert.deepEqual(fromReleases.releases.map((r) => r.tag), ['TS-27.0.0-RC.1', 'TS-26.0.0-BETA.3', 'TS-25.10.8', 'TS-25.10.7']);
    const unchanged = result(truenasTags);
    assert.equal(await applyVersionPattern(unchanged, { ...truenas, versionPattern: null }), unchanged);
  });

  it('applies the pattern through ProviderReleaseSource', async () => {
    const gitea = new FakeSource();
    gitea.releases = [release('v1.0.0', 1), release('nightly-5', 2)];
    const source = new ProviderReleaseSource({ github: new FakeSource(), gitea, gitlab: new FakeSource() });
    const result = await source.getRecentReleases({ ...codeberg, versionPattern: '^v' }, null);
    assert.deepEqual(result.releases.map((r) => r.tag), ['v1.0.0']);
    assert.equal(result.order, 'date');
  });
});

describe('tags review fixes', () => {
  const ref = { provider: 'github', host: null, owner: 'acme', name: 'widget' } as const;
  const fetched = (tags: string[]): ReleaseFetchResult => ({
    releases: tags.map((tag) => ({ ...release(tag, 1, isPrereleaseTag(tag)), publishedAt: '' })),
    etag: null,
    notModified: false,
    order: 'version',
  });

  it('keeps the pre-release suffix of a tag the pattern cut off, so the stable version is newer', async () => {
    const result = await applyVersionPattern(fetched(['v2.0.0-rc1', 'v2.0.0']), {
      ...ref,
      releaseSource: 'tags',
      versionPattern: String.raw`^v(\d+\.\d+\.\d+)`,
    });
    assert.deepEqual(
      result.releases.map((r) => [r.tag, r.isPrerelease]),
      [['2.0.0-rc1', true], ['2.0.0', false]],
    );
    // The group ends before the suffix (not directly followed by it): the tag's suffix is still kept.
    const major = await applyVersionPattern(fetched(['v2.0.0-rc1', 'v2.0.0']), {
      ...ref,
      releaseSource: 'tags',
      versionPattern: String.raw`^v(\d+)\.`,
    });
    assert.deepEqual(
      major.releases.map((r) => [r.tag, r.isPrerelease]),
      [['2-rc1', true], ['2', false]],
    );
  });

  it('keeps only tags that look like versions when there is no pattern', async () => {
    const result = await applyVersionPattern(
      fetched(['build-20231010', '2024-01-15', 'docs-2026', 'nightly', 'v1.2.3', 'TS-25.10.8', 'v2.5.0p21+security', 'TrueNAS-9.10.2-U5']),
      { ...ref, releaseSource: 'tags', versionPattern: null },
    );
    assert.deepEqual(result.releases.map((r) => r.tag), ['v1.2.3', 'TS-25.10.8', 'v2.5.0p21+security', 'TrueNAS-9.10.2-U5']);
  });

  it('retries GitLab tags without order_by on an older instance', async () => {
    const { fetch, calls } = fakeFetch({
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/repository/tags?per_page=100&order_by=version': () =>
        json({ message: 'order_by does not have a valid value' }, {}, 400),
      'https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/repository/tags?per_page=100': () => json([{ name: 'v1.0.0' }]),
    });
    const result = await new GitLabReleaseSource({ releasesPerPage: 10, fetch }).getRecentReleases(
      { ...gitlab, releaseSource: 'tags' },
      null,
    );
    assert.deepEqual(result.releases.map((r) => r.tag), ['v1.0.0']);
    assert.equal(calls.length, 2);
  });
});
