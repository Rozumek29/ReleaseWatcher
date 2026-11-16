import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { WatchedRepository } from '../../core/models';
import { settle } from '../../testing';
import { RepositoriesPage } from './repositories.page';

const repo = (id: number, fullName: string, extra: Partial<WatchedRepository> = {}): WatchedRepository => {
  const [owner, name] = fullName.split('/') as [string, string];
  return {
    id,
    owner,
    name,
    fullName,
    url: `https://github.com/${fullName}`,
    avatarUrl: `https://avatars.githubusercontent.com/${owner}?s=64`,
    includePrereleases: false,
    isEnabled: true,
    lastSeenTag: 'v1.0.0',
    lastSeenPublishedAt: '2026-01-01T00:00:00Z',
    lastCheckedAt: '2026-01-02T00:00:00Z',
    lastError: null,
    createdAt: '2026-01-01T00:00:00Z',
    installedVersionUrl: null,
    installedVersionField: null,
  installedVersionHeaders: [],
    installedVersion: null,
    installedVersionCheckedAt: null,
    installedVersionError: null,
    updateAvailable: null,
    hasOwnToken: false,
    githubTokenMasked: null,
    ...extra,
  };
};

describe('RepositoriesPage', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RepositoriesPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  async function render(repositories: WatchedRepository[], discordEnabled = true) {
    const fixture = TestBed.createComponent(RepositoriesPage);
    fixture.detectChanges();
    await settle(fixture);
    http.expectOne('/api/repositories').flush(repositories);
    http.expectOne('/api/notifiers').flush([{ name: 'discord', isEnabled: discordEnabled }]);
    await settle(fixture);
    return { el: fixture.nativeElement as HTMLElement, fixture };
  }

  it('lists repositories and filters by errors', async () => {
    const { el, fixture } = await render([repo(1, 'angular/angular'), repo(2, 'nodejs/node', { lastError: 'boom' })]);
    expect(el.querySelectorAll('.row').length).toBe(2);
    expect(el.querySelector('.row app-avatar img')?.getAttribute('src')).toBe('https://avatars.githubusercontent.com/angular?s=64');

    const errorsTab = [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes('Errors'))!;
    expect(errorsTab.textContent).toContain('1');
    errorsTab.click();
    await settle(fixture);
    const rows = el.querySelectorAll('.row');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('nodejs/');
  });

  it('points to settings when no notifier is configured', async () => {
    const { el } = await render([], false);
    expect(el.querySelector('.callout a')?.getAttribute('href')).toBe('/settings');
    expect(el.querySelector('.empty h2')?.textContent).toContain('No repositories yet');
  });

  it('shows update badges and filters by available updates', async () => {
    const { el, fixture } = await render([
      repo(1, 'dani-garcia/vaultwarden', { installedVersion: '1.31.0', lastSeenTag: '1.32.0', updateAvailable: true, installedVersionUrl: 'https://vault.lan/api/version' }),
      repo(2, 'jellyfin/jellyfin', { installedVersion: '10.10.3', lastSeenTag: 'v10.10.3', updateAvailable: false }),
    ]);
    expect(el.querySelector('.badge-warning')?.textContent).toContain('Update available');
    expect(el.querySelector('.installed')?.textContent).toContain('1.31.0');

    [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes('Updates'))!.click();
    await settle(fixture);
    expect(el.querySelectorAll('.row').length).toBe(1);
  });

  it('keeps repositories sorted by repository name, not by owner', async () => {
    const { el, fixture } = await render([repo(1, 'zeta/alpha'), repo(2, 'acme/widget')]);
    const input = el.querySelector<HTMLInputElement>('#new-repo')!;
    input.value = 'aaa/middle';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    el.querySelector<HTMLFormElement>('form.add-card')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    http.expectOne({ method: 'POST', url: '/api/repositories' }).flush(repo(3, 'aaa/middle'));
    await settle(fixture);
    http.match('/api/status').forEach((r) => r.flush({}));

    const names = [...el.querySelectorAll('.row')].map((r) => r.textContent ?? '');
    expect(names.map((t) => ['alpha', 'middle', 'widget'].find((n) => t.includes(n)))).toEqual([
      'alpha',
      'middle',
      'widget',
    ]);
  });

  it('switches to the grid layout', async () => {
    const { el, fixture } = await render([repo(1, 'angular/angular')]);
    expect(el.querySelector('.list.grid')).toBeNull();
    el.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click();
    await settle(fixture);
    expect(el.querySelector('.list.grid')).not.toBeNull();
  });
});
