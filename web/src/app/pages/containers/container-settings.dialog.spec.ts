import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Container } from '../../core/models';
import { settle } from '../../testing';
import { ContainerSettingsDialog } from './container-settings.dialog';
import { container } from './fixtures';

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement | HTMLSelectElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
};

describe('ContainerSettingsDialog', () => {
  let http: HttpTestingController;

  const open = async (value: Container) => {
    await TestBed.configureTestingModule({
      imports: [ContainerSettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(ContainerSettingsDialog);
    fixture.componentRef.setInput('globalCron', '0 */6 * * *');
    fixture.componentRef.setInput('container', value);
    await settle(fixture);
    http.expectOne('/api/repositories').flush([
      { id: 3, fullName: 'dani-garcia/vaultwarden', lastSeenTag: '1.32.0' },
    ]);
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
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/containers/1');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      name: 'vaultwarden',
      isEnabled: true,
      aptEnabled: true,
      backupBeforeUpdate: false,
      checkCron: '30 4 * * *',
    });
    request.flush(container({ checkCron: '30 4 * * *' }));
    await settle(fixture);
    expect(saved[0]?.checkCron).toBe('30 4 * * *');
  });

  it('adds an application whose latest version comes from a watched repository', async () => {
    const { fixture, el } = await open(container({ apps: [] }));

    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Add application'))!.click();
    await settle(fixture);
    type(el, '#app-name', 'Vaultwarden');
    type(el, '#app-version', 'cat /opt/vw_version.txt');
    type(el, '#app-source', 'github');
    await settle(fixture);
    const repo = el.querySelector<HTMLSelectElement>('#app-repo')!;
    repo.selectedIndex = 1;
    repo.dispatchEvent(new Event('change'));
    type(el, '#app-update', 'update');
    el.querySelector<HTMLButtonElement>('[role=switch][aria-label="Use a terminal (TTY)"]')!.click();
    await settle(fixture);

    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Add application'))!.click();
    const request = http.expectOne('/api/containers/1/apps');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      name: 'Vaultwarden',
      versionCommand: 'cat /opt/vw_version.txt',
      latestSource: 'github',
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

  it('shows validation errors of an application', async () => {
    const { fixture, el } = await open(container({ apps: [] }));
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Add application'))!.click();
    await settle(fixture);
    type(el, '#app-name', 'X');
    type(el, '#app-source', 'command');
    await settle(fixture);
    [...el.querySelectorAll<HTMLButtonElement>('.app-form-actions button')].find((b) => b.textContent?.includes('Add application'))!.click();
    http
      .expectOne('/api/containers/1/apps')
      .flush(
        { status: 400, errors: { latestCommand: ['Enter a command that prints the latest version.'] } },
        { status: 400, statusText: 'Bad Request' },
      );
    await settle(fixture);
    expect(el.querySelector('.app-form .save-error')?.textContent).toContain('latest version');
  });
});
