import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { validateHost } from '../src/hosts/domain.ts';
import { BACKUP_STORAGE_SEEDED_META, PROXMOX_SEEDED_META } from '../src/hosts/seed.ts';
import { ShellPool } from '../src/hosts/shells.ts';
import { HostStore } from '../src/hosts/store.ts';
import { silentLogger } from '../src/log.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeKeyTool, FakeShell, FakeSource, TEST_PRIVATE_KEY } from './helpers.ts';

interface Harness {
  app: App;
  store: RepositoryStore;
  shell: FakeShell;
  keyTool: FakeKeyTool;
  request: (method: string, url: string, payload?: unknown) => Promise<{ status: number; json: () => any; text: string }>;
}

let current: Harness | null = null;

async function start(options: { store?: RepositoryStore; env?: Record<string, string> } = {}): Promise<Harness> {
  const store = options.store ?? new RepositoryStore(':memory:');
  const shell = new FakeShell().on(/pveversion/, { output: 'pve-manager/9.1.1\n' }).on(/^uname -a$/, { output: 'Linux vps 6.1\n' });
  const keyTool = new FakeKeyTool();
  const app = await buildApp({
    store,
    settings: new SettingsService(store, loadConfig(options.env ?? {})),
    source: new FakeSource(),
    notifiers: [],
    log: silentLogger,
    shell,
    keyTool,
    knownHostsFile: '/data/known_hosts',
    auth: { requireAuth: false },
  });
  const baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text), text };
  };
  current = { app, store, shell, keyTool, request };
  return current;
}

afterEach(async () => {
  await current?.app.close();
  current = null;
});

describe('host validation', () => {
  it('rejects addresses and users that could become ssh options', () => {
    const valid = { type: 'server' as const, name: 'vps', address: 'vps.example.com', port: 22, user: 'admin', sshKeyId: null, backupStorage: null };
    assert.deepEqual(validateHost(valid), {});
    assert.ok(validateHost({ ...valid, address: '-oProxyCommand=x' }).address);
    assert.ok(validateHost({ ...valid, user: '-l' }).user);
    assert.ok(validateHost({ ...valid, port: 70_000 }).port);
    assert.ok(validateHost({ ...valid, name: ' ' }).name);
    assert.ok(validateHost({ ...valid, backupStorage: 'pbs' }).backupStorage); // servers have no vzdump
    assert.deepEqual(validateHost({ ...valid, type: 'proxmox', backupStorage: 'pbs' }), {});
    assert.ok(validateHost({ ...valid, type: 'proxmox', backupStorage: '../x' }).backupStorage);
  });
});

describe('shell pool', () => {
  it('connects with the stored host and key, read again for every command', () => {
    const store = new RepositoryStore(':memory:');
    const hosts = new HostStore(store.database, store.secretBox);
    const keyId = hosts.addKey({ name: 'k', privateKey: TEST_PRIVATE_KEY, publicKey: null, fingerprint: null });
    const host = hosts.addHost({ type: 'server', name: 'vps', address: 'vps.lan', port: 22, user: 'root', sshKeyId: null, backupStorage: null });
    const pool = new ShellPool({ hosts, knownHostsFile: 'kh' });
    const shell = pool.forHost(host.id);
    assert.equal(shell.isConfigured, false); // no key yet
    hosts.saveHost({ ...host, sshKeyId: keyId, port: 2222 });
    assert.equal(shell.isConfigured, true);
    assert.equal(pool.forHost(host.id), shell);
    assert.deepEqual(pool.options(host.id), { host: 'vps.lan', port: 2222, user: 'root', privateKey: TEST_PRIVATE_KEY, knownHostsFile: 'kh' });
    assert.equal(pool.forHost(null).isConfigured, false);
    assert.equal(pool.forHost(999).isConfigured, false);
    pool.dispose();
  });
});

