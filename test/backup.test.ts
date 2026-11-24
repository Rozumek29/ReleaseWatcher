import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'bun:test';
import { buildApp, type App } from '../src/app.ts';
import { BACKUP_FORMAT, BACKUP_SCHEMA_VERSION, EXPORTABLE_SETTING_KEYS, type BackupFile, type ImportPreview } from '../src/backup/domain.ts';
import { loadConfig } from '../src/config.ts';
import { RepositoryStore, SECRET_SETTING_KEYS } from '../src/db.ts';
import { DockerStore } from '../src/docker/store.ts';
import { HostStore } from '../src/hosts/store.ts';
import { silentLogger } from '../src/log.ts';
import { ContainerStore } from '../src/proxmox/store.ts';
import { SettingsService } from '../src/settings.ts';
import { FakeKeyTool, FakeShell, FakeSource, RecordingNotifier, TEST_PRIVATE_KEY } from './helpers.ts';

const GITHUB_TOKEN = 'ghp_repositorySecretToken123';
const HEADER_SECRET = 'Bearer header-secret-value';
const HA_TOKEN = 'home-assistant-secret-token';
const WEBHOOK_URL = 'https://discord.com/api/webhooks/123/discord-secret';
const SMTP_PASSWORD = 'smtp-secret-password';

interface Instance {
  app: App;
  store: RepositoryStore;
  settings: SettingsService;
  hosts: HostStore;
  containers: ContainerStore;
  docker: DockerStore;
  shell: FakeShell;
  request: (method: string, path: string, payload?: unknown) => Promise<{ status: number; json: () => any; text: string; headers: Headers }>;
}

