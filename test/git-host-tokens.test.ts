import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { parseGitHost } from '../src/domain.ts';
import { GiteaReleaseSource } from '../src/gitea.ts';
import { effectiveToken, providerMismatch } from '../src/git-host-tokens/domain.ts';
import { GitLabReleaseSource } from '../src/gitlab.ts';
import { silentLogger } from '../src/log.ts';
import { ProviderReleaseSource } from '../src/release-source.ts';
import { SettingsService } from '../src/settings.ts';
import { WebReleaseSource } from '../src/web-source/source.ts';
import { FakeSource, RecordingNotifier } from './helpers.ts';

describe('git host tokens: domain', () => {
  it('parses the host of an instance', () => {
    assert.equal(parseGitHost('git.example.com'), 'git.example.com');
    assert.equal(parseGitHost(' https://Git.Example.com:3000/some/path '), 'git.example.com:3000');
    assert.equal(parseGitHost('www.example.org'), 'example.org');
    assert.equal(parseGitHost('http://git.example.com'), null);
    assert.equal(parseGitHost('https://user:pw@git.example.com'), null);
    assert.equal(parseGitHost('github.com'), null);
    assert.equal(parseGitHost('not a host'), null);
    assert.equal(parseGitHost(''), null);
  });

  it('rejects a provider a well-known host does not have', () => {
    assert.equal(providerMismatch('gitea', 'codeberg.org'), null);
    assert.match(providerMismatch('gitlab', 'codeberg.org') ?? '', /codeberg\.org is Gitea\/Forgejo, not GitLab/);
    assert.equal(providerMismatch('gitlab', 'git.example.com'), null);
  });

  it('prefers the repository token and uses the host token only on Gitea/Forgejo and GitLab', () => {
    const hostToken = (provider: string, host: string) => (provider === 'gitea' && host === 'git.example.com' ? 'host-token' : null);
    const gitea = { provider: 'gitea', host: 'git.example.com' } as const;
    assert.equal(effectiveToken(gitea, null, hostToken), 'host-token');
    assert.equal(effectiveToken(gitea, 'own', hostToken), 'own');
    assert.equal(effectiveToken({ provider: 'gitlab', host: 'git.example.com' }, null, hostToken), null);
    assert.equal(effectiveToken({ provider: 'github', host: null }, undefined, hostToken), undefined);
    assert.equal(effectiveToken({ provider: 'web', host: 'git.example.com' }, null, hostToken), null);
  });
});

