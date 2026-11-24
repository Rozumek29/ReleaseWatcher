import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import type { RepositoryRef } from '../src/domain.ts';
import { GiteaReleaseSource } from '../src/gitea.ts';
import { GitLabReleaseSource } from '../src/gitlab.ts';
import { ProviderReleaseSource, type ReleaseSource } from '../src/release-source.ts';
import { FakeSource } from './helpers.ts';

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

const json = (value: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json;charset=utf-8', ...headers } });

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
    assert.deepEqual(result, { releases: [], etag: '"e1"', notModified: true });
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
