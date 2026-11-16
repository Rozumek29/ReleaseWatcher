import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';
import { settle } from './testing';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    }).compileComponents();
  });

  it('renders navigation and poller status', async () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();

    http.expectOne('/api/status').flush({
      poller: { intervalMinutes: 15, isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null, nextRunAt: null },
      repositories: { total: 3, enabled: 2, withErrors: 1, updatesAvailable: 2 },
      containers: { total: 4, enabled: 4, withErrors: 1, aptPending: 2, appUpdatesAvailable: 1 },
    });
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
  });
});
