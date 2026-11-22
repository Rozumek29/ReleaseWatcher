import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AdvisoryOverview, AdvisoryPage, AppStatus, RepositoryAdvisory } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { settle } from '../../testing';
import { SEARCH_DELAY_MS, VulnerabilitiesPage } from './vulnerabilities.page';

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
    iconUrls: [],
    installedVersion: null,
    installedVersions: [],
  },
  ...extra,
});

const overview = (extra: Partial<AdvisoryOverview> = {}): AdvisoryOverview => ({
  total: 3,
  affecting: 1,
  unknown: 1,
  unaffected: 1,
  critical: 1,
  repositories: 1,
  noFix: 1,
  sources: ['github'],
  ...extra,
});

/** A first page (with counts) or, with `cursor`, a following page. */
const page = (items: RepositoryAdvisory[], extra: Partial<AdvisoryPage> = {}): AdvisoryPage => ({
  items,
  nextCursor: null,
  total: items.length,
  overview: overview(),
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

  afterEach(() => http.verify());

  /** The pending request for advisories; fails unless exactly one is open. */
  const request = (): TestRequest => http.expectOne((r) => r.url === '/api/advisories');
  const params = (r: TestRequest) => Object.fromEntries(r.request.params.keys().map((k) => [k, r.request.params.get(k)]));

  async function render(first: AdvisoryPage) {
    const fixture = TestBed.createComponent(VulnerabilitiesPage);
    fixture.detectChanges();
    await settle(fixture);
    const r = request();
    expect(params(r)).toEqual({ impact: 'affecting', limit: '50' });
    r.flush(first);
    await settle(fixture);
    return { el: fixture.nativeElement as HTMLElement, fixture };
  }

  const vault = { id: 2, fullName: 'dani-garcia/vaultwarden', owner: 'dani-garcia', url: 'https://github.com/dani-garcia/vaultwarden', avatarUrl: '', iconUrls: [], installedVersion: '1.30.0', installedVersions: ['1.30.0'] };
  const crit = advisory('GHSA-crit', {
    severity: 'critical',
    cvssScore: 9.8,
    affectsInstalled: true,
    affectedVersions: ['1.30.0'],
    repository: vault,
    vulnerabilities: [{ packageName: null, vulnerableRange: '< 1.31.0', patchedVersions: null }],
  });
  const summaries = (el: HTMLElement) => [...el.querySelectorAll('.advisory .summary')].map((s) => s.textContent);
  const waitForSearch = () => new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 20));

  it('shows the vulnerability check schedule', async () => {
    const job = { cron: '0 */6 * * *', isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null };
    TestBed.inject(StatusService).status.set({
      advisoryPoller: { ...job, nextRunAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
    } as AppStatus);
    const { el } = await render(page([], { overview: overview({ total: 0, affecting: 0, unknown: 0, unaffected: 0 }) }));
    expect(el.querySelector('.page-header .schedule')?.textContent).toMatch(/Checked every 6 hours\s+· next in 2 hours/);
  });

  it('starts on the advisories affecting an installed version and sends the filters to the server', async () => {
    const { el, fixture } = await render(page([crit], { total: 1 }));
    const tabs = () => [...el.querySelectorAll<HTMLButtonElement>('.tab')];
    expect(tabs().find((t) => t.getAttribute('aria-selected') === 'true')?.textContent).toContain('Affects installed');
    expect(summaries(el)).toEqual(['Problem GHSA-crit']);
    const first = el.querySelector<HTMLElement>('.advisory')!;
    expect(first.textContent).toContain('Critical · 9.8');
    expect(first.textContent).toContain('Affects 1.30.0');
    expect(first.textContent).toContain('No fix yet');
    expect([...el.querySelectorAll('.stat .stat-value')].map((s) => s.textContent)).toEqual(['1', '1', '1', '1']);
    expect(tabs().map((t) => t.querySelector('.tab-count')?.textContent)).toEqual(['3', '1', '1', '1']);

    tabs().find((t) => t.textContent?.includes('Not affected'))!.click();
    await settle(fixture);
    const unaffected = request();
    expect(params(unaffected)).toEqual({ impact: 'unaffected', limit: '50' });
    unaffected.flush(page([advisory('GHSA-low', { severity: 'low', affectsInstalled: false, repository: vault })]));
    await settle(fixture);
    expect(summaries(el)).toEqual(['Problem GHSA-low']);
    expect(el.textContent).toContain('1.30.0 not affected');

    tabs()[0]!.click();
    const select = el.querySelector<HTMLSelectElement>('#severity')!;
    select.value = 'high';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    const high = request();
    expect(params(high)).toEqual({ severity: 'high', limit: '50' });
    high.flush(page([advisory('GHSA-unknown')]));
    await settle(fixture);
    expect(summaries(el)).toEqual(['Problem GHSA-unknown']);
    expect(el.textContent).toContain('Installed version unknown');

    const search = el.querySelector<HTMLInputElement>('#search')!;
    search.value = ' vaultwarden ';
    search.dispatchEvent(new Event('input'));
    await waitForSearch();
    await settle(fixture);
    const searched = request();
    expect(params(searched)).toEqual({ severity: 'high', q: 'vaultwarden', limit: '50' });
    searched.flush(page([]));
    await settle(fixture);
    expect(el.querySelector('.empty h2')?.textContent).toContain('Nothing matches');
  });

  it('falls back to all advisories when none affects an installed version', async () => {
    const fixture = TestBed.createComponent(VulnerabilitiesPage);
    fixture.detectChanges();
    await settle(fixture);
    request().flush(page([], { total: 0, overview: overview({ affecting: 0, critical: 0, repositories: 0, noFix: 0 }) }));
    await settle(fixture);
    const all = request();
    expect(params(all)).toEqual({ limit: '50' });
    all.flush(page([advisory('GHSA-unknown')], { overview: overview({ affecting: 0, critical: 0, repositories: 0, noFix: 0 }) }));
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tab[aria-selected="true"]')?.textContent).toContain('All');
    expect(summaries(el)).toEqual(['Problem GHSA-unknown']);
  });

  it('names the affected versions of linked container apps', async () => {
    const containers = { ...vault, installedVersion: null, installedVersions: ['1.29.0', '1.32.0'] };
    const { el } = await render(
      page([advisory('GHSA-crit', { severity: 'critical', affectsInstalled: true, affectedVersions: ['1.29.0'], repository: containers })]),
    );
    expect(el.querySelector('.advisory')?.textContent).toContain('Affects 1.29.0');
  });

  it('shows an empty state without advisories', async () => {
    const { el } = await render(page([], { overview: overview({ total: 0, affecting: 0, unknown: 0, unaffected: 0 }) }));
    expect(el.querySelector('.empty h2')?.textContent).toContain('No known vulnerabilities');
    expect(el.querySelector('.stats')).toBeNull();
  });

  it('loads the next pages with the cursor and starts over when a filter changes', async () => {
    const batch = (from: number, count: number) =>
      Array.from({ length: count }, (_, i) => advisory(`GHSA-${String(from + i).padStart(3, '0')}`, { affectsInstalled: true }));
    const { el, fixture } = await render(page(batch(0, 50), { total: 120, nextCursor: 'c1' }));
    const rows = () => el.querySelectorAll('.advisory').length;
    const more = () => el.querySelector<HTMLButtonElement>('.list-foot button');
    expect(rows()).toBe(50);
    expect(el.querySelector('.list-foot')?.textContent).toContain('Showing 50 of 120');

    more()!.click();
    await settle(fixture);
    const second = request();
    expect(params(second)).toEqual({ impact: 'affecting', cursor: 'c1', limit: '50' });
    expect(more()?.disabled).toBe(true);
    second.flush(page(batch(50, 50), { nextCursor: 'c2', total: null, overview: null }));
    await settle(fixture);
    expect(rows()).toBe(100);
    expect(more()?.textContent).toContain('Show 20 more');

    more()!.click();
    await settle(fixture);
    request().flush(page(batch(100, 20), { total: null, overview: null }));
    await settle(fixture);
    expect(rows()).toBe(120);
    expect(more()).toBeNull();

    const search = el.querySelector<HTMLInputElement>('#search')!;
    search.value = 'GHSA-1';
    search.dispatchEvent(new Event('input'));
    await waitForSearch();
    await settle(fixture);
    const filtered = request();
    expect(params(filtered)).toEqual({ impact: 'affecting', q: 'GHSA-1', limit: '50' });
    filtered.flush(page(batch(100, 20), { total: 20 }));
    await settle(fixture);
    expect(rows()).toBe(20);
  });

  it('ignores the answer to an older request', async () => {
    const { el, fixture } = await render(page([crit]));
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('.tab')];
    tabs[0]!.click();
    await settle(fixture);
    const older = request();
    tabs[3]!.click();
    await settle(fixture);
    const newer = request();
    newer.flush(page([advisory('GHSA-low', { affectsInstalled: false })]));
    await settle(fixture);
    older.flush(page([advisory('GHSA-old')]));
    await settle(fixture);
    expect(summaries(el)).toEqual(['Problem GHSA-low']);
  });
});
