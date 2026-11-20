import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { HomeAssistantApi, HomeAssistantApiError } from '../src/proxmox/home-assistant-api.ts';
import {
  type HomeAssistantUpdate,
  homeAssistantUpdates,
  installableUpdates,
  installBlocker,
  needsCoreRestart,
  normalizeHomeAssistantUrl,
  parseHomeAssistantProbe,
  sortForInstall,
  supervisorUpdateCommand,
  updateEntitiesFromStates,
} from '../src/proxmox/home-assistant.ts';
import { HAOS_PROBE_OUTPUT, haState } from './helpers.ts';

const update = (id: string, source: HomeAssistantUpdate['source'], platform: string | null = null): HomeAssistantUpdate => ({
  id,
  source,
  name: id,
  installedVersion: '1',
  latestVersion: '2',
  releaseUrl: null,
  platform,
  installable: true,
});

describe('Home Assistant probe', () => {
  it('returns null outside Home Assistant OS', () => {
    assert.equal(parseHomeAssistantProbe('none\n'), null);
    assert.equal(parseHomeAssistantProbe(''), null);
  });

  it('reads versions, Supervisor updates, saved entities and platforms', () => {
    const probe = parseHomeAssistantProbe(HAOS_PROBE_OUTPUT)!;
    assert.equal(probe.coreVersion, '2026.11.2');
    assert.equal(probe.osVersion, '18.4');
    assert.deepEqual(probe.errors, []);
    assert.equal(probe.savedAt, new Date(1795180744 * 1000).toISOString());
    assert.deepEqual(probe.supervisorUpdates, [
      {
        id: 'app:core_mosquitto',
        source: 'app',
        name: 'Mosquitto broker',
        installedVersion: '7.1.3',
        latestVersion: '7.2.0',
        releaseUrl: null,
        platform: null,
        installable: true,
      },
    ]);
    assert.equal(probe.savedEntities?.length, 3);
    assert.equal(probe.platforms.get('update.dahua_update'), 'marketplace');
  });

  it('reports sources that could not be read and keeps the rest', () => {
    const output = [
      'haos',
      'core {"result":"ok","data":{"version":"2026.11.2","version_latest":"2026.12.0","update_available":true}}',
      'os {"result":"error","message":"Not supported"}',
      'supervisor Error response from daemon: No such container: hassio_cli',
      'entities jq: error: Could not open core.restore_state',
      'registry []',
      'saved stat: cannot stat',
    ].join('\n');
    const probe = parseHomeAssistantProbe(output)!;
    assert.deepEqual(probe.supervisorUpdates.map((u) => [u.id, u.latestVersion]), [['core', '2026.12.0']]);
    assert.equal(probe.savedEntities, null);
    assert.equal(probe.savedAt, null);
    assert.deepEqual(
      probe.errors.map((e) => e.split(':')[0]),
      ['ha os info', 'ha supervisor info', 'saved entity states'],
    );
  });

  it('accepts apps listed under "apps" by newer Supervisors', () => {
    const output = `haos\nsupervisor {"result":"ok","data":{"apps":[{"slug":"x","name":"X","version":"1","version_latest":"2","update_available":true}]}}`;
    assert.deepEqual(parseHomeAssistantProbe(output)!.supervisorUpdates.map((u) => u.id), ['app:x']);
  });
});

