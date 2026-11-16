import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { APT_LIST_MARKER } from '../src/proxmox/domain.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeShell, FakeSource, RecordingNotifier, release } from './helpers.ts';

const PCT_LIST = 'VMID       Status     Lock         Name\n101        running                 vaultwarden\n102        stopped                 old\n';
const APT_OUTPUT = `${APT_LIST_MARKER}\nListing...\ncurl/stable 8.1 amd64 [upgradable from: 8.0]\n`;

describe('containers API', () => {
  let app: App;
  let store: RepositoryStore;
  let shell: FakeShell;
  let source: FakeSource;
  let notifier: RecordingNotifier;
  let baseUrl: URL;

  const request = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text), text };
  };

  beforeEach(async () => {
    shell = new FakeShell()
      .on(/^pct list$/, { output: PCT_LIST })
      .on(/^pct status 101$/, { output: 'status: running\n' })
      .on(/^pct status 102$/, { output: 'status: stopped\n' })
      .on(/apt list --upgradable/, { output: APT_OUTPUT })
      .on(/cat \/opt\/vw_version/, { output: '1.30.0\n' })
      .on(/pveversion/, { output: 'pve-manager/9.1.1\n' })
      .on(/vzdump/, { output: 'INFO: Backup job finished successfully\n' });
    source = new FakeSource();
    source.releases = [release('v1.32.0', 1)];
    notifier = new RecordingNotifier();
    store = new RepositoryStore(':memory:');
    const settings = new SettingsService(store, loadConfig({}));
    app = await buildApp({ store, settings, source, notifiers: [notifier], log: silentLogger, shell, auth: { requireAuth: false } });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  /** Adds CT 101 and waits for its initial check. */
  const addContainer = async () => {
    const response = await request('POST', '/api/containers', { vmid: 101 });
    assert.equal(response.status, 201);
    const container = response.json();
    await app.containers.wait(container.id);
    return container as { id: number; name: string };
  };

  it('creates the new tables with indexes', () => {
    const indexes = store.database
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((r) => r.name);
    assert.deepEqual(indexes, [
      'idx_container_apps_container',
      'idx_container_apps_repository',
      'idx_container_runs_app',
      'idx_container_runs_container',
      'idx_container_runs_running',
      'idx_containers_enabled',
      'idx_sessions_expires',
      'idx_watched_repositories_enabled',
    ]);
  });

  it('lists containers on the node and marks added ones', async () => {
    await addContainer();
    const response = await request('GET', '/api/proxmox/containers');
    assert.deepEqual(response.json(), [
      { vmid: 101, status: 'running', name: 'vaultwarden', added: true },
      { vmid: 102, status: 'stopped', name: 'old', added: false },
    ]);
  });

  it('rejects containers that do not exist and duplicates', async () => {
    assert.equal((await request('POST', '/api/containers', { vmid: 999 })).status, 400);
    await addContainer();
    assert.equal((await request('POST', '/api/containers', { vmid: 101 })).status, 409);
  });

  it('checks apt and application versions and notifies once', async () => {
    const container = await addContainer();
    assert.equal(container.name, 'vaultwarden');

    await request('POST', '/api/repositories', { repository: 'acme/widget' });
    const repo = (await request('GET', '/api/repositories')).json()[0];
    const appResponse = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      versionCommand: 'cat /opt/vw_version.txt',
      latestSource: 'github',
      repositoryId: repo.id,
      updateCommand: 'update',
    });
    assert.equal(appResponse.status, 201);

    const run = (await request('POST', `/api/containers/${container.id}/check`)).json();
    assert.equal(run.status, 'running');
    await app.containers.wait(container.id);

    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.status, 'running');
    assert.deepEqual(dto.aptUpgradable, [{ name: 'curl', newVersion: '8.1', currentVersion: '8.0' }]);
    assert.equal(dto.apps[0].installedVersion, '1.30.0');
    assert.equal(dto.apps[0].latestVersion, 'v1.32.0');
    assert.equal(dto.apps[0].repositoryFullName, 'acme/widget');
    assert.equal(dto.apps[0].updateAvailable, true);
    assert.equal(dto.updatesAvailable, 2);
    assert.equal(dto.lastError, null);

    const finished = (await request('GET', `/api/runs/${run.id}`)).json();
    assert.equal(finished.status, 'succeeded');
    assert.match(finished.output, /Vaultwarden: installed 1\.30\.0, latest v1\.32\.0/);

    // First check (on add) notified about apt; the app update is new → one more notification.
    assert.equal(notifier.containerSent.length, 2);
    assert.equal(notifier.containerSent[1]!.apps[0]!.latestVersion, 'v1.32.0');

    // Nothing new → no further notification.
    app.containers.startCheck(await getContainer(container.id), 'schedule');
    await app.containers.wait(container.id);
    assert.equal(notifier.containerSent.length, 2);

    const status = (await request('GET', '/api/status')).json();
    assert.deepEqual(status.containers, { total: 1, enabled: 1, withErrors: 0, aptPending: 1, appUpdatesAvailable: 1 });
  });

  const getContainer = async (id: number) => {
    const { ContainerStore } = await import('../src/proxmox/store.ts');
    return new ContainerStore(store.database).get(id)!;
  };

  it('runs apt upgrade after a backup and refreshes the state', async () => {
    const container = await addContainer();
    await request('PUT', '/api/settings', { backupStorage: 'pbs', backupBeforeUpdate: true });
    shell.commands.length = 0;
    shell.on(/apt list --upgradable/, { output: `${APT_LIST_MARKER}\nListing...\n` });
    const upgrade = Promise.withResolvers<{ output: string }>();
    shell.on(/apt-get -y/, () => upgrade.promise);

    const response = await request('POST', `/api/containers/${container.id}/apt-upgrade`);
    assert.equal(response.status, 202);
    // A second task in the same container is refused while the first one runs.
    assert.equal((await request('POST', `/api/containers/${container.id}/check`)).status, 409);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().isBusy, true);
    upgrade.resolve({ output: 'Setting up curl (8.1) ...\n' });
    const run = await app.containers.wait(container.id);

    assert.equal(run?.status, 'succeeded');
    assert.match(shell.commands[0]!, /vzdump 101 --storage 'pbs' --mode snapshot/);
    assert.ok(shell.commands[1]!.includes('apt-get -y'));
    assert.deepEqual((await request('GET', `/api/containers/${container.id}`)).json().aptUpgradable, []);
    assert.match(run?.output ?? '', /Backing up CT 101 to storage "pbs"/);
  });

  it('chooses whether to back up: per update, per container, then the global default', async () => {
    const container = await addContainer();
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.backupBeforeUpdate, null);
    assert.equal(dto.effectiveBackupBeforeUpdate, false);
    const upgrade = async (body?: unknown) => {
      shell.commands.length = 0;
      const response = await request('POST', `/api/containers/${container.id}/apt-upgrade`, body);
      if (response.status === 202) {
        await app.containers.wait(container.id);
      }
      return { status: response.status, backedUp: shell.commands.some((c) => c.includes('vzdump')) };
    };

    // Global default off → no backup; asking for one without a storage is refused.
    assert.deepEqual(await upgrade(), { status: 202, backedUp: false });
    assert.equal((await upgrade({ backup: true })).status, 409);

    await request('PUT', '/api/settings', { backupStorage: 'local', backupBeforeUpdate: true });
    assert.deepEqual(await upgrade(), { status: 202, backedUp: true });
    assert.deepEqual(await upgrade({ backup: false }), { status: 202, backedUp: false });

    // The container overrides the global default; a single update overrides the container.
    const updated = await request('PUT', `/api/containers/${container.id}`, { ...dto, backupBeforeUpdate: false });
    assert.equal(updated.json().effectiveBackupBeforeUpdate, false);
    assert.deepEqual(await upgrade(), { status: 202, backedUp: false });
    assert.deepEqual(await upgrade({ backup: true }), { status: 202, backedUp: true });
  });

  it('aborts the update when the backup fails', async () => {
    const container = await addContainer();
    await request('PUT', '/api/settings', { backupStorage: 'local', backupBeforeUpdate: true });
    shell.on(/vzdump/, { exitCode: 255, output: 'ERROR: Backup of VM 101 failed - no space left\n' });
    shell.commands.length = 0;

    await request('POST', `/api/containers/${container.id}/apt-upgrade`);
    const run = await app.containers.wait(container.id);
    assert.equal(run?.status, 'failed');
    assert.match(run?.output ?? '', /Backup failed – update not started/);
    assert.equal(shell.commands.some((c) => c.includes('apt-get -y')), false);
  });

  it('lists backup storages and validates the backup settings', async () => {
    shell.on(/^pvesm status --content backup$/, {
      output: 'Name Type Status Total Used Available %\nlocal dir active 100 10 90 10%\n',
    });
    assert.deepEqual((await request('GET', '/api/proxmox/storages')).json(), [
      { name: 'local', type: 'dir', status: 'active', availableBytes: 90 * 1024 },
    ]);
    assert.equal((await request('PUT', '/api/settings', { backupStorage: 'bad name' })).status, 400);
    const saved = (await request('PUT', '/api/settings', { backupStorage: 'pbs', backupBeforeUpdate: true })).json();
    assert.equal(saved.proxmox.backupStorage, 'pbs');
    assert.equal(saved.proxmox.backupBeforeUpdate, true);
  });

  it('runs an application update and marks failures', async () => {
    const container = await addContainer();
    const app1 = (
      await request('POST', `/api/containers/${container.id}/apps`, {
        name: 'Custom',
        latestSource: 'none',
        updateCommand: 'cd /opt/app && ./pull.sh',
        useTty: true,
      })
    ).json();
    shell.on(/pull\.sh/, { exitCode: 2, output: 'git: merge conflict\n' });

    const response = await request('POST', `/api/containers/${container.id}/apps/${app1.id}/update`);
    assert.equal(response.status, 202);
    const run = await app.containers.wait(container.id);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.exitCode, 2);
    assert.match(run?.output ?? '', /merge conflict/);

    const runs = (await request('GET', `/api/containers/${container.id}/runs`)).json();
    assert.equal(runs[0].kind, 'app-update');
    assert.equal('output' in runs[0], false);
  });

  it('validates applications and container settings', async () => {
    const container = await addContainer();
    const bad = await request('POST', `/api/containers/${container.id}/apps`, { name: 'X', latestSource: 'github' });
    assert.equal(bad.status, 400);
    assert.ok(bad.json().errors.repositoryId);
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    const cron = await request('PUT', `/api/containers/${container.id}`, { ...dto, checkCron: '99 * * * *' });
    assert.equal(cron.status, 400);
    const ok = await request('PUT', `/api/containers/${container.id}`, { ...dto, checkCron: '30 4 * * *' });
    assert.equal(ok.json().checkCron, '30 4 * * *');
  });

  it('reports stopped containers as errors without running commands inside', async () => {
    const response = await request('POST', '/api/containers', { vmid: 102 });
    const run = await app.containers.wait(response.json().id);
    assert.equal(run?.status, 'failed');
    assert.equal(shell.commands.some((c) => c.startsWith('pct exec 102')), false);
    assert.match((await request('GET', `/api/containers/${response.json().id}`)).json().lastError, /stopped/);
  });

  it('checks containers in parallel up to the configured limit, one batch command each', async () => {
    shell.on(/^pct list$/, {
      output: `${PCT_LIST}103        running                 a\n104        running                 b\n`,
    });
    for (const vmid of [101, 103, 104]) {
      const response = await request('POST', '/api/containers', { vmid });
      await app.containers.wait(response.json().id);
    }
    assert.equal((await request('PUT', '/api/settings', { containerCheckConcurrency: 2 })).status, 200);
    assert.equal((await request('PUT', '/api/settings', { containerCheckConcurrency: 11 })).status, 400);

    let running = 0;
    let maxRunning = 0;
    shell.on(/^pct status (101|103|104)$/, async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(30);
      running--;
      return { output: 'status: running\n' };
    });
    shell.commands.length = 0;
    shell.connections = 0;

    assert.equal((await request('POST', '/api/containers/check-all')).status, 202);
    await app.scheduler.idle();

    assert.equal(maxRunning, 2);
    // Exactly one SSH connection per container check (status, apt and app commands batched).
    assert.equal(shell.connections, 3);
    assert.equal(shell.commands.filter((c) => c.startsWith('pct status')).length, 3);
  });

  it('runs scheduled checks only for due containers', async () => {
    const container = await addContainer();
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    await request('PUT', `/api/containers/${container.id}`, { ...dto, checkCron: '30 4 * * *' });
    shell.commands.length = 0;
    await app.scheduler.tick(new Date(2026, 10, 16, 4, 29));
    assert.equal(shell.commands.length, 0);
    await app.scheduler.tick(new Date(2026, 10, 16, 4, 30));
    assert.ok(shell.commands.includes('pct status 101'));
  });

  it('never returns the SSH key and validates Proxmox settings', async () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const response = await request('PUT', '/api/settings', { proxmoxHost: 'pve.lan', proxmoxSshKey: key });
    assert.equal(response.status, 200);
    assert.equal(response.text.includes('abc'), false);
    assert.equal(response.json().proxmox.sshKeyConfigured, true);
    assert.equal((await request('PUT', '/api/settings', { proxmoxSshKey: 'password123' })).status, 400);
    assert.equal((await request('PUT', '/api/settings', { proxmoxHost: '-oProxyCommand=x' })).status, 400);
    assert.equal((await request('PUT', '/api/settings', { containerCheckCron: 'often' })).status, 400);
  });

  it('refuses container actions until the node is configured', async () => {
    shell.isConfigured = false;
    assert.equal((await request('POST', '/api/containers', { vmid: 101 })).status, 409);
  });

});
