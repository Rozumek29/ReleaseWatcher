import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService, WEBAUTHN } from '../../core/auth.service';
import { settle } from '../../testing';
import { LoginPage } from './login.page';
import { SetupPage } from './setup.page';

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('Sign-in pages', () => {
  let http: HttpTestingController;
  let navigate: ReturnType<typeof vi.fn>;
  const webauthn = { supported: vi.fn(() => true), authenticate: vi.fn(), register: vi.fn() };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LoginPage, SetupPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: WEBAUTHN, useValue: webauthn },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    navigate = vi
      .spyOn(TestBed.inject(Router), 'navigateByUrl')
      .mockResolvedValue(true) as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => http.verify());

  const login = async (hasPasskeys = false, returnUrl?: string) => {
    TestBed.inject(AuthService).state.set({ setupRequired: false, authenticated: false, username: null, hasPasskeys });
    const fixture = TestBed.createComponent(LoginPage);
    if (returnUrl) {
      fixture.componentRef.setInput('returnUrl', returnUrl);
    }
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  it('signs in with the password and returns to the page that needed it', async () => {
    const { fixture, el } = await login(false, '/containers');
    expect(el.querySelector('.passkey-btn')).toBeNull();

    type(el, '#login-username', 'admin');
    type(el, '#login-password', 'correct horse battery');
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const request = http.expectOne('/api/auth/login');
    expect(request.request.body).toEqual({ username: 'admin', password: 'correct horse battery' });
    request.flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: false });
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith('/containers');
  });

  for (const returnUrl of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/x']) {
    it(`never redirects to another site after signing in (${returnUrl})`, async () => {
      const { fixture, el } = await login(false, returnUrl);
      type(el, '#login-username', 'admin');
      type(el, '#login-password', 'correct horse battery');
      await settle(fixture);
      el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
      http.expectOne('/api/auth/login').flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: false });
      await settle(fixture);
      expect(navigate).toHaveBeenCalledWith('/');
    });
  }

  it('shows wrong-password and lockout errors', async () => {
    const { fixture, el } = await login();
    type(el, '#login-username', 'admin');
    type(el, '#login-password', 'wrong');
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    http.expectOne('/api/auth/login').flush({ status: 401, title: 'Wrong user name or password.' }, { status: 401, statusText: 'Unauthorized' });
    await settle(fixture);
    expect(el.querySelector('.form-error')?.textContent).toContain('Wrong user name or password.');

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    http
      .expectOne('/api/auth/login')
      .flush({ status: 429, title: 'Too many failed attempts – try again in 60 s.' }, { status: 429, statusText: 'Too Many Requests' });
    await settle(fixture);
    expect(el.querySelector('.form-error')?.textContent).toContain('try again in 60 s');
  });

  it('offers passkey sign-in only when the account has passkeys and the browser supports them', async () => {
    const { fixture, el } = await login(true);
    const button = el.querySelector<HTMLButtonElement>('.passkey-btn')!;
    expect(button.textContent).toContain('Sign in with a passkey');
    webauthn.authenticate.mockResolvedValueOnce({ id: 'cred' });
    button.click();
    http.expectOne('/api/auth/passkey/options').flush({ challengeId: 'c', options: { challenge: 'x' } });
    await settle(fixture);
    http.expectOne('/api/auth/passkey/login').flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: true });
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith('/');

    webauthn.supported.mockReturnValue(false);
    try {
      const unsupported = await login(true);
      expect(unsupported.el.querySelector('.passkey-btn')).toBeNull();
    } finally {
      webauthn.supported.mockReturnValue(true);
    }
  });

  it('creates the account with the setup code', async () => {
    const fixture = TestBed.createComponent(SetupPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('setup-code');

    type(el, '#setup-password', 'short');
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    await settle(fixture);
    http.expectNone('/api/auth/setup');
    expect(el.textContent).toContain('Enter the setup code.');
    expect(el.textContent).toContain('at least 10 characters');

    type(el, '#setup-code', 'abcd-efgh');
    type(el, '#setup-password', 'correct horse battery');
    type(el, '#setup-confirm', 'correct horse battery');
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const wrong = http.expectOne('/api/auth/setup');
    expect(wrong.request.body).toEqual({ code: 'abcd-efgh', username: 'admin', password: 'correct horse battery' });
    wrong.flush({ status: 400, errors: { code: ['Wrong setup code.'] } }, { status: 400, statusText: 'Bad Request' });
    await settle(fixture);
    expect(el.textContent).toContain('Wrong setup code.');

    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    http.expectOne('/api/auth/setup').flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: false });
    await settle(fixture);
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