describe('SSH keys API', () => {
  it('saves a pasted key and never returns its private part', async () => {
    const { request, store } = await start();
    const response = await request('POST', '/api/ssh-keys', { name: 'Main key', privateKey: `${TEST_PRIVATE_KEY}\r\n` });
    assert.equal(response.status, 201);
    const key = response.json();
    assert.equal(key.name, 'Main key');
    assert.match(key.publicKey, /^ssh-ed25519 /);
    assert.match(key.fingerprint, /^SHA256:/);
    assert.equal(key.hostCount, 0);
    assert.equal(response.text.includes('OPENSSH PRIVATE KEY'), false);
    assert.equal((await request('GET', '/api/ssh-keys')).text.includes('PRIVATE KEY'), false);
    // Encrypted at rest.
    const raw = store.database.query<{ private_key: string }, []>('SELECT private_key FROM ssh_keys').get()!;
    assert.equal(raw.private_key.includes('PRIVATE KEY'), false);
    assert.equal(new HostStore(store.database, store.secretBox).getKey(key.id)?.privateKey, TEST_PRIVATE_KEY);
  });

  it('validates names and keys', async () => {
    const { request, keyTool } = await start();
    await request('POST', '/api/ssh-keys', { name: 'Main', privateKey: TEST_PRIVATE_KEY });
    const duplicate = await request('POST', '/api/ssh-keys', { name: 'main', privateKey: TEST_PRIVATE_KEY });
    assert.equal(duplicate.status, 400);
    assert.ok(duplicate.json().errors.name);
    assert.ok((await request('POST', '/api/ssh-keys', { name: 'Other', privateKey: 'password123' })).json().errors.privateKey);
    const encrypted = TEST_PRIVATE_KEY.replace('\n', '\nProc-Type: 4,ENCRYPTED\n');
    assert.match((await request('POST', '/api/ssh-keys', { name: 'Other', privateKey: encrypted })).json().errors.privateKey[0], /passphrase/);
    keyTool.invalid.add(TEST_PRIVATE_KEY.replace('not-a-real', 'broken'));
    const invalid = await request('POST', '/api/ssh-keys', { name: 'Other', privateKey: TEST_PRIVATE_KEY.replace('not-a-real', 'broken') });
    assert.equal(invalid.status, 400);
    assert.match(invalid.json().errors.privateKey[0], /not a valid private key/);
  });

  it('generates a key pair, renames it and deletes it only when no host uses it', async () => {
    const { request, keyTool } = await start();
    const generated = await request('POST', '/api/ssh-keys/generate', { name: 'Generated' });
    assert.equal(generated.status, 201);
    assert.equal(keyTool.generated, 1);
    const key = generated.json();
    assert.ok(key.publicKey);
    assert.equal((await request('PUT', `/api/ssh-keys/${key.id}`, { name: 'Renamed' })).json().name, 'Renamed');
    const host = (await request('POST', '/api/hosts', { type: 'server', name: 'vps', address: 'vps.lan', sshKeyId: key.id })).json();
    assert.equal((await request('GET', '/api/ssh-keys')).json()[0].hostCount, 1);
    const inUse = await request('DELETE', `/api/ssh-keys/${key.id}`);
    assert.equal(inUse.status, 409);
    assert.match(inUse.json().title, /vps/);
    await request('PUT', `/api/hosts/${host.id}`, { sshKeyId: null });
    assert.equal((await request('DELETE', `/api/ssh-keys/${key.id}`)).status, 204);
    assert.equal((await request('DELETE', `/api/ssh-keys/${key.id}`)).status, 404);
  });
});

