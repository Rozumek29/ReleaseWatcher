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
    provider: 'github',
    host: null,
    owner,
    name,
    fullName,
    url: `https://github.com/${fullName}`,
    avatarUrl: `https://avatars.githubusercontent.com/${owner}?s=64`,
    icon: null,
    iconUrls: [],
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
    installedVersionSource: 'none',
    installedVersionApp: null,
    installedVersionCheckedAt: null,
    installedVersionError: null,
    installedVersions: [],
    updateAvailable: null,
    hasAccessToken: false,
    accessTokenMasked: null,
    osvEcosystem: null,
    osvPackage: null,
    advisories: { total: 0, affecting: 0, highestSeverity: null, checkedAt: null, error: null },
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
    expect(el.querySelector('.callout a')?.getAttribute('href')).toBe('/settings?tab=notifications');
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

  it('marks the latest release as installed only for versions entered by hand', async () => {
    const markButton = (row: Element | undefined) =>
      [...(row?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent?.includes('Mark as installed'));
    const manual = repo(1, 'dani-garcia/vaultwarden', {
      installedVersion: '1.31.0',
      installedVersionSource: 'manual',
      lastSeenTag: '1.32.0',
      updateAvailable: true,
    });
    const { el, fixture } = await render([
      manual,
      repo(2, 'jellyfin/jellyfin', {
        installedVersion: '10.9.0',
        installedVersionSource: 'url',
        installedVersionUrl: 'https://jf.lan/version',
        lastSeenTag: 'v10.10.3',
        updateAvailable: true,
      }),
    ]);
    const rows = [...el.querySelectorAll('.row')];
    expect(markButton(rows[1])).toBeUndefined(); // read from a URL
    expect(rows[0]?.querySelector('.installed')?.getAttribute('title')).toBe('Entered by hand');

    markButton(rows[0])!.click();
    await settle(fixture);
    const request = http.expectOne('/api/repositories/1/mark-installed');
    expect(request.request.method).toBe('POST');
    request.flush({ ...manual, installedVersion: '1.32.0', updateAvailable: false });
    await settle(fixture);
    http.match('/api/status').forEach((r) => r.flush(null));

    expect(markButton(el.querySelectorAll('.row')[0])).toBeUndefined();
    expect(el.querySelector('.row .installed')?.textContent).toContain('1.32.0');
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

  it('offers a provider choice only for a host it does not know', async () => {
    const { el, fixture } = await render([]);
    const input = el.querySelector<HTMLInputElement>('#new-repo')!;
    const type = async (value: string) => {
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(fixture);
    };

    await type('https://codeberg.org/forgejo/forgejo');
    expect(el.querySelector('#new-provider')).toBeNull();
    await type('https://git.example.com/me/app');
    const select = el.querySelector<HTMLSelectElement>('#new-provider')!;
    expect(select).not.toBeNull();
    select.value = 'gitlab';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);

    el.querySelector<HTMLFormElement>('form.add-card')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    const request = http.expectOne({ method: 'POST', url: '/api/repositories' });
    expect(request.request.body).toEqual({ repository: 'https://git.example.com/me/app', includePrereleases: false, provider: 'gitlab' });
    request.flush(repo(3, 'me/app', { provider: 'gitlab', host: 'git.example.com', fullName: 'git.example.com/me/app', avatarUrl: null }));
    await settle(fixture);
    http.match('/api/status').forEach((r) => r.flush({}));

    expect(el.querySelector('.row')?.textContent).toContain('git.example.com/me/app');
    expect(el.querySelector('#new-provider')).toBeNull();
  });

  it('switches to the grid layout', async () => {
    const { el, fixture } = await render([repo(1, 'angular/angular')]);
    expect(el.querySelector('.list.grid')).toBeNull();
    el.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click();
    await settle(fixture);
    expect(el.querySelector('.list.grid')).not.toBeNull();
  });

  it('shows security advisories, filters vulnerable repositories and opens the advisories dialog', async () => {
    const { el, fixture } = await render([
      repo(1, 'angular/angular', { advisories: { total: 2, affecting: 0, highestSeverity: 'low', checkedAt: null, error: null } }),
      repo(2, 'dani-garcia/vaultwarden', {
        installedVersion: '1.30.0',
        installedVersions: ['1.30.0', '1.29.0'],
        advisories: { total: 3, affecting: 1, highestSeverity: 'critical', checkedAt: '2026-01-02T00:00:00Z', error: null },
      }),
      repo(3, 'nodejs/node'),
    ]);
    const badges = [...el.querySelectorAll<HTMLButtonElement>('.badge-btn')];
    expect(badges.map((b) => b.textContent?.trim())).toEqual(['2 advisories', '1 vulnerability affects installed']);
    expect(badges[1]?.classList).toContain('badge-danger');

    const tab = [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes('Vulnerable'))!;
    expect(tab.querySelector('.tab-count')?.textContent).toBe('1');
    tab.click();
    await settle(fixture);
    expect(el.querySelectorAll('.row').length).toBe(1);

    el.querySelector<HTMLButtonElement>('.badge-btn')!.click();
    await settle(fixture);
    http.expectOne('/api/repositories/2/advisories').flush([
      {
        id: 'GHSA-old',
        source: 'github',
        aliases: [],
        cveId: null,
        summary: 'Old problem',
        severity: 'low',
        cvssScore: null,
        htmlUrl: 'https://github.com/advisories/GHSA-old',
        publishedAt: '2026-01-03T00:00:00Z',
        updatedAt: null,
        vulnerabilities: [{ packageName: 'vaultwarden', vulnerableRange: '< 1.0.0', patchedVersions: '1.0.0' }],
        affectsInstalled: false,
        affectedVersions: [],
      },
      {
        id: 'GHSA-xss',
        source: 'github',
        aliases: [],
        cveId: 'CVE-2026-1',
        summary: 'Stored XSS',
        severity: 'critical',
        cvssScore: 9.1,
        htmlUrl: 'https://github.com/advisories/GHSA-xss',
        publishedAt: '2026-01-01T00:00:00Z',
        updatedAt: null,
        vulnerabilities: [{ packageName: 'vaultwarden', vulnerableRange: '< 1.31.0', patchedVersions: null }],
        affectsInstalled: true,
        affectedVersions: ['1.30.0', '1.29.0'],
      },
    ]);
    await settle(fixture);

    const items = [...el.querySelectorAll<HTMLElement>('app-advisories-dialog .advisory')];
    // Advisories affecting the installed version come first.
    expect(items.map((i) => i.querySelector('.summary')?.textContent)).toEqual(['Stored XSS', 'Old problem']);
    expect(items[0]?.textContent).toContain('Critical · 9.1');
    expect(items[0]?.textContent).toContain('Affects installed version');
    expect(items[0]?.textContent).toContain('No fix yet');
    expect(items[1]?.textContent).toContain('Not affected');
    expect(el.querySelector('app-advisories-dialog .intro')?.textContent).toContain('installed versions 1.30.0, 1.29.0');
  });
});
