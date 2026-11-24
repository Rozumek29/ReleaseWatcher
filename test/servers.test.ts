import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { targetName } from '../src/notifiers/notifier.ts';
import { MACHINE_RESTART_COMMAND, PACKAGE_LIST_MARKER, PACKAGES_UPGRADE_SCRIPT, appUpdateScript, capabilities, machinePackagesUpgradeScript, machineExec } from '../src/proxmox/domain.ts';
import { SettingsService } from '../src/settings.ts';
import { addProxmoxHost, FakeKeyTool, FakeShell, FakeSource, RecordingNotifier, TEST_PRIVATE_KEY } from './helpers.ts';

const APT_OUTPUT = `${PACKAGE_LIST_MARKER} apt\nListing...\nnginx/stable 1.26.1 amd64 [upgradable from: 1.26.0]\n`;

describe('servers', () => {
  let app: App;
  let store: RepositoryStore;
  let shell: FakeShell;
  let notifier: RecordingNotifier;
  let baseUrl: URL;

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
    shell = new FakeShell().on(/apt list --upgradable/, { output: APT_OUTPUT }).on(/^true$/, { output: '' });
    notifier = new RecordingNotifier();
    store = new RepositoryStore(':memory:');
    app = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source: new FakeSource(),
      notifiers: [notifier],
      log: silentLogger,
      shell,
      keyTool: new FakeKeyTool(),
      reconnectDelayMs: 0,
      machineRestartWaitMs: 0,
      machinePollMs: 0,
      auth: { requireAuth: false },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  const addKey = async () => (await request('POST', '/api/ssh-keys', { name: 'VPS key', privateKey: TEST_PRIVATE_KEY })).json() as { id: number };

  /** Adds a server host (its target is created and checked) and waits for the first check. */
  const addServer = async (name = 'Hetzner VPS') => {
    const key = await addKey().catch(() => null);
    const keys = (await request('GET', '/api/ssh-keys')).json() as { id: number }[];
    const host = (
      await request('POST', '/api/hosts', { type: 'server', name, address: `${name.replace(/\W/g, '').toLowerCase()}.example.com`, user: 'admin', sshKeyId: key?.id ?? keys[0]!.id })
    ).json();
    const target = ((await request('GET', '/api/targets')).json() as { id: number; hostId: number }[]).find((c) => c.hostId === host.id)!;
    await app.containers.wait(target.id);
    return { host, target: (await request('GET', `/api/targets/${target.id}`)).json() };
  };

  it('watches a server as soon as it is added – without a Proxmox node', async () => {
    const { host, target } = await addServer();
    assert.deepEqual(
      [target.kind, target.name, target.hostId, target.hostName, target.configured, target.status],
      ['server', 'Hetzner VPS', host.id, 'Hetzner VPS', true, 'running'],
    );
    assert.deepEqual(target.capabilities, capabilities('server'));
    assert.equal(target.packageUpdates.length, 1);
    assert.equal(target.effectiveBackupBeforeUpdate, false);
    // Commands ran directly on the server – no pct/qm.
    assert.ok(shell.commands.some((c) => c.includes('apt list --upgradable')));
    assert.equal(shell.commands.some((c) => /^(pct|qm) /.test(c)), false);
    assert.equal(notifier.containerSent.at(-1)?.targetKind, 'server');
    assert.equal(targetName(notifier.containerSent.at(-1)!), 'Hetzner VPS');
    assert.equal((await request('GET', '/api/settings')).json().proxmox.configured, false);
    assert.equal((await request('GET', '/api/hosts')).json()[0].targetCount, 1);

    // Check all works with servers only.
    assert.deepEqual((await request('POST', '/api/targets/check-all')).json(), { queued: 1 });
  });

  it('checks and upgrades a server with another package manager (dnf) and names it in notifications', async () => {
    const dnf = [
      `${PACKAGE_LIST_MARKER} dnf`,
      '',
      'openssl-libs.x86_64     1:3.2.4-1.fc41     updates',
      `${PACKAGE_LIST_MARKER} installed`,
      'openssl-libs.x86_64 1:3.2.2-9.fc41',
    ].join('\n');
    shell.on(/apt list --upgradable/, { output: dnf });
    const { target } = await addServer();
    assert.equal(target.packageManager, 'dnf');
    assert.deepEqual(target.packageUpdates, [{ name: 'openssl-libs', newVersion: '1:3.2.4-1.fc41', currentVersion: '1:3.2.2-9.fc41' }]);
    assert.equal(notifier.containerSent.at(-1)?.packageManager, 'dnf');

    shell.on(/dnf -y upgrade/, { output: 'Complete!\n' });
    assert.equal((await request('POST', `/api/targets/${target.id}/packages-upgrade`)).status, 202);
    const run = await app.containers.wait(target.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /Upgrading the system packages of Hetzner VPS \(no backup\)/);
    assert.equal(shell.detached.at(-1)?.command, PACKAGES_UPGRADE_SCRIPT);
  });

  it('checks Flatpak and Snap, notifies about their updates and updates them', async () => {
    const stores = [
      '---releasewatcher-store--- flatpak',
      'org.gnome.Calculator\t51.1\tstable\t00516a24d410\tapp/org.gnome.Calculator/x86_64/stable',
      '---releasewatcher-store--- flatpak-installed',
      'org.gnome.Calculator/x86_64/stable\t51.0\t0032886e3396',
      '---releasewatcher-store--- snap',
      'All snaps up to date.',
      '---releasewatcher-store--- snap-installed',
      'Name Version Rev Tracking Publisher Notes',
    ].join('\n');
    shell.on(/flatpak remote-ls --updates/, { output: stores });
    const { target } = await addServer();
    assert.deepEqual(target.appStores, [
      { store: 'flatpak', label: 'Flatpak', packages: [{ name: 'org.gnome.Calculator', currentVersion: '51.0', newVersion: '51.1' }] },
      { store: 'snap', label: 'Snap', packages: [] },
    ]);
    // apt (1) + Flatpak (1); Snap has nothing pending.
    assert.equal(target.updatesAvailable, 2);
    assert.deepEqual(notifier.containerSent.at(-1)?.appStores, [
      { name: 'Flatpak', packages: [{ name: 'org.gnome.Calculator', currentVersion: '51.0', newVersion: '51.1' }] },
    ]);
    assert.equal((await request('GET', '/api/status')).json().targets.appStorePending, 1);

    shell.on(/flatpak update -y --noninteractive/, { output: 'Updating app/org.gnome.Calculator/x86_64/stable\n' });
    assert.equal((await request('POST', `/api/targets/${target.id}/flatpak-update`, {})).status, 202);
    const run = await app.containers.wait(target.id);
    assert.equal(run?.kind, 'flatpak-update');
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /Updating the Flatpak applications in Hetzner VPS/);
    assert.match(shell.detached.at(-1)?.command ?? '', /flatpak update -y --noninteractive/);

    // A store the last check did not find cannot be updated.
    shell.on(/flatpak remote-ls --updates/, { output: '' });
    await request('POST', `/api/targets/${target.id}/check`);
    await app.containers.wait(target.id);
    const missing = await request('POST', `/api/targets/${target.id}/snap-update`, {});
    assert.equal(missing.status, 409);
    assert.match(missing.json().title, /Snap was not found on Hetzner VPS/);
  });

  it('reports a machine without a supported package manager', async () => {
    shell.on(/apt list --upgradable/, { exitCode: 127, output: 'No supported package manager found (apt, dnf, yum, zypper, apk or pacman)\n' });
    const { target } = await addServer();
    assert.equal(target.packageManager, null);
    assert.match(target.lastError, /^System packages: .*No supported package manager found/);
  });

  it('upgrades apt with apt-get upgrade and runs application updates on the server itself', async () => {
    const { target } = await addServer();
    assert.equal((await request('POST', `/api/targets/${target.id}/packages-upgrade`, { backup: true })).status, 409);
    shell.on(/ upgrade && /, { output: 'Setting up nginx (1.26.1) ...\n' });
    assert.equal((await request('POST', `/api/targets/${target.id}/packages-upgrade`)).status, 202);
    const apt = await app.containers.wait(target.id);
    assert.equal(apt?.status, 'succeeded', apt?.output ?? '');
    assert.equal(shell.detached.at(-1)?.command, machinePackagesUpgradeScript('server'));

    const added = await request('POST', `/api/targets/${target.id}/apps`, {
      name: 'Gitea',
      versionCommand: 'gitea --version',
      latestSource: 'command',
      latestCommand: 'echo 1.23.0',
      updateCommand: '/opt/update-gitea.sh',
      useTty: true,
    });
    assert.equal(added.status, 201);
    shell.on(/gitea --version/, { output: '1.22.0\n' }).on(/echo 1\.23\.0/, { output: '1.23.0\n' });
    shell.on(/update-gitea/, { output: 'Updated.\n' });
    shell.on(/apt list --upgradable/, { output: `${PACKAGE_LIST_MARKER} apt\nListing...\n` });
    await request('POST', `/api/targets/${target.id}/check`);
    await app.containers.wait(target.id);
    const updateAll = await request('POST', '/api/targets/update-all', {});
    assert.equal(updateAll.status, 202);
    assert.deepEqual(updateAll.json(), { targets: 1, updates: 1 });
    for (let i = 0; i < 50 && !shell.detached.some((d) => d.command.includes('update-gitea')); i++) await Bun.sleep(10);
    await app.updater.idle();
    const update = shell.detached.find((d) => d.command.includes('update-gitea'))!;
    assert.equal(update.command, machineExec(appUpdateScript('/opt/update-gitea.sh')));
    assert.equal(update.tty, true); // a pseudo-terminal works directly on a machine
  });

  it('restarts a server and checks it once it answers again; tasks on other hosts do not block it', async () => {
    addProxmoxHost(store);
    const { target } = await addServer();
    shell.on(/systemd-run .*systemctl reboot/, { output: '' });
    shell.commands.length = 0;
    assert.equal((await request('POST', `/api/targets/${target.id}/restart`)).status, 202);
    const run = await app.containers.wait(target.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /Restart scheduled – Hetzner VPS is unavailable[\s\S]*Hetzner VPS is back[\s\S]*Checking Hetzner VPS again/);
    assert.deepEqual(shell.commands.slice(0, 2), [
      MACHINE_RESTART_COMMAND,
      'true',
    ]);

    // A running check of the Proxmox host (another machine) does not block the restart of the server.
    shell.on(/^hostname$/, { output: 'pve\n' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const node = (await request('POST', '/api/targets/node')).json();
    await app.containers.wait(node.id);
    shell.on(/dist-upgrade/, async () => {
      await gate;
      return { output: '' };
    });
    assert.equal((await request('POST', `/api/targets/${node.id}/packages-upgrade`)).status, 202);
    assert.equal((await request('POST', `/api/targets/${target.id}/restart`)).status, 202);
    release();
    await app.containers.wait(node.id);
    await app.containers.wait(target.id);
  });

  it('shows why a server could not be reached', async () => {
    // The whole SSH connection fails (no status section at all).
    shell.run = async () => ({ exitCode: 255, output: 'ssh: connect to host vps.example.com port 22: Connection timed out', timedOut: false });
    const { target } = await addServer();
    assert.match(target.lastError, /SSH connection failed: ssh: connect to host/);
    assert.ok(target.lastCheckedAt);
  });

  it('keeps a server without a key until one is chosen', async () => {
    const host = (await request('POST', '/api/hosts', { type: 'server', address: 'vps.example.com' })).json();
    const [target] = (await request('GET', '/api/targets')).json();
    assert.equal(target.hostId, host.id);
    assert.equal(target.name, 'vps.example.com');
    assert.equal(target.kind, 'server');
    // Without a key the host is not configured (the shell pool test shows the real shell is then unconfigured too).
    assert.equal((await request('GET', '/api/hosts')).json()[0].configured, false);
    await app.containers.wait(target.id);
  });

  it('renames the server with its host and removes both together', async () => {
    const { host, target } = await addServer();
    await request('PUT', `/api/hosts/${host.id}`, { name: 'Web server' });
    assert.equal((await request('GET', `/api/targets/${target.id}`)).json().name, 'Web server');
    // A name changed on the target itself is kept when the host is renamed again.
    await request('PUT', `/api/targets/${target.id}`, { ...target, name: 'nginx box' });
    await request('PUT', `/api/hosts/${host.id}`, { name: 'Web' });
    assert.equal((await request('GET', `/api/targets/${target.id}`)).json().name, 'nginx box');

    assert.equal((await request('DELETE', `/api/targets/${target.id}`)).status, 204);
    assert.equal((await request('GET', `/api/hosts/${host.id}`)).status, 404);

    const second = await addServer('Mail');
    assert.equal((await request('DELETE', `/api/hosts/${second.host.id}`)).status, 204);
    assert.equal((await request('GET', `/api/targets/${second.target.id}`)).status, 404);
  });
});
