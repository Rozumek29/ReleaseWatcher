import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { Container, Run } from '../../core/models';
import { settle } from '../../testing';
import { ContainersPage } from './containers.page';
import { container, proxmoxSettings } from './fixtures';

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

  it('shows a hint linking to Settings when the node is not configured', async () => {
    const { el } = await create([], false);
    expect(el.querySelector('.callout')?.textContent).toContain('not configured');
    expect(el.querySelector('.callout a')?.getAttribute('href')).toBe('/settings');
  });

  it('asks before upgrading apt packages and opens the run log', async () => {
    const { fixture, el } = await create([container()]);

    const upgrade = [...el.querySelectorAll<HTMLButtonElement>('.item button')].find((b) =>
      b.textContent?.includes('Upgrade'),
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
  });

  it('updates all containers with pending updates after a confirmation, leaving out the host', async () => {
    const node = container({ id: 2, kind: 'node', vmid: 0, name: 'pve', apps: [] });
    const disabled = container({ id: 3, vmid: 103, name: 'off', isEnabled: false });
    const { fixture, el } = await create([container(), node, disabled]);
    const updateAll = () =>
      [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) =>
        b.textContent?.includes('Update all'),
      )!;

    updateAll().click();
    await settle(fixture);
    http.expectNone('/api/containers/update-all');
    expect(el.querySelector('.header-actions')?.textContent).toContain('Update 1 container(s) one after another?');
    const backup = el.querySelector<HTMLInputElement>('.header-actions .backup-check input')!;
    expect(backup.checked).toBe(true);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
    const request = http.expectOne('/api/containers/update-all');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ backup: true });
    request.flush({ containers: 1, updates: 2 }, { status: 202, statusText: 'Accepted' });
    await settle(fixture);

    http.expectOne('/api/containers').flush([container({ aptUpgradable: [], apps: [], updatesAvailable: 0 }), node]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    await settle(fixture);
    http.expectOne('/api/status').flush({});
    await settle(fixture);
    // Only the host has pending updates now – it is updated by hand.
    expect(updateAll().disabled).toBe(true);
  });

  it('updates everything in one container after a confirmation', async () => {
    const single = container({ id: 4, vmid: 104, name: 'single', aptUpgradable: [], updatesAvailable: 1 });
    const { fixture, el } = await create([container(), single]);
    const rows = el.querySelectorAll<HTMLElement>('li.row');
    const rowButton = (row: HTMLElement, text: string) =>
      [...row.querySelectorAll<HTMLButtonElement>('.actions button')].find((b) => b.textContent?.includes(text));
    // Only a container with more than one pending update gets the button.
    expect(rowButton(rows[1]!, 'Update all')).toBeUndefined();

    rowButton(rows[0]!, 'Update all (2)')!.click();
    await settle(fixture);
    expect(rows[0]!.querySelector('.actions')?.textContent).toContain('Run 2 update(s) one after another?');
    expect(rows[0]!.querySelector<HTMLInputElement>('.actions .backup-check input')!.checked).toBe(true);
    rows[0]!.querySelector<HTMLInputElement>('.actions .backup-check input')!.click();

    rowButton(rows[0]!, 'Yes')!.click();
    const request = http.expectOne('/api/containers/1/update-all');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ backup: false });
    request.flush({ containers: 1, updates: 2 }, { status: 202, statusText: 'Accepted' });
    await settle(fixture);
    http.expectOne('/api/containers').flush([container({ isBusy: true }), single]);
    http.expectOne('/api/settings').flush(proxmoxSettings(true));
    await settle(fixture);
    http.expectOne('/api/status').flush({});
    await settle(fixture);
    expect(el.querySelector('li.row')?.textContent).toContain('Working…');
    expect(rowButton(el.querySelector<HTMLElement>('li.row')!, 'Update all')!.disabled).toBe(true);
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

  it('adds a container picked from the node', async () => {
    const { fixture, el } = await create([]);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add'))!.click();
    http.expectOne('/api/proxmox/containers').flush([
      { vmid: 101, status: 'running', name: 'vaultwarden', added: true },
      { vmid: 102, status: 'running', name: 'jellyfin', added: false },
    ]);
    await settle(fixture);

    const options = [...el.querySelectorAll('#vmid option')].map((o) => o.textContent);
    expect(options).toEqual(['102 · jellyfin (running)']);

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

  it('adds all containers of the node at once', async () => {
    const { fixture, el } = await create([]);

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add'))!.click();
    http.expectOne('/api/proxmox/containers').flush([
      { vmid: 101, status: 'running', name: 'vaultwarden', added: false },
      { vmid: 102, status: 'stopped', name: 'jellyfin', added: false },
    ]);
    await settle(fixture);

    const addAll = [...el.querySelectorAll<HTMLButtonElement>('.add-form button')].find((b) =>
      b.textContent?.includes('Add all'),
    )!;
    expect(addAll.textContent?.trim()).toBe('Add all (2)');
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

    expect(el.querySelectorAll('.list > li').length).toBe(2);
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

    [...el.querySelectorAll<HTMLButtonElement>('.header-actions button')].find((b) => b.textContent?.includes('Add'))!.click();
    http.expectOne('/api/proxmox/containers').flush([{ vmid: 101, status: 'running', name: 'vaultwarden', added: true }]);
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('.node-row button')!.click();
    const request = http.expectOne('/api/containers/node');
    expect(request.request.method).toBe('POST');
    const node = container({ id: 5, kind: 'node', vmid: 0, name: 'pve', apps: [], updatesAvailable: 1 });
    request.flush(node, { status: 201, statusText: 'Created' });
    await settle(fixture);
    http.expectOne('/api/status').flush({});

    const row = el.querySelector('.list > li')!;
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
});
