import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import {
  displayImage,
  imageState,
  installedVersion,
  isVersionTag,
  keptLabels,
  labelRepository,
  labelVersion,
  localDigests,
  parseDockerListOutput,
  parseEndpointUrl,
  parseImageRef,
  needsResolving,
  refinesTag,
  resolveCandidates,
  tagKey,
} from '../src/docker/domain.ts';
import { HttpDockerEngine } from '../src/docker/engine.ts';
import { OciRegistryClient, parseChallenge } from '../src/docker/registry.ts';
import { digest } from './helpers.ts';

describe('image references', () => {
  it('parses references like Docker does', () => {
    assert.deepEqual(parseImageRef('nginx'), { registry: 'docker.io', repository: 'library/nginx', tag: 'latest', digest: null });
    assert.deepEqual(parseImageRef('searxng/searxng:latest'), {
      registry: 'docker.io',
      repository: 'searxng/searxng',
      tag: 'latest',
      digest: null,
    });
    assert.deepEqual(parseImageRef('lscr.io/linuxserver/sonarr:4.0.11'), {
      registry: 'lscr.io',
      repository: 'linuxserver/sonarr',
      tag: '4.0.11',
      digest: null,
    });
    assert.deepEqual(parseImageRef('registry.lan:5000/team/app'), {
      registry: 'registry.lan:5000',
      repository: 'team/app',
      tag: 'latest',
      digest: null,
    });
    assert.deepEqual(parseImageRef(`ghcr.io/owner/app:1.2@${digest('a')}`), {
      registry: 'ghcr.io',
      repository: 'owner/app',
      tag: '1.2',
      digest: digest('a'),
    });
    assert.equal(parseImageRef('docker.io/library/redis:7')?.repository, 'library/redis');
    assert.equal(parseImageRef('index.docker.io/library/redis')?.registry, 'docker.io');
  });

  it('rejects image IDs and malformed references', () => {
    assert.equal(parseImageRef(digest('b')), null);
    assert.equal(parseImageRef('b'.repeat(64)), null);
    assert.equal(parseImageRef('Upper/Case'), null);
    assert.equal(parseImageRef(''), null);
  });

  it('shows short names and keys', () => {
    assert.equal(displayImage(parseImageRef('nginx:1.27')!), 'nginx:1.27');
    assert.equal(displayImage(parseImageRef('ghcr.io/owner/app')!), 'ghcr.io/owner/app:latest');
    assert.equal(tagKey(parseImageRef('nginx')!), 'docker.io/library/nginx:latest');
    assert.equal(tagKey(parseImageRef(`nginx@${digest('c')}`)!), null);
  });

  it('picks the digests of the same repository', () => {
    const ref = parseImageRef('nginx:latest')!;
    const digests = [`nginx@${digest('a')}`, `docker.io/library/nginx@${digest('a')}`, `mirror.lan/library/nginx@${digest('b')}`];
    assert.deepEqual(localDigests(ref, digests), [digest('a')]);
  });
});

