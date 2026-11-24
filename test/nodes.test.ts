import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { PACKAGE_LIST_MARKER } from '../src/proxmox/domain.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeKeyTool, FakeShell, FakeSource, RecordingNotifier, TEST_PRIVATE_KEY } from './helpers.ts';

const APT_OUTPUT = `${PACKAGE_LIST_MARKER} apt\nListing...\ncurl/stable 8.1 amd64 [upgradable from: 8.0]\n`;
const pctList = (name: string) => `VMID       Status     Lock         Name\n100        running                 ${name}\n`;

/** A fake Proxmox node: `pct list` with CT 100, its own hostname. */
const fakeNode = (hostname: string, guest: string) =>
  new FakeShell()
    .on(/^pct list /, { output: `${pctList(guest)}---releasewatcher-qm---\n` })
    .on(/^pct status 100$/, { output: 'status: running\n' })
    .on(/apt list --upgradable/, { output: APT_OUTPUT })
    .on(/^hostname$/, { output: `${hostname}\n` })
    .on(/pveversion/, { output: `pve-manager/9.1.1 (${hostname})\n` })
    .on(/vzdump/, { output: 'INFO: Backup job finished successfully\n' });

describe('several Proxmox nodes', () => {
  let app: App;
  let store: RepositoryStore;
  let baseUrl: URL;
  let shells: Record<string, FakeShell>;

  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text), text };
  };

  beforeEach(async () => {
    shells = { 'pve1.lan': fakeNode('pve1', 'vaultwarden'), 'pve2.lan': fakeNode('pve2', 'jellyfin') };
    store = new RepositoryStore(':memory:');
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source: new FakeSource(),
      notifiers: [new RecordingNotifier()],
      log: silentLogger,
      // Every host gets the fake of its address.
      openShell: (options) => ({
        get isConfigured() {
          return !!options().host && !!options().privateKey;
        },
        run: (command, runOptions) => shells[options().host!]!.run(command, runOptions),
      }),
      keyTool: new FakeKeyTool(),
      reconnectDelayMs: 0,
      machineRestartWaitMs: 0,
      machinePollMs: 0,
      auth: { requireAuth: false },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  const addNodes = async () => {
    const key = (await request('POST', '/api/ssh-keys', { name: 'Cluster', privateKey: TEST_PRIVATE_KEY })).json();
    const pve1 = (await request('POST', '/api/hosts', { type: 'proxmox', address: 'pve1.lan', sshKeyId: key.id })).json();
    const pve2 = (await request('POST', '/api/hosts', { type: 'proxmox', address: 'pve2.lan', sshKeyId: key.id })).json();
    return { pve1, pve2 };
  };

  it('lists and adds guests per node – the same VMID on two nodes', async () => {
    const { pve1, pve2 } = await addNodes();
    assert.deepEqual(
      (await request('GET', `/api/proxmox/guests?hostId=${pve2.id}`)).json().map((c: { name: string }) => c.name),
      ['jellyfin'],
    );
    // Without hostId: the first node.
    assert.equal((await request('GET', '/api/proxmox/guests')).json()[0].name, 'vaultwarden');

    const first = await request('POST', '/api/targets', { vmid: 100, hostId: pve1.id });
    const second = await request('POST', '/api/targets', { vmid: 100, hostId: pve2.id });
    assert.deepEqual([first.status, second.status], [201, 201]);
    assert.deepEqual([first.json().name, first.json().hostName], ['vaultwarden', 'pve1.lan']);
    assert.deepEqual([second.json().name, second.json().hostName], ['jellyfin', 'pve2.lan']);
    assert.equal((await request('POST', '/api/targets', { vmid: 100, hostId: pve2.id })).status, 409);
    await app.containers.wait(first.json().id);
    await app.containers.wait(second.json().id);
    // Each check ran on its own node.
    assert.ok(shells['pve1.lan']!.commands.some((c) => c.includes('pct exec 100') || c.includes('pct status 100')));
    assert.ok(shells['pve2.lan']!.commands.some((c) => c.includes('pct status 100')));
    const listed = (await request('GET', `/api/proxmox/guests?hostId=${pve2.id}`)).json();
    assert.equal(listed[0].added, true);

    // The node entries carry the node's own hostname.
    const node2 = await request('POST', `/api/targets/node?hostId=${pve2.id}`);
    assert.equal(node2.json().name, 'pve2');
    assert.equal((await request('POST', `/api/targets/node?hostId=${pve1.id}`)).json().name, 'pve1');
    assert.equal((await request('POST', `/api/targets/node?hostId=${pve2.id}`)).status, 409);
    assert.match((await request('POST', `/api/proxmox/test?hostId=${pve2.id}`)).json().output, /pve2/);
  });

  it('refuses unknown nodes and servers as nodes', async () => {
    await addNodes();
    const server = (await request('POST', '/api/hosts', { type: 'server', address: 'vps.lan' })).json();
    assert.equal((await request('GET', '/api/proxmox/guests?hostId=99')).status, 404);
    assert.equal((await request('GET', `/api/proxmox/storages?hostId=${server.id}`)).status, 404);
    assert.equal((await request('POST', '/api/targets', { vmid: 100, hostId: server.id })).status, 404);
    assert.equal((await request('GET', '/api/proxmox/guests?hostId=abc')).status, 400);
  });

  it('backs up to the storage of the guest’s own node', async () => {
    const { pve1, pve2 } = await addNodes();
    await request('PUT', '/api/settings', { backupBeforeUpdate: true });
    assert.equal((await request('PUT', `/api/hosts/${pve1.id}`, { backupStorage: 'local' })).json().backupStorage, 'local');
    assert.equal((await request('PUT', `/api/hosts/${pve2.id}`, { backupStorage: 'pbs2' })).json().backupStorage, 'pbs2');
    const ct1 = (await request('POST', '/api/targets', { vmid: 100, hostId: pve1.id })).json();
    const ct2 = (await request('POST', '/api/targets', { vmid: 100, hostId: pve2.id })).json();
    await app.containers.wait(ct1.id);
    await app.containers.wait(ct2.id);
    assert.equal((await request('GET', `/api/targets/${ct1.id}`)).json().backupStorage, 'local');
    assert.equal((await request('GET', `/api/targets/${ct2.id}`)).json().backupStorage, 'pbs2');

    shells['pve2.lan']!.on(/apt-get -y/, { output: 'Done.\n' });
    assert.equal((await request('POST', `/api/targets/${ct2.id}/packages-upgrade`, { backup: true })).status, 202);
    const run = await app.containers.wait(ct2.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.ok(shells['pve2.lan']!.detached.some((d) => d.command.includes('vzdump 100') && d.command.includes("--storage 'pbs2'")));
    assert.equal(shells['pve1.lan']!.detached.length, 0);

    // A node without its own storage makes no backups (there is no global storage to fall back to).
    await request('PUT', `/api/hosts/${pve2.id}`, { backupStorage: null });
    assert.equal((await request('GET', `/api/targets/${ct2.id}`)).json().backupStorage, null);
    assert.equal((await request('POST', `/api/targets/${ct2.id}/packages-upgrade`, { backup: true })).status, 409);
  });

  it('restarts one node while another one is busy', async () => {
    const { pve1, pve2 } = await addNodes();
    const node1 = (await request('POST', `/api/targets/node?hostId=${pve1.id}`)).json();
    const node2 = (await request('POST', `/api/targets/node?hostId=${pve2.id}`)).json();
    await app.containers.wait(node1.id);
    await app.containers.wait(node2.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    shells['pve2.lan']!.on(/dist-upgrade/, async () => {
      await gate;
      return { output: '' };
    });
    assert.equal((await request('POST', `/api/targets/${node2.id}/packages-upgrade`)).status, 202);
    shells['pve1.lan']!.on(/systemctl reboot$/, { output: '' }).on(/^true$/, { output: '' });
    assert.equal((await request('POST', `/api/targets/${node1.id}/restart`)).status, 202);
    assert.equal((await request('POST', `/api/targets/${node2.id}/restart`)).status, 409);
    release();
    await app.containers.wait(node1.id);
    await app.containers.wait(node2.id);
  });
});
