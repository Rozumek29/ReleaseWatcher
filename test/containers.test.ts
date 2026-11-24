import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore } from '../src/db.ts';
import { silentLogger } from '../src/log.ts';
import { PACKAGE_LIST_MARKER, capabilities } from '../src/proxmox/domain.ts';
import { ContainerStore } from '../src/proxmox/store.ts';
import { SettingsService } from '../src/settings.ts';
import { addProxmoxHost, FakeShell, FakeSource, guestJson, HAOS_PROBE_OUTPUT, haState, RecordingNotifier, release } from './helpers.ts';

const PCT_LIST = 'VMID       Status     Lock         Name\n101        running                 vaultwarden\n102        stopped                 old\n';
const QM_LIST =
  '      VMID NAME                 STATUS     MEM(MiB)   BOOTDISK(GiB) PID\n       137 debian               running    4096              32.00 1667\n';
/** Output of DISCOVER_COMMAND: `pct list`, a marker, `qm list`. */
const discovered = (pct = PCT_LIST) => `${pct}---releasewatcher-qm---\n${QM_LIST}`;
const APT_OUTPUT = `${PACKAGE_LIST_MARKER} apt\nListing...\ncurl/stable 8.1 amd64 [upgradable from: 8.0]\n`;

describe('containers API', () => {
  let app: App;
  let store: RepositoryStore;
  let shell: FakeShell;
  let source: FakeSource;
  let notifier: RecordingNotifier;
  let baseUrl: URL;
  /** Answers requests to the Home Assistant REST API (tests never reach a real one). */
  let haFetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** The Proxmox node the containers live on. */
  let nodeHostId: number;

  const request = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL(url, baseUrl), {
      method,
      headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, json: () => JSON.parse(text), text };
  };

  /** Sets the backup storage of the node and, if given, the global "back up before updates". */
  const setBackupStorage = async (storage: string, backupBeforeUpdate?: boolean) => {
    assert.equal((await request('PUT', `/api/hosts/${nodeHostId}`, { backupStorage: storage })).status, 200);
    if (backupBeforeUpdate !== undefined) await request('PUT', '/api/settings', { backupBeforeUpdate });
  };

  beforeEach(async () => {
    shell = new FakeShell()
      .on(/^pct list /, { output: discovered() })
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
    nodeHostId = addProxmoxHost(store).id;
    haFetch = async () => {
      throw new TypeError('Home Assistant is not reachable in this test');
    };
    app = await buildApp({
      store,
      settings,
      source,
      notifiers: [notifier],
      log: silentLogger,
      shell,
      reconnectDelayMs: 0,
      resourcePollMs: 0,
      promptIdleMs: 40,
      homeAssistantFetch: (url, init) => haFetch(url, init),
      homeAssistantPollMs: 0,
      machineRestartWaitMs: 0,
      machinePollMs: 0,
      auth: { requireAuth: false },
    });
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
      'idx_containers_host_vmid',
      'idx_docker_containers_endpoint',
      'idx_docker_containers_label_repository',
      'idx_docker_containers_repository',
      'idx_docker_containers_source',
      'idx_docker_containers_target',
      'idx_hosts_ssh_key',
      'idx_repository_advisories_page',
      'idx_sessions_expires',
      'idx_watched_repositories_enabled',
      'idx_watched_repositories_full_name',
    ]);
  });

  it('lists containers on the node and marks added ones', async () => {
    await addContainer();
    const response = await request('GET', '/api/proxmox/containers');
    assert.deepEqual(response.json(), [
      { kind: 'lxc', vmid: 101, status: 'running', name: 'vaultwarden', added: true },
      { kind: 'lxc', vmid: 102, status: 'stopped', name: 'old', added: false },
      { kind: 'vm', vmid: 137, status: 'running', name: 'debian', added: false },
    ]);
  });

  it('checks, updates and restarts a virtual machine through the QEMU guest agent', async () => {
    shell.on(/^qm status 137$/, { output: 'status: running\n' });
    shell.on(/^qm guest exec 137 -- sh -lc .*reboot-required/, { output: 'kernel 6.12.48-amd64 6.12.57-amd64\nstale sshd\n' });
    const response = await request('POST', '/api/containers', { vmid: 137 });
    assert.equal(response.status, 201);
    const vm = response.json();
    assert.equal(vm.kind, 'vm');
    assert.equal(vm.capabilities.homeAssistant, true);
    assert.equal(vm.name, 'debian');
    await app.containers.wait(vm.id);

    // One batched `qm guest exec`, decoded from its JSON – no pct at all.
    let dto = (await request('GET', `/api/containers/${vm.id}`)).json();
    assert.equal(dto.lastError, null);
    assert.deepEqual(dto.aptUpgradable, [{ name: 'curl', newVersion: '8.1', currentVersion: '8.0' }]);
    assert.deepEqual(dto.restartReasons, [
      'Kernel 6.12.57-amd64 is installed, 6.12.48-amd64 is running',
      'Processes use upgraded files: sshd',
    ]);
    assert.equal(shell.commands.some((c) => c.startsWith('pct') && !c.startsWith('pct list')), false);
    assert.equal(notifier.containerSent.at(-1)?.targetKind, 'vm');

    // apt upgrade runs detached on the node through the agent; the log shows the command's output, not the JSON.
    shell.on(/^qm guest exec 137 --timeout 3600 -- sh -c /, { output: guestJson('Setting up curl (8.1) ...\n', 0) });
    shell.on(/apt list --upgradable/, { output: `${PACKAGE_LIST_MARKER} apt\nListing...\n` });
    assert.equal((await request('POST', `/api/containers/${vm.id}/apt-upgrade`, { backup: false })).status, 202);
    let run = await app.containers.wait(vm.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /QEMU guest agent – the output appears when the command has finished/);
    assert.match(run?.output ?? '', /Setting up curl \(8\.1\) \.\.\./);
    assert.doesNotMatch(run?.output ?? '', /out-data/);
    assert.match(shell.detached.at(-1)?.command ?? '', /^qm guest exec 137 --timeout 3600 -- sh -c '.*apt-get -y/s);

    // The exit code comes from the JSON, not from `qm` (which succeeds even when the command fails).
    shell.on(/^qm guest exec 137 --timeout 3600 -- sh -c /, { output: guestJson('E: Unable to lock\n', 100) });
    await request('POST', `/api/containers/${vm.id}/apt-upgrade`, { backup: false });
    run = await app.containers.wait(vm.id);
    assert.equal(run?.status, 'failed');
    assert.equal(run?.exitCode, 100);
    assert.match(run?.output ?? '', /E: Unable to lock/);

    // Restart with `qm reboot`, waiting for the agent again.
    shell.on(/^qm reboot 137 /, { output: '' });
    assert.equal((await request('POST', `/api/containers/${vm.id}/restart`)).status, 202);
    run = await app.containers.wait(vm.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /VM 137 restarted/);
    assert.match(shell.detached.at(-1)?.command ?? '', /^qm reboot 137 --timeout 120[^]*qm agent 137 ping/);

    // Without a running agent the check reports it once and keeps the previous results.
    shell.guestAgentDown = true;
    await request('POST', `/api/containers/${vm.id}/check`);
    await app.containers.wait(vm.id);
    dto = (await request('GET', `/api/containers/${vm.id}`)).json();
    assert.match(dto.lastError, /^The QEMU guest agent did not run the commands \(QEMU guest agent is not running\)/);

    // Virtual machines are not resized and not added by "Add all".
    const saved = await request('PUT', `/api/containers/${vm.id}`, { ...dto, updateCores: 4, updateMemoryMb: 4096 });
    assert.deepEqual([saved.json().updateCores, saved.json().updateMemoryMb], [null, null]);
    await request('DELETE', `/api/containers/${vm.id}`);
    const added = (await request('POST', '/api/containers/add-all')).json();
    assert.deepEqual(added.map((c: { kind: string; vmid: number }) => `${c.kind}:${c.vmid}`), ['lxc:101', 'lxc:102']);
  });

  it('finds Home Assistant OS in a virtual machine and installs its updates', async () => {
    shell.on(/^qm status 137$/, { output: 'status: running\n' });
    shell.on(/^qm guest exec 137 -- sh -lc .*ID=haos/, { output: HAOS_PROBE_OUTPUT });
    const vm = (await request('POST', '/api/containers', { vmid: 137, name: 'ha' })).json();
    await app.containers.wait(vm.id);

    // Without a token: Supervisor components live, integrations from the saved states; HAOS has no apt.
    let dto = (await request('GET', `/api/containers/${vm.id}`)).json();
    assert.equal(dto.lastError, null);
    assert.equal(dto.aptEnabled, false);
    assert.deepEqual(dto.aptUpgradable, []);
    assert.equal(dto.homeAssistant.detected, true);
    assert.equal(dto.homeAssistant.coreVersion, '2026.11.2');
    assert.equal(dto.homeAssistant.entitiesSavedAt, new Date(1795180744 * 1000).toISOString());
    assert.equal(dto.homeAssistant.hasToken, false);
    // Check-only by default: nothing is installed from ReleaseWatcher, "update all" leaves Home Assistant out.
    assert.equal(dto.homeAssistant.installEnabled, false);
    assert.ok(dto.homeAssistant.updates.every((u: { installBlocker: string | null }) => /switched off/.test(u.installBlocker ?? '')));
    let started = await request('POST', `/api/containers/${vm.id}/home-assistant-update`, { backup: false });
    assert.equal(started.status, 409);
    assert.match(started.json().title, /switched off/);
    assert.deepEqual((await request('POST', `/api/containers/${vm.id}/update-all`, { backup: false })).json(), {
      containers: 0,
      updates: 0,
    });
    dto = (await request('PUT', `/api/containers/${vm.id}`, { ...dto, homeAssistantInstall: true })).json();
    assert.equal(dto.homeAssistant.installEnabled, true);
    assert.deepEqual(
      dto.homeAssistant.updates.map((u: { id: string; installBlocker: string | null }) => [u.id, u.installBlocker !== null]),
      [
        ['app:core_mosquitto', false],
        ['update.dahua_update', true],
        ['update.frigate_server', true],
      ],
    );
    assert.equal(dto.updatesAvailable, 3);
    assert.deepEqual(
      notifier.containerSent.at(-1)?.apps.map((a) => `${a.name} ${a.latestVersion}`),
      ['Mosquitto broker 7.2.0', 'Dahua 3.1.0', 'Frigate Server 0.18.3'],
    );
    const status = (await request('GET', '/api/status')).json();
    assert.equal(status.containers.homeAssistantUpdatesAvailable, 3);

    // Integrations need the token; the operating system and unknown updates are refused.
    started = await request('POST', `/api/containers/${vm.id}/home-assistant-update`, { ids: ['update.dahua_update'], backup: false });
    assert.equal(started.status, 409);
    assert.match(started.json().title, /access token/);
    started = await request('POST', `/api/containers/${vm.id}/home-assistant-update`, { ids: ['update.nope'], backup: false });
    assert.equal(started.status, 409);
    started = await request('POST', `/api/containers/${vm.id}/home-assistant-update`, { ids: ['update.frigate_server'], backup: false });
    assert.match(started.json().title, /only announces/);

    // The token is stored encrypted and never returned; a URL is required with it.
    assert.equal((await request('PUT', `/api/containers/${vm.id}`, { ...dto, homeAssistantToken: 'secret-ha-token' })).status, 400);
    const saved = await request('PUT', `/api/containers/${vm.id}`, {
      ...dto,
      homeAssistantUrl: 'https://ha.example.com:8123/',
      homeAssistantToken: 'secret-ha-token',
    });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(saved.text, /secret-ha-token/);
    assert.equal(saved.json().homeAssistant.url, 'https://ha.example.com:8123');
    assert.equal(saved.json().homeAssistant.hasToken, true);
    const raw = store.database.query<{ t: string }, []>('SELECT home_assistant_token AS t FROM containers').get()!.t;
    assert.match(raw, /^enc:v1:/);
    // Omitted keeps the token (the UI never sends it back).
    assert.equal((await request('PUT', `/api/containers/${vm.id}`, saved.json())).json().homeAssistant.hasToken, true);

    // With the token the integrations are read live.
    const requests: { method: string; url: string; auth: string | null; body: string | null }[] = [];
    let dahua = haState('update.dahua_update', 'on', '3.0.0', '3.1.0', 'Dahua');
    let coreUp = true;
    haFetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ method: init?.method ?? 'GET', url, auth: headers.get('authorization'), body: (init?.body as string) ?? null });
      if (!coreUp) throw new TypeError('Connection refused');
      if (url.endsWith('/api/services/update/install')) {
        dahua = haState('update.dahua_update', 'off', '3.1.0', '3.1.0', 'Dahua');
        return Response.json([]);
      }
      if (url.endsWith('/api/states/update.dahua_update')) return Response.json(dahua);
      return Response.json([dahua, haState('update.places_update', 'off', 'v3.0.3', 'v3.0.3')]);
    };
    await request('POST', `/api/containers/${vm.id}/check`);
    await app.containers.wait(vm.id);
    dto = (await request('GET', `/api/containers/${vm.id}`)).json();
    assert.equal(dto.lastError, null);
    assert.equal(dto.homeAssistant.entitiesSavedAt, null);
    assert.equal(requests[0]!.url, 'https://ha.example.com:8123/api/states');
    assert.equal(requests[0]!.auth, 'Bearer secret-ha-token');

    // Install everything: the integration through the API, the app with the ha CLI, then a Core restart.
    shell.on(/^qm guest exec 137 --timeout \d+ -- sh -c [^]*ha apps update core_mosquitto/, { output: guestJson('Updated\n', 0) });
    shell.on(/^qm guest exec 137 --timeout \d+ -- sh -c [^]*ha core restart/, () => {
      coreUp = false;
      setTimeout(() => (coreUp = true), 20);
      return { output: guestJson('Command completed successfully.\n', 0) };
    });
    requests.length = 0;
    started = await request('POST', `/api/containers/${vm.id}/home-assistant-update`, { backup: false });
    assert.equal(started.status, 202);
    const run = await app.containers.wait(vm.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.equal(run?.kind, 'home-assistant-update');
    const install = requests.find((r) => r.url.endsWith('/api/services/update/install'));
    assert.equal(install?.method, 'POST');
    assert.deepEqual(JSON.parse(install!.body!), { entity_id: 'update.dahua_update' });
    assert.match(run?.output ?? '', /Dahua installed \(3\.1\.0\)/);
    assert.match(run?.output ?? '', /Restarting Home Assistant Core to load the updated integrations/);
    assert.match(run?.output ?? '', /Home Assistant is running/);
    const order = shell.detached.map((d) => (/ha apps update/.test(d.command) ? 'app' : /ha core restart/.test(d.command) ? 'restart' : '?'));
    assert.deepEqual(order.slice(-2), ['app', 'restart']);
    // The token never reaches the node.
    assert.equal(shell.commands.some((c) => c.includes('secret-ha-token')), false);
    assert.equal(shell.detached.some((d) => d.command.includes('secret-ha-token')), false);
  });

  it('rejects containers that do not exist and duplicates', async () => {
    assert.equal((await request('POST', '/api/containers', { vmid: 999 })).status, 400);
    await addContainer();
    assert.equal((await request('POST', '/api/containers', { vmid: 101 })).status, 409);
  });

  it('checks the linked containers when a manual repository check finds a new release', async () => {
    const container = await addContainer();
    await request('POST', '/api/repositories', { repository: 'acme/widget' });
    const repo = (await request('GET', '/api/repositories')).json()[0];
    await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      versionCommand: 'cat /opt/vw_version.txt',
      latestSource: 'github',
      repositoryId: repo.id,
    });
    // A disabled container with a linked app is left alone.
    const other = (await request('POST', '/api/containers', { vmid: 102 })).json();
    await app.containers.wait(other.id);
    await request('POST', `/api/containers/${other.id}/apps`, {
      name: 'Widget',
      versionCommand: 'cat /opt/widget_version',
      latestSource: 'github',
      repositoryId: repo.id,
    });
    await request('PUT', `/api/containers/${other.id}`, { name: 'old', isEnabled: false, aptEnabled: true });

    // An app never checked is behind the repository's baseline: the repository check brings it up to date.
    const first = (await request('POST', `/api/repositories/${repo.id}/check`)).json();
    assert.equal(first.containerChecks, 1);
    await app.scheduler.idle();
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().apps[0].latestVersion, 'v1.32.0');

    // Nothing new → no container check.
    const unchanged = (await request('POST', `/api/repositories/${repo.id}/check`)).json();
    assert.equal(unchanged.containerChecks, 0);

    source.releases = [release('v1.32.0', 1), release('v1.33.0', 2)];
    const checked = (await request('POST', `/api/repositories/${repo.id}/check`)).json();
    assert.equal(checked.containerChecks, 1);
    await app.scheduler.idle();

    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.apps[0].latestVersion, 'v1.33.0');
    assert.equal(dto.apps[0].updateAvailable, true);
    assert.equal((await request('GET', `/api/containers/${other.id}`)).json().apps[0].latestVersion, null);
  });

  it('checks the linked containers after a run of all repositories (scheduled, startup, check all)', async () => {
    const container = await addContainer();
    await request('POST', '/api/repositories', { repository: 'acme/widget' });
    const repo = (await request('GET', '/api/repositories')).json()[0];
    await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      versionCommand: 'cat /opt/vw_version.txt',
      latestSource: 'github',
      repositoryId: repo.id,
    });
    const latest = async () => (await request('GET', `/api/containers/${container.id}`)).json().apps[0].latestVersion;

    // The app was never checked, so it is behind the repository's baseline: the run brings it up to date.
    assert.equal(await latest(), null);
    await app.releaseJob.runNow();
    assert.equal(await latest(), 'v1.32.0');

    // Nothing new → no container check.
    const checks = () => shell.commands.length;
    let before = checks();
    await app.releaseJob.runNow();
    assert.equal(checks(), before);

    source.releases = [release('v1.32.0', 1), release('v1.33.0', 2)];
    await app.releaseJob.runNow();
    assert.equal(await latest(), 'v1.33.0');

    // Up to date → the next run leaves the container alone.
    before = checks();
    await app.releaseJob.runNow();
    assert.equal(checks(), before);
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
    assert.deepEqual(dto.apps[0].iconUrls, []);
    assert.equal(dto.apps[0].updateAvailable, true);
    assert.equal(dto.updatesAvailable, 2);
    assert.equal(dto.lastError, null);

    const finished = (await request('GET', `/api/runs/${run.id}`)).json();
    assert.equal(finished.status, 'succeeded');
    assert.match(finished.output, /Vaultwarden: installed 1\.30\.0, latest v1\.32\.0/);

    // The application inherits the custom icon of its repository.
    await request('PUT', `/api/repositories/${repo.id}`, { includePrereleases: false, isEnabled: true, icon: 'https://img.test/vw.png' });
    const withIcon = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.deepEqual(withIcon.apps[0].iconUrls, ['https://img.test/vw.png']);

    // First check (on add) notified about apt; the app update is new → one more notification.
    assert.equal(notifier.containerSent.length, 2);
    assert.equal(notifier.containerSent[1]!.apps[0]!.latestVersion, 'v1.32.0');

    // Nothing new → no further notification.
    app.containers.startCheck(await getContainer(container.id), 'schedule');
    await app.containers.wait(container.id);
    assert.equal(notifier.containerSent.length, 2);

    const status = (await request('GET', '/api/status')).json();
    assert.deepEqual(status.containers, { total: 1, enabled: 1, withErrors: 0, aptPending: 1, appUpdatesAvailable: 1, homeAssistantUpdatesAvailable: 0 });
  });

  it('takes the installed version of an app without a version command by hand and marks the latest as installed', async () => {
    const container = await addContainer();
    await request('POST', '/api/repositories', { repository: 'acme/widget' });
    const repo = (await request('GET', '/api/repositories')).json()[0];
    const created = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Widget',
      latestSource: 'github',
      repositoryId: repo.id,
      installedVersion: '1.30.0',
    });
    assert.equal(created.status, 201);
    const appId = created.json().id;
    assert.equal(created.json().installedVersion, '1.30.0');

    // A check keeps the version entered by hand and compares it with the latest.
    await request('POST', `/api/containers/${container.id}/check`);
    await app.containers.wait(container.id);
    let dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.apps[0].installedVersion, '1.30.0');
    assert.equal(dto.apps[0].updateAvailable, true);
    // The repository's vulnerabilities are compared with it too.
    assert.deepEqual((await request('GET', `/api/repositories/${repo.id}`)).json().installedVersions, ['1.30.0']);

    const marked = await request('POST', `/api/containers/${container.id}/apps/${appId}/mark-installed`);
    assert.equal(marked.status, 200);
    assert.equal(marked.json().installedVersion, 'v1.32.0');
    assert.equal(marked.json().updateAvailable, false);

    // Only without a version command.
    const both = await request('PUT', `/api/containers/${container.id}/apps/${appId}`, {
      name: 'Widget',
      latestSource: 'github',
      repositoryId: repo.id,
      versionCommand: 'cat /opt/vw_version.txt',
      installedVersion: '1.0.0',
    });
    assert.equal(both.status, 400);
    assert.ok(both.json().errors.installedVersion);
    await request('PUT', `/api/containers/${container.id}/apps/${appId}`, {
      name: 'Widget',
      latestSource: 'github',
      repositoryId: repo.id,
      versionCommand: 'cat /opt/vw_version.txt',
    });
    const withCommand = await request('POST', `/api/containers/${container.id}/apps/${appId}/mark-installed`);
    assert.equal(withCommand.status, 409);
    dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.apps[0].installedVersion, null); // the command reads it from now on
  });

  const getContainer = async (id: number) => {
    const { ContainerStore } = await import('../src/proxmox/store.ts');
    return new ContainerStore(store.database, store.secretBox).get(id)!;
  };

  it('runs apt upgrade after a backup and refreshes the state', async () => {
    const container = await addContainer();
    await setBackupStorage('pbs', true);
    shell.commands.length = 0;
    shell.on(/apt list --upgradable/, { output: `${PACKAGE_LIST_MARKER} apt\nListing...\n` });
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

  it('notifies about finished and failed updates when switched on', async () => {
    const container = await addContainer();
    shell.on(/apt-get -y/, { output: 'E: Could not get lock\n', exitCode: 100 });

    await request('POST', `/api/containers/${container.id}/apt-upgrade`, { backup: false });
    await app.containers.wait(container.id);
    assert.equal(notifier.resultsSent.length, 0); // off by default

    await request('PUT', '/api/settings', { notifyUpdateFailed: true, notifyUpdateSucceeded: true });
    await request('POST', `/api/containers/${container.id}/apt-upgrade`, { backup: false });
    await app.containers.wait(container.id);
    assert.equal(notifier.resultsSent.length, 1);
    assert.deepEqual(
      { ...notifier.resultsSent[0], detail: undefined },
      { vmid: 101, targetKind: 'lxc', containerName: container.name, kind: 'apt-upgrade', appName: null, succeeded: false, detail: undefined, packageManager: 'apt' },
    );
    assert.match(notifier.resultsSent[0]?.detail ?? '', /^Update failed/);

    shell.on(/apt-get -y/, { output: 'done\n' });
    await request('POST', `/api/containers/${container.id}/apt-upgrade`, { backup: false });
    await app.containers.wait(container.id);
    assert.deepEqual([notifier.resultsSent[1]?.succeeded, notifier.resultsSent[1]?.detail], [true, null]);
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

    await setBackupStorage('local', true);
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
    await setBackupStorage('local', true);
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
    assert.equal((await request('PUT', `/api/hosts/${nodeHostId}`, { backupStorage: 'bad name' })).status, 400);
    await setBackupStorage('pbs');
    const saved = (await request('PUT', '/api/settings', { backupStorage: 'local', backupBeforeUpdate: true })).json();
    assert.equal(saved.proxmox.backupBeforeUpdate, true);
    assert.equal(saved.proxmox.backupStorage, undefined, 'the storage belongs to the node');
    assert.deepEqual(saved.proxmox.nodes.map((n: { backupStorage: string | null }) => n.backupStorage), ['pbs']);
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

    const runs = (await request('GET', `/api/containers/${container.id}/runs`)).json().items;
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

  it('runs application updates non-interactively (PHS_SILENT=1 for community-scripts)', async () => {
    const container = await addContainer();
    const created = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      latestSource: 'none',
      updateCommand: 'update',
      useTty: true,
    });
    shell.on(/\nupdate'$/, { output: 'Updated.\n' });
    await request('POST', `/api/containers/${container.id}/apps/${created.json().id}/update`);
    assert.equal((await app.containers.wait(container.id))?.status, 'succeeded');

    assert.match(shell.detached[0]?.command ?? '', /\nexport PHS_SILENT=1 DEBIAN_FRONTEND=noninteractive\nupdate'$/);
  });

  it('stops an update that waits at an interactive menu instead of running into its timeout', async () => {
    const container = await addContainer();
    const created = await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Vaultwarden',
      latestSource: 'none',
      updateCommand: 'update',
      useTty: true,
    });
    // whiptail as drawn in a pseudo-terminal: cursor movement, line-drawing charset, then silence.
    const menu =
      '\x1b[?1049h\x1b[1;1H\x1b(0lqqqqk\x1b(B Vaultwarden LXC Update/Setting \x1b[5;3H1 YES (Silent Mode)' +
      '\x1b[6;3H2 YES (Verbose Mode)\x1b[7;3H3 NO (Cancel Update)\x1b[10;26H<Ok>\x1b[10;30H';
    shell.on(/\nupdate'$/, { output: menu });
    shell.hangUntilStopped = true;

    const started = Date.now();
    await request('POST', `/api/containers/${container.id}/apps/${created.json().id}/update`);
    const run = await app.containers.wait(container.id);

    assert.ok(Date.now() - started < 5000, 'stopped long before the 30-minute timeout');
    assert.equal(run?.status, 'failed');
    assert.deepEqual(shell.stoppedUnits, [`releasewatcher-run-${run?.id}-update`]);
    assert.match(run?.output ?? '', /stopped at an interactive menu \(whiptail\/dialog\) and waited \d+ s for input/);
    assert.match(run?.output ?? '', /YES \(Silent Mode\)/, 'the menu stays visible in the log');
    assert.equal(shell.units.size, 0, 'the stopped unit is cleaned up on the node');
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
    // Proxmox applies the cpuset of a running container only in pvestatd's next cycle.
    let nprocCalls = 0;
    shell.on(/^pct exec 101 -- nproc$/, () => ({ output: ++nprocCalls < 3 ? '1\n' : '4\n' }));
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
    const relevant = shell.commands.filter((c) => /^pct (config|set)|nproc|cargo build/.test(c));
    assert.deepEqual(relevant.map((c) => c.replace(/'.*/s, '')), [
      'pct config 101',
      'pct set 101 --cores 4 --memory 4096',
      'pct exec 101 -- nproc',
      'pct exec 101 -- nproc',
      'pct exec 101 -- nproc',
      'pct exec 101 -- sh -c ',
      'pct set 101 --cores 1 --memory 1024',
    ]);
    assert.match(run?.output ?? '', /Raising resources for the update: 4 cores, 4096 MiB memory/);
    assert.match(run?.output ?? '', /Waiting for Proxmox to apply the CPU cores \(CT 101 sees 1\)…/);
    assert.match(run?.output ?? '', /CT 101 now sees 4 CPU cores/);
    assert.match(run?.output ?? '', /Restoring resources: 1 cores, 1024 MiB memory/);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().resourcesRaised, false);
  });

  it('re-attaches to an update still running on the node after a restart and restores resources', async () => {
    const container = await addContainer();
    const containerStore = new ContainerStore(store.database, store.secretBox);
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
    assert.match(run?.output ?? '', /stopped – package and application checks skipped/);
    assert.equal(shell.commands.some((c) => c.startsWith('pct exec') || c.startsWith('pct start')), false);
    const dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.status, 'stopped');
    assert.equal(dto.lastError, null);
    assert.equal(dto.aptUpgradable.length, 1, 'results of the last check are kept');
    assert.equal(notifier.containerSent.length, sent);
  });

  it('refuses to update a container that is stopped now', async () => {
    const container = await addContainer();
    await setBackupStorage('local', true);
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
    shell.on(/apt list --upgradable/, { output: `${PACKAGE_LIST_MARKER} apt\nListing...\n` });

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
    await setBackupStorage('local', true);
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
    assert.deepEqual(node.capabilities, capabilities('node'));
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
    assert.equal(notifier.containerSent.at(-1)?.targetKind, 'node');

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
    await setBackupStorage('local', true);
    assert.equal((await request('POST', `/api/containers/${node.id}/apt-upgrade`, { backup: true })).status, 409);

    // Proxmox VE is upgraded with dist-upgrade, without vzdump and directly on the node.
    shell.on(/dist-upgrade/, { output: 'Setting up pve-manager (9.1.2) ...\n' });
    shell.on(/apt list --upgradable/, { output: `${PACKAGE_LIST_MARKER} apt\nListing...\n` });
    shell.commands.length = 0;
    assert.equal((await request('POST', `/api/containers/${node.id}/apt-upgrade`)).status, 202);
    const run = await app.containers.wait(node.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(shell.commands[0]!, /^export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get -y .* dist-upgrade && apt-get -y autoremove$/);
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

  it('keeps as many runs as the run history settings allow', async () => {
    const container = await addContainer();
    for (let i = 0; i < 3; i++) {
      await request('POST', `/api/containers/${container.id}/check`);
      await app.containers.wait(container.id);
    }
    const runs = async () => (await request('GET', `/api/containers/${container.id}/runs`)).json().items as { id: number }[];
    assert.equal((await runs()).length, 4); // the check after adding + 3

    const proxmox = async () => (await request('GET', '/api/settings')).json().proxmox;
    assert.deepEqual(
      Object.fromEntries(Object.entries(await proxmox()).filter(([k]) => /RunHistory/i.test(k))),
      // No limits by default (null = keep all runs).
      { runHistoryChecks: null, runHistoryUpdates: null, minRunHistory: 1, maxRunHistory: 500 },
    );
    assert.equal((await request('PUT', '/api/settings', { runHistoryChecks: 0 })).status, 400);
    assert.equal((await request('PUT', '/api/settings', { runHistoryUpdates: 501 })).status, 400);
    // Lowering the limit prunes right away, without waiting for the next run.
    assert.equal((await request('PUT', '/api/settings', { runHistoryChecks: 2 })).status, 200);
    assert.equal((await proxmox()).runHistoryChecks, 2);
    assert.equal((await runs()).length, 2);
    // null goes back to the default: no limit, new runs are kept again.
    assert.equal((await request('PUT', '/api/settings', { runHistoryChecks: null })).status, 200);
    assert.equal((await proxmox()).runHistoryChecks, null);
    await request('POST', `/api/containers/${container.id}/check`);
    await app.containers.wait(container.id);
    assert.equal((await runs()).length, 3);
  });

  it('pages the run history newest first with a cursor', async () => {
    const container = await addContainer();
    const containerStore = new ContainerStore(store.database, store.secretBox);
    for (let i = 0; i < 4; i++) {
      const run = containerStore.startRun(container.id, null, 'check', 'schedule');
      containerStore.finishRun({ ...run, status: 'succeeded', finishedAt: new Date().toISOString(), exitCode: 0, output: '' });
    }
    const page = async (query: string) => {
      const response = await request('GET', `/api/containers/${container.id}/runs${query}`);
      return { status: response.status, body: response.json() };
    };
    const all = (await page('')).body as { items: { id: number }[]; nextCursor: string | null };
    assert.equal(all.items.length, 5); // the check after adding + 4
    assert.equal(all.nextCursor, null);

    const first = (await page('?limit=2')).body;
    assert.deepEqual(first.items.map((r: { id: number }) => r.id), all.items.slice(0, 2).map((r) => r.id));
    const second = (await page(`?limit=2&cursor=${first.nextCursor}`)).body;
    assert.deepEqual(second.items.map((r: { id: number }) => r.id), all.items.slice(2, 4).map((r) => r.id));
    const last = (await page(`?limit=2&cursor=${second.nextCursor}`)).body;
    assert.deepEqual(last.items.map((r: { id: number }) => r.id), [all.items[4]!.id]);
    assert.equal(last.nextCursor, null);

    assert.equal((await page('?limit=0')).status, 400);
    assert.equal((await page('?cursor=abc')).status, 400);
  });

  it('checks containers in parallel up to the configured limit, one batch command each', async () => {
    shell.on(/^pct list /, {
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

  it('validates container settings; the connection lives in hosts, not in the settings', async () => {
    const settings = (await request('GET', '/api/settings')).json();
    assert.equal(settings.proxmox.configured, true);
    assert.equal('host' in settings.proxmox || 'sshKeyConfigured' in settings.proxmox, false);
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
    await setBackupStorage('pbs', true);
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
    const runs = (await request('GET', `/api/containers/${container.id}/runs`)).json().items;
    assert.deepEqual(runs.slice(0, 2).map((r: { kind: string; status: string }) => [r.kind, r.status]), [
      ['app-update', 'succeeded'],
      ['apt-upgrade', 'succeeded'],
    ]);
    assert.equal((await request('GET', `/api/containers/${container.id}`)).json().isBusy, false);
  });

  it('updates only the containers chosen with ids', async () => {
    const container = await addContainerWithUpdates();
    shell.on(/apt-get -y/, { output: 'Setting up curl (8.1) ...\n' });
    shell.on(/\nupdate'$/, { output: 'Updated.\n' });
    shell.commands.length = 0;

    assert.equal((await request('POST', '/api/containers/update-all', { ids: ['x'] })).status, 400);
    assert.deepEqual((await request('POST', '/api/containers/update-all', { backup: false, ids: [] })).json(), {
      containers: 0,
      updates: 0,
    });
    assert.deepEqual((await request('POST', '/api/containers/update-all', { ids: [container.id + 1] })).json(), {
      containers: 0,
      updates: 0,
    });
    assert.equal(shell.commands.some((c) => c.includes('apt-get -y')), false);

    const response = await request('POST', '/api/containers/update-all', { backup: false, ids: [container.id] });
    assert.equal(response.status, 202);
    assert.deepEqual(response.json(), { containers: 1, updates: 2 });
    await app.updater.idle();
    assert.ok(shell.commands.some((c) => c.includes('apt-get -y')));
  });

  it('skips the remaining updates of a container after a failure and honours backup: false', async () => {
    const container = await addContainerWithUpdates();
    await setBackupStorage('pbs', true);
    shell.on(/apt-get -y/, { exitCode: 100, output: 'E: Could not get lock\n' });
    shell.commands.length = 0;

    assert.equal((await request('POST', '/api/containers/update-all', { backup: false })).status, 202);
    await app.updater.idle();

    assert.equal(shell.commands.some((c) => c.includes('vzdump')), false);
    assert.equal(shell.commands.some((c) => /\nupdate'$/.test(c)), false);
    const runs = (await request('GET', `/api/containers/${container.id}/runs`)).json().items;
    assert.equal(runs[0].kind, 'apt-upgrade');
    assert.equal(runs[0].status, 'failed');
  });

  it('updates all pending updates of one container: apt, then applications, one backup', async () => {
    const container = await addContainerWithUpdates();
    await setBackupStorage('pbs');
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
    // The live log comes from memory: the first read has everything, later reads only what is new.
    assert.equal(active.outputAppend, false);
    assert.equal(typeof active.outputCursor, 'string');
    const again = (await request('GET', `/api/runs/${activeRunId}?after=${encodeURIComponent(active.outputCursor)}`)).json();
    assert.deepEqual([again.outputAppend, again.output], [true, '']);
    const stale = (await request('GET', `/api/runs/${activeRunId}?after=unknown.0.0`)).json();
    assert.deepEqual([stale.outputAppend, stale.output], [false, active.output]);
    upgrade.resolve({ output: 'Setting up curl (8.1) ...\n' });
    await app.updater.idle();
    const done = (await request('GET', `/api/runs/${activeRunId}?after=${encodeURIComponent(active.outputCursor)}`)).json();
    assert.deepEqual([done.status, done.outputAppend, done.outputCursor], ['succeeded', false, null]);
    assert.match(done.output, /Setting up curl/);
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
    shell.on(/apt list --upgradable/, { output: `${PACKAGE_LIST_MARKER} apt\nListing...\n` });
    await app.scheduler.checkAll();
    shell.commands.length = 0;
    const response = await request('POST', '/api/containers/update-all');
    assert.equal(response.status, 200);
    assert.deepEqual(response.json(), { containers: 0, updates: 0 });
    assert.equal(shell.commands.length, 0);
  });

  it('flags a container that needs a restart and restarts it', async () => {
    shell.on(/reboot-required/, { output: 'file libc6\nstale nginx\nstale sshd\n' });
    const container = await addContainer();
    let dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.deepEqual(dto.restartReasons, ['Requested by package libc6', 'Processes use upgraded files: nginx, sshd']);
    // Not an error and not an update.
    assert.equal(dto.lastError, null);
    assert.equal(dto.updatesAvailable, 1);

    shell.on(/^pct reboot 101 /, { output: '' });
    shell.on(/reboot-required/, { output: '' });
    const response = await request('POST', `/api/containers/${container.id}/restart`);
    assert.equal(response.status, 202);
    assert.equal(response.json().kind, 'restart');
    const run = await app.containers.wait(container.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /CT 101 restarted/);
    // Detached, so it completes even when ReleaseWatcher runs in this container.
    assert.equal(shell.detached.at(-1)?.unit, `releasewatcher-run-${run?.id}-restart`);
    assert.match(shell.detached.at(-1)?.command ?? '', /^pct reboot 101 --timeout 120/);
    dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.deepEqual(dto.restartReasons, []);
    assert.equal(notifier.resultsSent.length, 0);

    // A stopped container has nothing to restart; its reasons are cleared by the next check.
    shell.on(/reboot-required/, { output: 'file\n' });
    await request('POST', `/api/containers/${container.id}/check`);
    await app.containers.wait(container.id);
    shell.on(/^pct status 101$/, { output: 'status: stopped\n' });
    await request('POST', `/api/containers/${container.id}/check`);
    await app.containers.wait(container.id);
    dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.deepEqual(dto.restartReasons, []);
    assert.equal((await request('POST', `/api/containers/${container.id}/restart`)).status, 409);
    assert.equal((await request('POST', '/api/containers/999/restart')).status, 404);
  });

  it('reads the operating system and keeps it when a later probe fails', async () => {
    shell.on(/debian_version/, {
      output: 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nNAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\nID=debian\nRW_DEBIAN_VERSION=12.8\n',
    });
    const container = await addContainer();
    let dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.os.label, 'Debian 12.8 (bookworm)');
    assert.equal(dto.os.versionId, '12');
    assert.equal(dto.os.pointVersion, '12.8');
    assert.equal(dto.lastError, null);

    shell.on(/debian_version/, { output: 'no os-release file\n', exitCode: 1 });
    await request('POST', `/api/containers/${container.id}/check`);
    const run = await app.containers.wait(container.id);
    assert.match(run?.output ?? '', /Could not read the operating system/);
    dto = (await request('GET', `/api/containers/${container.id}`)).json();
    assert.equal(dto.os.label, 'Debian 12.8 (bookworm)');
    assert.equal(dto.lastError, null);
  });

  it('schedules a restart of the Proxmox host only while nothing else runs', async () => {
    shell.on(/^hostname$/, { output: 'pve\n' });
    shell.on(/uname -r/, { output: 'kernel 6.8.12-4-pve 6.8.12-5-pve\n' });
    const node = (await request('POST', '/api/containers/node')).json();
    await app.containers.wait(node.id);
    const dto = (await request('GET', `/api/containers/${node.id}`)).json();
    assert.deepEqual(dto.restartReasons, ['Kernel 6.8.12-5-pve is installed, 6.8.12-4-pve is running']);

    // A check of another container is running → 409.
    const container = await addContainer();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    shell.on(/^pct status 101$/, async () => {
      await gate;
      return { output: 'status: running\n' };
    });
    await request('POST', `/api/containers/${container.id}/check`);
    assert.equal((await request('POST', `/api/containers/${node.id}/restart`)).status, 409);
    release();
    await app.containers.wait(container.id);

    shell.on(/^systemd-run .*systemctl reboot$/, { output: '' });
    shell.on(/^true$/, { output: '' });
    shell.commands.length = 0;
    assert.equal((await request('POST', `/api/containers/${node.id}/restart`)).status, 202);
    const run = await app.containers.wait(node.id);
    assert.equal(run?.status, 'succeeded', run?.output ?? '');
    assert.match(run?.output ?? '', /Restart scheduled/);
    // Then it waits until the host answers again and checks it.
    assert.match(run?.output ?? '', /The Proxmox host is back[\s\S]*Checking the Proxmox host again/);
    assert.deepEqual(shell.commands.slice(0, 2), [
      'systemd-run --quiet --unit=releasewatcher-host-restart --on-active=15 --timer-property=AccuracySec=1s systemctl reboot',
      'true',
    ]);
    assert.ok(shell.commands.length > 2); // + the check
  });

  it('refuses container actions until the node is configured', async () => {
    shell.isConfigured = false;
    assert.equal((await request('POST', '/api/containers', { vmid: 101 })).status, 409);
  });

});

describe('application detection API', () => {
  let app: App;
  let store: RepositoryStore;
  let shell: FakeShell;
  let baseUrl: URL;
  const scripts = new Map<string, string>();
  const fetchedSlugs: string[] = [];

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
    scripts.clear();
    fetchedSlugs.length = 0;
    shell = new FakeShell()
      .on(/^pct list /, { output: discovered() })
      .on(/^pct status 101$/, { output: 'status: running\n' })
      .on(/^pct status 102$/, { output: 'status: stopped\n' })
      .on(/apt list --upgradable/, { output: APT_OUTPUT });
    const source = new FakeSource();
    source.existing.add('dani-garcia/vaultwarden');
    store = new RepositoryStore(':memory:');
    const settings = new SettingsService(store, loadConfig({}));
    addProxmoxHost(store);
    app = await buildApp({
      store,
      settings,
      source,
      notifiers: [],
      log: silentLogger,
      shell,
      auth: { requireAuth: false },
      fetchAppScript: async (slug) => {
        fetchedSlugs.push(slug);
        return scripts.get(slug) ?? null;
      },
    });
    baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
  });

  afterEach(() => app.close());

  const addContainer = async (vmid: number) => {
    const container = (await request('POST', '/api/containers', { vmid })).json() as { id: number };
    await app.containers.wait(container.id);
    return container;
  };

  it('suggests a community-scripts application with its repository and marks watched repositories', async () => {
    shell.on(/\/usr\/bin\/update/, { output: 'update\tct/vaultwarden.sh\nfile\t/root/.vaultwarden\t1.34.3\n' });
    const container = await addContainer(101);

    let detected = await request('POST', `/api/containers/${container.id}/detect-apps`);
    assert.equal(detected.status, 200);
    assert.deepEqual(detected.json(), [
      {
        name: 'Vaultwarden',
        slug: 'vaultwarden',
        versionCommand: 'cat /root/.vaultwarden',
        installedVersion: '1.34.3',
        updateCommand: 'update',
        repository: 'dani-garcia/vaultwarden',
        repositoryId: null,
        alreadyAdded: false,
      },
    ]);
    assert.deepEqual(fetchedSlugs, [], 'known applications need no download');

    const repo = (await request('POST', '/api/repositories', { repository: 'dani-garcia/vaultwarden' })).json();
    detected = await request('POST', `/api/containers/${container.id}/detect-apps`);
    assert.equal(detected.json()[0].repositoryId, repo.id);
    assert.equal(detected.json()[0].alreadyAdded, false);

    await request('POST', `/api/containers/${container.id}/apps`, {
      name: 'Password manager',
      latestSource: 'github',
      repositoryId: repo.id,
    });
    detected = await request('POST', `/api/containers/${container.id}/detect-apps`);
    assert.equal(detected.json()[0].alreadyAdded, true, 'the same repository counts as added under another name');
  });

  it('reads the repository of an unknown application from its community-scripts script', async () => {
    shell.on(/\/usr\/bin\/update/, { output: 'update\tct/someapp.sh\nfile\t/root/.someapp\t2.1.0\n' });
    scripts.set('someapp', '# Source: https://github.com/acme/some-app\nAPP="SomeApp"\n');
    const container = await addContainer(101);

    const detected = (await request('POST', `/api/containers/${container.id}/detect-apps`)).json();
    assert.deepEqual(fetchedSlugs, ['someapp']);
    assert.equal(detected[0].name, 'SomeApp');
    assert.equal(detected[0].repository, 'acme/some-app');
    assert.equal(detected[0].versionCommand, 'cat /root/.someapp');
  });

  it('refuses stopped containers and the host, and reports node failures', async () => {
    const stopped = await addContainer(102);
    const response = await request('POST', `/api/containers/${stopped.id}/detect-apps`);
    assert.equal(response.status, 409);
    assert.match(response.json().title, /stopped – start it/);

    shell.on(/pveversion|hostname/, { output: 'pve\n' });
    const node = (await request('POST', '/api/containers/node')).json() as { id: number };
    await app.containers.wait(node.id);
    assert.equal((await request('POST', `/api/containers/${node.id}/detect-apps`)).status, 409);

    const running = await addContainer(101);
    shell.on(/\/usr\/bin\/update/, { exitCode: 1, output: 'boom' });
    const failed = await request('POST', `/api/containers/${running.id}/detect-apps`);
    assert.equal(failed.status, 502);
    assert.match(failed.json().detail, /boom/);

    assert.equal((await request('POST', '/api/containers/999/detect-apps')).status, 404);
  });
});
