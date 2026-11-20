import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RepositoryAdvisory } from '../../core/models';
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
  repository: {
    id: 1,
    fullName: 'acme/app',
    owner: 'acme',
    url: 'https://github.com/acme/app',
    avatarUrl: 'https://avatars.githubusercontent.com/acme?s=64',
    installedVersion: null,
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

  const vault = { id: 2, fullName: 'dani-garcia/vaultwarden', owner: 'dani-garcia', url: 'https://github.com/dani-garcia/vaultwarden', avatarUrl: '', installedVersion: '1.30.0' };

  it('lists advisories affecting the installed version first and filters them', async () => {
    const { el, fixture } = await render([
      advisory('GHSA-low', { severity: 'low', affectsInstalled: false, repository: vault }),
      advisory('GHSA-unknown'),
      advisory('GHSA-crit', { severity: 'critical', cvssScore: 9.8, affectsInstalled: true, repository: vault, vulnerabilities: [{ packageName: null, vulnerableRange: '< 1.31.0', patchedVersions: null }] }),
    ]);
    const summaries = () => [...el.querySelectorAll('.advisory .summary')].map((s) => s.textContent);
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

  it('shows an empty state without advisories', async () => {
    const { el } = await render([]);
    expect(el.querySelector('.empty h2')?.textContent).toContain('No known vulnerabilities');
    expect(el.querySelector('.stats')).toBeNull();
  });
});