describe('hosts API', () => {
  const addKey = async (h: Harness, name = 'Main') =>
    (await h.request('POST', '/api/ssh-keys', { name, privateKey: TEST_PRIVATE_KEY })).json() as { id: number };

  it('adds, lists, edits and removes a host', async () => {
    const h = await start();
    const key = await addKey(h);
    const response = await h.request('POST', '/api/hosts', { type: 'proxmox', address: 'pve.lan', sshKeyId: key.id });
    assert.equal(response.status, 201);
    const host = response.json();
    assert.deepEqual(
      { ...host, id: undefined, createdAt: undefined },
      {
        id: undefined,
        type: 'proxmox',
        name: 'pve.lan',
        address: 'pve.lan',
        port: 22,
        user: 'root',
        sshKeyId: key.id,
        sshKeyName: 'Main',
        backupStorage: null,
        configured: true,
        targetCount: 0,
        createdAt: undefined,
      },
    );
    const edited = await h.request('PUT', `/api/hosts/${host.id}`, { name: 'pve', port: 2222, user: 'admin' });
    assert.equal(edited.status, 200);
    assert.deepEqual([edited.json().name, edited.json().port, edited.json().user, edited.json().address], ['pve', 2222, 'admin', 'pve.lan']);
    assert.equal((await h.request('PUT', `/api/hosts/${host.id}`, { type: 'server' })).status, 400);
    assert.equal((await h.request('GET', '/api/hosts')).json().length, 1);
    assert.equal((await h.request('DELETE', `/api/hosts/${host.id}`)).status, 204);
    assert.equal((await h.request('GET', `/api/hosts/${host.id}`)).status, 404);
  });

  it('validates hosts', async () => {
    const h = await start();
    assert.ok((await h.request('POST', '/api/hosts', { type: 'cloud', address: 'x' })).json().errors.type);
    const invalid = await h.request('POST', '/api/hosts', { type: 'server', address: '-oProxyCommand=x', port: 0, user: '-l', sshKeyId: 99 });
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.json().errors).sort(), ['address', 'port', 'sshKeyId', 'user']);
  });

  it('keeps a host with watched machines', async () => {
    const h = await start();
    const key = await addKey(h);
    const host = (await h.request('POST', '/api/hosts', { type: 'proxmox', address: 'pve.lan', sshKeyId: key.id })).json();
    h.shell.on(/^hostname$/, { output: 'pve\n' });
    assert.equal((await h.request('POST', '/api/containers/node')).status, 201);
    assert.equal((await h.request('GET', '/api/hosts')).json()[0].targetCount, 1);
    const response = await h.request('DELETE', `/api/hosts/${host.id}`);
    assert.equal(response.status, 409);
    assert.match(response.json().title, /1 watched machine/);
  });

  it('tests the connection and forgets the pinned host key', async () => {
    const h = await start();
    const key = await addKey(h);
    const node = (await h.request('POST', '/api/hosts', { type: 'proxmox', address: 'pve.lan', sshKeyId: key.id })).json();
    const vps = (await h.request('POST', '/api/hosts', { type: 'server', address: 'vps.lan', port: 2222, sshKeyId: key.id })).json();
    const noKey = (await h.request('POST', '/api/hosts', { type: 'server', address: 'other.lan' })).json();
    assert.equal(noKey.configured, false);

    assert.deepEqual((await h.request('POST', `/api/hosts/${node.id}/test`)).json(), { output: 'pve-manager/9.1.1' });
    assert.deepEqual((await h.request('POST', `/api/hosts/${vps.id}/test`)).json(), { output: 'Linux vps 6.1' });
    h.shell.on(/^uname -a$/, { exitCode: 255, output: 'Permission denied (publickey).' });
    const failed = await h.request('POST', `/api/hosts/${vps.id}/test`);
    assert.equal(failed.status, 502);
    assert.match(failed.json().detail, /authentication failed/);

    assert.equal((await h.request('POST', `/api/hosts/${vps.id}/forget-host-key`)).status, 204);
    assert.deepEqual(h.keyTool.forgotten, [{ knownHostsFile: '/data/known_hosts', address: 'vps.lan', port: 2222 }]);
  });

  it('needs a Proxmox host before guests can be added', async () => {
    const h = await start();
    const response = await h.request('POST', '/api/containers', { vmid: 101 });
    assert.equal(response.status, 409);
    assert.equal((await h.request('GET', '/api/settings')).json().proxmox.configured, false);
  });
});

