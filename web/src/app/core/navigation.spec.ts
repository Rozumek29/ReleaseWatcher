import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Route, Router, provideRouter } from '@angular/router';
import { routes } from '../app.routes';
import { DEFAULT_NAV_ORDER, normalizeNavOrder } from './nav-pages';
import { NavigationService } from './navigation';
import { PreferencesService } from './preferences.service';

const STORAGE_KEY = 'releasewatcher.preferences';

@Component({ template: '' })
class Stub {}

/** The app routes without lazy pages and guards, so only the redirects are tested. */
const stubRoutes: Route[] = routes.map((r) =>
  r.loadComponent ? { path: r.path, component: Stub } : r,
);

describe('normalizeNavOrder', () => {
  it('keeps a valid order', () => {
    const order = ['settings', 'docker', 'machines', 'vulnerabilities', 'repositories'];
    expect(normalizeNavOrder(order)).toEqual(order);
  });

  it('drops unknown and repeated pages and appends missing ones in default order', () => {
    expect(normalizeNavOrder(['docker', 'nope', 'docker', 'settings'])).toEqual([
      'docker',
      'settings',
      'repositories',
      'machines',
      'vulnerabilities',
    ]);
  });

  it('falls back to the default order for anything else', () => {
    expect(normalizeNavOrder(undefined)).toEqual(DEFAULT_NAV_ORDER);
    expect(normalizeNavOrder('docker')).toEqual(DEFAULT_NAV_ORDER);
  });
});

describe('NavigationService', () => {
  beforeEach(() => localStorage.removeItem(STORAGE_KEY));

  it('moves pages, saves the order and resets it', async () => {
    const navigation = TestBed.inject(NavigationService);
    expect(navigation.home()).toBe('repositories');
    expect(navigation.isDefault()).toBe(true);

    navigation.move(2, 0);
    TestBed.tick();

    expect(navigation.pages().map((p) => p.id)).toEqual([
      'docker',
      'repositories',
      'machines',
      'vulnerabilities',
      'settings',
    ]);
    expect(navigation.home()).toBe('docker');
    expect(navigation.isDefault()).toBe(false);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').navOrder[0]).toBe('docker');

    navigation.reset();
    expect(navigation.home()).toBe('repositories');
  });

  it('restores a saved order', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ navOrder: ['vulnerabilities'] }));
    expect(TestBed.inject(PreferencesService).navOrder()[0]).toBe('vulnerabilities');
    expect(TestBed.inject(NavigationService).home()).toBe('vulnerabilities');
  });
});

describe('start page redirect', () => {
  beforeEach(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        navOrder: ['machines', 'repositories', 'docker', 'vulnerabilities', 'settings'],
      }),
    );
    TestBed.configureTestingModule({ providers: [provideRouter(stubRoutes)] });
  });

  it('opens the first sidebar page at /', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/');
    expect(router.url).toBe('/machines');
  });

  it('opens an explicitly requested page as it is', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/repositories');
    expect(router.url).toBe('/repositories');
    await router.navigateByUrl('/docker');
    expect(router.url).toBe('/docker');
  });

  it('sends unknown paths to the start page and follows a changed order', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/nope');
    expect(router.url).toBe('/machines');

    TestBed.inject(NavigationService).move(2, 0);
    await router.navigateByUrl('/');
    expect(router.url).toBe('/docker');
  });
});
