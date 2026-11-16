import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
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
  installedVersionCheckedAt: null,
  installedVersionError: null,
  updateAvailable: null,
  hasOwnToken: false,
  githubTokenMasked: null,
};

describe('RepositorySettingsDialog', () => {
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
});
