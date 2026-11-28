import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { componentsFromStates, entityRepository, isComparableVersion } from '../src/home-assistant/domain.ts';
import { silentLogger } from '../src/log.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeSource, RecordingNotifier, release } from './helpers.ts';

const HA_URL = 'http://ha.test:8123';
const TOKEN = 'long-lived-secret-token';

const update = (entityId: string, attributes: Record<string, unknown>, state = 'off') => ({ entity_id: entityId, state, attributes });

describe('Home Assistant connections: domain', () => {
  it('reads the repository from the release URL', () => {
    assert.equal(entityRepository('update.card', 'https://github.com/Owner/Some-Card/releases/tag/v7.0.1'), 'owner/some-card');
    assert.equal(entityRepository('update.plain', 'https://github.com/owner/integration'), 'owner/integration');
    assert.equal(entityRepository('update.forge', 'https://codeberg.org/owner/repo/releases/tag/v1.0'), 'codeberg.org/owner/repo');
    assert.equal(entityRepository('update.lab', 'https://gitlab.com/group/project/-/releases/v2.0'), 'gitlab.com/group/project');
    assert.equal(entityRepository('update.bare', 'https://codeberg.org/owner/repo'), null);
    // Home Assistant Core links its release notes; the repository is known.
    assert.equal(entityRepository('update.home_assistant_core_update', 'https://www.home-assistant.io/latest-release-notes/'), 'home-assistant/core');
    // No repository: a release notes page, a page of GitHub itself, another scheme, nothing.
    assert.equal(entityRepository('update.device', 'https://www.example.com/firmware/1.2'), null);
    assert.equal(entityRepository('update.page', 'https://github.com/owner'), null);
    assert.equal(entityRepository('update.blueprint', 'https://github.com/owner/repo/blob/main/blueprints/automation/some.yaml'), null);
    assert.equal(entityRepository('update.gist', 'https://gist.github.com/owner/0123456789abcdef'), null);
    assert.equal(entityRepository('update.http', 'http://github.com/owner/repo'), null);
    assert.equal(entityRepository('update.none', null), null);
  });

  it('keeps the update entities that name a repository, pending or not', () => {
    const components = componentsFromStates([
      update('update.button_card_update', {
        title: 'Button Card',
        installed_version: 'v7.0.1',
        latest_version: 'v7.0.1',
        release_url: 'https://github.com/custom-cards/button-card/releases/tag/v7.0.1',
        supported_features: 1 | 4 | 16,
      }),
      update(
        'update.addon_update',
        { friendly_name: 'Some add-on Update', installed_version: '2.14.2', latest_version: '2.14.3', release_url: 'https://github.com/owner/addon/releases/tag/2.14.3' },
        'on',
      ),
      update('update.home_assistant_core_update', { title: 'Home Assistant Core', installed_version: '2026.11.3', latest_version: '2026.11.3' }),
      // Left out: device firmware without a link, a server running elsewhere that Home Assistant only announces,
      // an entity of another domain, a broken entry.
      update('update.plug_firmware', { title: 'Plug firmware', installed_version: '1.0', latest_version: '1.1', release_url: null }),
      update('update.server_version', { title: 'Server', installed_version: '2.0', latest_version: '2.1', release_url: 'https://github.com/owner/server/releases/tag/v2.1', supported_features: 16 }),
      { entity_id: 'sensor.temperature', state: '21', attributes: { release_url: 'https://github.com/owner/repo' } },
      null,
    ]);
    assert.deepEqual(
      components.map((c) => [c.entityId, c.name, c.installedVersion, c.latestVersion, c.repository]),
      [
        ['update.button_card_update', 'Button Card', 'v7.0.1', 'v7.0.1', 'custom-cards/button-card'],
        ['update.home_assistant_core_update', 'Home Assistant Core', '2026.11.3', '2026.11.3', 'home-assistant/core'],
        ['update.addon_update', 'Some add-on Update', '2.14.2', '2.14.3', 'owner/addon'],
      ],
    );
    assert.throws(() => componentsFromStates({ message: 'nope' }), /list of states/);
  });

  it('tells versions from commit hashes', () => {
    for (const version of ['v7.0.1', '2026.11.19', '18.4', '2.14.3-1', '1234567']) {
      assert.equal(isComparableVersion(version), true, version);
    }
    for (const version of ['a358575', '8d606bf960f065d20c1a7dd12cad90b805d99a55', 'main', null]) {
      assert.equal(isComparableVersion(version), false, String(version));
    }
  });
});