describe('versions', () => {
  it('tells version tags from floating ones', () => {
    for (const tag of ['1.2.3', 'v2.0', '16', '2024.10.1', '1.27-alpine', 'version-4.0.11', '4.0.11.2680-ls263']) {
      assert.equal(isVersionTag(tag), true, tag);
    }
    for (const tag of ['latest', 'stable', 'alpine', 'main', 'nightly', null]) {
      assert.equal(isVersionTag(tag), false, String(tag));
    }
  });

  it('reads versions from labels, including linuxserver.io builds', () => {
    assert.equal(labelVersion({ 'org.opencontainers.image.version': '2.5.0' }), '2.5.0');
    assert.equal(labelVersion({ 'org.opencontainers.image.version': 'latest' }), null);
    assert.equal(labelVersion({ build_version: 'Linuxserver.io version:- 4.0.11.2680-ls263 Build-date:- 2024-11-20' }), '4.0.11.2680-ls263');
  });

  it('reads the repository from labels', () => {
    assert.equal(labelRepository({ 'org.opencontainers.image.source': 'https://github.com/SearXNG/searxng' }), 'searxng/searxng');
    assert.equal(
      labelRepository({ 'releasewatcher.repo': 'owner/own', 'org.opencontainers.image.source': 'https://github.com/a/b' }),
      'owner/own',
    );
    // Gitea/Forgejo and GitLab repositories are named with their host.
    assert.equal(labelRepository({ 'org.opencontainers.image.source': 'https://gitlab.com/A/b' }), 'gitlab.com/a/b');
    assert.equal(
      labelRepository({ 'org.opencontainers.image.source': 'https://codeberg.org/forgejo/forgejo.git' }),
      'codeberg.org/forgejo/forgejo',
    );
    // The url label of another host is usually a project or registry page.
    assert.equal(labelRepository({ 'org.opencontainers.image.url': 'https://hub.docker.com/r/a/b' }), null);
    assert.equal(labelRepository({ 'org.opencontainers.image.url': 'https://forgejo.org/' }), null);
  });

  it('keeps only the labels it uses', () => {
    assert.deepEqual(keptLabels({ 'org.opencontainers.image.version': '1.0', SECRET: 'x', 'com.docker.compose.project': 'media' }), {
      'org.opencontainers.image.version': '1.0',
      'com.docker.compose.project': 'media',
    });
  });

  it('derives the installed version: tag, refining label, resolved digest, label', () => {
    assert.deepEqual(installedVersion({ tag: '1.27', labels: {}, resolvedVersion: null }), { version: '1.27', source: 'tag' });
    assert.deepEqual(
      installedVersion({ tag: '16', labels: { 'org.opencontainers.image.version': '16.4' }, resolvedVersion: null }),
      { version: '16.4', source: 'label' },
    );
    // A label inherited from the base image does not override the tag.
    assert.deepEqual(
      installedVersion({ tag: '2.1.0', labels: { 'org.opencontainers.image.version': '24.04' }, resolvedVersion: null }),
      { version: '2.1.0', source: 'tag' },
    );
    assert.deepEqual(
      installedVersion({ tag: 'latest', labels: { 'org.opencontainers.image.version': '1.0' }, resolvedVersion: '1.1.0' }),
      { version: '1.1.0', source: 'digest' },
    );
    assert.deepEqual(
      installedVersion({ tag: 'latest', labels: { 'org.opencontainers.image.version': '1.0' }, resolvedVersion: null }),
      { version: '1.0', source: 'label' },
    );
    assert.equal(installedVersion({ tag: 'latest', labels: {}, resolvedVersion: null }), null);
    // A moving version tag shows the exact version with the same digest.
    assert.deepEqual(installedVersion({ tag: '17-alpine', labels: {}, resolvedVersion: '17.7-alpine3.22' }), {
      version: '17.7-alpine3.22',
      source: 'digest',
    });
    assert.deepEqual(installedVersion({ tag: '17-alpine', labels: {}, resolvedVersion: '16.4-alpine' }), { version: '17-alpine', source: 'tag' });
  });

  it('resolves floating and moving version tags, not pinned ones', () => {
    assert.equal(needsResolving('latest'), true);
    assert.equal(needsResolving('alpine'), true);
    assert.equal(needsResolving(null), true);
    assert.equal(needsResolving('17-alpine'), true);
    assert.equal(needsResolving('1.25'), true);
    assert.equal(needsResolving('1.25.3'), false);
    assert.equal(needsResolving('4.0.11.2680-ls263'), false);
    assert.equal(refinesTag('17.7-alpine3.22', '17-alpine'), true);
    assert.equal(refinesTag('17-alpine3.22', '17-alpine'), false);
    assert.equal(refinesTag('18.1-alpine', '17-alpine'), false);
  });

  it('compares local and registry digests', () => {
    assert.equal(imageState([digest('a')], digest('a')), 'up-to-date');
    assert.equal(imageState([digest('a')], digest('b')), 'update-available');
    assert.equal(imageState([], digest('b')), 'unknown');
    assert.equal(imageState([digest('a')], null), 'unknown');
  });

  it('chooses resolve candidates of the same flavour, newest and most specific first', () => {
    const tags = ['latest', '1', '1.2', '1.2.3', '1.2.2', '1.2.3-alpine', 'alpine', '0.9', 'nightly-2024'];
    assert.deepEqual(resolveCandidates(tags, 'latest'), ['1.2.3', '1.2.2', '1.2', '1', '0.9']);
    assert.deepEqual(resolveCandidates(tags, 'alpine'), ['1.2.3-alpine']);
    assert.deepEqual(resolveCandidates(['2026.9.5-242dc6e39', '2026.9.8-3fdc6d753', 'latest'], 'latest'), ['2026.9.8-3fdc6d753', '2026.9.5-242dc6e39']);
    assert.equal(resolveCandidates(Array.from({ length: 100 }, (_, i) => `1.${i}`), 'latest', 5).length, 5);
  });

  it('chooses more specific tags of the same line and variant for a moving version tag', () => {
    const tags = ['17', '17-alpine', '17-alpine3.22', '17.7', '17.7-alpine', '17.7-alpine3.22', '17.6-alpine', '17.7-bookworm', '18.1-alpine', '17rc1-alpine', 'alpine'];
    assert.deepEqual(resolveCandidates(tags, '17-alpine'), ['17.7-alpine3.22', '17.7-alpine', '17.6-alpine']);
    assert.deepEqual(resolveCandidates(['1.25', '1.25.3', '1.25.2', '1.26.0', '1.25.3-alpine'], '1.25'), ['1.25.3', '1.25.2']);
  });
});

