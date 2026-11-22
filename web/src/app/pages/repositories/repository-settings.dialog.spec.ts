import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { SELFHST_INDEX_URL } from '../../core/api.service';
import { settle } from '../../testing';
import { WatchedRepository } from '../../core/models';
import { RepositorySettingsDialog } from './repository-settings.dialog';

const repo: WatchedRepository = {
  id: 7,
  owner: 'dani-garcia',
  name: 'vaultwarden',
  fullName: 'dani-garcia/vaultwarden',
  url: 'https://github.com/dani-garcia/vaultwarden',
  avatarUrl: 'https://avatars.githubusercontent.com/dani-garcia?s=64',
  icon: null,
  iconUrls: [],
  includePrereleases: false,
  isEnabled: true,
  lastSeenTag: '1.32.0',
  lastSeenPublishedAt: null,
  lastCheckedAt: null,
  lastError: null,
  createdAt: '2026-01-01T00:00:00Z',
  installedVersionUrl: null,
  installedVersionField: null,
  installedVersionHeaders: [],
  installedVersion: null,
  installedVersionSource: 'none',
  installedVersionCheckedAt: null,
  installedVersionError: null,
  installedVersions: [],
  updateAvailable: null,
  hasOwnToken: false,
  githubTokenMasked: null,
  osvEcosystem: null,
  osvPackage: null,
  advisories: { total: 0, affecting: 0, highestSeverity: null, checkedAt: null, error: null },
};

