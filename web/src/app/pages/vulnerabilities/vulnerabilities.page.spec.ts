import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppStatus, RepositoryAdvisory } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { settle } from '../../testing';
import { VulnerabilitiesPage } from './vulnerabilities.page';

const advisory = (id: string, extra: Partial<RepositoryAdvisory> = {}): RepositoryAdvisory => ({
  id,
  source: 'github',
  aliases: [],
  cveId: null,
  summary: `Problem ${id}`,
  severity: 'high',
  cvssScore: 7.5,
  htmlUrl: `https://github.com/advisories/${id}`,
  publishedAt: '2026-01-01T00:00:00Z',
  updatedAt: null,
  vulnerabilities: [{ packageName: 'app', vulnerableRange: '< 2.0.0', patchedVersions: '2.0.0' }],
  affectsInstalled: null,
  affectedVersions: [],
  repository: {
    id: 1,
    fullName: 'acme/app',
    owner: 'acme',
    url: 'https://github.com/acme/app',
    avatarUrl: 'https://avatars.githubusercontent.com/acme?s=64',
    installedVersion: null,
    installedVersions: [],
  },
  ...extra,
});

describe('VulnerabilitiesPage', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [VulnerabilitiesPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  async function render(advisories: RepositoryAdvisory[]) {
    const fixture = TestBed.createComponent(VulnerabilitiesPage);
    fixture.detectChanges();
    await settle(fixture);
    http.expectOne('/api/advisories').flush(advisories);
    await settle(fixture);
    return { el: fixture.nativeElement as HTMLElement, fixture };
  }

  const vault = { id: 2, fullName: 'dani-garcia/vaultwarden', owner: 'dani-garcia', url: 'https://github.com/dani-garcia/vaultwarden', avatarUrl: '', installedVersion: '1.30.0', installedVersions: ['1.30.0'] };

  it('shows the vulnerability check schedule', async () => {
    const job = { cron: '0 */6 * * *', isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null };
    TestBed.inject(StatusService).status.set({
      advisoryPoller: { ...job, nextRunAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
    } as AppStatus);
    const { el } = await render([]);
    expect(el.querySelector('.page-header .schedule')?.textContent).toMatch(/Checked every 6 hours\s+· next in 2 hours/);
  });

  it('lists advisories affecting the installed version first and filters them', async () => {
    const { el, fixture } = await render([
      advisory('GHSA-low', { severity: 'low', affectsInstalled: false, repository: vault }),
      advisory('GHSA-unknown'),
      advisory('GHSA-crit', { severity: 'critical', cvssScore: 9.8, affectsInstalled: true, affectedVersions: ['1.30.0'], repository: vault, vulnerabilities: [{ packageName: null, vulnerableRange: '< 1.31.0', patchedVersions: null }] }),
    ]);
    const summaries = () => [...el.querySelectorAll('.advisory .summary')].map((s) => s.textContent);
    const tabs = () => [...el.querySelectorAll<HTMLButtonElement>('.tab')];
    // Starts on the advisories affecting an installed version.
    expect(tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent).toContain('Affects installed');
    expect(summaries()).toEqual(['Problem GHSA-crit']);

    tabs()[0]!.click();
    await settle(fixture);
    expect(summaries()).toEqual(['Problem GHSA-crit', 'Problem GHSA-unknown', 'Problem GHSA-low']);

    const first = el.querySelector<HTMLElement>('.advisory')!;
    expect(first.textContent).toContain('Critical · 9.8');
    expect(first.textContent).toContain('Affects 1.30.0');
    expect(first.textContent).toContain('No fix yet');
    expect(el.querySelector('.stat .stat-value')?.textContent).toBe('1');

    const tab = [...el.querySelectorAll<HTMLButtonElement>('.tab')].find((t) => t.textContent?.includes('Not affected'))!;
    tab.click();
    await settle(fixture);
    expect(summaries()).toEqual(['Problem GHSA-low']);

    tab.parentElement!.querySelector<HTMLButtonElement>('.tab')!.click();
    const select = el.querySelector<HTMLSelectElement>('#severity')!;
    select.value = 'high';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(summaries()).toEqual(['Problem GHSA-unknown']);

    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    const search = el.querySelector<HTMLInputElement>('#search')!;
    search.value = 'vaultwarden';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(summaries()).toEqual(['Problem GHSA-crit', 'Problem GHSA-low']);
  });

  it('names the affected versions of linked container apps', async () => {
    const containers = { ...vault, installedVersion: null, installedVersions: ['1.29.0', '1.32.0'] };
    const { el, fixture } = await render([
      advisory('GHSA-crit', { severity: 'critical', affectsInstalled: true, affectedVersions: ['1.29.0'], repository: containers }),
      advisory('GHSA-low', { severity: 'low', affectsInstalled: false, repository: containers }),
      advisory('GHSA-unknown'),
    ]);
    const rows = [...el.querySelectorAll<HTMLElement>('.advisory')].map((r) => r.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('Affects 1.29.0');
    el.querySelector<HTMLButtonElement>('.tab')!.click();
    await settle(fixture);
    const all = [...el.querySelectorAll<HTMLElement>('.advisory')].map((r) => r.textContent);
    expect(all[1]).toContain('Installed version unknown');
    expect(all[2]).toContain('1.29.0, 1.32.0 not affected');
  });

  it('shows an empty state without advisories', async () => {
    const { el } = await render([]);
    expect(el.querySelector('.empty h2')?.textContent).toContain('No known vulnerabilities');
    expect(el.querySelector('.stats')).toBeNull();
  });

  it('renders long lists in steps and starts over when a filter changes', async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      advisory(`GHSA-${String(i).padStart(3, '0')}`, { severity: i < 10 ? 'critical' : 'high' }),
    );
    const { el, fixture } = await render(many);
    const rows = () => el.querySelectorAll('.advisory').length;
    const more = () => el.querySelector<HTMLButtonElement>('.list-foot button');
    // Nothing affects an installed version, so the list starts on all advisories.
    expect(el.querySelector('.tab[aria-selected="true"]')?.textContent).toContain('All');
    expect(rows()).toBe(50);
    expect(el.querySelector('.list-foot')?.textContent).toContain('Showing 50 of 120');
    expect(el.querySelector('.tab-count')?.textContent).toBe('120');

    more()!.click();
    await settle(fixture);
    expect(rows()).toBe(100);
    expect(more()?.textContent).toContain('Show 20 more');

    more()!.click();
    await settle(fixture);
    expect(rows()).toBe(120);
    expect(more()).toBeNull();

    const search = el.querySelector<HTMLInputElement>('#search')!;
    search.value = 'GHSA-1';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(rows()).toBe(20);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(rows()).toBe(50);
  });
});