describe('docker endpoints', () => {
  it('normalizes endpoint URLs', () => {
    assert.deepEqual(parseEndpointUrl('unix:///var/run/docker.sock'), {
      baseUrl: 'http://localhost',
      unixSocket: '/var/run/docker.sock',
      url: 'unix:///var/run/docker.sock',
    });
    assert.deepEqual(parseEndpointUrl('/run/podman/podman.sock'), {
      baseUrl: 'http://localhost',
      unixSocket: '/run/podman/podman.sock',
      url: 'unix:///run/podman/podman.sock',
    });
    assert.deepEqual(parseEndpointUrl('tcp://socket-proxy'), {
      baseUrl: 'http://socket-proxy:2375',
      unixSocket: null,
      url: 'tcp://socket-proxy:2375',
    });
    assert.deepEqual(parseEndpointUrl('https://nas.lan:2376/'), {
      baseUrl: 'https://nas.lan:2376',
      unixSocket: null,
      url: 'https://nas.lan:2376',
    });
    assert.ok('error' in parseEndpointUrl('ftp://x'));
    assert.ok('error' in parseEndpointUrl('http://user:pw@nas.lan:2375'));
    assert.ok('error' in parseEndpointUrl('socket-proxy:2375x'));
  });

  it('parses the CLI listing of Docker and Podman', () => {
    const output = [
      'runtime podman 5.2.0',
      'C {"id":"abc","name":"web","image":"docker.io/library/nginx:latest","imageId":"' + 'e'.repeat(64) + '","state":"running","labels":{"org.opencontainers.image.version":"1.27.3","other":"x"}}',
      `I {"id":"${'e'.repeat(64)}","repoDigests":["docker.io/library/nginx@${digest('a')}"]}`,
    ].join('\n');
    const listing = parseDockerListOutput(output)!;
    assert.equal(listing.runtime, 'podman');
    assert.equal(listing.version, '5.2.0');
    assert.deepEqual(listing.containers, [
      {
        id: 'abc',
        name: 'web',
        image: 'docker.io/library/nginx:latest',
        imageId: `sha256:${'e'.repeat(64)}`,
        state: 'running',
        labels: { 'org.opencontainers.image.version': '1.27.3' },
        repoDigests: [`docker.io/library/nginx@${digest('a')}`],
      },
    ]);
    assert.equal(parseDockerListOutput('runtime none\n'), null);
    assert.deepEqual(parseDockerListOutput('runtime docker 27.3.1\n')?.containers, []);
    assert.throws(() => parseDockerListOutput('permission denied while trying to connect to the Docker daemon socket'), /permission denied/);
  });

  it('reads containers from the Engine API over a socket', async () => {
    const requests: { url: string; unix: string | undefined }[] = [];
    const engine = new HttpDockerEngine('unix:///var/run/docker.sock', async (url, init) => {
      requests.push({ url, unix: init.unix });
      if (url.endsWith('/version')) return Response.json({ Version: '27.3.1', Components: [{ Name: 'Engine' }] });
      if (url.endsWith('/containers/json')) {
        return Response.json([
          { Id: 'abc', Names: ['/web'], Image: 'nginx:latest', ImageID: digest('e'), State: 'running', Labels: { 'com.docker.compose.project': 'site' } },
        ]);
      }
      return Response.json({ RepoDigests: [`nginx@${digest('a')}`] });
    });
    const listing = await engine.list();
    assert.equal(listing.runtime, 'docker');
    assert.deepEqual(listing.containers[0], {
      id: 'abc',
      name: 'web',
      image: 'nginx:latest',
      imageId: digest('e'),
      state: 'running',
      labels: { 'com.docker.compose.project': 'site' },
      repoDigests: [`nginx@${digest('a')}`],
    });
    assert.deepEqual(
      requests.map((r) => [r.url, r.unix]),
      [
        ['http://localhost/version', '/var/run/docker.sock'],
        ['http://localhost/containers/json', '/var/run/docker.sock'],
        [`http://localhost/images/${encodeURIComponent(digest('e'))}/json`, '/var/run/docker.sock'],
      ],
    );
  });

  it('keeps going when a socket proxy refuses images', async () => {
    const engine = new HttpDockerEngine('tcp://proxy:2375', async (url) => {
      if (url.endsWith('/version')) return Response.json({ Version: '27.3.1' });
      if (url.endsWith('/containers/json')) return Response.json([{ Id: 'abc', Names: ['/web'], Image: 'nginx:1.27', ImageID: digest('e') }]);
      return new Response('{"message":"forbidden"}', { status: 403 });
    });
    const listing = await engine.list();
    assert.deepEqual(listing.containers[0]?.repoDigests, []);
  });

  it('explains a refused container listing', async () => {
    const engine = new HttpDockerEngine('tcp://proxy:2375', async (url) =>
      url.endsWith('/version') ? Response.json({ Version: '27.3.1' }) : new Response('forbidden', { status: 403 }),
    );
    await assert.rejects(engine.list(), /allow CONTAINERS and IMAGES/);
  });
});

