import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import { settle } from './testing';

const status = {
  poller: { intervalMinutes: 15, isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null, nextRunAt: null },
  repositories: { total: 3, enabled: 2, withErrors: 1, updatesAvailable: 2 },
  containers: { total: 4, enabled: 4, withErrors: 1, aptPending: 2, appUpdatesAvailable: 1 },
};

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    }).compileComponents();
  });

  it('renders navigation, poller status and the signed-in user', async () => {
    TestBed.inject(AuthService).state.set({
      setupRequired: false,
      authenticated: true,
      username: 'szymon',
      hasPasskeys: false,
    });
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    http.expectOne('/api/status').flush(status);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const links = [...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim());
    expect(links[0]).toContain('Repositories');
    expect(links[1]).toContain('Containers');
    expect(links[2]).toContain('Settings');
    const counts = [...el.querySelectorAll('nav .count')].map((c) => c.textContent?.trim());
    expect(counts).toEqual(['3', '4']);
    expect(el.querySelector('.poller')?.textContent).toContain('1 repo(s) with errors');
    expect(el.querySelector('.update-link')?.textContent).toContain('2 update(s) available');
    expect(el.querySelector('.containers-link')?.textContent).toContain('3 container update(s) waiting');
    expect(el.querySelector('.poller')?.textContent).toContain('1 container(s) with errors');
    expect(el.querySelector('.user-name')?.textContent).toContain('szymon');
  });

  it('does not poll the status while signed out', async () => {
    TestBed.inject(AuthService).state.set({
      setupRequired: false,
      authenticated: false,
      username: null,
      hasPasskeys: false,
    });
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await settle(fixture);
    http.expectNone('/api/status');
  });

  it('signs out from the sidebar', async () => {
    const auth = TestBed.inject(AuthService);
    auth.state.set({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: false });
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    fixture.detectChanges();
    http.expectOne('/api/status').flush(status);
    await settle(fixture);

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[aria-label="Sign out"]')!.click();
    http.expectOne('/api/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    expect(auth.authenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith('/login');
  });
});