describe('moving the Proxmox settings into a host', () => {
  /** A database of an older version: Proxmox settings saved in the UI and containers without a host. */
  const legacyStore = () => {
    const store = new RepositoryStore(':memory:');
    store.writeSetting('proxmoxHost', 'pve.lan');
    store.writeSetting('proxmoxPort', '2222');
    store.writeSetting('proxmoxUser', 'admin');
    store.writeSetting('proxmoxSshKey', TEST_PRIVATE_KEY);
    store.database.run("INSERT INTO containers (kind, vmid, name, created_at) VALUES ('lxc', 101, 'vw', 'x')");
    store.database.run("INSERT INTO containers (kind, vmid, name, created_at) VALUES ('node', 0, 'pve', 'x')");
    return store;
  };

  it('creates the host and its key once and assigns the existing containers to it', async () => {
    const store = legacyStore();
    const h = await start({ store });
    const hosts = (await h.request('GET', '/api/hosts')).json();
    assert.equal(hosts.length, 1);
    assert.deepEqual(
      [hosts[0].type, hosts[0].address, hosts[0].port, hosts[0].user, hosts[0].sshKeyName, hosts[0].targetCount],
      ['proxmox', 'pve.lan', 2222, 'admin', 'Proxmox node', 2],
    );
    assert.equal(store.readSettings()['proxmoxSshKey'], undefined);
    assert.equal(store.readSettings()['proxmoxHost'], undefined);
    assert.ok(new HostStore(store.database, store.secretBox).readMeta(PROXMOX_SEEDED_META));
    const containers = (await h.request('GET', '/api/containers')).json();
    assert.ok(containers.every((c: { hostId?: number }) => c.hostId === undefined || c.hostId === hosts[0].id));
    assert.equal((await h.request('GET', '/api/settings')).json().proxmox.configured, true);

    // A host removed later is not created again on the next start.
    await h.request('DELETE', `/api/containers/${containers[0].id}`);
    await h.request('DELETE', `/api/containers/${containers[1].id}`);
    assert.equal((await h.request('DELETE', `/api/hosts/${hosts[0].id}`)).status, 204);
    await h.app.close();
    const again = await start({ store });
    assert.equal((await again.request('GET', '/api/hosts')).json().length, 0);
  });

  it('creates the host from the environment and lets the first Proxmox host take over unassigned containers', async () => {
    const h = await start({ env: { PROXMOX_HOST: 'node.lan' } });
    const [seeded] = (await h.request('GET', '/api/hosts')).json();
    assert.deepEqual([seeded.address, seeded.sshKeyId, seeded.configured], ['node.lan', null, false]);
    await h.app.close();

    const store = new RepositoryStore(':memory:');
    const first = await start({ store });
    store.database.run("INSERT INTO containers (kind, vmid, name, created_at) VALUES ('lxc', 105, 'cloud', 'x')");
    const host = (await first.request('POST', '/api/hosts', { type: 'proxmox', address: 'pve.lan' })).json();
    const row = store.database.query<{ host_id: number }, []>('SELECT host_id FROM containers').get()!;
    assert.equal(row.host_id, host.id);
  });
});

describe('moving the global backup storage to the Proxmox nodes', () => {
  it('gives the storage saved in the UI to the nodes without their own, once', async () => {
    const store = new RepositoryStore(':memory:');
    const hosts = new HostStore(store.database, store.secretBox);
    const plain = { port: 22, user: 'root', sshKeyId: null };
    const pve1 = hosts.addHost({ type: 'proxmox', name: 'pve1', address: 'pve1.lan', backupStorage: null, ...plain });
    const pve2 = hosts.addHost({ type: 'proxmox', name: 'pve2', address: 'pve2.lan', backupStorage: 'pbs2', ...plain });
    const vps = hosts.addHost({ type: 'server', name: 'vps', address: 'vps.lan', backupStorage: null, ...plain });
    store.writeSetting('backupStorage', 'local');

    const h = await start({ store, env: { PROXMOX_BACKUP_STORAGE: 'from-env' } });
    assert.deepEqual(
      [pve1, pve2, vps].map((x) => hosts.getHost(x.id)!.backupStorage),
      ['local', 'pbs2', null],
    );
    assert.equal(store.readSettings()['backupStorage'], undefined);
    assert.ok(hosts.readMeta(BACKUP_STORAGE_SEEDED_META));
    assert.equal((await h.request('GET', '/api/settings')).json().proxmox.backupStorage, undefined);

    // Cleared later on a node: stays cleared after a restart (the environment value is not applied again).
    assert.equal((await h.request('PUT', `/api/hosts/${pve1.id}`, { backupStorage: null })).json().backupStorage, null);
    await h.app.close();
    await start({ store, env: { PROXMOX_BACKUP_STORAGE: 'from-env' } });
    assert.equal(hosts.getHost(pve1.id)!.backupStorage, null);
  });

  it('gives PROXMOX_BACKUP_STORAGE to the node created from PROXMOX_HOST', async () => {
    const h = await start({ env: { PROXMOX_HOST: 'node.lan', PROXMOX_BACKUP_STORAGE: 'pbs' } });
    const [seeded] = (await h.request('GET', '/api/hosts')).json();
    assert.equal(seeded.backupStorage, 'pbs');
  });
});
