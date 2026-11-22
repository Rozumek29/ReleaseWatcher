import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree, provideRouter } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { authGuard, loginGuard, setupGuard } from './auth.guards';
import { authInterceptor } from './auth.interceptor';
import { AuthService, WEBAUTHN } from './auth.service';
import { AuthState } from './models';

const state = (overrides: Partial<AuthState> = {}): AuthState => ({
  setupRequired: false,
  authenticated: false,
  username: null,
  hasPasskeys: false,
  passwordLogin: true,
  ...overrides,
});

describe('AuthService, guards and interceptor', () => {
  let http: HttpTestingController;
  let auth: AuthService;
  const webauthn = {
    supported: vi.fn(() => true),
    authenticate: vi.fn(async () => ({ id: 'cred', type: 'public-key' })),
    register: vi.fn(async () => ({ id: 'new-cred', type: 'public-key' })),
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: WEBAUTHN, useValue: webauthn },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    auth = TestBed.inject(AuthService);
  });

  afterEach(() => http.verify());

  it('loads the state once for concurrent callers and treats failures as signed out', async () => {
    const first = auth.load();
    const second = auth.load();
    http.expectOne('/api/auth/state').flush(state({ authenticated: true, username: 'admin' }));
    expect((await first).username).toBe('admin');
    expect(await second).toEqual(await first);
    expect(auth.authenticated()).toBe(true);

    const failed = auth.load();
    http.expectOne('/api/auth/state').flush(null, { status: 500, statusText: 'Error' });
    expect((await failed).authenticated).toBe(false);
  });

  it('signs in with a passkey: options → authenticator → login', async () => {
    const done = auth.loginWithPasskey();
    http.expectOne('/api/auth/passkey/options').flush({ challengeId: 'c1', options: { challenge: 'abc' } });
    await Promise.resolve();
    await Promise.resolve();
    const login = http.expectOne('/api/auth/passkey/login');
    expect(webauthn.authenticate).toHaveBeenCalledWith({ challenge: 'abc' });
    expect(login.request.body).toEqual({ challengeId: 'c1', response: { id: 'cred', type: 'public-key' } });
    login.flush(state({ authenticated: true, username: 'admin', hasPasskeys: true }));
    await done;
    expect(auth.authenticated()).toBe(true);
  });

  it('registers a passkey and URL-encodes passkey IDs', async () => {
    auth.state.set(state({ authenticated: true, username: 'admin' }));
    const added = auth.addPasskey('Laptop');
    http.expectOne('/api/auth/passkeys/options').flush({ challenge: 'xyz' });
    await Promise.resolve();
    await Promise.resolve();
    const save = http.expectOne('/api/auth/passkeys');
    expect(save.request.body).toEqual({ name: 'Laptop', response: { id: 'new-cred', type: 'public-key' } });
    save.flush([{ id: 'a+b/c', name: 'Laptop' }]);
    await added;
    expect(auth.state()?.hasPasskeys).toBe(true);

    const removed = auth.deletePasskey('a+b/c');
    http.expectOne('/api/auth/passkeys/a%2Bb%2Fc').flush(null, { status: 204, statusText: 'No Content' });
    await removed;
  });

  it('a 401 from the API signs out and goes to the login page with a return URL', async () => {
    auth.state.set(state({ authenticated: true, username: 'admin' }));
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/containers');

    const request = firstValueFrom(TestBed.inject(HttpClient).get('/api/containers'));
    http.expectOne('/api/containers').flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(request).rejects.toBeTruthy();
    expect(auth.authenticated()).toBe(false);
    expect(navigate).toHaveBeenCalledWith(['/login'], { queryParams: { returnUrl: '/containers' } });

    // A wrong password (401 from /api/auth) is the login form's business, not a redirect.
    navigate.mockClear();
    const login = firstValueFrom(TestBed.inject(HttpClient).post('/api/auth/login', {}));
    http.expectOne('/api/auth/login').flush(null, { status: 401, statusText: 'Unauthorized' });
    await expect(login).rejects.toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  describe('guards', () => {
    const run = async (guard: typeof authGuard, url = '/settings') =>
      TestBed.runInInjectionContext(() =>
        guard({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
      ) as Promise<boolean | UrlTree>;
    const target = (result: boolean | UrlTree) =>
      result instanceof UrlTree ? TestBed.inject(Router).serializeUrl(result) : result;

    it('send app pages to setup or login', async () => {
      auth.state.set(state({ setupRequired: true }));
      expect(target(await run(authGuard))).toBe('/setup');
      auth.state.set(state());
      expect(target(await run(authGuard))).toBe('/login?returnUrl=%2Fsettings');
      auth.state.set(state({ authenticated: true }));
      expect(await run(authGuard)).toBe(true);
    });

    it('keep signed-in users away from login, and setup only before the account exists', async () => {
      auth.state.set(state({ authenticated: true }));
      expect(target(await run(loginGuard))).toBe('/');
      auth.state.set(state());
      expect(await run(loginGuard)).toBe(true);

      const setup = run(setupGuard);
      http.expectOne('/api/auth/state').flush(state({ setupRequired: true }));
      expect(await setup).toBe(true);
      const closed = run(setupGuard);
      http.expectOne('/api/auth/state').flush(state());
      expect(target(await closed)).toBe('/login');
    });
  });
});