describe('git host tokens: API', () => {
  let app: App;
  let store: RepositoryStore;
  let fake: FakeSource;
  let baseUrl: URL;
  let requests: { url: string; headers: Headers }[];

  /** A Gitea/Forgejo or GitLab API that knows every repository and has no releases. */
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: new Headers(init?.headers) });
    const list = /\/(releases|tags)\b/.test(url);
    return new Response(list ? '[]' : '{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  beforeEach(async () => {
    requests = [];
    store = new RepositoryStore(':memory:');
    fake = new FakeSource();
    const settings = new SettingsService(store, loadConfig({}));
    settings.update({ githubToken: 'github-secret' });
    app = await buildApp({
      store,
      settings,
      source: new ProviderReleaseSource({
        github: fake,
        gitea: new GiteaReleaseSource({ releasesPerPage: 10, fetch: fakeFetch }),
        gitlab: new GitLabReleaseSource({ releasesPerPage: 10, fetch: fakeFetch }),
        web: new WebReleaseSource({ fetch: fakeFetch }),
      }),
      notifiers: [new RecordingNotifier()],
      log: silentLogger,
      auth: { requireAuth: false },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  const addToken = (provider: string, host: string, token = 'host-secret-token') =>
    request('POST', '/api/git-host-tokens', { provider, host, token });

  it('adds, lists, updates and removes a token without returning it', async () => {
    const added = await addToken('gitea', 'https://Git.Example.com/');
    assert.equal(added.status, 201);
    assert.equal(added.body.host, 'git.example.com');
    assert.equal(added.body.provider, 'gitea');
    assert.ok(!JSON.stringify(added.body).includes('host-secret-token'));
    assert.match(added.body.tokenMasked, /^host…/);

    const raw = store.database.query<{ token: string }, []>('SELECT token FROM git_host_tokens').get()!;
    assert.notEqual(raw.token, 'host-secret-token', 'encrypted at rest');

    const list = await request('GET', '/api/git-host-tokens');
    assert.deepEqual(list.body.map((t: { host: string }) => t.host), ['git.example.com']);

    const kept = await request('PUT', `/api/git-host-tokens/${added.body.id}`, { host: 'git.example.com:3000' });
    assert.equal(kept.status, 200);
    assert.equal(kept.body.host, 'git.example.com:3000');
    assert.equal(kept.body.tokenMasked, added.body.tokenMasked, 'omitted token is kept');

    const rotated = await request('PUT', `/api/git-host-tokens/${added.body.id}`, { token: 'rotated-token-value' });
    assert.match(rotated.body.tokenMasked, /^rota…/);

    assert.equal((await request('DELETE', `/api/git-host-tokens/${added.body.id}`)).status, 204);
    assert.equal((await request('DELETE', `/api/git-host-tokens/${added.body.id}`)).status, 404);
    assert.deepEqual((await request('GET', '/api/git-host-tokens')).body, []);
  });

  it('validates the host, the provider and duplicates', async () => {
    assert.equal((await addToken('gitea', 'http://git.example.com')).status, 400);
    assert.equal((await addToken('gitea', 'github.com')).status, 400);
    assert.equal((await addToken('github', 'git.example.com')).status, 400);
    assert.equal((await addToken('gitea', 'git.example.com', '  ')).status, 400);
    const mismatch = await addToken('gitlab', 'codeberg.org');
    assert.equal(mismatch.status, 400);
    assert.ok(mismatch.body.errors.provider);

    assert.equal((await addToken('gitea', 'git.example.com')).status, 201);
    assert.equal((await addToken('gitea', 'GIT.example.com')).status, 409);
    // Another provider on the same host is a separate token.
    const gitlab = await addToken('gitlab', 'git.example.com');
    assert.equal(gitlab.status, 201);
    assert.equal((await request('PUT', `/api/git-host-tokens/${gitlab.body.id}`, { provider: 'gitea' })).status, 409);
  });

  it('reads repositories without their own token with the token of their host – only on that host', async () => {
    await addToken('gitea', 'git.example.com', 'gitea-host-token');
    await addToken('gitlab', 'gitlab.example.com', 'gitlab-host-token');

    const added = await request('POST', '/api/repositories', { repository: 'https://git.example.com/team/app', provider: 'gitea' });
    assert.equal(added.status, 201);
    const giteaCalls = requests.filter((r) => r.url.startsWith('https://git.example.com/'));
    assert.ok(giteaCalls.length >= 2, 'existence check and first release check');
    for (const r of giteaCalls) assert.equal(r.headers.get('authorization'), 'token gitea-host-token');

    await request('POST', '/api/repositories', { repository: 'https://gitlab.example.com/group/project', provider: 'gitlab' });
    const gitlabCalls = requests.filter((r) => r.url.startsWith('https://gitlab.example.com/'));
    assert.ok(gitlabCalls.length > 0);
    for (const r of gitlabCalls) assert.equal(r.headers.get('private-token'), 'gitlab-host-token');

    // A host without a token is read anonymously, never with another host's or GitHub's token.
    requests = [];
    await request('POST', '/api/repositories', { repository: 'https://other.example.com/team/app', provider: 'gitea' });
    assert.ok(requests.length > 0);
    for (const r of requests) {
      assert.equal(r.headers.get('authorization'), null);
      assert.equal(r.headers.get('private-token'), null);
    }

    const tokens = await request('GET', '/api/git-host-tokens');
    assert.deepEqual(
      tokens.body.map((t: { host: string; repositoryCount: number }) => [t.host, t.repositoryCount]),
      [
        ['git.example.com', 1],
        ['gitlab.example.com', 1],
      ],
    );
  });

  it("prefers the repository's own token", async () => {
    await addToken('gitea', 'git.example.com', 'gitea-host-token');
    const added = await request('POST', '/api/repositories', {
      repository: 'https://git.example.com/team/app',
      provider: 'gitea',
      accessToken: 'own-token',
    });
    assert.equal(added.status, 201);
    const calls = requests.filter((r) => r.url.startsWith('https://git.example.com/'));
    assert.ok(calls.length > 0);
    for (const r of calls) assert.equal(r.headers.get('authorization'), 'token own-token');
    const [token] = (await request('GET', '/api/git-host-tokens')).body;
    assert.equal(token.repositoryCount, 0);
  });

  it('keeps GitHub repositories on the GitHub token', async () => {
    await addToken('gitea', 'git.example.com', 'gitea-host-token');
    assert.equal((await request('POST', '/api/repositories', { repository: 'acme/widget' })).status, 201);
    assert.equal(fake.lastToken, null);
  });

  it('lists host tokens as omitted secrets in a backup', async () => {
    await addToken('gitea', 'git.example.com');
    const backup = await request('GET', '/api/backup/export');
    assert.ok(backup.body.secretsOmitted.includes('Gitea/Forgejo token of git.example.com'));
    assert.ok(!JSON.stringify(backup.body).includes('host-secret-token'));
  });
});