describe('backup', () => {
  const apps: App[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((a) => a.close()));
  });

  async function instance(): Promise<Instance> {
    const store = new RepositoryStore(':memory:');
    const settings = new SettingsService(store, loadConfig({}));
    const shell = new FakeShell();
    const app = await buildApp({
      store,
      settings,
      source: new FakeSource(),
      notifiers: [new RecordingNotifier()],
      log: silentLogger,
      shell,
      keyTool: new FakeKeyTool(),
      reconnectDelayMs: 0,
      auth: { requireAuth: false },
    });
    apps.push(app);
    const baseUrl = app.listen({ port: 0, hostname: '127.0.0.1' }).url;
    const request: Instance['request'] = async (method, path, payload) => {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        headers: payload === undefined ? {} : { 'content-type': 'application/json' },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await response.text();
      return { status: response.status, json: () => JSON.parse(text), text, headers: response.headers };
    };
    return {
      app,
      store,
      settings,
      hosts: new HostStore(store.database, store.secretBox),
      containers: new ContainerStore(store.database, store.secretBox),
      docker: new DockerStore(store.database),
      shell,
      request,
    };
  }

  /** An instance with something of every kind, secrets included. */
  async function configured(): Promise<Instance> {
    const i = await instance();
    i.settings.update({
      releaseCheckCron: '*/30 * * * *',
      notifyPackageUpdates: false,
      smtpHost: 'smtp.example.com',
      smtpUsername: 'alerts',
      smtpPassword: SMTP_PASSWORD,
      discordWebhookUrl: WEBHOOK_URL,
      discordUsername: 'Watcher',
    });

    const widget = i.store.add('acme', 'widget', true);
    Object.assign(widget, {
      icon: 'sh:frigate',
      accessToken: GITHUB_TOKEN,
      installedVersionUrl: 'https://widget.example.com/api/version',
      installedVersionField: 'version',
      installedVersionHeaders: [{ name: 'Authorization', value: HEADER_SECRET }],
      osvEcosystem: 'npm',
      osvPackage: 'widget',
      lastSeenTag: 'v1.2.0',
    });
    i.store.save(widget);
    const gadget = i.store.add('acme', 'gadget', false);
    gadget.installedVersion = '2.0.0';
    i.store.save(gadget);

    const keyId = i.hosts.addKey({ name: 'Homelab key', privateKey: TEST_PRIVATE_KEY, publicKey: null, fingerprint: null });
    const pve = i.hosts.addHost({ type: 'proxmox', name: 'pve', address: 'pve.lan', port: 22, user: 'root', sshKeyId: keyId, backupStorage: 'pbs' });
    const ct = i.containers.add(pve.id, 101, 'nginx');
    Object.assign(ct, { checkCron: '0 3 * * *', updateCores: 4, backupBeforeUpdate: true, status: 'running' });
    i.containers.save(ct);
    i.containers.addApp(ct.id, {
      name: 'Widget',
      versionCommand: 'widget --version',
      latestSource: 'repository',
      repositoryId: widget.id,
      latestCommand: null,
      updateCommand: 'widget-update',
      useTty: true,
      timeoutSeconds: 600,
    });
    const vm = i.containers.add(pve.id, 200, 'haos', 'vm');
    Object.assign(vm, { homeAssistantUrl: 'http://haos.lan:8123', homeAssistantToken: HA_TOKEN });
    i.containers.save(vm);
    i.containers.addNode(pve.id, 'pve');

    const vps = i.hosts.addHost({ type: 'server', name: 'VPS', address: 'vps.example.com', port: 2222, user: 'admin', sshKeyId: keyId, backupStorage: null });
    i.containers.addServer(vps.id, 'VPS');

    i.docker.addEndpoint('Synology', 'tcp://nas.lan:2375');
    return i;
  }

  const exportFrom = async (i: Instance): Promise<BackupFile> => {
    const response = await i.request('GET', '/api/backup/export');
    assert.equal(response.status, 200);
    return response.json();
  };

  const importInto = (i: Instance, backup: unknown, mode: 'merge' | 'replace', dryRun = false) =>
    i.request('POST', '/api/backup/import', { backup, mode, dryRun });

  const section = (preview: ImportPreview, key: string) => preview.sections.find((s) => s.key === key)!;

  it('exports the configuration without any secret', async () => {
    const i = await configured();
    const response = await i.request('GET', '/api/backup/export');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="releasewatcher-backup-\d{4}-\d{2}-\d{2}\.json"/);
    for (const secret of [GITHUB_TOKEN, HEADER_SECRET, HA_TOKEN, WEBHOOK_URL, SMTP_PASSWORD, 'not-a-real-key-only-for-tests']) {
      assert.equal(response.text.includes(secret), false, `export contains ${secret}`);
    }

    const file: BackupFile = response.json();
    assert.equal(file.format, BACKUP_FORMAT);
    assert.equal(file.schemaVersion, BACKUP_SCHEMA_VERSION);
    assert.ok(file.appVersion);
    assert.deepEqual(file.settings, {
      discordUsername: 'Watcher',
      releaseCheckCron: '*/30 * * * *',
      smtpHost: 'smtp.example.com',
      smtpUsername: 'alerts',
      notifyPackageUpdates: false,
    });
    const widget = file.repositories.find((r) => r.name === 'widget')!;
    assert.deepEqual(widget, {
      provider: 'github',
      host: null,
      owner: 'acme',
      name: 'widget',
      includePrereleases: true,
      isEnabled: true,
      icon: 'sh:frigate',
      installedVersionUrl: 'https://widget.example.com/api/version',
      installedVersionField: 'version',
      installedVersionHeaderNames: ['Authorization'],
      installedVersion: null,
      osvEcosystem: 'npm',
      osvPackage: 'widget',
      hasAccessToken: true,
    });
    assert.equal(file.repositories.find((r) => r.name === 'gadget')!.installedVersion, '2.0.0');

    const pve = file.hosts.find((h) => h.type === 'proxmox')!;
    assert.deepEqual([pve.name, pve.address, pve.sshKeyName, pve.backupStorage], ['pve', 'pve.lan', 'Homelab key', 'pbs']);
    assert.deepEqual(pve.targets.map((t) => [t.kind, t.vmid, t.name]), [['node', 0, 'pve'], ['lxc', 101, 'nginx'], ['vm', 200, 'haos']]);
    const nginx = pve.targets.find((t) => t.vmid === 101)!;
    assert.deepEqual([nginx.checkCron, nginx.updateCores, nginx.backupBeforeUpdate], ['0 3 * * *', 4, true]);
    assert.deepEqual(nginx.apps, [
      {
        name: 'Widget',
        versionCommand: 'widget --version',
        latestSource: 'repository',
        repository: 'acme/widget',
        latestCommand: null,
        updateCommand: 'widget-update',
        useTty: true,
        timeoutSeconds: 600,
        installedVersion: null,
        isInstalledVersionSource: false,
      },
    ]);
    const haos = pve.targets.find((t) => t.vmid === 200)!;
    assert.deepEqual([haos.homeAssistantUrl, haos.hasHomeAssistantToken], ['http://haos.lan:8123', true]);
    assert.deepEqual(file.hosts.find((h) => h.type === 'server')!.targets.map((t) => t.kind), ['server']);
    assert.deepEqual(file.dockerEndpoints, [{ name: 'Synology', url: 'tcp://nas.lan:2375', isEnabled: true }]);

    assert.deepEqual(file.secretsOmitted, [
      'Discord webhook URL',
      'SMTP password',
      'GitHub token of acme/widget',
      'Version URL headers of acme/widget (Authorization)',
      'SSH private key "Homelab key"',
      'Home Assistant token of haos',
    ]);
  });

  it('never exports secret settings', () => {
    for (const key of EXPORTABLE_SETTING_KEYS) {
      assert.equal(SECRET_SETTING_KEYS.has(key), false, key);
      assert.equal(key.startsWith('oidc'), false, key);
    }
  });

  it('previews an import without writing anything', async () => {
    const file = await exportFrom(await configured());
    const target = await instance();

    const response = await importInto(target, file, 'merge', true);
    assert.equal(response.status, 200);
    const { applied, preview } = response.json() as { applied: boolean; preview: ImportPreview };
    assert.equal(applied, false);
    assert.deepEqual(section(preview, 'repositories').added.sort(), ['acme/gadget', 'acme/widget']);
    assert.deepEqual(section(preview, 'machines').added.sort(), ['VPS', 'pve']);
    assert.deepEqual(section(preview, 'dockerEndpoints').added, ['Synology']);
    assert.equal(section(preview, 'settings').added.length, 5);
    assert.deepEqual(preview.secretsToReenter, [
      'Discord webhook URL',
      'SMTP password',
      'GitHub token of acme/widget',
      'Version URL headers of acme/widget (Authorization)',
      'SSH key "Homelab key" for pve (add the key and choose it for the machine)',
      'Home Assistant token of haos',
      'SSH key "Homelab key" for VPS (add the key and choose it for the machine)',
    ]);

    assert.equal(target.store.list().length, 0);
    assert.equal(target.hosts.listHosts().length, 0);
    assert.equal(target.docker.listEndpoints().length, 0);
    assert.notEqual(target.settings.sourceOf('releaseCheckCron'), 'ui');
  });

  it('restores an export into an empty instance', async () => {
    const source = await configured();
    const file = await exportFrom(source);
    const target = await instance();
    // A key with the same name is reused by the imported machines.
    const keyId = target.hosts.addKey({ name: 'Homelab key', privateKey: TEST_PRIVATE_KEY, publicKey: null, fingerprint: null });

    const response = await importInto(target, file, 'merge');
    assert.equal(response.status, 200);
    assert.equal(response.json().applied, true);

    // Everything but the secrets (and the state) is back.
    const again = await exportFrom(target);
    const strip = (f: BackupFile) => ({
      ...f,
      exportedAt: null,
      secretsOmitted: null,
      repositories: f.repositories.map((r) => ({ ...r, hasAccessToken: null, installedVersionHeaderNames: null })),
      hosts: f.hosts.map((h) => ({ ...h, targets: h.targets.map((t) => ({ ...t, hasHomeAssistantToken: null })) })),
    });
    assert.deepEqual(strip(again), strip(file));
    assert.equal(target.settings.current.smtpPassword, null);
    assert.equal(target.settings.current.releaseCheckCron, '*/30 * * * *');
    assert.ok(target.hosts.listHosts().every((h) => h.sshKeyId === keyId));
    // The application is linked to the imported repository.
    const widget = target.store.list().find((r) => r.name === 'widget')!;
    assert.equal(target.containers.listApps()[0]!.repositoryId, widget.id);
    assert.equal(widget.accessToken, null);
    assert.deepEqual(widget.installedVersionHeaders, []);
    // Importing the same file again changes nothing.
    const preview: ImportPreview = (await importInto(target, file, 'merge', true)).json().preview;
    for (const s of preview.sections) {
      assert.deepEqual([s.key, s.added, s.updated, s.removed], [s.key, [], [], []]);
    }
  });

  it('restores repositories of Gitea/Forgejo and GitLab instances', async () => {
    const source = await instance();
    source.store.add('forgejo', 'forgejo', false, { provider: 'gitea', host: 'codeberg.org' });
    source.store.add('group/sub', 'project', true, { provider: 'gitlab', host: 'gitlab.com' });
    source.store.add('forgejo', 'forgejo', false);
    const file = await exportFrom(source);
    assert.deepEqual(
      file.repositories.map((r) => [r.provider, r.host, r.owner, r.name]).toSorted(),
      [
        ['gitea', 'codeberg.org', 'forgejo', 'forgejo'],
        ['github', null, 'forgejo', 'forgejo'],
        ['gitlab', 'gitlab.com', 'group/sub', 'project'],
      ],
    );

    const target = await instance();
    assert.equal((await importInto(target, file, 'merge')).status, 200);
    assert.deepEqual(
      target.store.list().map((r) => [r.provider, r.host, r.owner, r.name]).toSorted(),
      file.repositories.map((r) => [r.provider, r.host, r.owner, r.name]).toSorted(),
    );

    // A file of an older version (no provider) means GitHub; a repository of a host needs a valid host.
    const invalid = await importInto(
      await instance(),
      { ...file, repositories: [{ ...file.repositories[0]!, provider: 'gitea', host: 'not a host' }] },
      'merge',
    );
    assert.equal(invalid.status, 400);
  });

  it('keeps the app a repository reads its installed version from', async () => {
    const source = await configured();
    const gadget = source.store.list().find((r) => r.name === 'gadget')!;
    const ct = source.containers.list().find((c) => c.vmid === 101)!;
    const app = source.containers.addApp(ct.id, {
      name: 'Gadget',
      versionCommand: 'gadget --version',
      latestSource: 'repository',
      repositoryId: gadget.id,
      latestCommand: null,
      updateCommand: null,
      useTty: false,
      timeoutSeconds: 600,
    });
    source.store.setInstalledVersionApp(gadget.id, { kind: 'app', id: app.id });
    const file = await exportFrom(source);
    const apps = file.hosts.find((h) => h.type === 'proxmox')!.targets.find((t) => t.vmid === 101)!.apps;
    assert.deepEqual(apps.map((a) => [a.name, a.isInstalledVersionSource]), [['Gadget', true], ['Widget', false]]);
    // The last version stays in the file as entered by hand, for instances without the app.
    assert.equal(file.repositories.find((r) => r.name === 'gadget')!.installedVersion, '2.0.0');

    const target = await instance();
    assert.equal((await importInto(target, file, 'merge')).status, 200);
    const restored = () => target.store.list().find((r) => r.name === 'gadget')!;
    const restoredApp = target.containers.listApps().find((a) => a.name === 'Gadget')!;
    assert.deepEqual(restored().installedVersionApp, { kind: 'app', id: restoredApp.id });
    assert.equal(restored().installedVersion, '2.0.0');

    // A file without the flag (or of an older version) stops reading the version from the app.
    for (const t of file.hosts.flatMap((h) => h.targets)) {
      for (const a of t.apps) delete (a as Partial<typeof a>).isInstalledVersionSource;
    }
    const preview: ImportPreview = (await importInto(target, file, 'merge', true)).json().preview;
    assert.equal(section(preview, 'machines').updated.length, 1);
    assert.equal((await importInto(target, file, 'merge')).status, 200);
    assert.equal(restored().installedVersionApp, null);
    assert.equal(restored().installedVersion, '2.0.0');
  });

  it('merges into an existing configuration and keeps its secrets', async () => {
    const file = await exportFrom(await configured());
    const target = await configured();
    // Local changes: a token for gadget, other settings of widget, an extra repository and app.
    const gadget = target.store.list().find((r) => r.name === 'gadget')!;
    gadget.accessToken = 'local-token';
    target.store.save(gadget);
    const widget = target.store.list().find((r) => r.name === 'widget')!;
    widget.includePrereleases = false;
    widget.icon = null;
    target.store.save(widget);
    target.store.add('other', 'tool', false);
    const ct = target.containers.list().find((c) => c.vmid === 101)!;
    target.containers.addApp(ct.id, {
      name: 'Local app',
      versionCommand: null,
      latestSource: 'none',
      repositoryId: null,
      latestCommand: null,
      updateCommand: null,
      useTty: false,
      timeoutSeconds: 60,
    });

    const preview: ImportPreview = (await importInto(target, file, 'merge')).json().preview;
    assert.deepEqual(section(preview, 'repositories').updated, ['acme/widget']);
    assert.deepEqual(section(preview, 'repositories').removed, []);
    assert.deepEqual(preview.secretsToReenter, []);

    const repos = target.store.list();
    assert.deepEqual(repos.map((r) => `${r.owner}/${r.name}`).sort(), ['acme/gadget', 'acme/widget', 'other/tool']);
    const updated = repos.find((r) => r.name === 'widget')!;
    assert.deepEqual([updated.includePrereleases, updated.icon, updated.accessToken], [true, 'sh:frigate', GITHUB_TOKEN]);
    assert.deepEqual(updated.installedVersionHeaders, [{ name: 'Authorization', value: HEADER_SECRET }]);
    assert.equal(repos.find((r) => r.name === 'gadget')!.accessToken, 'local-token');
    assert.equal(target.containers.list().find((c) => c.vmid === 200)!.homeAssistantToken, HA_TOKEN);
    assert.deepEqual(target.containers.listApps(ct.id).map((a) => a.name), ['Local app', 'Widget']);
    assert.equal(target.settings.current.smtpPassword, SMTP_PASSWORD);
  });

  it('replaces the configuration: removes what the file does not have', async () => {
    const source = await instance();
    source.store.add('acme', 'widget', false);
    source.settings.update({ releaseCheckCron: '0 * * * *' });
    const file = await exportFrom(source);

    const target = await configured();
    target.settings.update({ advisoryCheckCron: '0 5 * * *' });
    const response = await importInto(target, file, 'replace');
    assert.equal(response.status, 200);
    const preview: ImportPreview = response.json().preview;
    assert.deepEqual(section(preview, 'repositories').removed, ['acme/gadget']);
    assert.deepEqual(section(preview, 'repositories').updated, ['acme/widget']);
    assert.deepEqual(section(preview, 'machines').removed.sort(), ['VPS', 'pve']);
    assert.deepEqual(section(preview, 'dockerEndpoints').removed, ['Synology']);
    assert.ok(section(preview, 'settings').removed.includes('Advisory check cron'));

    assert.deepEqual(target.store.list().map((r) => r.name), ['widget']);
    // Secrets of kept repositories survive a replace.
    assert.equal(target.store.list()[0]!.accessToken, GITHUB_TOKEN);
    assert.equal(target.hosts.listHosts().length, 0);
    assert.equal(target.containers.list().length, 0);
    assert.equal(target.docker.listEndpoints().length, 0);
    assert.equal(target.settings.current.releaseCheckCron, '0 * * * *');
    assert.notEqual(target.settings.sourceOf('advisoryCheckCron'), 'ui');
    assert.notEqual(target.settings.sourceOf('smtpHost'), 'ui');
    // Secret settings are not part of a backup, so they stay.
    assert.equal(target.settings.current.smtpPassword, SMTP_PASSWORD);
  });

  it('rejects invalid values and writes nothing', async () => {
    const target = await instance();
    const file = {
      format: BACKUP_FORMAT,
      schemaVersion: 1,
      settings: { releaseCheckCron: 'every day' },
      repositories: [
        { owner: 'acme', name: 'widget' },
        { owner: 'acme', name: 'gadget', icon: 'not an icon' },
      ],
      hosts: [{ type: 'proxmox', name: 'pve', address: 'pve.lan', targets: [{ kind: 'server', vmid: 0, name: 'x' }] }],
      dockerEndpoints: [{ name: 'Bad', url: 'ftp://nas' }],
    };
    const response = await importInto(target, file, 'merge');
    assert.equal(response.status, 400);
    const errors = response.json().errors as Record<string, string[]>;
    assert.deepEqual(Object.keys(errors).sort(), [
      'dockerEndpoints[0].url',
      'hosts[0].targets[0].kind',
      'repositories[1].icon',
      'settings.releaseCheckCron',
    ]);
    assert.equal(target.store.list().length, 0);
    assert.equal(target.hosts.listHosts().length, 0);
  });

  it('rejects files that are not backups or are too new', async () => {
    const target = await instance();
    assert.equal((await importInto(target, { format: 'something-else', schemaVersion: 1 }, 'merge')).status, 400);
    const newer = await importInto(target, { format: BACKUP_FORMAT, schemaVersion: BACKUP_SCHEMA_VERSION + 1 }, 'merge');
    assert.equal(newer.status, 400);
    assert.match(JSON.stringify(newer.json().errors), /Update ReleaseWatcher first/);
    assert.equal((await target.request('POST', '/api/backup/import', { backup: {}, mode: 'merge' })).status, 400);
    assert.equal((await target.request('POST', '/api/backup/import', { backup: { format: BACKUP_FORMAT, schemaVersion: 1 }, mode: 'all' })).status, 400);
  });

  it('skips secrets and unknown settings in a hand-edited file and unlinks unknown repositories', async () => {
    const target = await instance();
    const file = {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      settings: { githubToken: 'ghp_x', unknownSetting: 'x', notifyReleases: false },
      hosts: [
        {
          type: 'proxmox',
          name: 'pve',
          address: 'pve.lan',
          targets: [{ kind: 'lxc', vmid: 101, name: 'app', apps: [{ name: 'Tool', latestSource: 'repository', repository: 'nobody/tool' }] }],
        },
      ],
    };
    const response = await importInto(target, file, 'merge');
    assert.equal(response.status, 200);
    const preview: ImportPreview = response.json().preview;
    assert.equal(preview.warnings.length, 2);
    assert.equal(target.settings.current.githubToken, null);
    assert.equal(target.settings.current.notifyReleases, false);
    assert.deepEqual(target.containers.listApps().map((a) => [a.name, a.latestSource, a.repositoryId]), [['Tool', 'none', null]]);
  });

  it('reads the names of format version 1', async () => {
    const target = await instance();
    const file = {
      format: BACKUP_FORMAT,
      schemaVersion: 1,
      settings: { notifyAptUpdates: false },
      repositories: [{ owner: 'acme', name: 'tool', hasGithubToken: true }],
      hosts: [
        {
          type: 'proxmox',
          name: 'pve',
          address: 'pve.lan',
          targets: [{ kind: 'lxc', vmid: 101, name: 'app', aptEnabled: false, apps: [{ name: 'Tool', latestSource: 'github', repository: 'acme/tool' }] }],
        },
      ],
    };
    const response = await importInto(target, file, 'merge');
    assert.equal(response.status, 200);
    assert.ok(response.json().preview.secretsToReenter.some((s: string) => s.includes('acme/tool')));
    assert.equal(target.settings.current.notifyPackageUpdates, false);
    assert.equal(target.containers.list()[0]!.packagesEnabled, false);
    const tool = target.store.list().find((r) => r.name === 'tool')!;
    assert.deepEqual(target.containers.listApps().map((a) => [a.latestSource, a.repositoryId]), [['repository', tool.id]]);
  });

  it('refuses to replace while a task runs on a machine that would be removed', async () => {
    const source = await instance();
    const file = await exportFrom(source);
    const target = await configured();
    const ct = target.containers.list().find((c) => c.vmid === 101)!;
    let release!: () => void;
    target.shell.on(/apt|pct|lxc/, () => new Promise((resolve) => (release = () => resolve({ output: '', exitCode: 0 }))));
    target.app.containers.startCheck(ct, 'manual');
    const response = await importInto(target, file, 'replace');
    assert.equal(response.status, 409);
    assert.equal(target.hosts.listHosts().length, 2);
    release?.();
    await target.app.containers.wait(ct.id);
  });
});