describe('registry client', () => {
  it('parses bearer challenges', () => {
    assert.deepEqual(parseChallenge('Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"'), {
      scheme: 'bearer',
      params: { realm: 'https://auth.docker.io/token', service: 'registry.docker.io', scope: 'repository:library/nginx:pull' },
    });
  });

  it('gets an anonymous token, then the digest of a tag', async () => {
    const calls: { url: string; method: string; auth: string | null; accept: string | null }[] = [];
    const client = new OciRegistryClient({
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url, method: init?.method ?? 'GET', auth: headers.get('authorization'), accept: headers.get('accept') });
        if (url.startsWith('https://auth.docker.io/token')) return Response.json({ token: 'anon' });
        if (headers.get('authorization') !== 'Bearer anon') {
          return new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"' },
          });
        }
        return new Response(null, { status: 200, headers: { 'docker-content-digest': digest('a') } });
      },
    });
    assert.equal(await client.digest(parseImageRef('nginx')!), digest('a'));
    assert.equal(calls[0]?.url, 'https://registry-1.docker.io/v2/library/nginx/manifests/latest');
    assert.equal(calls[0]?.method, 'HEAD');
    assert.match(calls[0]?.accept ?? '', /^application\/vnd\.oci\.image\.index\.v1\+json/);
    assert.equal(calls[1]?.url, 'https://auth.docker.io/token?service=registry.docker.io&scope=repository%3Alibrary%2Fnginx%3Apull');
    // The token is reused for the next request.
    await client.digest(parseImageRef('nginx:1.27')!);
    assert.equal(calls.length, 4);
  });

  it('pages through the tags of a repository on the same host', async () => {
    const client = new OciRegistryClient({
      fetch: async (url) =>
        url.includes('last=b')
          ? Response.json({ tags: ['c'] })
          : Response.json({ tags: ['a', 'b'] }, { headers: { link: '</v2/owner/app/tags/list?last=b&n=1000>; rel="next"' } }),
    });
    assert.deepEqual(await client.tags({ registry: 'ghcr.io', repository: 'owner/app' }), ['a', 'b', 'c']);
  });

  it('reports registries that need a login', async () => {
    const client = new OciRegistryClient({
      fetch: async () => new Response(null, { status: 401, headers: { 'www-authenticate': 'Basic realm="Registry"' } }),
    });
    await assert.rejects(client.digest(parseImageRef('registry.lan/app')!), /requires a login/);
  });
});
