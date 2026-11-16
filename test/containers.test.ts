import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { APT_LIST_MARKER } from '../src/proxmox/domain.ts';
import { ContainerStore } from '../src/proxmox/store.ts';
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
    app = await buildApp({ store, settings, source, notifiers: [notifier], log: silentLogger, shell, reconnectDelayMs: 0, auth: { requireAuth: false } });
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
    // The live status is read first – updates never run in a stopped container.
    assert.equal(shell.commands[0], 'pct status 101');
    assert.match(shell.commands[1]!, /vzdump 101 --storage 'pbs' --mode snapshot/);
    assert.ok(shell.commands[2]!.includes('apt-get -y'));
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

  it('runs updates detached on the node, with a pseudo-terminal only when asked', async () => {
    const container = await addContainer();
    const created = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Custom',
      latestSource: 'none',
      updateCommand: 'update',
      useTty: true,
    });
    shell.on(/\nupdate'$/, { output: 'Updated.\n' });
    await request('POST', `/api/containers/${container.id}/apps/${created.json().id}/update`);
    assert.equal((await app.containers.wait(container.id))?.status, 'succeeded');
    await request('POST', `/api/containers/${container.id}/apt-upgrade`);
    await app.containers.wait(container.id);

    assert.deepEqual(
      shell.detached.map((d) => [d.command.replace(/'.*/s, ''), d.tty]),
      [
        ['pct exec 101 -- sh -c ', true],
        ['pct exec 101 -- sh -c ', false],
      ],
    );
    assert.equal(shell.units.size, 0, 'finished units are cleaned up on the node');
  });

  it('keeps an update running when the SSH connection drops and reads its output again', async () => {
    const container = await addContainer();
    const created = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      latestSource: 'none',
      updateCommand: 'update',
    });
    shell.on(/\nupdate'$/, { output: 'Compiling vaultwarden\nUpdated to 1.32.0\n' });
    shell.dropFollows = 2;

    await request('POST', `/api/containers/${container.id}/apps/${created.json().id}/update`);
    const run = await app.containers.wait(container.id);

    assert.equal(run?.status, 'succeeded');
    const output = run?.output ?? '';
    // The partial copies read before each drop are replaced, so every line appears exactly once.
    assert.equal(output.split('Compiling vaultwarden').length - 1, 1, output);
    assert.equal(output.split('Updated to 1.32.0').length - 1, 1, output);
    assert.doesNotMatch(output, /Broken pipe/);
    assert.match(output, /dropped 2× – the command kept running/);
    assert.equal(shell.detached.length, 1, 'the update itself was started once');
  });

  it('raises CPU and memory for updates and restores them afterwards, also after a failure', async () => {
    const container = await addContainer();
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal((await request('PUT', `/api/containers/${container.id}`, { ...dto, updateCores: 0 })).status, 400);
    assert.equal((await request('PUT', `/api/containers/${container.id}`, { ...dto, updateMemoryMb: 10 })).status, 400);
    const saved = await request('PUT', `/api/containers/${container.id}`, { ...dto, updateCores: 4, updateMemoryMb: 4096 });
    assert.deepEqual([saved.json().updateCores, saved.json().updateMemoryMb, saved.json().resourcesRaised], [4, 4096, false]);
    // Omitted = keep.
    const { updateCores: _c, updateMemoryMb: _m, ...withoutResources } = saved.json();
    assert.equal((await request('PUT', `/api/containers/${container.id}`, withoutResources)).json().updateCores, 4);

    shell.on(/^pct config 101$/, { output: 'arch: amd64\ncores: 1\nmemory: 1024\n' });
    shell.on(/^pct set 101 /, { output: '' });
    const created = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      latestSource: 'none',
      updateCommand: 'cargo build',
    });
    let raisedDuringUpdate: boolean | null = null;
    shell.on(/cargo build/, async () => {
      raisedDuringUpdate = (await request('GET', `/api/containers/${container.id}`)).json().resourcesRaised;
      return { exitCode: 101, output: 'error: could not compile\n' };
    });
    shell.commands.length = 0;

    await request('POST', `/api/containers/${container.id}/apps/${created.json().id}/update`);
    const run = await app.containers.wait(container.id);

    assert.equal(run?.status, 'failed');
    assert.equal(raisedDuringUpdate, true);
    const relevant = shell.commands.filter((c) => /^pct (config|set)|cargo build/.test(c));
    assert.deepEqual(relevant.map((c) => c.replace(/'.*/s, '')), [
      'pct config 101',
      'pct set 101 --cores 4 --memory 4096',
      'pct exec 101 -- sh -c ',
      'pct set 101 --cores 1 --memory 1024',
    ]);
    assert.match(run?.output ?? '', /Raising resources for the update: 4 cores, 4096 MiB memory/);
    assert.match(run?.output ?? '', /Restoring resources: 1 cores, 1024 MiB memory/);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().resourcesRaised, false);
  });

  it('re-attaches to an update still running on the node after a restart and restores resources', async () => {
    const container = await addContainer();
    const containerStore = new ContainerStore(store.database);
    const run = containerStore.startRun(container.id, null, 'apt-upgrade', 'manual');
    containerStore.saveRunOutput(run.id, '» Updating…\n');
    containerStore.setRunResume(run.id, { unit: `releasewatcher-run-${run.id}-update`, step: 'update', timeoutSeconds: 600, startedContainer: false });
    containerStore.setResourcesToRestore(containerStore.get(container.id)!, { cores: 2 });
    const stale = containerStore.startRun(container.id, null, 'check', 'manual'); // no detached step → failed
    shell.units.set(`releasewatcher-run-${run.id}-update`, { exitCode: 0, output: 'Setting up curl (8.1) ...\n', timedOut: false });
    shell.on(/^pct set 101 /, { output: '' });
    shell.commands.length = 0;

    const restarted = await buildApp({
      store,
      settings: new SettingsService(store, loadConfig({})),
      source,
      notifiers: [notifier],
      log: silentLogger,
      shell,
      reconnectDelayMs: 0,
      auth: { requireAuth: false },
    });
    try {
      assert.equal(containerStore.getRun(stale.id)?.status, 'failed');
      assert.equal(containerStore.getRun(run.id)?.status, 'running');
      await restarted.containers.recover();
      assert.equal(restarted.containers.isBusy(container.id), true);
      const finished = await restarted.containers.wait(container.id);

      assert.equal(finished?.status, 'succeeded');
      assert.match(finished?.output ?? '', /^» Updating…\n» ReleaseWatcher was restarted – re-attaching/);
      assert.match(finished?.output ?? '', /Setting up curl/);
      assert.ok(shell.commands.includes('pct set 101 --cores 2'), shell.commands.join('\n'));
      assert.equal(containerStore.get(container.id)?.resourcesToRestore, null);
      assert.deepEqual(containerStore.listResumableRuns(), []);
    } finally {
      await restarted.close();
    }
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

  it('skips stopped containers without an error, keeps their last results and never starts them', async () => {
    const container = await addContainer();
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().aptUpgradable.length, 1);
    const sent = notifier.containerSent.length;

    shell.on(/^pct status 101$/, { output: 'status: stopped\n' });
    shell.commands.length = 0;
    await request('POST', `/api/containers/${container.id}/check`);
    const run = await app.containers.wait(container.id);

    assert.equal(run?.status, 'succeeded');
    assert.match(run?.output ?? '', /stopped – apt and application checks skipped/);
    assert.equal(shell.commands.some((c) => c.startsWith('pct exec') || c.startsWith('pct start')), false);
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.status, 'stopped');
    assert.equal(dto.lastError, null);
    assert.equal(dto.aptUpgradable.length, 1, 'results of the last check are kept');
    assert.equal(notifier.containerSent.length, sent);
  });

  it('refuses to update a container that is stopped now', async () => {
    const container = await addContainer();
    await request('PUT', '/api/settings', { backupStorage: 'local', backupBeforeUpdate: true });
    shell.on(/^pct status 101$/, { output: 'status: stopped\n' });
    shell.commands.length = 0;

    assert.equal((await request('POST', `/api/containers/${container.id}/apt-upgrade`)).status, 202);
    const run = await app.containers.wait(container.id);
    assert.equal(run?.status, 'failed');
    assert.match(run?.output ?? '', /CT 101 is stopped – start it, then run the update again/);
    assert.deepEqual(shell.commands, ['pct status 101'], 'no backup, no update');
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().status, 'stopped');
  });

  /** Makes CT 101 stopped; `pct start`/`pct shutdown` change its state like on a real node. */
  const stoppableContainer = async () => {
    const container = await addContainer();
    let state = 'stopped';
    shell
      .on(/^pct status 101$/, () => ({ output: `status: ${state}\n` }))
      .on(/^pct start 101/, () => {
        state = 'running';
        return { output: '' };
      })
      .on(/^pct shutdown 101 /, () => {
        state = 'stopped';
        return { output: '' };
      });
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    const saved = await request('PUT', `/api/containers/${container.id}`, { ...dto, startWhenStopped: true });
    assert.equal(saved.json().startWhenStopped, true);
    shell.commands.length = 0;
    return { container, state: () => state };
  };

  it('starts a stopped container temporarily for a check when allowed and shuts it down again', async () => {
    const { container, state } = await stoppableContainer();
    shell.on(/apt list --upgradable/, { output: `${APT_LIST_MARKER}\nListing...\n` });

    await request('POST', `/api/containers/${container.id}/check`);
    const run = await app.containers.wait(container.id);

    assert.equal(run?.status, 'succeeded');
    const started = shell.commands.findIndex((c) => c.startsWith('pct start 101'));
    const checked = shell.commands.findIndex((c) => c.startsWith('pct exec 101'));
    const stopped = shell.commands.findIndex((c) => c.startsWith('pct shutdown 101 --timeout 120 --forceStop 1'));
    assert.ok(started >= 0 && started < checked && checked < stopped, shell.commands.join('\n'));
    // It waits for the network inside the container (apt needs it).
    assert.match(shell.commands[started]!, /\/proc\/net\/route/);
    assert.equal(state(), 'stopped');
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.status, 'stopped');
    assert.deepEqual(dto.aptUpgradable, [], 'fresh results from the temporary start');
    assert.equal(dto.lastError, null);
  });

  it('starts a stopped container temporarily for an update, after the backup', async () => {
    const { container, state } = await stoppableContainer();
    await request('PUT', '/api/settings', { backupStorage: 'local', backupBeforeUpdate: true });
    shell.on(/apt-get -y/, { output: 'Setting up curl (8.1) ...\n' });

    assert.equal((await request('POST', `/api/containers/${container.id}/apt-upgrade`)).status, 202);
    const run = await app.containers.wait(container.id);

    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    const order = ['pct start 101', 'vzdump', 'apt-get -y', 'pct shutdown 101'].map((part) =>
      shell.commands.findIndex((c) => c.includes(part)),
    );
    assert.deepEqual([...order].sort((a, b) => a - b), order, shell.commands.join('\n'));
    assert.ok(order.every((i) => i >= 0));
    assert.equal(state(), 'stopped');
  });

  it('leaves a running container running when the option is on', async () => {
    const { container, state } = await stoppableContainer();
    shell.on(/^pct status 101$/, { output: 'status: running\n' });
    await request('POST', `/api/containers/${container.id}/check`);
    await app.containers.wait(container.id);
    assert.equal(shell.commands.some((c) => /^pct (start|shutdown)/.test(c)), false);
    assert.equal(state(), 'stopped', 'the fake state was never touched');
  });

  it('fails the update when the container cannot be started', async () => {
    const { container } = await stoppableContainer();
    shell.on(/^pct start 101/, { exitCode: 255, output: 'startup for container 101 failed\n' });
    await request('POST', `/api/containers/${container.id}/apt-upgrade`);
    const run = await app.containers.wait(container.id);
    assert.equal(run?.status, 'failed');
    assert.match(run?.output ?? '', /Starting CT 101 failed/);
    assert.equal(shell.commands.some((c) => c.includes('apt-get -y') || c.startsWith('pct shutdown')), false);
  });

  it('checks and upgrades apt on the Proxmox host itself', async () => {
    shell.on(/^hostname$/, { output: 'pve\n' });
    const response = await request('POST', '/api/containers/node');
    assert.equal(response.status, 201);
    const node = response.json();
    assert.equal(node.kind, 'node');
    assert.equal(node.name, 'pve');
    assert.equal((await request('POST', '/api/containers/node')).status, 409);
    await app.containers.wait(node.id);

    // The apt check ran directly on the node – no pct status/exec.
    assert.ok(shell.commands.some((c) => c.includes('apt list --upgradable') && !c.startsWith('pct')));
    assert.equal(shell.commands.some((c) => c.startsWith('pct')), false);
    let dto = (await request('GET', `/api/containers/${node.id}`)).json();
    assert.equal(dto.status, 'running');
    assert.equal(dto.aptUpgradable.length, 1);
    assert.equal(dto.effectiveBackupBeforeUpdate, false);
    assert.equal(notifier.containerSent.at(-1)?.isNode, true);

    // The host has no applications, backups or temporary starts.
    const app1 = await request('POST', `/api/containers/${node.id}/apps`, { name: 'x', latestSource: 'none' });
    assert.equal(app1.status, 409);
    const saved = await request('PUT', `/api/containers/${node.id}`, {
      ...dto,
      aptEnabled: false,
      startWhenStopped: true,
      backupBeforeUpdate: true,
    });
    assert.deepEqual(
      [saved.json().aptEnabled, saved.json().startWhenStopped, saved.json().backupBeforeUpdate],
      [true, false, null],
    );
    await request('PUT', '/api/settings', { backupStorage: 'local', backupBeforeUpdate: true });
    assert.equal((await request('POST', `/api/containers/${node.id}/apt-upgrade`, { backup: true })).status, 409);

    // Proxmox VE is upgraded with dist-upgrade, without vzdump and directly on the node.
    shell.on(/dist-upgrade/, { output: 'Setting up pve-manager (9.1.2) ...\n' });
    shell.on(/apt list --upgradable/, { output: `${APT_LIST_MARKER}\nListing...\n` });
    shell.commands.length = 0;
    assert.equal((await request('POST', `/api/containers/${node.id}/apt-upgrade`)).status, 202);
    const run = await app.containers.wait(node.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(shell.commands[0]!, /^export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get -y .* dist-upgrade$/);
    assert.equal(shell.commands.some((c) => c.includes('vzdump') || c.startsWith('pct')), false);
    dto = (await request('GET', `/api/containers/${node.id}`)).json();
    assert.deepEqual(dto.aptUpgradable, []);

    // Listed first; "add all" does not add it again and the vmid of a real container is unaffected.
    await request('POST', '/api/containers/add-all');
    const list = (await request('GET', '/api/containers')).json();
    assert.deepEqual(list.map((c: { kind: string; vmid: number }) => `${c.kind}:${c.vmid}`), ['node:0', 'lxc:101', 'lxc:102']);
  });

  it('adds all containers of the node at once and checks them', async () => {
    await addContainer();
    const response = await request('POST', '/api/containers/add-all');
    assert.equal(response.status, 201);
    assert.deepEqual(
      response.json().map((c: { vmid: number; name: string }) => [c.vmid, c.name]),
      [[102, 'old']],
    );
    await app.scheduler.idle();
    const list = (await request('GET', '/api/containers')).json();
    assert.deepEqual(list.map((c: { vmid: number }) => c.vmid), [101, 102]);
    assert.equal(list[1].status, 'stopped');
    assert.ok(list[1].lastCheckedAt);

    // Nothing left to add.
    const again = await request('POST', '/api/containers/add-all');
    assert.equal(again.status, 200);
    assert.deepEqual(again.json(), []);
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

  /** CT 101 with pending apt packages and a Vaultwarden app (1.30.0 → v1.32.0) with an update command. */
  const addContainerWithUpdates = async () => {
    const container = await addContainer();
    await request('POST', '/api/repositories', { repository: 'acme/widget' });
    const repo = (await request('GET', '/api/repositories')).json()[0];
    await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      versionCommand: 'cat /opt/vw_version.txt',
      latestSource: 'github',
      repositoryId: repo.id,
      updateCommand: 'update',
    });
    await request('POST', `/api/containers/${container.id}/check`);
    await app.containers.wait(container.id);
    return container;
  };

  it('updates all containers one after another: apt, then applications, without the host', async () => {
    const container = await addContainerWithUpdates();
    shell.on(/^hostname$/, { output: 'pve\n' });
    const node = (await request('POST', '/api/containers/node')).json();
    await app.containers.wait(node.id);
    await request('PUT', '/api/settings', { backupStorage: 'pbs', backupBeforeUpdate: true });
    const upgrade = Promise.withResolvers<{ output: string }>();
    shell.on(/apt-get -y/, () => upgrade.promise);
    shell.on(/\nupdate'$/, { output: 'Updated.\n' });
    shell.commands.length = 0;

    const response = await request('POST', '/api/containers/update-all', { backup: true });
    assert.equal(response.status, 202);
    assert.deepEqual(response.json(), { containers: 1, updates: 2 });
    assert.equal((await request('POST', '/api/containers/update-all')).status, 409);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().isBusy, true);
    upgrade.resolve({ output: 'Setting up curl (8.1) ...\n' });
    await app.updater.idle();

    const updates = shell.commands.filter((c) => /vzdump|apt-get -y|dist-upgrade|\nupdate'$/.test(c));
    assert.equal(updates.length, 3, updates.join('\n'));
    assert.match(updates[0]!, /vzdump 101/, 'backed up once, before the first update');
    assert.ok(updates[1]!.includes('apt-get -y'));
    assert.match(updates[2]!, /pct exec 101 [\s\S]*\nupdate'$/);
    const runs = (await request('GET', `/api/containers/${container.id}/runs`)).json();
    assert.deepEqual(runs.slice(0, 2).map((r: { kind: string; status: string }) => [r.kind, r.status]), [
      ['app-update', 'succeeded'],
      ['apt-upgrade', 'succeeded'],
    ]);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().isBusy, false);
  });

  it('skips the remaining updates of a container after a failure and honours backup: false', async () => {
    const container = await addContainerWithUpdates();
    await request('PUT', '/api/settings', { backupStorage: 'pbs', backupBeforeUpdate: true });
    shell.on(/apt-get -y/, { exitCode: 100, output: 'E: Could not get lock\n' });
    shell.commands.length = 0;

    assert.equal((await request('POST', '/api/containers/update-all', { backup: false })).status, 202);
    await app.updater.idle();

    assert.equal(shell.commands.some((c) => c.includes('vzdump')), false);
    assert.equal(shell.commands.some((c) => /\nupdate'$/.test(c)), false);
    const runs = (await request('GET', `/api/containers/${container.id}/runs`)).json();
    assert.equal(runs[0].kind, 'apt-upgrade');
    assert.equal(runs[0].status, 'failed');
  });

  it('updates all pending updates of one container: apt, then applications, one backup', async () => {
    const container = await addContainerWithUpdates();
    await request('PUT', '/api/settings', { backupStorage: 'pbs' });
    const upgrade = Promise.withResolvers<{ output: string }>();
    shell.on(/apt-get -y/, () => upgrade.promise);
    shell.on(/\nupdate'$/, { output: 'Updated.\n' });
    shell.commands.length = 0;

    const response = await request('POST', `/api/containers/${container.id}/update-all`, { backup: true });
    assert.equal(response.status, 202);
    assert.deepEqual(response.json(), { containers: 1, updates: 2 });
    // Queued already – by itself and by the global "update all".
    assert.equal((await request('POST', `/api/containers/${container.id}/update-all`)).status, 409);
    assert.equal((await request('POST', '/api/containers/update-all')).status, 409);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().isBusy, true);
    // The run in progress is exposed, so the UI can show its live log.
    let activeRunId: number | null = null;
    for (let i = 0; i < 50 && activeRunId === null; i++) {
      activeRunId = (await request('GET', `/api/containers/${container.id}`)).json().activeRunId;
      await Bun.sleep(5);
    }
    assert.notEqual(activeRunId, null);
    const active = (await request('GET', `/api/runs/${activeRunId}`)).json();
    assert.deepEqual([active.kind, active.status], ['apt-upgrade', 'running']);
    upgrade.resolve({ output: 'Setting up curl (8.1) ...\n' });
    await app.updater.idle();
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().activeRunId, null);

    const updates = shell.commands.filter((c) => /vzdump|apt-get -y|\nupdate'$/.test(c));
    assert.equal(updates.length, 3, updates.join('\n'));
    assert.match(updates[0]!, /vzdump 101 .*pbs/);
    assert.ok(updates[1]!.includes('apt-get -y'));
    assert.match(updates[2]!, /pct exec 101 [\s\S]*\nupdate'$/);
    assert.equal((await request('POST', '/api/containers/999/update-all')).status, 404);
  });

  it('queues a container while "update all" of another one runs', async () => {
    const first = await addContainerWithUpdates();
    shell.on(/^pct status 102$/, { output: 'status: running\n' });
    const second = (await request('POST', '/api/containers', { vmid: 102 })).json();
    await app.containers.wait(second.id);
    const upgrade = Promise.withResolvers<{ output: string }>();
    shell.on(/pct exec 101 [\s\S]*apt-get -y/, () => upgrade.promise);
    shell.commands.length = 0;

    assert.equal((await request('POST', `/api/containers/${first.id}/update-all`, { backup: false })).status, 202);
    assert.equal((await request('POST', `/api/containers/${second.id}/update-all`, { backup: false })).status, 202);
    assert.equal((await request('GET', `/api/containers/${second.id}`)).json().isBusy, true);
    upgrade.resolve({ output: 'done\n' });
    await app.updater.idle();
    assert.ok(shell.commands.some((c) => /pct exec 102 [\s\S]*apt-get -y/.test(c)), shell.commands.join('\n'));
  });

  it('lists applications in alphabetical order', async () => {
    const container = await addContainer();
    for (const name of ['ViaVersion', 'bluemap', 'Purpur']) {
      await request('POST', `/api/containers/${container.id}/apps`, { name, latestSource: 'none' });
    }
    const apps = (await request('GET', `/api/containers/${container.id}`)).json().apps;
    assert.deepEqual(apps.map((a: { name: string }) => a.name), ['bluemap', 'Purpur', 'ViaVersion']);
  });

  it('starts nothing when no container has pending updates', async () => {
    await addContainer();
    shell.on(/apt list --upgradable/, { output: `${APT_LIST_MARKER}\nListing...\n` });
    await app.scheduler.checkAll();
    shell.commands.length = 0;
    const response = await request('POST', '/api/containers/update-all');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { containers: 0, updates: 0 });
    assert.equal(shell.commands.length, 0);
  });

  it('refuses container actions until the node is configured', async () => {
    shell.isConfigured = false;
    assert.equal((await request('POST', '/api/containers', { vmid: 101 })).status, 409);
  });

});
