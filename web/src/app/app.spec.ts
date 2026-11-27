import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { AuthService } from './core/auth.service';
import { NavigationService } from './core/navigation';
import { settle } from './testing';

const status = {
  version: '1.4.0',
  poller: { cron: '*/15 * * * *', isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null, nextRunAt: null },
  advisoryPoller: { cron: '0 */6 * * *', isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null, nextRunAt: null },
  repositories: { total: 3, enabled: 2, withErrors: 1, updatesAvailable: 2 },
  targets: { total: 4, enabled: 4, withErrors: 1, packagesPending: 2, appUpdatesAvailable: 1 },
  advisories: { total: 5, affecting: 2 },
};

describe('App shell', () => {
  beforeEach(async () => {
    localStorage.removeItem('releasewatcher.preferences');
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
      passwordLogin: true,
      oidcLogin: null,
    });
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    http.expectOne('/api/status').flush(status);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const links = [...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim());
    expect(links[0]).toContain('Repositories');
    expect(links[1]).toContain('Machines');
    expect(links[2]).toContain('Docker');
    expect(links[3]).toContain('Home Assistant');
    expect(links[4]).toContain('Vulnerabilities');
    expect(links[5]).toContain('Settings');
    const counts = [...el.querySelectorAll('nav .count')].map((c) => c.textContent?.trim());
    expect(counts).toEqual(['3', '4', '2']);
    expect(el.querySelector('nav .count.danger')?.textContent?.trim()).toBe('2');
    expect(el.querySelector('.poller')?.textContent).toContain('1 repo(s) with errors');
    expect(el.querySelector('.update-link')?.textContent).toContain('2 update(s) available');
    expect(el.querySelector('.containers-link')?.textContent).toContain('3 container update(s) waiting');
    expect(el.querySelector('.poller')?.textContent).toContain('1 container(s) with errors');
    expect(el.querySelector('.user-name')?.textContent).toContain('szymon');
    expect(el.querySelector('.sidebar-foot .version')?.textContent?.trim()).toBe('v1.4.0');
    const github = el.querySelector<HTMLAnchorElement>('.sidebar-foot a[aria-label="ReleaseWatcher on GitHub"]');
    expect(github?.href).toBe('https://github.com/Rozumek29/ReleaseWatcher');
    expect(github?.rel).toBe('noopener noreferrer');
  });

  it('does not poll the status while signed out', async () => {
    TestBed.inject(AuthService).state.set({
      setupRequired: false,
      authenticated: false,
      username: null,
      hasPasskeys: false,
      passwordLogin: true,
      oidcLogin: null,
    });
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await settle(fixture);
    http.expectNone('/api/status');
  });

  it('signs out from the sidebar', async () => {
    const auth = TestBed.inject(AuthService);
    auth.state.set({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: false, passwordLogin: true, oidcLogin: null });
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

  async function signedIn() {
    TestBed.inject(AuthService).state.set({
      setupRequired: false,
      authenticated: true,
      username: 'admin',
      hasPasskeys: false,
      passwordLogin: true,
      oidcLogin: null,
    });
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController).expectOne('/api/status').flush(status);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const labels = (selector: string) =>
      [...el.querySelectorAll(selector)].map((a) => a.textContent?.trim());
    return { fixture, el, labels, navigation: TestBed.inject(NavigationService) };
  }

  it('shows the pages in the saved order', async () => {
    localStorage.setItem(
      'releasewatcher.preferences',
      JSON.stringify({ navOrder: ['docker', 'settings', 'repositories', 'machines', 'vulnerabilities'] }),
    );
    const { labels } = await signedIn();
    expect(labels('nav a > span:not(.count)')).toEqual([
      'Docker',
      'Settings',
      'Repositories',
      'Machines',
      'Vulnerabilities',
      // Not in the saved order yet (added in a newer version): appended.
      'Home Assistant',
    ]);
  });

  it('rearranges the pages with the keyboard in edit mode', async () => {
    const { fixture, el, labels, navigation } = await signedIn();
    navigation.editing.set(true);
    await settle(fixture);

    expect(el.querySelector('nav a')).toBeNull();
    expect(labels('.nav-item')).toEqual(['Repositories', 'Machines', 'Docker', 'Home Assistant', 'Vulnerabilities', 'Settings']);
    expect(el.querySelector('.nav-item .home-mark')).not.toBeNull();

    el.querySelectorAll<HTMLButtonElement>('.nav-item')[2]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
    );
    await settle(fixture);

    expect(labels('.nav-item')).toEqual(['Docker', 'Repositories', 'Machines', 'Home Assistant', 'Vulnerabilities', 'Settings']);
    expect(navigation.home()).toBe('docker');
    expect(el.querySelector('[aria-live]')?.textContent).toContain('Docker moved to position 1 of 6.');

    [...el.querySelectorAll<HTMLButtonElement>('nav .btn')].find((b) => b.textContent?.includes('Done'))!.click();
    await settle(fixture);
    expect(labels('nav a')[0]).toContain('Docker');
  });

  it('rearranges the pages by dragging', async () => {
    const { fixture, el, labels, navigation } = await signedIn();
    navigation.editing.set(true);
    await settle(fixture);
    // Items 36px high with a 4px gap.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = [...el.querySelectorAll('.nav-item')].indexOf(this);
      return { top: index * 40, bottom: index * 40 + 36, height: 36 } as DOMRect;
    });
    const item = el.querySelector<HTMLButtonElement>('[data-page="repositories"]')!;
    const pointer = (type: string, clientY: number) =>
      item.dispatchEvent(new MouseEvent(type, { clientY, button: 0, bubbles: true }));

    pointer('pointerdown', 10);
    pointer('pointermove', 40);
    pointer('pointermove', 95);
    await settle(fixture);
    expect(item.classList).toContain('dragging');

    pointer('pointerup', 95);
    await settle(fixture);

    expect(labels('.nav-item')).toEqual(['Machines', 'Docker', 'Repositories', 'Home Assistant', 'Vulnerabilities', 'Settings']);
    expect(item.classList).not.toContain('dragging');
  });

  it('scrolls a short sidebar while an item is held near its edge', async () => {
    const { fixture, el, labels, navigation } = await signedIn();
    navigation.editing.set(true);
    await settle(fixture);
    // A sidebar 120px high that can scroll by 140px; items 36px high with a 4px gap.
    const sidebar = el.querySelector<HTMLElement>('.sidebar')!;
    let scrollTop = 0;
    Object.defineProperty(sidebar, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => (scrollTop = Math.max(0, Math.min(140, value))),
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === sidebar) return { top: 0, bottom: 120, height: 120 } as DOMRect;
      if (this.localName === 'nav') return { top: -scrollTop, bottom: 240 - scrollTop } as DOMRect;
      const index = [...el.querySelectorAll('.nav-item')].indexOf(this);
      return { top: index * 40 - scrollTop, bottom: index * 40 + 36 - scrollTop, height: 36 } as DOMRect;
    });
    const item = el.querySelector<HTMLButtonElement>('[data-page="repositories"]')!;
    const pointer = (type: string, clientY: number) =>
      item.dispatchEvent(new MouseEvent(type, { clientY, button: 0, bubbles: true }));

    pointer('pointerdown', 10);
    pointer('pointermove', 115);
    // Only as far as the end of the list (240px + 8px of room - 120px).
    await vi.waitFor(() => expect(scrollTop).toBe(128));
    pointer('pointerup', 115);
    await settle(fixture);

    // 115px on screen + 128px scrolled is below the last item.
    expect(labels('.nav-item')).toEqual(['Machines', 'Docker', 'Home Assistant', 'Vulnerabilities', 'Settings', 'Repositories']);
  });
});