describe('Home Assistant updates', () => {
  it('leaves out entities of the Supervisor integration and entities without a newer version', () => {
    const probe = parseHomeAssistantProbe(HAOS_PROBE_OUTPUT)!;
    const entities = [
      ...probe.savedEntities!,
      { id: 'update.same', name: 'Same', installed: '1', latest: '1', url: null, installable: true },
      { id: 'update.unknown', name: null, installed: '1', latest: null, url: null, installable: true },
    ];
    const updates = homeAssistantUpdates(probe.supervisorUpdates, entities, probe.platforms);
    assert.deepEqual(
      updates.map((u) => [u.id, u.source, u.platform]),
      [
        ['app:core_mosquitto', 'app', null],
        ['update.dahua_update', 'entity', 'marketplace'],
        ['update.frigate_server', 'entity', 'frigate'],
      ],
    );
  });

  it('maps live states of the REST API', () => {
    const entities = updateEntitiesFromStates([
      haState('update.dahua_update', 'on', '3.0.0', '3.1.0', 'Dahua'),
      haState('update.places_update', 'off', 'v3.0.3', 'v3.0.3'),
      haState('update.frigate_server', 'on', '0.18.0', '0.18.3', null, 0),
      { entity_id: 'sensor.temperature', state: 'on', attributes: {} },
    ]);
    assert.deepEqual(
      entities.map((e) => [e.id, e.name, e.installed, e.latest, e.installable]),
      [
        ['update.dahua_update', 'Dahua', '3.0.0', '3.1.0', true],
        ['update.frigate_server', 'update.frigate_server friendly', '0.18.0', '0.18.3', false],
      ],
    );
    assert.throws(() => updateEntitiesFromStates({ message: 'x' }), /list of states/);
  });

  it('installs integrations only with the API and never the operating system', () => {
    const on = { enabled: true, hasApi: true };
    const noApi = { enabled: true, hasApi: false };
    const off = { enabled: false, hasApi: true };
    assert.match(installBlocker(update('update.x', 'entity'), noApi)!, /access token/);
    assert.equal(installBlocker(update('update.x', 'entity'), on), null);
    assert.match(installBlocker(update('os', 'os'), on)!, /restarts the virtual machine/);
    assert.equal(installBlocker(update('core', 'core'), noApi), null);
    assert.match(installBlocker({ ...update('update.frigate_server', 'entity'), installable: false }, on)!, /only announces/);
    // Check-only: nothing is installed from ReleaseWatcher, not even with a token.
    assert.match(installBlocker(update('core', 'core'), off)!, /switched off/);
    assert.match(installBlocker(update('update.x', 'entity'), off)!, /switched off/);
    const state = {
      coreVersion: null,
      osVersion: null,
      entitiesSavedAt: null,
      updates: [update('os', 'os'), update('core', 'core'), update('update.x', 'entity')],
    };
    assert.deepEqual(installableUpdates(state, noApi).map((u) => u.id), ['core']);
    assert.deepEqual(installableUpdates(state, on).map((u) => u.id), ['core', 'update.x']);
    assert.deepEqual(installableUpdates(state, off), []);
    assert.deepEqual(installableUpdates(null, on), []);
  });

  it('installs integrations and apps first and Core last; restarts Core for custom integrations', () => {
    const sorted = sortForInstall([update('core', 'core'), update('supervisor', 'supervisor'), update('app:a', 'app'), update('update.x', 'entity')]);
    assert.deepEqual(sorted.map((u) => u.id), ['update.x', 'app:a', 'supervisor', 'core']);
    assert.equal(needsCoreRestart(update('update.x', 'entity', 'marketplace')), true);
    assert.equal(needsCoreRestart(update('update.x', 'entity', 'hacs')), true);
    assert.equal(needsCoreRestart(update('update.fw', 'entity', 'esphome')), false);
    assert.equal(needsCoreRestart(update('app:a', 'app')), false);
  });

  it('builds ha CLI commands and rejects unsafe slugs', () => {
    assert.equal(supervisorUpdateCommand(update('core', 'core')), 'ha core update');
    assert.equal(supervisorUpdateCommand(update('supervisor', 'supervisor')), 'ha supervisor update');
    assert.match(supervisorUpdateCommand(update('app:core_mosquitto', 'app')), /ha apps update core_mosquitto;.*ha addons update core_mosquitto/);
    assert.throws(() => supervisorUpdateCommand(update('app:x; rm -rf /', 'app')), /Invalid app slug/);
    assert.throws(() => supervisorUpdateCommand(update('update.x', 'entity')), /API/);
  });

  it('normalises the Home Assistant URL', () => {
    assert.deepEqual(normalizeHomeAssistantUrl(' https://ha.example.com:8123/ '), { url: 'https://ha.example.com:8123' });
    assert.deepEqual(normalizeHomeAssistantUrl('http://192.168.1.20:8123'), { url: 'http://192.168.1.20:8123' });
    assert.ok('error' in normalizeHomeAssistantUrl('ha.local'));
    assert.ok('error' in normalizeHomeAssistantUrl('ftp://ha.local'));
    assert.ok('error' in normalizeHomeAssistantUrl('https://user:pass@ha.local'));
  });
});

describe('Home Assistant API client', () => {
  it('sends the token and reads states', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const api = new HomeAssistantApi({ url: 'http://ha:8123', token: 'secret-token' }, async (url, init) => {
      calls.push({ url, init });
      return Response.json([haState('update.dahua_update', 'on', '3.0.0', '3.1.0')]);
    });
    assert.deepEqual((await api.pendingEntities()).map((e) => e.id), ['update.dahua_update']);
    assert.equal(calls[0]!.url, 'http://ha:8123/api/states');
    assert.equal((calls[0]!.init!.headers as Record<string, string>)['authorization'], 'Bearer secret-token');
  });

  it('explains failures without the token', async () => {
    const answer = (response: Response | Error) =>
      new HomeAssistantApi({ url: 'http://ha:8123', token: 'secret-token' }, async () => {
        if (response instanceof Error) throw response;
        return response;
      });
    await assert.rejects(answer(new Response('', { status: 401 })).pendingEntities(), /rejected the access token/);
    await assert.rejects(answer(new Response('boom', { status: 500 })).pendingEntities(), /answered 500: boom/);
    await assert.rejects(answer(new Response('<html>')).pendingEntities(), /other than JSON/);
    const error = await answer(new TypeError('Unable to connect')).pendingEntities().catch((e: unknown) => e);
    assert.ok(error instanceof HomeAssistantApiError);
    assert.match(error.message, /Could not reach Home Assistant at http:\/\/ha:8123 – Unable to connect/);
    assert.doesNotMatch(error.message, /secret-token/);
  });
});
