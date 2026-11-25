import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RepositoryGroup, WatchedRepository } from '../../core/models';
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
    groupId: null,
    iconUrls: [],
    webSource: null,
    includePrereleases: false,
    releaseSource: 'releases',
    versionPattern: null,
    isEnabled: true,
    lastSeenTag: 'v1.0.0',
    lastSeenUrl: `https://github.com/${fullName}/releases/tag/v1.0.0`,
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
    localStorage.clear();
    await TestBed.configureTestingModule({
      imports: [RepositoriesPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  async function render(repositories: WatchedRepository[], discordEnabled = true, groups: RepositoryGroup[] = []) {
    const fixture = TestBed.createComponent(RepositoriesPage);
    fixture.detectChanges();
    await settle(fixture);
    http.expectOne('/api/repositories').flush(repositories);
    http.expectOne('/api/notifiers').flush([{ name: 'discord', isEnabled: discordEnabled }]);
    http.expectOne('/api/repository-groups').flush(groups);
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

  it('marks repositories watching tags and links the latest release page from the server', async () => {
    const { el } = await render([
      repo(1, 'truenas/middleware', { releaseSource: 'tags', versionPattern: '^TS-(.+)$', lastSeenTag: '25.10.8', lastSeenUrl: null }),
      repo(2, 'group/project', { releaseSource: 'tags', lastSeenTag: 'v2.0', lastSeenUrl: 'https://gitlab.com/group/project/-/tags/v2.0' }),
    ]);
    const cards = el.querySelectorAll('.card');
    const truenas = [...cards].find((c) => c.textContent?.includes('middleware'))!;
    expect(truenas.querySelector('.badge[title="Tags matching ^TS-(.+)$"]')).not.toBeNull();
    // The version picked by the pattern is no tag name: shown, not linked.
    expect(truenas.querySelector('a.mono')).toBeNull();
    expect(truenas.textContent).toContain('25.10.8');
    const gitlab = [...cards].find((c) => c.textContent?.includes('project'))!;
    expect(gitlab.querySelector('a.mono')!.getAttribute('href')).toBe('https://gitlab.com/group/project/-/tags/v2.0');
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

  const headerButton = (el: HTMLElement, text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('.page-header button')].find((b) => b.textContent?.trim() === text)!;

  it('adds a repository from its dialog and keeps the list sorted by repository name, not by owner', async () => {
    const { el, fixture } = await render([repo(1, 'zeta/alpha'), repo(2, 'acme/widget')]);
    expect(el.querySelector('app-add-repository-dialog form')).toBeNull();
    headerButton(el, 'Add repository').click();
    await settle(fixture);
    const dialog = el.querySelector('app-add-repository-dialog')!;
    expect(dialog.querySelector('h2')?.textContent).toContain('Add repository');
    const input = dialog.querySelector<HTMLInputElement>('#add-repo')!;
    input.value = 'aaa/middle';
    input.dispatchEvent(new Event('input'));
    await settle(fixture);
    dialog.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);
    http.expectOne({ method: 'POST', url: '/api/repositories' }).flush(repo(3, 'aaa/middle'));
    await settle(fixture);
    http.match('/api/status').forEach((r) => r.flush({}));

    expect(el.querySelector('app-add-repository-dialog form')).toBeNull();
    const names = [...el.querySelectorAll('.row')].map((r) => r.textContent ?? '');
    expect(names.map((t) => ['alpha', 'middle', 'widget'].find((n) => t.includes(n)))).toEqual([
      'alpha',
      'middle',
      'widget',
    ]);
  });

  it('offers both ways to add in the empty state', async () => {
    const { el, fixture } = await render([]);
    const actions = [...el.querySelectorAll<HTMLButtonElement>('.empty .empty-actions button')];
    expect(actions.map((b) => b.textContent?.trim())).toEqual(['Add web page', 'Add repository']);
    actions[0]!.click();
    await settle(fixture);
    expect(el.querySelector('app-web-source-dialog form')).not.toBeNull();
  });

  it('shows a web source by its name and the host of its page', async () => {
    const web = repo(5, 'web/UniFi Network', {
      provider: 'web',
      host: 'ui.com',
      fullName: 'ui.com/web/unifi network',
      url: 'https://ui.com/download/releases/network-server',
      avatarUrl: null,
      lastSeenTag: '9.5.21',
      lastSeenUrl: 'https://ui.com/download/releases/network-server',
      webSource: {
        url: 'https://ui.com/download/releases/network-server',
        format: 'text',
        items: null,
        version: null,
        date: null,
        link: null,
        userAgent: null,
      },
      versionPattern: 'UniFi Network Application (\\d+\\.\\d+\\.\\d+)',
    });
    const { el, fixture } = await render([web]);
    const row = el.querySelector('.row')!;
    const name = row.querySelector<HTMLAnchorElement>('a.name')!;
    expect(name.textContent?.trim()).toBe('UniFi Network');
    expect(name.getAttribute('href')).toBe('https://ui.com/download/releases/network-server');
    expect(row.textContent).not.toContain('/web/');
    expect(row.querySelector('.web-badge')?.textContent).toContain('ui.com');
    expect(row.querySelector('.meta a.mono')?.getAttribute('href')).toBe('https://ui.com/download/releases/network-server');
    expect(row.querySelector('button[aria-label="Settings of UniFi Network"]')).not.toBeNull();

    // The search finds it by its display name.
    const search = el.querySelector<HTMLInputElement>('#search')!;
    search.value = 'unifi net';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(el.querySelectorAll('.row').length).toBe(1);
  });

  it('adds a web page from its own dialog', async () => {
    const { el, fixture } = await render([repo(1, 'zeta/zulu')]);
    expect(el.querySelector('app-web-source-dialog form')).toBeNull();
    headerButton(el, 'Add web page').click();
    await settle(fixture);
    const dialog = el.querySelector('app-web-source-dialog')!;
    expect(dialog.querySelector('h2')?.textContent).toContain('Watch a web page');

    const type = async (id: string, value: string) => {
      const input = dialog.querySelector<HTMLInputElement>(`#${id}`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      await settle(fixture);
    };
    await type('new-web-name', 'TrueNAS');
    await type('new-web-url', 'https://www.truenas.com/docs/softwarereleases/');
    await type('new-web-version', 'dt a.gdoc-props__title');
    dialog.querySelector('form')!.dispatchEvent(new Event('submit'));
    await settle(fixture);

    const request = http.expectOne({ method: 'POST', url: '/api/repositories' });
    expect(request.request.body.name).toBe('TrueNAS');
    request.flush(
      repo(2, 'web/TrueNAS', {
        provider: 'web',
        host: 'www.truenas.com',
        fullName: 'www.truenas.com/web/truenas',
        avatarUrl: null,
        webSource: { ...request.request.body.webSource },
      }),
    );
    await settle(fixture);
    http.match('/api/status').forEach((r) => r.flush({}));

    expect(el.querySelector('app-web-source-dialog form')).toBeNull();
    expect([...el.querySelectorAll('.row a.name')].map((a) => a.textContent?.trim())).toEqual(['TrueNAS', 'zeta/zulu']);
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

  describe('grouping', () => {
    const groupNames = (el: HTMLElement) => [...el.querySelectorAll('.group-name')].map((n) => n.textContent?.trim());
    /** Names of the repositories shown outside of groups. */
    const ungrouped = (el: HTMLElement) =>
      [...el.querySelectorAll(':scope .list:not(.group-list) > .row .name')].map((n) => n.textContent?.replace(/\s/g, ''));
    const groupBy = async (el: HTMLElement, fixture: { whenStable(): Promise<unknown>; detectChanges(): void }, label: string) => {
      [...el.querySelectorAll<HTMLButtonElement>('.grouping-toggle button')].find((b) => b.textContent?.trim() === label)!.click();
      await settle(fixture);
    };
    const groups = (): RepositoryGroup[] => [
      { id: 1, name: 'Media', icon: 'sh:jellyfin', iconUrls: ['https://example.com/jellyfin.svg'], repositoryCount: 1 },
      { id: 2, name: 'Home', icon: null, iconUrls: [], repositoryCount: 1 },
    ];
    const repositories = () => [
      repo(1, 'immich-app/immich', { updateAvailable: true, installedVersion: 'v1.0.0', groupId: 1 }),
      repo(2, 'home-assistant/core', { updateAvailable: true, groupId: 2 }),
      repo(3, 'Home-Assistant/frontend', { updateAvailable: true }),
      repo(4, 'home-assistant/supervisor', { updateAvailable: false }),
      repo(5, 'angular/angular'),
    ];

    it('groups owners with several repositories, keeps single ones as they are and remembers the choice', async () => {
      const { el, fixture } = await render(repositories());
      expect(el.querySelector('.owner-group')).toBeNull();

      await groupBy(el, fixture, 'Owner');
      expect(groupNames(el)).toEqual(['home-assistant']);
      const group = el.querySelector('.owner-group')!;
      expect([...group.querySelectorAll('.row .name')].map((n) => n.textContent?.replace(/\s/g, ''))).toEqual([
        'home-assistant/core',
        'Home-Assistant/frontend',
        'home-assistant/supervisor',
      ]);
      expect(group.querySelector('.group-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('3 repositories');
      expect(group.querySelector('.group-head .badge-warning')?.textContent).toContain('2 updates available');
      expect(ungrouped(el)).toEqual(['immich-app/immich', 'angular/angular']);
      expect(JSON.parse(localStorage.getItem('releasewatcher.preferences')!).repositoryGrouping).toBe('owner');

      await groupBy(el, fixture, 'None');
      expect(el.querySelector('.owner-group')).toBeNull();
      expect(el.querySelectorAll('.row').length).toBe(5);
    });

    it('groups by the custom groups of the repositories', async () => {
      const { el, fixture } = await render(repositories(), true, groups());
      await groupBy(el, fixture, 'Custom');
      expect(groupNames(el)).toEqual(['Home', 'Media']);
      expect(el.querySelectorAll('.owner-group')[1]!.querySelector('.group-logo img')?.getAttribute('src')).toBe('https://example.com/jellyfin.svg');
      expect(el.querySelector('.owner-group .group-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('1 repository');
      expect(ungrouped(el)).toEqual(['Home-Assistant/frontend', 'home-assistant/supervisor', 'angular/angular']);
    });

    it('collapses groups, remembers them and collapses or expands all', async () => {
      const { el, fixture } = await render(repositories(), true, groups());
      await groupBy(el, fixture, 'Custom');
      const toggle = () => el.querySelectorAll<HTMLButtonElement>('.group-toggle')[1]!;
      toggle().click();
      await settle(fixture);
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(el.querySelectorAll('.row').length).toBe(4);
      expect(JSON.parse(localStorage.getItem('releasewatcher.preferences')!).collapsedGroups).toEqual(['group:1']);

      const all = () => [...el.querySelectorAll<HTMLButtonElement>('.toolbar button')].find((b) => /all$/.test(b.textContent!.trim()))!;
      expect(all().textContent?.trim()).toBe('Collapse all');
      all().click();
      await settle(fixture);
      expect(el.querySelectorAll('.row').length).toBe(3);
      expect(all().textContent?.trim()).toBe('Expand all');
      all().click();
      await settle(fixture);
      expect(el.querySelectorAll('.row').length).toBe(5);
    });

    it('renames a custom group and removes it from its options', async () => {
      const { el, fixture } = await render(repositories(), true, groups());
      await groupBy(el, fixture, 'Owner');
      // Owners have no options.
      expect(el.querySelector('.group-options')).toBeNull();
      await groupBy(el, fixture, 'Custom');
      el.querySelector<HTMLButtonElement>('button[aria-label="Settings of group Media"]')!.click();
      await settle(fixture);
      const name = el.querySelector<HTMLInputElement>('#group-name')!;
      await fixture.whenStable();
      expect(name.value).toBe('Media');
      expect(el.querySelector<HTMLInputElement>('#group-icon')!.value).toBe('sh:jellyfin');
      name.value = 'Movies';
      name.dispatchEvent(new Event('input'));
      el.querySelector<HTMLButtonElement>('app-repository-group-dialog button[type=submit]')!.click();
      const put = http.expectOne('/api/repository-groups/1');
      expect(put.request.body).toEqual({ name: 'Movies', icon: 'sh:jellyfin' });
      put.flush({ ...groups()[0], name: 'Movies' });
      await settle(fixture);
      expect(groupNames(el)).toEqual(['Home', 'Movies']);

      el.querySelector<HTMLButtonElement>('button[aria-label="Settings of group Home"]')!.click();
      await settle(fixture);
      [...el.querySelectorAll<HTMLButtonElement>('app-repository-group-dialog button')].find((b) => b.textContent?.includes('Remove group'))!.click();
      await settle(fixture);
      [...el.querySelectorAll<HTMLButtonElement>('app-repository-group-dialog button')].find((b) => b.textContent?.trim() === 'Yes')!.click();
      http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/repository-groups/2').flush(null);
      await settle(fixture);
      expect(groupNames(el)).toEqual(['Movies']);
      expect(ungrouped(el)).toContain('home-assistant/core');
    });

    it('starts with the remembered grouping and collapsed groups', async () => {
      localStorage.setItem(
        'releasewatcher.preferences',
        JSON.stringify({ repositoryGrouping: 'owner', collapsedGroups: ['owner:home-assistant'] }),
      );
      const { el } = await render(repositories());
      expect(groupNames(el)).toEqual(['home-assistant']);
      expect(el.querySelector('.group-toggle')!.getAttribute('aria-expanded')).toBe('false');
      expect(el.querySelectorAll('.row').length).toBe(2);
    });

    it('applies search and filters and hides empty groups', async () => {
      const { el, fixture } = await render(repositories());
      await groupBy(el, fixture, 'Owner');
      const search = el.querySelector<HTMLInputElement>('#search')!;
      search.value = 'immich';
      search.dispatchEvent(new Event('input'));
      await settle(fixture);
      expect(groupNames(el)).toEqual([]);
      expect(ungrouped(el)).toEqual(['immich-app/immich']);

      search.value = '';
      search.dispatchEvent(new Event('input'));
      [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes('Updates'))!.click();
      await settle(fixture);
      expect(groupNames(el)).toEqual(['home-assistant']);
      expect(el.querySelector('.owner-group .group-meta')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('2 repositories');
    });

    it('groups in the grid layout too', async () => {
      const { el, fixture } = await render(repositories());
      await groupBy(el, fixture, 'Owner');
      el.querySelector<HTMLButtonElement>('button[aria-label="Grid view"]')!.click();
      await settle(fixture);
      expect(el.querySelectorAll('.owner-group .list.grid').length).toBe(1);
      expect(el.querySelectorAll('.list.grid.after-groups').length).toBe(1);
    });
  });
});
