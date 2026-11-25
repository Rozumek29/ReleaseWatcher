import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Container } from '../../core/models';
import { settle } from '../../testing';
import { ContainerSettingsDialog } from './container-settings.dialog';
import { container, homeAssistant } from './fixtures';

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
};

describe('ContainerSettingsDialog', () => {
  let http: HttpTestingController;

  const open = async (
    value: Container,
    repositories: object[] = [{ id: 3, fullName: 'dani-garcia/vaultwarden', lastSeenTag: '1.32.0' }],
  ) => {
    await TestBed.configureTestingModule({
      imports: [ContainerSettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ContainerSettingsDialog);
    fixture.componentRef.setInput('globalCron', '0 */6 * * *');
    fixture.componentRef.setInput('container', value);
    await settle(fixture);
    http.expectOne('/api/repositories').flush(repositories);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  afterEach(() => http.verify());

  it('saves the container with a cron override', async () => {
    const { fixture, el } = await open(container());
    const saved: Container[] = [];
    fixture.componentInstance.saved.subscribe((c) => saved.push(c));

    expect(el.querySelector<HTMLInputElement>('#ct-cron')!.placeholder).toContain('0 */6 * * *');
    type(el, '#ct-cron', '30 4 * * *');
    const backup = el.querySelector<HTMLSelectElement>('#ct-backup')!;
    expect(backup.value).toBe('default');
    backup.value = 'no';
    backup.dispatchEvent(new Event('change'));
    const startSwitch = el.querySelector<HTMLButtonElement>('[role=switch][aria-label="Start temporarily when stopped"]')!;
    expect(startSwitch.getAttribute('aria-checked')).toBe('false');
    startSwitch.click();
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/targets/1');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      name: 'vaultwarden',
      isEnabled: true,
      packagesEnabled: true,
      startWhenStopped: true,
      dockerEnabled: true,
      backupBeforeUpdate: false,
      checkCron: '30 4 * * *',
      updateCores: null,
      updateMemoryMb: null,
    });
    request.flush(container({ checkCron: '30 4 * * *' }));
    await settle(fixture);
    expect(saved[0]?.checkCron).toBe('30 4 * * *');
  });

  it('saves the Home Assistant URL and token of a virtual machine without sending the saved token back', async () => {
    const vm = container({
      kind: 'vm',
      vmid: 111,
      name: 'ha',
      packagesEnabled: false,
      homeAssistant: homeAssistant({ url: 'http://ha:8123', hasToken: true, tokenMasked: 'eyJh…abcd' }),
    });
    const { fixture, el } = await open(vm);
    expect(el.querySelector<HTMLInputElement>('#ct-ha-url')!.value).toBe('http://ha:8123');
    const token = el.querySelector<HTMLInputElement>('#ct-ha-token')!;
    expect(token.type).toBe('password');
    expect(token.placeholder).toBe('eyJh…abcd');
    expect(el.textContent).toContain('Leave empty to keep the current one.');

    // Empty token field: the saved token is kept (omitted).
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    let request = http.expectOne('/api/targets/1');
    expect(request.request.body.homeAssistantUrl).toBe('http://ha:8123');
    expect(request.request.body.homeAssistantInstall).toBe(true);
    expect('homeAssistantToken' in request.request.body).toBe(false);
    request.flush(vm);
    await settle(fixture);

    // A new token is sent; "Remove" sends null; installing can be switched off (check only).
    el.querySelector<HTMLButtonElement>('[role=switch][aria-label="Install Home Assistant updates from ReleaseWatcher"]')!.click();
    type(el, '#ct-ha-token', 'new-token');
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    request = http.expectOne('/api/targets/1');
    expect(request.request.body.homeAssistantToken).toBe('new-token');
    expect(request.request.body.homeAssistantInstall).toBe(false);
    request.flush(vm);
    await settle(fixture);

    [...el.querySelectorAll<HTMLButtonElement>('.input-with-action button')].find((b) => b.textContent?.trim() === 'Remove')!.click();
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    request = http.expectOne('/api/targets/1');
    expect(request.request.body.homeAssistantToken).toBeNull();
    request.flush(vm);
    await settle(fixture);
  });

  it('saves resources for updates and warns while they are raised', async () => {
    const { fixture, el } = await open(container({ updateCores: 2, resourcesRaised: true }));
    expect(el.querySelector<HTMLInputElement>('#ct-update-cores')!.value).toBe('2');
    expect(el.textContent).toContain('Resources are raised right now');

    type(el, '#ct-update-cores', '');
    type(el, '#ct-update-memory', '4096');
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/targets/1');
    expect(request.request.body).toMatchObject({ updateCores: null, updateMemoryMb: 4096 });
    request.flush(container({ updateMemoryMb: 4096 }));
    await settle(fixture);
  });

  it('explains the guest agent for a virtual machine and leaves out resources', async () => {
    const { fixture, el } = await open(container({ kind: 'vm', vmid: 137, name: 'debian' }));

    expect(el.querySelector('#ct-settings-title')?.textContent).toContain('Virtual machine settings');
    expect(el.querySelector('.head-text p')?.textContent).toContain('VM 137');
    expect(el.textContent).toContain('qemu-guest-agent');
    expect(el.textContent).toContain('qm start');
    expect(el.querySelector('#ct-update-cores')).toBeNull();
    expect(el.querySelector('#ct-backup')).not.toBeNull();
    expect(el.textContent).toContain('Add application');

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const request = http.expectOne('/api/targets/1');
    expect(request.request.body).not.toHaveProperty('updateCores');
    request.flush(container({ kind: 'vm', vmid: 137, name: 'debian' }));
    await settle(fixture);
  });

  it('shows only the settings that apply to the Proxmox host', async () => {
    const { el } = await open(container({ kind: 'node', vmid: 0, name: 'pve', apps: [] }));

    expect(el.querySelector('#ct-settings-title')?.textContent).toContain('Host settings');
    expect(el.querySelector('.head-text p')?.textContent).toContain('Proxmox host');
    expect(el.querySelector('#ct-backup')).toBeNull();
    expect(el.querySelector('#ct-update-cores')).toBeNull();
    expect(el.querySelector('[aria-label="Start temporarily when stopped"]')).toBeNull();
    expect(el.querySelector('[aria-label="System packages"]')).toBeNull();
    expect(el.textContent).not.toContain('Add application');
    expect(el.textContent).toContain('dist-upgrade');
  });

  it('warns in the footer about unsaved container and application changes', async () => {
    const { fixture, el } = await open(container());
    const note = () => el.querySelector('.dialog-foot app-unsaved-changes');
    expect(note()).toBeNull();

    type(el, '#ct-cron', '30 4 * * *');
    await settle(fixture);
    expect(note()?.textContent).toContain('Unsaved changes');
    // Unsaved changes keep the dialog open on a backdrop click or Escape.
    expect(el.querySelector('dialog')!.getAttribute('closedby')).toBe('none');
    type(el, '#ct-cron', '');
    await settle(fixture);
    expect(note()).toBeNull();
    expect(el.querySelector('dialog')!.getAttribute('closedby')).toBe('any');

    // An opened but untouched application form is no change.
    el.querySelector<HTMLButtonElement>('.app-row [aria-label^="Edit"]')!.click();
    await settle(fixture);
    expect(note()).toBeNull();

    type(el, '#app-update', './pull.sh');
    await settle(fixture);
    // "Save container" does not save the application, so the note points at its form.
    expect(note()?.textContent).toContain('Unsaved application');
    const link = note()!.querySelector<HTMLButtonElement>('.link-btn')!;
    expect(link.textContent).toContain('save or cancel it');
    const focus = vi.spyOn(el.querySelector<HTMLInputElement>('#app-name')!, 'focus');
    link.click();
    expect(focus).toHaveBeenCalled();

    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Cancel'))!.click();
    await settle(fixture);
    expect(note()).toBeNull();
  });

  it('adds an application whose latest version comes from a watched repository', async () => {
    const { fixture, el } = await open(container({ apps: [] }));

    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Add application'))!.click();
    await settle(fixture);
    type(el, '#app-name', 'Vaultwarden');
    type(el, '#app-version', 'cat /opt/vw_version.txt');
    type(el, '#app-source', 'repository');
    await settle(fixture);
    const repo = el.querySelector<HTMLSelectElement>('#app-repo')!;
    repo.selectedIndex = 1;
    repo.dispatchEvent(new Event('change'));
    type(el, '#app-update', 'update');
    el.querySelector<HTMLButtonElement>('[role=switch][aria-label="Use a terminal (TTY)"]')!.click();
    await settle(fixture);

    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Add application'))!.click();
    const request = http.expectOne('/api/targets/1/apps');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      name: 'Vaultwarden',
      versionCommand: 'cat /opt/vw_version.txt',
      latestSource: 'repository',
      repositoryId: 3,
      latestCommand: null,
      updateCommand: 'update',
      useTty: true,
      timeoutSeconds: 1800,
    });
    request.flush(container().apps[0]);
    await settle(fixture);

    expect(el.querySelector('.app-row')?.textContent).toContain('Vaultwarden');
    expect(el.querySelector('.app-form')).toBeNull();
  });

  it('lists the watched repositories of an application alphabetically', async () => {
    const { fixture, el } = await open(container({ apps: [] }), [
      { id: 1, provider: 'github', fullName: 'Sonarr/Sonarr', name: 'Sonarr', lastSeenTag: null },
      { id: 2, provider: 'web', fullName: 'web/example', name: 'example.com app', lastSeenTag: null },
      { id: 3, provider: 'github', fullName: 'dani-garcia/vaultwarden', name: 'vaultwarden', lastSeenTag: null },
      { id: 4, provider: 'github', fullName: 'Radarr/Radarr', name: 'Radarr', lastSeenTag: null },
    ]);

    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Add application'))!.click();
    await settle(fixture);
    type(el, '#app-source', 'repository');
    await settle(fixture);

    const options = [...el.querySelectorAll<HTMLOptionElement>('#app-repo option')].slice(1).map((o) => o.textContent?.trim());
    expect(options).toEqual(['dani-garcia/vaultwarden', 'example.com app', 'Radarr/Radarr', 'Sonarr/Sonarr']);
  });

  it('takes the installed version by hand only without a version command', async () => {
    const base = container().apps[0]!;
    const { fixture, el } = await open(
      container({ apps: [{ ...base, versionCommand: null, installedVersion: '1.30.0' }] }),
    );
    el.querySelector<HTMLButtonElement>(`[aria-label="Edit ${base.name}"]`)!.click();
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('#app-installed')!.value).toBe('1.30.0');
    type(el, '#app-installed', ' 1.31.0 ');

    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Save application'))!.click();
    const request = http.expectOne(`/api/targets/1/apps/${base.id}`);
    expect(request.request.body.installedVersion).toBe('1.31.0');
    request.flush({ ...base, versionCommand: null, installedVersion: '1.31.0' });
    await settle(fixture);

    // A version command reads it instead: the field disappears and nothing is sent.
    el.querySelector<HTMLButtonElement>(`[aria-label="Edit ${base.name}"]`)!.click();
    await settle(fixture);
    type(el, '#app-version', 'cat /opt/vw_version.txt');
    await settle(fixture);
    expect(el.querySelector('#app-installed')).toBeNull();
    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Save application'))!.click();
    const second = http.expectOne(`/api/targets/1/apps/${base.id}`);
    expect('installedVersion' in second.request.body).toBe(false);
    second.flush(base);
    await settle(fixture);
  });

  it('edits an application in place and keeps the list sorted by name', async () => {
    const base = container().apps[0]!;
    const app = (id: number, name: string) => ({ ...base, id, name });
    const { fixture, el } = await open(container({ apps: [app(1, 'Alpha'), app(2, 'Beta'), app(3, 'Gamma')] }));
    const names = () => [...el.querySelectorAll('.app-row strong')].map((s) => s.textContent?.trim());

    el.querySelector<HTMLButtonElement>('[aria-label="Edit Beta"]')!.click();
    await settle(fixture);
    const rows = [...el.querySelectorAll('.apps > .app-row')];
    // The form replaces the edited row instead of appearing below the whole list.
    expect(rows[1]!.classList).toContain('editing');
    expect(rows[1]!.querySelector('.app-form')).not.toBeNull();
    expect(el.querySelectorAll('.app-form').length).toBe(1);
    expect(el.querySelector<HTMLInputElement>('#app-name')!.value).toBe('Beta');

    type(el, '#app-name', 'Zeta');
    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Save application'))!.click();
    const request = http.expectOne('/api/targets/1/apps/2');
    expect(request.request.body.name).toBe('Zeta');
    request.flush(app(2, 'Zeta'));
    await settle(fixture);
    expect(el.querySelector('.app-form')).toBeNull();
    expect(names()).toEqual(['Alpha', 'Gamma', 'Zeta']);
  });

  it('detects applications and adds one, watching its repository first', async () => {
    const { fixture, el } = await open(container({ apps: [] }));
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;

    button('Detect applications').click();
    await settle(fixture);
    expect(button('Detecting…').disabled).toBe(true);
    const detect = http.expectOne('/api/targets/1/detect-apps');
    expect(detect.request.method).toBe('POST');
    detect.flush([
      {
        name: 'Immich',
        slug: 'immich',
        versionCommand: 'cat /root/.immich',
        installedVersion: '1.130.0',
        updateCommand: 'update',
        repository: 'immich-app/immich',
        repositoryId: null,
        alreadyAdded: false,
      },
      {
        name: 'Vaultwarden',
        slug: null,
        versionCommand: 'cat /root/.vaultwarden',
        installedVersion: '1.34.3',
        updateCommand: null,
        repository: 'dani-garcia/vaultwarden',
        repositoryId: 3,
        alreadyAdded: true,
      },
    ]);
    await settle(fixture);
    const found = el.querySelector('.detected')!;
    expect(found.textContent).toContain('immich-app/immich');
    expect(found.textContent).toContain('(watched when added)');
    expect(found.querySelector('.badge')?.textContent).toContain('Added');

    [...found.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Add')!.click();
    await settle(fixture);
    const watch = http.expectOne('/api/repositories');
    expect(watch.request.method).toBe('POST');
    expect(watch.request.body).toEqual({ repository: 'immich-app/immich', includePrereleases: false });
    watch.flush({ id: 7, fullName: 'immich-app/immich', lastSeenTag: 'v1.131.0' });
    await settle(fixture);

    const add = http.expectOne('/api/targets/1/apps');
    expect(add.request.body).toEqual({
      name: 'Immich',
      versionCommand: 'cat /root/.immich',
      latestSource: 'repository',
      repositoryId: 7,
      latestCommand: null,
      updateCommand: 'update',
      useTty: false,
      timeoutSeconds: null,
    });
    add.flush({ ...container().apps[0]!, id: 9, name: 'Immich', repositoryId: 7 });
    await settle(fixture);
    expect(el.querySelector('.apps .app-row strong')?.textContent).toContain('Immich');
    expect(found.querySelectorAll('.badge').length).toBe(2);
  });

  it('shows why applications could not be detected', async () => {
    const { fixture, el } = await open(container({ apps: [] }));
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Detect applications'))!.click();
    http
      .expectOne('/api/targets/1/detect-apps')
      .flush(
        { status: 409, title: 'CT 101 is stopped – start it to detect its applications.' },
        { status: 409, statusText: 'Conflict' },
      );
    await settle(fixture);
    expect(el.querySelector('.save-error')?.textContent).toContain('start it to detect');
    expect(el.querySelector('.detected')).toBeNull();
  });

  it('shows validation errors of an application', async () => {
    const { fixture, el } = await open(container({ apps: [] }));
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Add application'))!.click();
    await settle(fixture);
    type(el, '#app-name', 'X');
    type(el, '#app-source', 'command');
    await settle(fixture);
    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Add application'))!.click();
    http
      .expectOne('/api/targets/1/apps')
      .flush(
        { status: 400, errors: { latestCommand: ['Enter a command that prints the latest version.'] } },
        { status: 400, statusText: 'Bad Request' },
      );
    await settle(fixture);
    expect(el.querySelector('.app-form .save-error')?.textContent).toContain('latest version');
  });
});
