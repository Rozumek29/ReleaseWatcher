import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Container, Run } from '../../core/models';
import { settle } from '../../testing';
import { ContainersPage } from './containers.page';
import { dockerContainer, dockerOverview } from '../docker/fixtures';
import { container, homeAssistant, proxmoxSettings } from './fixtures';

const run = (overrides: Partial<Run> = {}): Run => ({
  id: 9,
  containerId: 1,
  appId: null,
  kind: 'check',
  trigger: 'manual',
  status: 'succeeded',
  startedAt: '2026-01-01T00:00:00Z',
  finishedAt: '2026-01-01T00:00:05Z',
  exitCode: 0,
  output: '» Checking CT 101\n',
  ...overrides,
});

describe('ContainersPage', () => {
  let http: HttpTestingController;

  const create = async (containers: Container[], configured = true) => {
    await TestBed.configureTestingModule({
      imports: [ContainersPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ContainersPage);
    fixture.detectChanges();
    http.expectOne('/api/containers').flush(containers);
    http.expectOne('/api/settings').flush(proxmoxSettings(configured));
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  afterEach(() => http.verify());

  /** Picks a container in the list, which shows it in the detail pane. */
  const select = async (fixture: Parameters<typeof settle>[0], el: HTMLElement, name: string) => {
    [...el.querySelectorAll<HTMLButtonElement>('.ct-item')].find((b) => b.textContent?.includes(name))!.click();
    await settle(fixture);
  };

  it('lists containers with pending apt packages and application updates', async () => {
    const { fixture, el } = await create([container()]);

    expect(el.querySelector('.name')?.textContent).toContain('vaultwarden');
    expect(el.textContent).toContain('2 update(s)');
    expect(el.textContent).toContain('2 upgradable package(s)');
    expect(el.querySelector('.versions')?.textContent).toContain('1.30.0');
    expect(el.querySelector('.versions')?.textContent).toContain('1.32.0');
    expect(el.textContent).toContain('Update available');
    expect(el.querySelector('.callout')).toBeNull();

    // The package list is collapsed until requested.
    expect(el.querySelector('app-apt-packages')).toBeNull();
    [...el.querySelectorAll<HTMLButtonElement>('.link-btn')].find((b) => b.textContent?.includes('upgradable'))!.click();
    await settle(fixture);
    expect(el.querySelector('app-apt-packages')?.textContent).toContain('libssl3');
  });

  it('names the package manager of a machine and its upgrade command', async () => {
    const { fixture, el } = await create([container({ kind: 'server', packageManager: 'apk', capabilities: { ...container().capabilities, backup: null } })]);
    expect(el.querySelector('.item-name')?.textContent).toContain('apk');

    [...el.querySelectorAll<HTMLButtonElement>('.item button')].find((b) => b.textContent?.trim() === 'Upgrade')!.click();
    await settle(fixture);
    expect(el.textContent).toContain('apk upgrade, no backup');
  });

  it('calls the packages of a machine not checked yet "System packages"', async () => {
    const { el } = await create([container({ packageManager: null, aptUpgradable: [], lastCheckedAt: null })]);
    expect(el.querySelector('.item-name')?.textContent).toContain('System packages');
  });

  it('shows the Docker containers found on a machine', async () => {
    const { fixture, el } = await create([container({ docker: { enabled: true, engine: 'docker 27.3.1', error: null } })]);
    http.expectOne('/api/docker').flush(dockerOverview({ containers: [dockerContainer({ source: { kind: 'target', id: 1, name: 'vaultwarden' } })] }));
    await settle(fixture);
    const block = el.querySelector('.docker-block')!;
    expect(block.textContent).toContain('docker 27.3.1');
    expect(block.querySelector('.row .name')?.textContent).toContain('searxng');
    expect(block.textContent).toContain('New image');
  });

  it('shows the custom icon of the linked repository next to an application', async () => {
    const base = container();
    const iconUrls = ['https://cdn.jsdelivr.net/gh/selfhst/icons/svg/vaultwarden.svg'];
    const { el } = await create([container({ apps: base.apps.map((a) => ({ ...a, iconUrls })) })]);
    expect(el.querySelector('.item-name app-avatar img')?.getAttribute('src')).toBe(iconUrls[0]);
  });

  it('keeps the generic icon for an application without a custom icon', async () => {
    const { el } = await create([container()]);
    expect(el.querySelector('.item-name app-avatar')).toBeNull();
    expect(el.querySelector('.item-name app-icon')).not.toBeNull();
  });

  it('shows Home Assistant updates and installs an app update after a confirmation', async () => {
    const vm = container({
      kind: 'vm',
      vmid: 111,
      name: 'ha',
      aptEnabled: false,
      aptUpgradable: [],
      apps: [],
      homeAssistant: homeAssistant(),
      updatesAvailable: 2,
    });
    const { fixture, el } = await create([vm]);

    expect(el.textContent).toContain('Home Assistant');
    expect(el.textContent).toContain('Core 2026.11.2 · OS 18.4');
    expect(el.textContent).toContain('integrations as of');
    expect(el.textContent).toContain('Mosquitto broker');
    expect(el.textContent).toContain('Integration (marketplace)');
    // No application hint for Home Assistant OS.
    expect(el.textContent).not.toContain('No applications configured');
    // The integration waits for a token: no Update button on its row, a hint with a link to the settings instead.
    const rows = [...el.querySelectorAll<HTMLElement>('.item')];
    const dahua = rows.find((r) => r.textContent?.includes('Dahua'))!;
    expect([...dahua.querySelectorAll('button')].some((b) => b.textContent?.includes('Update'))).toBe(false);
    expect(el.textContent).toContain('Integration updates can be installed after you add an access token.');
    // An update Home Assistant cannot install explains why, even without a token.
    expect(el.textContent).toContain('Home Assistant only announces this update');
    expect(el.textContent).not.toContain('Add a Home Assistant access token in the settings');
    // Only one installable update: no "Update all" for Home Assistant.
    expect(el.querySelector('.ha-item .item-actions')).toBeNull();

    const mosquitto = rows.find((r) => r.textContent?.includes('Mosquitto broker') && !r.classList.contains('ha-item'))!;
    [...mosquitto.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Update'))!.click();
    await settle(fixture);
    http.expectNone('/api/containers/1/home-assistant-update');
    expect(el.textContent).toContain('Update Mosquitto broker?');
    el.querySelector<HTMLInputElement>('.backup-check input')!.click();

    [...el.querySelectorAll<HTMLButtonElement>('.item button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
    const request = http.expectOne('/api/containers/1/home-assistant-update');
    expect(request.request.body).toEqual({ backup: false, ids: ['app:core_mosquitto'] });
    request.flush(run({ kind: 'home-assistant-update', status: 'running', finishedAt: null, exitCode: null }), {
      status: 202,
      statusText: 'Accepted',
    });
    await settle(fixture);
    http.expectOne('/api/runs/9').flush(run({ kind: 'home-assistant-update', output: '» Updating Mosquitto broker\n' }));
    await settle(fixture);
    expect(el.querySelector('.run-status')?.textContent).toContain('Succeeded');
    http.expectOne('/api/containers').flush([vm]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    http.expectOne('/api/status').flush({});
    await settle(fixture);
  });

  it('only reports Home Assistant updates when installing from ReleaseWatcher is switched off', async () => {
    const blocked = 'Installing from ReleaseWatcher is switched off for this virtual machine – install it in Home Assistant.';
    const ha = homeAssistant({ installEnabled: false, url: 'http://ha:8123' });
    ha.updates = ha.updates.map((u) => ({ ...u, installBlocker: blocked }));
    const { el } = await create([
      container({ kind: 'vm', vmid: 111, name: 'ha', aptEnabled: false, aptUpgradable: [], apps: [], homeAssistant: ha }),
    ]);
    expect(el.textContent).toContain('Mosquitto broker');
    expect(el.textContent).toContain('install in Home Assistant');
    expect(el.querySelector<HTMLAnchorElement>('.ha-item a')?.href).toBe('http://ha:8123/config/updates');
    // No update buttons and no per-row or token hints.
    const haRows = [...el.querySelectorAll<HTMLElement>('.item')].filter((r) => /Mosquitto|Dahua|Frigate/.test(r.textContent ?? ''));
    expect(haRows.some((r) => [...r.querySelectorAll('button')].some((b) => b.textContent?.includes('Update')))).toBe(false);
    expect(el.textContent).not.toContain('switched off for this virtual machine');
    expect(el.textContent).not.toContain('after you add an access token');
  });

  it('offers "Update all" for several installable Home Assistant updates and shows live reads', async () => {
    const ha = homeAssistant({ hasToken: true, url: 'http://ha:8123', tokenMasked: 'eyJh…abcd', entitiesSavedAt: null });
    ha.updates = ha.updates.filter((u) => u.installable).map((u) => ({ ...u, installBlocker: null }));
    const { fixture, el } = await create([
      container({ kind: 'vm', vmid: 111, name: 'ha', aptEnabled: false, aptUpgradable: [], apps: [], homeAssistant: ha }),
    ]);
    expect(el.textContent).toContain('integrations read live through the API');
    [...el.querySelectorAll<HTMLButtonElement>('.ha-item button')].find((b) => b.textContent?.includes('Update all'))!.click();
    await settle(fixture);
    expect(el.textContent).toContain('Install 2 Home Assistant update(s)?');
    [...el.querySelectorAll<HTMLButtonElement>('.ha-item button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
    const request = http.expectOne('/api/containers/1/home-assistant-update');
    expect(request.request.body).toEqual({ backup: true });
    request.flush({ message: 'busy' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
  });

  it('groups the list by host when there are several', async () => {
    const { el } = await create([
      container({ id: 1, vmid: 101, name: 'vaultwarden', hostId: 2, hostName: 'pve2', apps: [] }),
      container({ id: 2, vmid: 100, name: 'nextcloud', hostId: 1, hostName: 'pve1', apps: [] }),
      container({ id: 3, kind: 'node', vmid: 0, name: 'pve1', hostId: 1, hostName: 'pve1', apps: [] }),
      container({ id: 4, kind: 'server', vmid: 0, name: 'Hetzner VPS', hostId: 3, hostName: 'Hetzner VPS', apps: [] }),
    ]);
    const headings = [...el.querySelectorAll('.ct-group')].map((g) =>
      [...g.querySelectorAll('span')].map((s) => s.textContent?.trim()).join(' '),
    );
    expect(headings).toEqual(['pve1 Proxmox node 2', 'pve2 Proxmox node 1', 'Servers 1']);
    const names = [...el.querySelectorAll('.ct-item .ct-name')].map((n) => n.textContent);
    expect(names).toEqual(['pve1', 'nextcloud', 'vaultwarden', 'Hetzner VPS']);
  });

  it('keeps a flat list for a single node', async () => {
    const { el } = await create([container({ id: 1 }), container({ id: 2, vmid: 102, name: 'jellyfin' })]);
    expect(el.querySelector('.ct-group')).toBeNull();
    expect(el.querySelector('h1')?.textContent).toBe('Machines');
  });

  it('shows the operating system read by the last check', async () => {
    const os = {
      id: 'debian',
      name: 'Debian GNU/Linux',
      versionId: '12',
      pointVersion: '12.8',
      codename: 'bookworm',
      prettyName: 'Debian GNU/Linux 12 (bookworm)',
      proxmoxVersion: null,
      label: 'Debian 12.8 (bookworm)',
    };
    const { el } = await create([container({ id: 1, os })]);
    const meta = [...el.querySelectorAll<HTMLElement>('.detail .meta-item')].find((m) => m.textContent?.includes('Debian'));
    expect(meta?.textContent?.trim()).toBe('Debian 12.8 (bookworm)');
    expect(meta?.title).toBe('Debian GNU/Linux 12 (bookworm)');
  });

  it('works with servers only – without a Proxmox node', async () => {
    const server = container({
      id: 7,
      kind: 'server',
      vmid: 0,
      name: 'Hetzner VPS',
      hostId: 3,
      hostName: 'Hetzner VPS',
      apps: [],
      restartReasons: ['Kernel 6.12.57 is installed, 6.12.48 is running'],
    });
    const { fixture, el } = await create([server], false);
    expect(el.querySelector('.callout')).toBeNull();
    expect(el.querySelector('.ct-item')?.textContent).toContain('Server');
    expect(el.querySelector('.ct-item')?.textContent).toContain('Hetzner VPS');
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')];
    expect(buttons.find((b) => b.textContent?.includes('Check all'))!.disabled).toBe(false);
    expect(buttons.find((b) => b.textContent?.includes('Add container'))!.disabled).toBe(true);

    await select(fixture, el, 'Hetzner VPS');
    expect(el.querySelector('.title-line')?.textContent).toContain('Server');
    const restart = [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Restart server'))!;
    expect(restart.disabled).toBe(false);

    buttons.find((b) => b.textContent?.includes('Add server'))!.click();
    await settle(fixture);
    http.expectOne('/api/ssh-keys').flush([]);
    await settle(fixture);
    expect(el.querySelector('app-host-dialog h2')?.textContent).toContain('Add server');
    expect(el.querySelector('app-host-dialog [role=radiogroup]')).toBeNull();
  });

  it('disables the actions of a target whose host has no SSH key', async () => {
    const { fixture, el } = await create([container({ configured: false })]);
    await select(fixture, el, 'vaultwarden');
    const check = [...el.querySelectorAll<HTMLButtonElement>('.row-head button, .actions button')].find(
      (b) => b.textContent?.trim() === 'Check',
    );
    expect(check?.disabled).toBe(true);
    const all = [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')];
    expect(all.find((b) => b.textContent?.includes('Check all'))!.disabled).toBe(true);
  });

  it('shows a hint linking to Settings when the node is not configured', async () => {
    const { el } = await create([], false);
    expect(el.querySelector('.callout')?.textContent).toContain('No Proxmox node is configured');
    expect(el.querySelector('.callout a')?.getAttribute('href')).toBe('/settings?tab=connections');
  });

  it('asks before upgrading apt packages and opens the run log', async () => {
    const { fixture, el } = await create([container()]);
    // The package list stays expanded while upgrading.
    [...el.querySelectorAll<HTMLButtonElement>('.link-btn')].find((b) => b.textContent?.includes('upgradable'))!.click();
    await settle(fixture);
    expect(el.querySelector('app-apt-packages')).not.toBeNull();

    const upgrade = [...el.querySelectorAll<HTMLButtonElement>('.item button')].find((b) =>
      b.textContent?.trim() === 'Upgrade',
    )!;
    upgrade.click();
    await settle(fixture);
    http.expectNone('/api/containers/1/apt-upgrade');
    expect(el.textContent).toContain('Upgrade 2 package(s)?');
    // "Backup first" starts with the container's default and can be changed for this update.
    const backup = el.querySelector<HTMLInputElement>('.backup-check input')!;
    expect(backup.checked).toBe(true);
    expect(el.querySelector('.backup-check')?.textContent).toContain('→ pbs');
    backup.click();

    [...el.querySelectorAll<HTMLButtonElement>('.item button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
    const request = http.expectOne('/api/containers/1/apt-upgrade');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ backup: false });
    request.flush(run({ kind: 'apt-upgrade', status: 'running', finishedAt: null, exitCode: null }), {
      status: 202,
      statusText: 'Accepted',
    });
    await settle(fixture);

    // The log dialog fetches the run; a finished run reloads the page data.
    http.expectOne('/api/runs/9').flush(run({ kind: 'apt-upgrade', output: 'Setting up curl (8.1) ...\n' }));
    await settle(fixture);
    expect(el.querySelector('.output')?.textContent).toContain('Setting up curl');
    expect(el.querySelector('.run-status')?.textContent).toContain('Succeeded');

    http.expectOne('/api/containers').flush([container({ aptUpgradable: [], updatesAvailable: 1 })]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    http.expectOne('/api/status').flush({});
    await settle(fixture);
    expect(el.textContent).toContain('no pending packages');
    // No empty package list (with its "No packages match" message) is left behind.
    expect(el.querySelector('app-apt-packages')).toBeNull();
    expect(el.textContent).not.toContain('No packages match');
  });

  it('shows why a restart is needed and restarts the container after a confirmation', async () => {
    const reasons = ['Requested by package libc6', 'Processes use upgraded files: nginx'];
    const { fixture, el } = await create([
      container({ aptUpgradable: [], apps: [], updatesAvailable: 0, restartReasons: reasons }),
    ]);

    expect(el.querySelector('.ct-state.warning')).not.toBeNull();
    expect(el.textContent).toContain('Restart needed');
    expect(el.textContent).not.toContain('Up to date');
    expect(el.querySelector('.restart-line')?.textContent).toContain('libc6');
    expect(el.querySelector('.restart-line')?.textContent).toContain('nginx');

    const restartButton = () =>
      [...el.querySelectorAll<HTMLButtonElement>('.restart-line button')].find((b) =>
        b.textContent?.includes('Restart'),
      )!;
    restartButton().click();
    await settle(fixture);
    http.expectNone('/api/containers/1/restart');
    expect(el.querySelector('.restart-line')?.textContent).toContain('Restart CT 101?');

    [...el.querySelectorAll<HTMLButtonElement>('.restart-line button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
    const request = http.expectOne('/api/containers/1/restart');
    expect(request.request.method).toBe('POST');
    request.flush(run({ kind: 'restart', status: 'running', finishedAt: null, exitCode: null }), {
      status: 202,
      statusText: 'Accepted',
    });
    await settle(fixture);
    http.expectOne('/api/runs/9').flush(run({ kind: 'restart', output: '» CT 101 restarted\n' }));
    await settle(fixture);
    expect(el.querySelector('.run-status')?.textContent).toContain('Succeeded');

    http.expectOne('/api/containers').flush([container({ aptUpgradable: [], apps: [], updatesAvailable: 0 })]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    http.expectOne('/api/status').flush({});
    await settle(fixture);
    expect(el.querySelector('.restart-line')).toBeNull();
    expect(el.textContent).toContain('Up to date');
  });

  it('warns that restarting the Proxmox host stops its guests and hides restarts of stopped containers', async () => {
    const { fixture, el } = await create([
      container({ id: 2, kind: 'node', vmid: 0, name: 'pve', apps: [], aptUpgradable: [], updatesAvailable: 0, restartReasons: ['Kernel 6.8.12-5-pve is installed, 6.8.12-4-pve is running'] }),
      container({ id: 3, vmid: 103, name: 'idle', status: 'stopped', restartReasons: ['Requested by an upgraded package'] }),
    ]);
    await select(fixture, el, 'pve');
    const button = [...el.querySelectorAll<HTMLButtonElement>('.restart-line button')].find((b) =>
      b.textContent?.includes('Restart host'),
    )!;
    button.click();
    await settle(fixture);
    expect(el.querySelector('.restart-line')?.textContent).toContain('All its guests stop');

    await select(fixture, el, 'idle');
    expect(el.querySelector('.restart-line')).toBeNull();
  });

  it('updates the containers ticked after the first click on "Update", leaving out the host', async () => {
    const node = container({ id: 2, kind: 'node', vmid: 0, name: 'pve', apps: [] });
    const disabled = container({ id: 3, vmid: 103, name: 'off', isEnabled: false });
    const second = container({ id: 4, vmid: 104, name: 'second', aptUpgradable: [], updatesAvailable: 1 });
    const { fixture, el } = await create([container(), node, disabled, second]);
    const headerButton = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.trim().startsWith(text))!;
    const checkboxes = () => [...el.querySelectorAll<HTMLInputElement>('.ct-list .pick input')];

    expect(checkboxes()).toHaveLength(0);
    headerButton('Update').click();
    await settle(fixture);
    http.expectNone('/api/containers/update-all');
    // Only containers with pending updates get a checkbox, all of them ticked.
    expect(checkboxes()).toHaveLength(2);
    expect(checkboxes().every((c) => c.checked)).toBe(true);
    expect(el.querySelector('.header-actions')?.textContent).toContain('2 of 2 container(s) selected');
    const backup = el.querySelector<HTMLInputElement>('.header-actions .backup-check input')!;
    expect(backup.checked).toBe(true);

    checkboxes()[1]!.click();
    await settle(fixture);
    expect(el.querySelector('.header-actions')?.textContent).toContain('1 of 2 container(s) selected');
    headerButton('Select all').click();
    await settle(fixture);
    headerButton('Select none').click();
    await settle(fixture);
    expect(headerButton('Update 0').disabled).toBe(true);
    // Tick the first container again (found by name, whatever the sort order).
    [...el.querySelectorAll<HTMLElement>('.ct-list li')]
      .find((li) => li.textContent?.includes('vaultwarden'))!
      .querySelector<HTMLInputElement>('.pick input')!
      .click();
    await settle(fixture);

    headerButton('Update 1').click();
    const request = http.expectOne('/api/containers/update-all');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ backup: true, ids: [1] });
    request.flush({ containers: 1, updates: 2 }, { status: 202, statusText: 'Accepted' });
    await settle(fixture);
    expect(checkboxes()).toHaveLength(0);

    http.expectOne('/api/containers').flush([container({ aptUpgradable: [], apps: [], updatesAvailable: 0 }), node]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    await settle(fixture);
    http.expectOne('/api/status').flush({});
    await settle(fixture);
    // Only the host has pending updates now – it is updated by hand.
    expect(headerButton('Update').disabled).toBe(true);
  });

  it('leaves the container choice for "Update" with Cancel', async () => {
    const { fixture, el } = await create([container()]);
    const headerButton = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.trim().startsWith(text))!;
    headerButton('Update').click();
    await settle(fixture);
    expect(el.querySelectorAll('.ct-list .pick input')).toHaveLength(1);
    headerButton('Cancel').click();
    await settle(fixture);
    expect(el.querySelectorAll('.ct-list .pick input')).toHaveLength(0);
    expect(headerButton('Check all')).toBeTruthy();
    http.expectNone('/api/containers/update-all');
  });

  it('updates everything in one container after a confirmation', async () => {
    const single = container({ id: 4, vmid: 104, name: 'single', aptUpgradable: [], updatesAvailable: 1 });
    const { fixture, el } = await create([container(), single]);
    const detail = () => el.querySelector<HTMLElement>('.detail')!;
    const detailButton = (text: string) =>
      [...detail().querySelectorAll<HTMLButtonElement>('.actions button')].find((b) => b.textContent?.includes(text));
    // Only a container with more than one pending update gets the button.
    await select(fixture, el, 'single');
    expect(detailButton('Update all')).toBeUndefined();

    await select(fixture, el, 'vaultwarden');
    detailButton('Update all (2)')!.click();
    await settle(fixture);
    expect(detail().querySelector('.actions')?.textContent).toContain('Run 2 update(s) one after another?');
    expect(detail().querySelector<HTMLInputElement>('.actions .backup-check input')!.checked).toBe(true);
    detail().querySelector<HTMLInputElement>('.actions .backup-check input')!.click();

    detailButton('Yes')!.click();
    const request = http.expectOne('/api/containers/1/update-all');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ backup: false });
    request.flush({ containers: 1, updates: 2 }, { status: 202, statusText: 'Accepted' });
    await settle(fixture);
    http.expectOne('/api/containers').flush([container({ isBusy: true, activeRunId: 9 }), single]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    await settle(fixture);
    http.expectOne('/api/status').flush({});
    // Like a single update, the live log of the running update opens.
    http.expectOne('/api/runs/9').flush(run({ kind: 'apt-upgrade', status: 'running', finishedAt: null, exitCode: null }));
    await settle(fixture);
    expect(detail().textContent).toContain('Working…');
    expect(detailButton('Update all')!.disabled).toBe(true);
    expect(el.querySelector('.run-dialog h2')?.textContent).toContain('Package upgrade');
  });

  it('opens the live log from the "Working…" badge and follows the next update of "Update all"', async () => {
    const { fixture, el } = await create([container({ isBusy: true, activeRunId: 9 }), container({ id: 2, vmid: 102, name: 'queued', isBusy: true })]);
    // Waiting for its turn in "update all" – nothing to show yet.
    await select(fixture, el, 'queued');
    expect(el.querySelector('.detail .badge-btn')).toBeNull();
    expect(el.querySelector('.detail')?.textContent).toContain('Queued');
    await select(fixture, el, 'vaultwarden');
    vi.useFakeTimers();
    try {
      el.querySelector<HTMLButtonElement>('.detail .badge-btn')!.click();
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/runs/9').flush(run({ kind: 'apt-upgrade', status: 'running', finishedAt: null, exitCode: null }));
      await vi.advanceTimersByTimeAsync(0);
      expect(el.querySelector('.run-dialog h2')?.textContent).toContain('Package upgrade');

      // The apt upgrade finishes; the application update starts as the next run.
      await vi.advanceTimersByTimeAsync(1000);
      http.expectOne('/api/runs/9').flush(run({ kind: 'apt-upgrade' }));
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne('/api/status').flush({});
      http.expectOne('/api/containers').flush([container({ isBusy: true, activeRunId: 10 })]);
      http.expectOne('/api/settings').flush(proxmoxSettings(true));
      await vi.advanceTimersByTimeAsync(0);
      http
        .expectOne('/api/runs/10')
        .flush(run({ id: 10, kind: 'app-update', appId: 7, status: 'running', finishedAt: null, exitCode: null }));
      await vi.advanceTimersByTimeAsync(0);
      expect(el.querySelector('.run-dialog h2')?.textContent).toContain('Application update');
    } finally {
      vi.useRealTimers();
    }
    fixture.destroy();
  });

  it('keeps polling while a container stays busy and stops afterwards', async () => {
    const { fixture } = await create([container()]);
    vi.useFakeTimers();
    try {
      const respond = async (isBusy: boolean) => {
        http.expectOne('/api/containers').flush([container({ isBusy })]);
        http.expectOne('/api/settings').flush(proxmoxSettings(true));
        await vi.advanceTimersByTimeAsync(0);
      };
      // A check that outlasts several refresh intervals (e.g. a slow apt-get update).
      void (fixture.componentInstance as unknown as { load(): Promise<void> }).load();
      await respond(true);
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(3000);
        await respond(true);
      }
      await vi.advanceTimersByTimeAsync(3000);
      await respond(false);
      await vi.advanceTimersByTimeAsync(30_000);
      http.expectNone('/api/containers');
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the update button only when an update is available or unknown', async () => {
    const base = container().apps[0]!;
    const { el } = await create([
      container({
        apps: [
          { ...base, id: 1, name: 'NoCommand', updateCommand: null },
          { ...base, id: 2, name: 'Current', updateAvailable: false },
          { ...base, id: 3, name: 'Outdated', updateAvailable: true },
          { ...base, id: 4, name: 'Unknown', updateAvailable: null },
        ],
      }),
    ]);
    const withButton = [...el.querySelectorAll('.item')]
      .filter((item) =>
        [...item.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Update'),
      )
      .map((item) => item.querySelector('.item-name')?.textContent?.trim());
    expect(withButton).toEqual(['Outdated', 'Unknown']);
  });

  it('marks the latest version as installed for an app without a version command', async () => {
    const base = container().apps[0]!;
    const manual = { ...base, id: 2, name: 'Manual', versionCommand: null, installedVersion: '1.30.0', latestVersion: '1.32.0', updateAvailable: true };
    const { fixture, el } = await create([container({ apps: [{ ...base, id: 1, name: 'Scripted' }, manual] })]);
    const markButtons = () =>
      [...el.querySelectorAll<HTMLButtonElement>('.item button')].filter((b) => b.textContent?.includes('Mark as installed'));
    expect(markButtons().length).toBe(1); // only the app without a version command

    markButtons()[0]!.click();
    await settle(fixture);
    const request = http.expectOne('/api/containers/1/apps/2/mark-installed');
    expect(request.request.method).toBe('POST');
    request.flush({ ...manual, installedVersion: '1.32.0', updateAvailable: false });
    await settle(fixture);
    http.expectOne('/api/containers/1').flush(
      container({ apps: [{ ...base, id: 1, name: 'Scripted' }, { ...manual, installedVersion: '1.32.0', updateAvailable: false }] }),
    );
    await settle(fixture);
    http.match('/api/status').forEach((r) => r.flush(null));

    expect(markButtons().length).toBe(0);
  });

  it('adds a container picked from the node', async () => {
    const { fixture, el } = await create([]);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add container'))!.click();
    http.expectOne('/api/proxmox/containers').flush([
      { kind: 'lxc', vmid: 101, status: 'running', name: 'vaultwarden', added: true },
      { kind: 'lxc', vmid: 102, status: 'running', name: 'jellyfin', added: false },
    ]);
    await settle(fixture);

    const options = [...el.querySelectorAll('#vmid option')].map((o) => o.textContent);
    expect(options).toEqual(['CT 102 · jellyfin (running)']);
    expect(el.querySelector('.vm-hint')).toBeNull();

    el.querySelector<HTMLButtonElement>('.add-form button[type=submit]')!.click();
    const request = http.expectOne('/api/containers');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ vmid: 102, name: null });
    request.flush(container({ id: 2, vmid: 102, name: 'jellyfin', isBusy: true }));
    await settle(fixture);
    http.expectOne('/api/status').flush({});

    expect(el.textContent).toContain('jellyfin');
    expect(el.querySelector('.add-card')).toBeNull();
  });

  it('adds a guest of another Proxmox node', async () => {
    await TestBed.configureTestingModule({
      imports: [ContainersPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ContainersPage);
    fixture.detectChanges();
    http.expectOne('/api/containers').flush([]);
    const settings = proxmoxSettings(true);
    settings.proxmox.nodes = [
      { id: 1, name: 'pve1', configured: true, backupStorage: null },
      { id: 2, name: 'pve2', configured: true, backupStorage: 'pbs2' },
    ];
    http.expectOne('/api/settings').flush(settings);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add container'))!.click();
    http.expectOne('/api/proxmox/containers?hostId=1').flush([{ kind: 'lxc', vmid: 100, status: 'running', name: 'vw', added: false }]);
    await settle(fixture);
    const node = el.querySelector<HTMLSelectElement>('#add-node')!;
    expect([...node.options].map((o) => o.textContent)).toEqual(['pve1', 'pve2']);
    node.value = node.options[1]!.value;
    node.dispatchEvent(new Event('change'));
    http.expectOne('/api/proxmox/containers?hostId=2').flush([{ kind: 'lxc', vmid: 100, status: 'running', name: 'jf', added: false }]);
    await settle(fixture);
    expect([...el.querySelectorAll('#vmid option')].map((o) => o.textContent)).toEqual(['CT 100 · jf (running)']);

    el.querySelector<HTMLButtonElement>('.add-form button[type=submit]')!.click();
    const request = http.expectOne('/api/containers');
    expect(request.request.body).toEqual({ vmid: 100, name: null, hostId: 2 });
    request.flush(container({ id: 2, vmid: 100, name: 'jf', hostId: 2, hostName: 'pve2', backupStorage: 'pbs2' }));
    await settle(fixture);
    http.expectOne('/api/status').flush({});
  });

  it('adds a virtual machine with a hint about the guest agent and labels it as a VM', async () => {
    const { fixture, el } = await create([]);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add container'))!.click();
    http.expectOne('/api/proxmox/containers').flush([{ kind: 'vm', vmid: 137, status: 'running', name: 'debian', added: false }]);
    await settle(fixture);

    expect([...el.querySelectorAll('#vmid option')].map((o) => o.textContent)).toEqual(['VM 137 · debian (running)']);
    expect(el.querySelector('.vm-hint')?.textContent).toContain('qemu-guest-agent');

    el.querySelector<HTMLButtonElement>('.add-form button[type=submit]')!.click();
    http.expectOne('/api/containers').flush(
      container({ id: 5, kind: 'vm', vmid: 137, name: 'debian', isBusy: true, restartReasons: [] }),
    );
    await settle(fixture);
    http.expectOne('/api/status').flush({});

    expect(el.querySelector('.ct-id')?.textContent).toContain('VM 137');
    expect(el.querySelector('.title-line')?.textContent).toContain('VM');
  });

  it('adds all containers of the node at once', async () => {
    const { fixture, el } = await create([]);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add container'))!.click();
    http.expectOne('/api/proxmox/containers').flush([
      { kind: 'lxc', vmid: 101, status: 'running', name: 'vaultwarden', added: false },
      { kind: 'lxc', vmid: 102, status: 'stopped', name: 'jellyfin', added: false },
      { kind: 'vm', vmid: 137, status: 'running', name: 'debian', added: false },
    ]);
    await settle(fixture);

    const addAll = [...el.querySelectorAll<HTMLButtonElement>('.add-form button')].find((b) =>
      b.textContent?.includes('Add all'),
    )!;
    // Virtual machines are added one by one.
    expect(addAll.textContent?.trim()).toBe('Add all containers (2)');
    addAll.click();
    const request = http.expectOne('/api/containers/add-all');
    expect(request.request.method).toBe('POST');
    const added = [container({ isBusy: true }), container({ id: 2, vmid: 102, name: 'jellyfin' })];
    request.flush(added, { status: 201, statusText: 'Created' });
    await settle(fixture);
    http.expectOne('/api/containers').flush(added);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    await settle(fixture);
    http.expectOne('/api/status').flush({});

    expect(el.querySelectorAll('.ct-list > li').length).toBe(2);
    expect(el.querySelector('.add-card')).toBeNull();
  });

  it('explains stopped containers and blocks their updates', async () => {
    const { el } = await create([container({ status: 'stopped' })]);

    expect(el.querySelector('.stopped-line')?.textContent).toContain('not started automatically');
    expect(el.textContent).not.toContain('Up to date');
    const updateButtons = [...el.querySelectorAll<HTMLButtonElement>('.item button')].filter((b) =>
      ['Upgrade', 'Update'].includes(b.textContent?.trim() ?? ''),
    );
    expect(updateButtons.length).toBe(2);
    expect(updateButtons.every((b) => b.disabled)).toBe(true);
    // Checking stays possible – it reads the status without starting the container.
    const check = [...el.querySelectorAll<HTMLButtonElement>('.actions button')].find(
      (b) => b.textContent?.trim() === 'Check',
    )!;
    expect(check.disabled).toBe(false);
  });

  it('adds the Proxmox host and upgrades it without a backup', async () => {
    const { fixture, el } = await create([container()]);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add container'))!.click();
    http.expectOne('/api/proxmox/containers').flush([{ vmid: 101, status: 'running', name: 'vaultwarden', added: true }]);
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('.node-row button')!.click();
    const request = http.expectOne('/api/containers/node');
    expect(request.request.method).toBe('POST');
    const node = container({ id: 5, kind: 'node', vmid: 0, name: 'pve', apps: [], updatesAvailable: 1 });
    request.flush(node, { status: 201, statusText: 'Created' });
    await settle(fixture);
    http.expectOne('/api/status').flush({});

    // The new host is selected and shown in the detail pane.
    const row = el.querySelector('.detail')!;
    expect(row.querySelector('.title-line')?.textContent).toContain('Host');
    expect(row.querySelector('.vmid')).toBeNull();
    expect(row.textContent).not.toContain('No applications configured');
    expect(row.querySelector('[title=Remove]')?.getAttribute('aria-label')).toBe('Remove Proxmox host');

    [...row.querySelectorAll<HTMLButtonElement>('.item button')].find((b) => b.textContent?.includes('Upgrade'))!.click();
    await settle(fixture);
    expect(row.querySelector('.backup-check')).toBeNull();
    expect(row.textContent).toContain('dist-upgrade, no backup');
    [...row.querySelectorAll<HTMLButtonElement>('.item button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
    const upgrade = http.expectOne('/api/containers/5/apt-upgrade');
    expect(upgrade.request.body).toEqual({ backup: false });
    upgrade.flush(run({ containerId: 5, kind: 'apt-upgrade', status: 'running', finishedAt: null, exitCode: null }), {
      status: 202,
      statusText: 'Accepted',
    });
    await settle(fixture);
    http.expectOne('/api/runs/9').flush(run({ containerId: 5, kind: 'apt-upgrade', status: 'running', finishedAt: null }));
    await settle(fixture);
    expect(el.querySelector('app-run-log-dialog')?.textContent).toContain('Proxmox host (pve)');
  });

  it('keeps updates of a stopped container available when it may be started temporarily', async () => {
    const { el } = await create([container({ status: 'stopped', startWhenStopped: true })]);

    expect(el.querySelector('.stopped-line')?.textContent).toContain('start it temporarily');
    const updateButtons = [...el.querySelectorAll<HTMLButtonElement>('.item button')].filter((b) =>
      ['Upgrade', 'Update'].includes(b.textContent?.trim() ?? ''),
    );
    expect(updateButtons.length).toBe(2);
    expect(updateButtons.some((b) => b.disabled)).toBe(false);
  });
  it('filters, searches and sorts the list and shows the selected container in the detail pane', async () => {
    const base = container().apps[0]!;
    const { fixture, el } = await create([
      container({ id: 1, vmid: 103, name: 'zigbee', aptUpgradable: [], apps: [], updatesAvailable: 0 }),
      container({ id: 2, vmid: 102, name: 'broken', lastError: 'ssh failed', aptUpgradable: [], apps: [], updatesAvailable: 0 }),
      container({ id: 3, vmid: 101, name: 'vaultwarden' }),
      container({ id: 4, vmid: 104, name: 'media', isEnabled: false, apps: [{ ...base, name: 'Jellyfin' }] }),
      container({ id: 5, kind: 'node', vmid: 0, name: 'pve', apps: [], aptUpgradable: [], updatesAvailable: 0 }),
    ]);
    const names = () => [...el.querySelectorAll('.ct-name')].map((n) => n.textContent?.trim());
    const tab = (label: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes(label))!;

    // Needs attention first: the host on top, then errors, updates, fine, paused.
    expect(names()).toEqual(['pve', 'broken', 'vaultwarden', 'zigbee', 'media']);
    expect(tab('Errors').querySelector('.tab-count')?.textContent?.trim()).toBe('1');
    expect(tab('Updates').querySelector('.tab-count')?.textContent?.trim()).toBe('2');
    // Nothing picked yet: the first container is shown.
    expect(el.querySelector('.detail .name')?.textContent).toContain('pve');

    tab('Updates').click();
    await settle(fixture);
    expect(names()).toEqual(['vaultwarden', 'media']);
    expect(el.querySelector('.detail .name')?.textContent).toContain('vaultwarden');

    tab('All').click();
    const search = el.querySelector<HTMLInputElement>('#ct-search')!;
    search.value = 'jelly';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(names()).toEqual(['media']);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    const sort = el.querySelector<HTMLSelectElement>('#ct-sort')!;
    sort.value = 'name';
    sort.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(names()).toEqual(['pve', 'broken', 'media', 'vaultwarden', 'zigbee']);

    // Arrow keys move the selection.
    await select(fixture, el, 'broken');
    expect(el.querySelector('.detail')?.textContent).toContain('ssh failed');
    el.querySelector('.ct-list')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle(fixture);
    expect(el.querySelector('.detail .name')?.textContent).toContain('media');
    expect(el.querySelector('.ct-item.selected')?.textContent).toContain('media');

    tab('Errors').click();
    search.value = 'nothing like this';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(el.querySelector('.ct-list')).toBeNull();
    expect(el.textContent).toContain('Nothing matches');
  });
});