describe('Home Assistant connections: API', () => {
  let app: App;
  let store: RepositoryStore;
  let source: FakeSource;
  let baseUrl: URL;
  /** What the fake Home Assistant answers `GET /api/states` with. */
  let states: unknown[];
  let failure: Response | null;
  /** `state` of `GET /api/config`: `RUNNING`, or e.g. `NOT_RUNNING` while Home Assistant starts. */
  let haState: string;
  let requests: { url: string; authorization: string | null }[];

  const requestedUrls = () => requests.map((r) => r.url);

  const fakeHomeAssistant = async (input: string, init?: RequestInit): Promise<Response> => {
    const authorization = new Headers(init?.headers).get('authorization');
    requests.push({ url: input, authorization });
    if (authorization !== `Bearer ${TOKEN}`) {
      return new Response('401: Unauthorized', { status: 401 });
    }
    if (new URL(input).pathname === '/api/config') {
      return failure ?? Response.json({ state: haState });
    }
    return failure ?? Response.json(states);
  };

  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      ...(payload === undefined ? {} : { body: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };

  const addConnection = async (payload: Record<string, unknown> = {}) => {
    const response = await request('POST', '/api/home-assistant/connections', { name: 'Home', url: `${HA_URL}/`, token: TOKEN, ...payload });
    await app.homeAssistant.idle();
    return response;
  };

  beforeEach(async () => {
    requests = [];
    failure = null;
    haState = 'RUNNING';
    states = [
      update('update.button_card_update', {
        title: 'Button Card',
        installed_version: 'v7.0.0',
        latest_version: 'v7.0.1',
        release_url: 'https://github.com/custom-cards/button-card/releases/tag/v7.0.1',
      }, 'on'),
      update('update.some_integration_update', {
        title: 'Some integration',
        installed_version: 'a358575',
        latest_version: 'a358575',
        release_url: 'https://github.com/owner/some-integration',
      }),
      update('update.home_assistant_core_update', { title: 'Home Assistant Core', installed_version: '2026.11.3', latest_version: '2026.11.3' }),
      update('update.plug_firmware', { title: 'Plug firmware', installed_version: '1.0', latest_version: '1.1' }),
    ];
    store = new RepositoryStore(':memory:');
    source = new FakeSource();
    source.existing.add('custom-cards/button-card').add('owner/some-integration').add('other/repo');
    source.releases = [release('v7.0.1', 2), release('v7.0.0', 1)];
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source,
      notifiers: [new RecordingNotifier()],
      log: silentLogger,
      auth: { requireAuth: false },
      homeAssistantFetch: fakeHomeAssistant,
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  it('adds a connection, reads its components and never returns the token', async () => {
    const added = await addConnection();
    assert.equal(added.status, 201);
    assert.equal(added.body.url, HA_URL);
    assert.equal(added.body.token, undefined);
    assert.ok(!added.text.includes(TOKEN));

    const overview = await request('GET', '/api/home-assistant');
    assert.ok(!overview.text.includes(TOKEN));
    const [connection] = overview.body.connections;
    assert.equal(connection.name, 'Home');
    assert.equal(connection.lastError, null);
    assert.ok(connection.lastCheckedAt);
    assert.match(connection.tokenMasked, /oken$/);
    assert.deepEqual(
      overview.body.components.map((c: Record<string, unknown>) => [c['name'], c['repositoryName'], c['installedVersion'], c['versionComparable'], c['homeAssistantUpdate']]),
      [
        ['Button Card', 'custom-cards/button-card', 'v7.0.0', true, true],
        ['Home Assistant Core', 'home-assistant/core', '2026.11.3', true, false],
        ['Some integration', 'owner/some-integration', 'a358575', false, false],
      ],
    );
    assert.deepEqual(requestedUrls(), [`${HA_URL}/api/config`, `${HA_URL}/api/states`]);
    // Encrypted at rest.
    const row = store.database.query<{ token: string }, []>('SELECT token FROM home_assistant_connections').get()!;
    assert.ok(!row.token.includes(TOKEN));
  });

  it('validates a new connection', async () => {
    assert.equal((await addConnection({ name: ' ' })).status, 400);
    assert.equal((await addConnection({ url: 'ha.test:8123' })).status, 400);
    assert.equal((await addConnection({ url: 'http://user:pw@ha.test:8123' })).status, 400);
    assert.equal((await addConnection({ token: ' ' })).status, 400);
    assert.deepEqual((await request('GET', '/api/home-assistant/connections')).body, []);
  });

  it('keeps the ids of components and drops those Home Assistant no longer has', async () => {
    const { body: connection } = await addConnection();
    const before = (await request('GET', '/api/home-assistant')).body.components;
    states = [
      update('update.button_card_update', {
        title: 'Button Card',
        installed_version: 'v7.0.1',
        latest_version: 'v7.0.1',
        release_url: 'https://github.com/custom-cards/button-card/releases/tag/v7.0.1',
      }),
    ];
    assert.equal((await request('POST', `/api/home-assistant/connections/${connection.id}/check`)).status, 202);
    await app.homeAssistant.idle();
    const after = (await request('GET', '/api/home-assistant')).body.components;
    assert.equal(after.length, 1);
    assert.equal(after[0].id, before.find((c: { name: string }) => c.name === 'Button Card').id);
    assert.equal(after[0].installedVersion, 'v7.0.1');
    assert.equal(after[0].homeAssistantUpdate, false);
  });

  it('takes "update available" from Home Assistant, not from comparing versions', async () => {
    states = [
      // A pre-release newer than the latest version, and a skipped version: Home Assistant reports no update.
      update('update.beta_update', { title: 'Beta', installed_version: 'v3.0.0-beta.2', latest_version: 'v2.3.1', release_url: 'https://github.com/owner/beta/releases/tag/v2.3.1' }),
      update('update.skipped_update', { title: 'Skipped', installed_version: '3.6.0', latest_version: '3.6.1', skipped_version: '3.6.1', release_url: 'https://github.com/owner/skipped/releases/tag/3.6.1' }),
      update('update.pending_update', { title: 'Pending', installed_version: '1.0', latest_version: '1.1', release_url: 'https://github.com/owner/pending/releases/tag/1.1' }, 'on'),
    ];
    await addConnection();
    const components = (await request('GET', '/api/home-assistant')).body.components;
    assert.deepEqual(
      components.map((c: Record<string, unknown>) => [c['name'], c['homeAssistantUpdate']]),
      [['Beta', false], ['Pending', true], ['Skipped', false]],
    );
  });

  it('keeps the components and reports the error when Home Assistant cannot be read', async () => {
    const { body: connection } = await addConnection();
    failure = new Response('Bad Gateway', { status: 502 });
    await request('POST', `/api/home-assistant/connections/${connection.id}/check`);
    await app.homeAssistant.idle();
    const overview = (await request('GET', '/api/home-assistant')).body;
    assert.match(overview.connections[0].lastError, /answered 502/);
    assert.equal(overview.components.length, 3);
  });

  it('keeps the components while Home Assistant is still starting', async () => {
    const { body: connection } = await addConnection();
    // Starting: the API answers, but the integrations and their update entities are not loaded yet.
    haState = 'NOT_RUNNING';
    states = [];
    await request('POST', `/api/home-assistant/connections/${connection.id}/check`);
    await app.homeAssistant.idle();
    const overview = (await request('GET', '/api/home-assistant')).body;
    assert.equal(overview.components.length, 3);
    assert.match(overview.connections[0].lastError, /still starting/);
  });

  it('tests a connection without saving it', async () => {
    const ok = await request('POST', '/api/home-assistant/connections/test', { url: HA_URL, token: TOKEN });
    assert.deepEqual(ok.body, { components: 3 });
    const rejected = await request('POST', '/api/home-assistant/connections/test', { url: HA_URL, token: 'wrong' });
    assert.equal(rejected.status, 502);
    assert.match(rejected.body.detail, /rejected the access token/);
    assert.equal((await request('POST', '/api/home-assistant/connections/test', { url: HA_URL })).status, 400);
    assert.deepEqual((await request('GET', '/api/home-assistant')).body.connections, []);

    // The saved token is used for the saved address only.
    const { body: connection } = await addConnection();
    assert.equal((await request('POST', '/api/home-assistant/connections/test', { url: HA_URL, id: connection.id })).status, 200);
    requests = [];
    assert.equal((await request('POST', '/api/home-assistant/connections/test', { url: 'http://other.test:8123', id: connection.id })).status, 400);
    assert.deepEqual(requestedUrls(), []);
  });

  it('edits a connection: keeps the token, asks for it again for another address', async () => {
    const { body: connection } = await addConnection();
    const path = `/api/home-assistant/connections/${connection.id}`;
    const renamed = await request('PUT', path, { name: 'Flat', url: HA_URL, isEnabled: false });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Flat');
    assert.equal(renamed.body.isEnabled, false);
    assert.equal((await request('GET', '/api/home-assistant')).body.components.length, 3);

    requests = [];
    assert.equal((await request('PUT', path, { name: 'Flat', url: 'http://other.test:8123' })).status, 400);
    assert.deepEqual(requestedUrls(), []);

    const moved = await request('PUT', path, { name: 'Flat', url: 'http://other.test:8123', token: TOKEN, isEnabled: true });
    assert.equal(moved.status, 200);
    await app.homeAssistant.idle();
    assert.deepEqual(requestedUrls(), ['http://other.test:8123/api/config', 'http://other.test:8123/api/states']);

    assert.equal((await request('PUT', '/api/home-assistant/connections/999', { name: 'x', url: HA_URL })).status, 404);
  });

  it('removes a connection with its components', async () => {
    const { body: connection } = await addConnection();
    assert.equal((await request('DELETE', `/api/home-assistant/connections/${connection.id}`)).status, 204);
    assert.deepEqual((await request('GET', '/api/home-assistant')).body.components, []);
    assert.equal((await request('DELETE', `/api/home-assistant/connections/${connection.id}`)).status, 404);
  });

  it('reads the enabled connections on the scheduled run', async () => {
    await addConnection();
    const { body: disabled } = await addConnection({ name: 'Disabled', url: 'http://second.test:8123' });
    await request('PUT', `/api/home-assistant/connections/${disabled.id}`, { name: 'Disabled', url: 'http://second.test:8123', isEnabled: false });
    requests = [];
    assert.equal((await request('POST', '/api/home-assistant/check')).status, 202);
    while (app.homeAssistantJob.status.isRunning) await Bun.sleep(5);
    await app.homeAssistant.idle();
    assert.deepEqual(requestedUrls(), [`${HA_URL}/api/config`, `${HA_URL}/api/states`]);
  });

  it('saves the check schedule', async () => {
    const response = await request('PUT', '/api/settings', { homeAssistantCheckCron: '15 3 * * *' });
    assert.equal(response.status, 200);
    assert.equal(response.body.homeAssistant.checkCron, '15 3 * * *');
    assert.equal((await request('PUT', '/api/settings', { homeAssistantCheckCron: 'nope' })).status, 400);
  });

  it('lists connections as omitted secrets in a backup', async () => {
    await addConnection();
    const backup = await request('GET', '/api/backup/export');
    assert.ok(backup.body.secretsOmitted.includes('Home Assistant connection "Home"'));
    assert.ok(!backup.text.includes(TOKEN));
  });
  // --- Linking to watched repositories ---

  const watch = async (repository: string) => (await request('POST', '/api/repositories', { repository })).body;
  const repository = async (id: number) =>
    (await request('GET', '/api/repositories')).body.find((r: { id: number }) => r.id === id);
  const component = async (name: string) =>
    (await request('GET', '/api/home-assistant')).body.components.find((c: { name: string }) => c.name === name);
  const recheck = async () => {
    const [connection] = (await request('GET', '/api/home-assistant/connections')).body;
    await request('POST', `/api/home-assistant/connections/${connection.id}/check`);
    await app.homeAssistant.idle();
  };

  it('offers a component of a repository that is not watched as a suggestion', async () => {
    await addConnection();
    const card = await component('Button Card');
    assert.equal(card.repository, null);
    assert.equal(card.suggestedRepository, 'custom-cards/button-card');
    assert.equal(card.updateAvailable, null);
    // Nothing is added to the watch list on its own.
    assert.deepEqual((await request('GET', '/api/repositories')).body, []);
  });

  it('links a component to the watched repository it names and gives the repository its installed version', async () => {
    const repo = await watch('custom-cards/button-card');
    await addConnection();
    const card = await component('Button Card');
    assert.equal(card.repository.id, repo.id);
    assert.equal(card.repository.latestVersion, 'v7.0.1');
    assert.equal(card.suggestedRepository, null);
    assert.equal(card.updateAvailable, true);

    const dto = await repository(repo.id);
    assert.equal(dto.installedVersion, 'v7.0.0');
    assert.equal(dto.installedVersionSource, 'machine');
    assert.deepEqual(dto.installedVersionApp, { kind: 'home-assistant', id: card.id, name: 'Button Card', machine: 'Home' });

    // The next check carries the new version over (trigger), also when saved through another code path.
    states = [update('update.button_card_update', { title: 'Button Card', installed_version: 'v7.0.1', latest_version: 'v7.0.1', release_url: 'https://github.com/custom-cards/button-card/releases/tag/v7.0.1' })];
    await recheck();
    assert.equal((await repository(repo.id)).installedVersion, 'v7.0.1');
    assert.equal((await component('Button Card')).updateAvailable, false);
  });

  it('gives a repository added later the version Home Assistant already reported', async () => {
    await addConnection();
    const repo = await watch('custom-cards/button-card');
    assert.equal(repo.installedVersion, 'v7.0.0');
    assert.equal(repo.installedVersionApp.kind, 'home-assistant');
    assert.equal((await component('Button Card')).suggestedRepository, null);
  });

  it('does not take a commit hash as the installed version', async () => {
    const repo = await watch('owner/some-integration');
    await addConnection();
    const dto = await repository(repo.id);
    assert.equal(dto.installedVersion, null);
    assert.equal(dto.installedVersionApp, null);
    const integration = await component('Some integration');
    assert.equal(integration.repository.id, repo.id);
    assert.equal(integration.updateAvailable, null);
  });

  it('keeps a version URL or another source of a repository', async () => {
    const repo = await watch('custom-cards/button-card');
    await request('PUT', `/api/repositories/${repo.id}`, { includePrereleases: false, isEnabled: true, installedVersionUrl: 'https://app.test/version' });
    await addConnection();
    const dto = await repository(repo.id);
    assert.equal(dto.installedVersionApp, null);
    assert.equal(dto.installedVersionUrl, 'https://app.test/version');
  });

  it('falls back to the last version when the component or its connection is gone', async () => {
    const repo = await watch('custom-cards/button-card');
    const { body: connection } = await addConnection();
    states = [];
    await recheck();
    let dto = await repository(repo.id);
    assert.equal(dto.installedVersion, 'v7.0.0');
    assert.equal(dto.installedVersionApp, null);
    assert.match(dto.installedVersionError, /removed from Home Assistant/);

    // Back again: read from Home Assistant once more; removing the connection drops the source with its components.
    states = [update('update.button_card_update', { title: 'Button Card', installed_version: 'v7.0.1', latest_version: 'v7.0.1', release_url: 'https://github.com/custom-cards/button-card/releases/tag/v7.0.1' })];
    await recheck();
    assert.equal((await repository(repo.id)).installedVersionApp.kind, 'home-assistant');
    await request('DELETE', `/api/home-assistant/connections/${connection.id}`);
    dto = await repository(repo.id);
    assert.equal(dto.installedVersion, 'v7.0.1');
    assert.equal(dto.installedVersionApp, null);
  });

  it('drops the source when the entity names another repository', async () => {
    const repo = await watch('custom-cards/button-card');
    await addConnection();
    states = [update('update.button_card_update', { title: 'Button Card', installed_version: 'v8.0.0', latest_version: 'v8.0.0', release_url: 'https://github.com/other/repo/releases/tag/v8.0.0' })];
    await recheck();
    const dto = await repository(repo.id);
    assert.equal(dto.installedVersion, 'v7.0.0');
    assert.equal(dto.installedVersionApp, null);
    assert.match(dto.installedVersionError, /no longer names this repository/);
  });

  it('lists components as installed-version sources and refuses one that names another repository', async () => {
    const repo = await watch('custom-cards/button-card');
    const other = await watch('other/repo');
    await addConnection();
    const card = await component('Button Card');
    const groups = (await request('GET', '/api/machine-apps')).body;
    const group = groups.find((g: { machine: { kind: string } }) => g.machine.kind === 'home-assistant');
    assert.equal(group.machine.name, 'Home');
    assert.deepEqual(
      group.apps.map((a: Record<string, unknown>) => [a['kind'], a['name'], a['repository']]),
      [
        ['home-assistant', 'Button Card', 'custom-cards/button-card'],
        ['home-assistant', 'Home Assistant Core', null],
        ['home-assistant', 'Some integration', null],
      ],
    );
    const refused = await request('PUT', `/api/repositories/${other.id}`, { includePrereleases: false, isEnabled: true, installedVersionApp: { kind: 'home-assistant', id: card.id } });
    assert.equal(refused.status, 400);

    // Stopped and chosen again by hand in the repository's settings.
    await request('PUT', `/api/repositories/${repo.id}`, { includePrereleases: false, isEnabled: true, installedVersionApp: null });
    assert.equal((await repository(repo.id)).installedVersionApp, null);
    const chosen = await request('PUT', `/api/repositories/${repo.id}`, { includePrereleases: false, isEnabled: true, installedVersionApp: { kind: 'home-assistant', id: card.id } });
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.installedVersionApp.kind, 'home-assistant');
  });

});