describe('RepositorySettingsDialog', () => {
  it('previews a selfh.st icon while typing and saves it', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', repo);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const preview = () => el.querySelector<HTMLImageElement>('.dialog-head app-avatar img')!.getAttribute('src');
    expect(preview()).toBe(repo.avatarUrl);
    const icon = el.querySelector<HTMLInputElement>('#repo-icon')!;
    icon.value = 'sh:vaultwarden-light';
    icon.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(preview()).toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/svg/vaultwarden-light.svg');

    // An image that fails to load falls back to the next format, then to the owner's avatar.
    el.querySelector('.dialog-head app-avatar img')!.dispatchEvent(new Event('error'));
    await settle(fixture);
    expect(preview()).toBe('https://cdn.jsdelivr.net/gh/selfhst/icons/png/vaultwarden-light.png');

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const request = http.expectOne('/api/repositories/7');
    expect(request.request.body.icon).toBe('sh:vaultwarden-light');
  });

  it('fills the icon from the visual picker', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', repo);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Browse'))!.click();
    await settle(fixture);
    http
      .expectOne(SELFHST_INDEX_URL)
      .flush([{ Name: 'Vaultwarden', Reference: 'vaultwarden', SVG: 'Yes', Light: 'No', Dark: 'No', Category: '', Tags: '' }]);
    await settle(fixture);
    // The search starts with the repository name.
    el.querySelector<HTMLButtonElement>('app-icon-picker-dialog .tile')!.click();
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('#repo-icon')!.value).toBe('sh:vaultwarden');
    expect(el.querySelector('app-icon-picker-dialog .dialog-card')).toBeNull();
  });

  it('sends null to use the owner avatar again', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', { ...repo, icon: 'https://example.com/a.png', iconUrls: ['https://example.com/a.png'] });
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const icon = el.querySelector<HTMLInputElement>('#repo-icon')!;
    expect(icon.value).toBe('https://example.com/a.png');
    icon.value = '';
    icon.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    expect(http.expectOne('/api/repositories/7').request.body.icon).toBeNull();
  });

  it('saves the installed-version URL when the form is submitted', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    const saved: WatchedRepository[] = [];
    fixture.componentInstance.saved.subscribe((r) => saved.push(r));
    fixture.componentRef.setInput('repository', repo);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('#version-url')).toBeNull(); // source "Nothing"
    const source = el.querySelector<HTMLSelectElement>('#version-source')!;
    source.value = 'url';
    source.dispatchEvent(new Event('change'));
    await settle(fixture);
    const url = el.querySelector<HTMLInputElement>('#version-url')!;
    url.value = 'https://vault.lan/api/version';
    url.dispatchEvent(new Event('input'));
    // A click (not a synthetic submit) guards against handlers that cancel the default action.
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/repositories/7');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body.installedVersionUrl).toBe('https://vault.lan/api/version');
    expect(request.request.body.installedVersionField).toBeNull();
    expect(request.request.body.installedVersionHeaders).toEqual([]);
    expect('githubToken' in request.request.body).toBe(false); // untouched token field = keep
    request.flush({ ...repo, installedVersionUrl: 'https://vault.lan/api/version', installedVersion: '1.31.0', updateAvailable: true });
    await settle(fixture);

    expect(saved[0]?.installedVersion).toBe('1.31.0');
  });

  it('keeps saved header values unless they are re-entered', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', {
      ...repo,
      installedVersionUrl: 'https://vault.lan/api/version',
      installedVersionSource: 'url',
      installedVersionHeaders: [{ name: 'Authorization', hasValue: true }],
    });
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const value = el.querySelector<HTMLInputElement>('.header-row input[type=password]')!;
    expect(value.placeholder).toContain('Saved');

    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Add header'))!.click();
    await settle(fixture);
    const rows = el.querySelectorAll('.header-row');
    expect(rows.length).toBe(2);
    const [name, val] = [...rows[1]!.querySelectorAll<HTMLInputElement>('input')];
    name!.value = 'X-Api-Key';
    name!.dispatchEvent(new Event('input'));
    val!.value = 'k1';
    val!.dispatchEvent(new Event('input'));

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const request = http.expectOne('/api/repositories/7');
    expect(request.request.body.installedVersionHeaders).toEqual([
      { name: 'Authorization', value: null },
      { name: 'X-Api-Key', value: 'k1' },
    ]);
  });

  it('sets, keeps and removes the repository token without ever showing it', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', { ...repo, hasOwnToken: true, githubTokenMasked: 'gith…1234' });
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const token = el.querySelector<HTMLInputElement>('#repo-token')!;
    expect(token.value).toBe('');
    expect(token.placeholder).toContain('gith…1234');

    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Remove it'))!.click();
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const request = http.expectOne('/api/repositories/7');
    expect(request.request.body.githubToken).toBeNull();
    request.flush({ ...repo });
    await settle(fixture);
    http.verify();
  });

  it('saves the OSV.dev package only with both the ecosystem and the name', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', repo);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;

    const ecosystem = el.querySelector<HTMLSelectElement>('#osv-ecosystem')!;
    const name = el.querySelector<HTMLInputElement>('#osv-package')!;
    expect(name.disabled).toBe(true);
    ecosystem.value = 'Go';
    ecosystem.dispatchEvent(new Event('change'));
    await settle(fixture);
    name.value = ' github.com/dani-garcia/vaultwarden ';
    name.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/repositories/7');
    expect(request.request.body.osvEcosystem).toBe('Go');
    expect(request.request.body.osvPackage).toBe('github.com/dani-garcia/vaultwarden');
  });

  it('saves an installed version entered by hand and clears the URL', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', {
      ...repo,
      installedVersionUrl: 'https://vault.lan/api/version',
      installedVersionSource: 'url',
      installedVersion: '1.31.0',
    });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;

    const source = el.querySelector<HTMLSelectElement>('#version-source')!;
    source.value = 'manual';
    source.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(el.querySelector('#version-url')).toBeNull();
    const manual = el.querySelector<HTMLInputElement>('#manual-version')!;
    expect(manual.value).toBe(''); // the version read from the URL is not offered as typed
    manual.value = ' 1.30.0 ';
    manual.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/repositories/7');
    expect(request.request.body.installedVersionUrl).toBeNull();
    expect(request.request.body.installedVersion).toBe('1.30.0');
  });

  it('does not send the version read from the URL back as one entered by hand', async () => {
    await TestBed.configureTestingModule({
      imports: [RepositorySettingsDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(RepositorySettingsDialog);
    fixture.componentRef.setInput('repository', {
      ...repo,
      installedVersionUrl: 'https://vault.lan/api/version',
      installedVersionSource: 'url',
      installedVersion: '1.31.0',
    });
    await settle(fixture);
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const request = http.expectOne('/api/repositories/7');
    expect(request.request.body.installedVersionUrl).toBe('https://vault.lan/api/version');
    expect('installedVersion' in request.request.body).toBe(false);
  });
});
