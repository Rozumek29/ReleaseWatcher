import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { DockerStore } from '../src/docker/store.ts';
import { silentLogger } from '../src/log.ts';
import { SettingsService } from '../src/settings.ts';
import { addProxmoxHost, digest, engineContainer, FakeEngine, FakeRegistry, FakeShell, FakeSource, release } from './helpers.ts';

interface ContainerView {
  id: number;
  name: string;
  source: { kind: string; id: number; name: string | null };
  imageDisplay: string;
  composeProject: string | null;
  installedVersion: string | null;
  installedVersionSource: string | null;
  linkAuto: boolean;
  repository: { id: number; fullName: string; latestVersion: string | null } | null;
  suggestedRepository: string | null;
  updateAvailable: boolean | null;
  ignored: boolean;
  present: boolean;
  registry: { state: string; latestVersion: string | null; error: string | null; note: string | null };
}

describe('docker API', () => {
  let app: App;
  let store: RepositoryStore;
  let engine: FakeEngine;
  let registry: FakeRegistry;
  let shell: FakeShell;
  let source: FakeSource;
  let baseUrl: URL;
  const engineUrls: string[] = [];

  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text), text };
  };

  const overview = async () => (await request('GET', '/api/docker')).json() as { endpoints: { id: number; engine: string | null; lastError: string | null }[]; containers: ContainerView[] };
  const container = async (name: string) => (await overview()).containers.find((c) => c.name === name)!;

  /** Adds an endpoint and waits for its first check. */
  const addEndpoint = async (url = 'tcp://socket-proxy:2375') => {
    const response = await request('POST', '/api/docker/endpoints', { name: 'NAS', url });
    assert.equal(response.status, 201);
    await app.docker.idle();
    return response.json() as { id: number; url: string };
  };

  beforeEach(async () => {
    engineUrls.length = 0;
    engine = new FakeEngine();
    registry = new FakeRegistry();
    shell = new FakeShell()
      .on(/^pct list /, { output: 'VMID       Status     Lock         Name\n101        running                 docker\n---releasewatcher-qm---\n' })
      .on(/^pct status 101$/, { output: 'status: running\n' });
    source = new FakeSource();
    store = new RepositoryStore(':memory:');
    addProxmoxHost(store);
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source,
      notifiers: [],
      log: silentLogger,
      shell,
      registry,
      dockerEngine: (url) => {
        engineUrls.push(url);
        return engine;
      },
      reconnectDelayMs: 0,
      auth: { requireAuth: false },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  it('validates and normalizes endpoints', async () => {
    const invalid = await request('POST', '/api/docker/endpoints', { name: 'NAS', url: 'ftp://nas' });
    assert.equal(invalid.status, 400);
    assert.ok(invalid.json().errors.url);
    const endpoint = await addEndpoint('tcp://socket-proxy');
    assert.equal(endpoint.url, 'tcp://socket-proxy:2375');
    assert.deepEqual(engineUrls, ['tcp://socket-proxy:2375']);
    const list = (await request('GET', '/api/docker/endpoints')).json() as { id: number; url: string; engine: string | null; isChecking: boolean }[];
    assert.deepEqual(list.map((e) => [e.id, e.url, e.isChecking]), [[endpoint.id, 'tcp://socket-proxy:2375', false]]);
    assert.ok(list[0]!.engine);
  });

  it('tests an endpoint without saving it', async () => {
    engine.listing.containers = [engineContainer('web', 'nginx:1.27')];
    const ok = await request('POST', '/api/docker/endpoints/test', { url: 'unix:///var/run/docker.sock' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json(), { engine: 'docker 27.3.1', containers: 1 });
    engine.error = new Error('/var/run/docker.sock was not found – mount the Docker socket or check the path.');
    const failed = await request('POST', '/api/docker/endpoints/test', { url: 'unix:///var/run/docker.sock' });
    assert.equal(failed.status, 502);
    assert.match(failed.json().detail, /was not found/);
    assert.equal((await overview()).endpoints.length, 0);
  });

  it('lists containers with versions from tags and labels, grouped by compose project', async () => {
    engine.listing.containers = [
      engineContainer('web', 'nginx:1.27.3', { labels: { 'com.docker.compose.project': 'site' } }),
      engineContainer('db', 'postgres:16', { labels: { 'org.opencontainers.image.version': '16.4', 'com.docker.compose.project': 'site' } }),
      engineContainer('local', 'myapp:dev'),
    ];
    await addEndpoint();
    const { endpoints, containers } = await overview();
    assert.equal(endpoints[0]?.engine, 'docker 27.3.1');
    assert.deepEqual(
      containers.map((c) => [c.name, c.installedVersion, c.installedVersionSource, c.composeProject, c.source.name]),
      [
        ['db', '16.4', 'label', 'site', 'NAS'],
        ['local', null, null, null, 'NAS'],
        ['web', '1.27.3', 'tag', 'site', 'NAS'],
      ],
    );
  });

  it('resolves a latest digest to its version tag and reports a newer image of the same tag', async () => {
    registry.set('docker.io/searxng/searxng', { latest: digest('b'), '2024.11.20': digest('b'), '2024.11.1': digest('a'), '2024.10.1': digest('9') });
    engine.listing.containers = [engineContainer('searxng', 'searxng/searxng:latest', { repoDigests: [`searxng/searxng@${digest('a')}`] })];
    await addEndpoint();
    const searxng = await container('searxng');
    assert.equal(searxng.installedVersion, '2024.11.1');
    assert.equal(searxng.installedVersionSource, 'digest');
    assert.equal(searxng.registry.state, 'update-available');
    assert.equal(searxng.registry.latestVersion, '2024.11.20');
    // Resolved digests are cached: the next check asks only for the tag's digest again.
    registry.tagRequests.length = 0;
    await request('POST', `/api/docker/endpoints/${(await overview()).endpoints[0]!.id}/check`);
    await app.docker.idle();
    assert.deepEqual(registry.tagRequests, []);
  });

  it('shows the exact versions of a moving version tag such as 17-alpine', async () => {
    registry.set('docker.io/library/postgres', {
      '17-alpine': digest('b'),
      '17.7-alpine': digest('b'),
      '17.7-alpine3.22': digest('b'),
      '17.6-alpine': digest('a'),
      '17.6-alpine3.22': digest('a'),
      '18.1-alpine': digest('c'),
    });
    engine.listing.containers = [engineContainer('db', 'postgres:17-alpine', { repoDigests: [`postgres@${digest('a')}`] })];
    await addEndpoint();
    const db = await container('db');
    assert.equal(db.installedVersion, '17.6-alpine3.22');
    assert.equal(db.installedVersionSource, 'digest');
    assert.equal(db.registry.state, 'update-available');
    assert.equal(db.registry.latestVersion, '17.7-alpine3.22');
  });

  it('shows images without releases as up to date or updated by digest only', async () => {
    registry.set('docker.io/library/nginx', { latest: digest('a') });
    engine.listing.containers = [engineContainer('web', 'nginx', { repoDigests: [`nginx@${digest('a')}`] })];
    await addEndpoint();
    const web = await container('web');
    assert.equal(web.installedVersion, null);
    assert.equal(web.registry.state, 'up-to-date');
  });

  it('keeps going when the registry fails', async () => {
    engine.listing.containers = [engineContainer('app', 'ghcr.io/owner/private:latest', { repoDigests: [`ghcr.io/owner/private@${digest('a')}`] })];
    await addEndpoint();
    const app_ = await container('app');
    assert.equal(app_.registry.state, 'unknown');
    assert.match(app_.registry.error ?? '', /not found/);
  });

  it('links containers to watched repositories through labels or by hand', async () => {
    const repo = store.add('searxng', 'searxng', false);
    repo.lastSeenTag = '2024.11.20';
    store.save(repo);
    const other = store.add('owner', 'other', false);
    engine.listing.containers = [
      engineContainer('searxng', 'searxng/searxng:2024.11.1', {
        labels: { 'org.opencontainers.image.source': 'https://github.com/searxng/searxng' },
      }),
      engineContainer('app', 'owner/app:1.0.0', { labels: { 'releasewatcher.repo': 'owner/app' } }),
    ];
    await addEndpoint();
    const searxng = await container('searxng');
    assert.equal(searxng.repository?.fullName, 'searxng/searxng');
    assert.equal(searxng.updateAvailable, true);
    const app_ = await container('app');
    assert.equal(app_.repository, null);
    assert.equal(app_.suggestedRepository, 'owner/app');

    // Linked by hand to another repository, then back to the labels.
    const linked = await request('PUT', `/api/docker/containers/${app_.id}`, { repositoryId: other.id });
    assert.equal(linked.status, 200);
    assert.equal(linked.json().repository.fullName, 'owner/other');
    assert.equal(linked.json().linkAuto, false);
    const unknown = await request('PUT', `/api/docker/containers/${app_.id}`, { repositoryId: 999 });
    assert.equal(unknown.status, 400);
    const auto = await request('PUT', `/api/docker/containers/${app_.id}`, { linkAuto: true });
    assert.equal(auto.json().repository, null);

    // The installed version counts for the repository (and its vulnerabilities).
    const dto = (await request('GET', `/api/repositories/${repo.id}`)).json();
    assert.ok(JSON.stringify(dto).includes('2024.11.1'));
  });

  it('keeps ignored containers ignored when they are re-created', async () => {
    engine.listing.containers = [engineContainer('web', 'nginx:1.27'), engineContainer('old', 'nginx:1.25', { labels: { 'releasewatcher.ignore': 'true' } })];
    const endpoint = await addEndpoint();
    assert.equal((await container('old')).ignored, true);
    const web = await container('web');
    assert.equal((await request('PUT', `/api/docker/containers/${web.id}`, { ignored: true })).json().ignored, true);

    // Removed: the ignored one is kept (not present), the other one is gone; re-created: still ignored.
    engine.listing.containers = [];
    await request('POST', `/api/docker/endpoints/${endpoint.id}/check`);
    await app.docker.idle();
    assert.deepEqual((await overview()).containers.map((c) => [c.name, c.present]), [['old', false], ['web', false]]);
    engine.listing.containers = [engineContainer('web', 'nginx:1.27', { id: 'new'.padEnd(64, '1') })];
    await request('POST', `/api/docker/endpoints/${endpoint.id}/check`);
    await app.docker.idle();
    const recreated = await container('web');
    assert.equal(recreated.present, true);
    assert.equal(recreated.ignored, true);
  });

  it('records endpoint errors and removes endpoints with their containers', async () => {
    engine.error = new Error('Could not reach http://socket-proxy:2375: connection refused');
    const endpoint = await addEndpoint();
    assert.match((await overview()).endpoints[0]?.lastError ?? '', /connection refused/);
    engine.error = null;
    engine.listing.containers = [engineContainer('web', 'nginx:1.27')];
    await request('POST', `/api/docker/endpoints/${endpoint.id}/check`);
    await app.docker.idle();
    assert.equal((await overview()).endpoints[0]?.lastError, null);
    assert.equal((await request('DELETE', `/api/docker/endpoints/${endpoint.id}`)).status, 204);
    const after = await overview();
    assert.deepEqual([after.endpoints, after.containers], [[], []]);
    assert.equal(new DockerStore(store.database).listContainers().length, 0);
  });

  it('lists Docker containers during target checks and forgets them when switched off', async () => {
    const ps = [
      'runtime docker 27.3.1',
      `C {"id":"${'a'.repeat(64)}","name":"/vaultwarden","image":"vaultwarden/server:1.32.0","imageId":"${digest('e')}","state":"running","labels":{"com.docker.compose.project":"vw"}}`,
      `I {"id":"${digest('e')}","repoDigests":["vaultwarden/server@${digest('a')}"]}`,
    ].join('\n');
    shell.on(/command -v docker/, { output: ps });
    registry.set('docker.io/vaultwarden/server', { '1.32.0': digest('a') });
    const added = (await request('POST', '/api/containers', { vmid: 101 })).json();
    await app.containers.wait(added.id);
    const target = (await request('GET', `/api/containers/${added.id}`)).json();
    assert.deepEqual(target.docker, { enabled: true, engine: 'docker 27.3.1', error: null });
    const vw = await container('vaultwarden');
    assert.deepEqual(vw.source.kind, 'target');
    assert.equal(vw.source.id, added.id);
    assert.equal(vw.installedVersion, '1.32.0');
    assert.equal(vw.registry.state, 'up-to-date');

    const off = await request('PUT', `/api/containers/${added.id}`, { name: target.name, isEnabled: true, aptEnabled: true, dockerEnabled: false });
    assert.equal(off.json().docker.enabled, false);
    assert.deepEqual((await overview()).containers, []);
    // Switched off: the next check does not list containers.
    shell.commands.length = 0;
    await request('POST', `/api/containers/${added.id}/check`);
    await app.containers.wait(added.id);
    assert.ok(!shell.commands.some((c) => c.includes('command -v docker')));
  });

  it('keeps a failed listing out of the target error', async () => {
    shell.on(/command -v docker/, { exitCode: 1, output: 'permission denied while trying to connect to the Docker daemon socket' });
    const added = (await request('POST', '/api/containers', { vmid: 101 })).json();
    await app.containers.wait(added.id);
    const target = (await request('GET', `/api/containers/${added.id}`)).json();
    assert.match(target.docker.error, /permission denied/);
    assert.ok(!(target.lastError ?? '').includes('Docker'));
  });

  it('counts containers with updates in the status', async () => {
    registry.set('docker.io/library/nginx', { latest: digest('b') });
    engine.listing.containers = [engineContainer('web', 'nginx', { repoDigests: [`nginx@${digest('a')}`] }), engineContainer('db', 'postgres:16')];
    await addEndpoint();
    const status = (await request('GET', '/api/status')).json();
    assert.deepEqual(status.docker, { total: 2, updatesAvailable: 1 });
  });

  it('checks again on request', async () => {
    source.releases = [release('v1', 1)];
    registry.set('docker.io/library/nginx', { latest: digest('a') });
    engine.listing.containers = [engineContainer('web', 'nginx', { repoDigests: [`nginx@${digest('a')}`] })];
    await addEndpoint();
    const calls = engine.calls;
    assert.equal((await request('POST', '/api/docker/check')).status, 202);
    while (app.dockerJob.status.isRunning) await Bun.sleep(5);
    await app.docker.idle();
    assert.equal(engine.calls, calls + 1);
  });

  it('saves the Docker check schedule', async () => {
    const response = await request('PUT', '/api/settings', { dockerCheckCron: '15 3 * * *' });
    assert.equal(response.status, 200);
    assert.equal(response.json().docker.checkCron, '15 3 * * *');
    assert.equal((await request('PUT', '/api/settings', { dockerCheckCron: 'nope' })).status, 400);
  });
});
