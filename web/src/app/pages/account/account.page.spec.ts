import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService, WEBAUTHN } from '../../core/auth.service';
import { ApiTokenInfo, PasskeyInfo, SessionInfo } from '../../core/models';
import { settle } from '../../testing';
import { AccountPage } from './account.page';

const passkey: PasskeyInfo = {
  id: 'cred+1',
  name: 'Laptop',
  transports: ['internal'],
  deviceType: 'multiDevice',
  backedUp: true,
  createdAt: '2026-01-01T00:00:00Z',
  lastUsedAt: null,
};

const session = (overrides: Partial<SessionInfo>): SessionInfo => ({
  id: 'aaaa',
  method: 'password',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  ip: '192.168.1.10',
  createdAt: '2026-01-01T00:00:00Z',
  lastSeenAt: '2026-01-01T00:00:00Z',
  expiresAt: '2026-02-01T00:00:00Z',
  current: false,
  ...overrides,
});

const apiToken = (overrides: Partial<ApiTokenInfo>): ApiTokenInfo => ({
  id: 1,
  name: 'Homepage',
  scope: 'read',
  prefix: 'rw_AbCd1234',
  createdAt: '2026-01-01T00:00:00Z',
  expiresAt: null,
  expired: false,
  lastUsedAt: null,
  lastUsedIp: null,
  ...overrides,
});

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('AccountPage', () => {
  let http: HttpTestingController;
  const webauthn = { supported: vi.fn(() => true), authenticate: vi.fn(), register: vi.fn() };

  const create = async (
    supported = true,
    passwordLogin = true,
    passkeys = [passkey],
    apiTokens: ApiTokenInfo[] = [],
  ) => {
    webauthn.supported.mockReturnValue(supported);
    await TestBed.configureTestingModule({
      imports: [AccountPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: WEBAUTHN, useValue: webauthn },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).state.set({
      setupRequired: false,
      authenticated: true,
      username: 'admin',
      hasPasskeys: passkeys.length > 0,
      passwordLogin,
    });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    http.expectOne('/api/auth/passkeys').flush(passkeys);
    http.expectOne('/api/auth/sessions').flush([
      session({ id: 'me', current: true }),
      session({ id: 'phone', method: 'passkey', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }),
    ]);
    http.expectOne('/api/auth/api-tokens').flush(apiTokens);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  };

  afterEach(() => http.verify());

  it('lists passkeys and sessions', async () => {
    const { el } = await create();
    expect(el.textContent).toContain('Laptop');
    expect(el.textContent).toContain('synced');
    expect(el.textContent).toContain('Chrome on Windows');
    expect(el.textContent).toContain('This browser');
    expect(el.textContent).toContain('Safari on iOS');
    // The current session cannot be ended from the list, the other one can.
    expect([...el.querySelectorAll('.session')].map((s) => !!s.querySelector('button'))).toEqual([false, true]);
  });

  it('changes the password with the current one', async () => {
    const { fixture, el } = await create();
    const unsaved = () => el.querySelector('form.section-body app-unsaved-changes');
    expect(unsaved()).toBeNull();
    type(el, '#account-new', 'another long password');
    type(el, '#account-confirm', 'another long password');
    await settle(fixture);
    expect(unsaved()).not.toBeNull();
    el.querySelector<HTMLButtonElement>('form.section-body button[type=submit]')!.click();
    await settle(fixture);
    http.expectNone('/api/auth/account');
    expect(el.textContent).toContain('Enter your current password.');

    type(el, '#account-current', 'correct horse battery');
    el.querySelector<HTMLButtonElement>('form.section-body button[type=submit]')!.click();
    const request = http.expectOne('/api/auth/account');
    expect(request.request.body).toEqual({
      currentPassword: 'correct horse battery',
      username: 'admin',
      newPassword: 'another long password',
    });
    request.flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: true });
    await settle(fixture);
    http.expectOne('/api/auth/sessions').flush([session({ id: 'me', current: true })]);
    await settle(fixture);
    expect(el.querySelectorAll('.session').length).toBe(1);
    expect(unsaved()).toBeNull();
  });

  it('turns password sign-in off with the current password', async () => {
    const { fixture, el } = await create();
    const toggle = () => el.querySelector<HTMLButtonElement>('.password-login [role=switch]')!;
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    toggle().click();
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('.password-login button[type=submit]')!.click();
    await settle(fixture);
    http.expectNone('/api/auth/account');
    expect(el.querySelector('.password-login .error')?.textContent).toContain('Enter your current password.');

    type(el, '#password-login-current', 'correct horse battery');
    await settle(fixture);
    el.querySelector<HTMLButtonElement>('.password-login button[type=submit]')!.click();
    const request = http.expectOne('/api/auth/account');
    expect(request.request.body).toEqual({ currentPassword: 'correct horse battery', passwordLogin: false });
    request.flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: true, passwordLogin: false });
    await settle(fixture);
    http.expectOne('/api/auth/sessions').flush([session({ id: 'me', current: true })]);
    await settle(fixture);
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(el.querySelector('#password-login-current')).toBeNull();
    // The last passkey stays while only passkeys sign in.
    expect(el.querySelector<HTMLButtonElement>('.list-item .icon-btn')!.disabled).toBe(true);
  });

  it('needs a passkey before password sign-in can be turned off', async () => {
    const { el } = await create(true, true, []);
    expect(el.querySelector<HTMLButtonElement>('.password-login [role=switch]')!.disabled).toBe(true);
    expect(el.querySelector('.password-login')?.textContent).toContain('Add a passkey to turn this off');
  });

  it('adds and removes passkeys', async () => {
    const { fixture, el } = await create();
    webauthn.register.mockResolvedValueOnce({ id: 'new' });
    type(el, '#passkey-name', 'Phone');
    el.querySelector<HTMLButtonElement>('.add-passkey button[type=submit]')!.click();
    http.expectOne('/api/auth/passkeys/options').flush({ challenge: 'c' });
    await settle(fixture);
    const save = http.expectOne((r) => r.method === 'POST' && r.url === '/api/auth/passkeys');
    expect(save.request.body).toEqual({ name: 'Phone', response: { id: 'new' } });
    save.flush([passkey, { ...passkey, id: 'new', name: 'Phone' }]);
    await settle(fixture);
    expect(el.textContent).toContain('Phone');

    el.querySelector<HTMLButtonElement>('[aria-label="Remove passkey Laptop"]')!.click();
    await settle(fixture);
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Remove')!.click();
    http.expectOne('/api/auth/passkeys/cred%2B1').flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    expect(el.textContent).not.toContain('Laptop');
  });

  it('explains that passkeys need HTTPS and disables adding them', async () => {
    const { el } = await create(false);
    expect(el.querySelector('.notice')?.textContent).toContain('HTTPS with a host name');
    expect(el.querySelector<HTMLButtonElement>('.add-passkey button')!.disabled).toBe(true);
  });

  it('signs out the other sessions', async () => {
    const { fixture, el } = await create();
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Sign out other sessions'))!.click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/auth/sessions').flush({ ended: 1 });
    await settle(fixture);
    http.expectOne('/api/auth/sessions').flush([session({ id: 'me', current: true })]);
    await settle(fixture);
    expect(el.querySelectorAll('.session').length).toBe(1);
  });
  it('lists API tokens without their value', async () => {
    const { el } = await create(true, true, [passkey], [
      apiToken({ lastUsedAt: '2026-01-02T00:00:00Z', lastUsedIp: '10.0.0.5' }),
      apiToken({ id: 2, name: 'Script', scope: 'full', expiresAt: '2026-01-05T12:00:00Z', expired: true }),
    ]);
    const text = el.querySelector('[aria-labelledby=tokens-title]')!.textContent!;
    expect(text).toContain('Homepage');
    expect(text).toContain('Read only');
    expect(text).toContain('rw_AbCd1234…');
    expect(text).toContain('from 10.0.0.5');
    expect(text).toContain('never expires');
    expect(text).toContain('Full access');
    expect(text).toContain('Expired');
    // The exact expiry date and time (local time zone); the relative time is in the tooltip.
    expect(text).toMatch(/expired 5 Jan 2026, \d{2}:\d{2}/);
  });

  it('creates an API token and shows its value once', async () => {
    const { fixture, el } = await create();
    const submit = () => el.querySelector<HTMLButtonElement>('.token-form button[type=submit]')!.click();
    submit();
    await settle(fixture);
    http.expectNone('/api/auth/api-tokens');
    expect(el.querySelector('.token-form')!.textContent).toContain('Enter a name for the token.');

    type(el, '#token-name', 'Homepage');
    const expiry = el.querySelector<HTMLSelectElement>('#token-expiry')!;
    expiry.selectedIndex = [...expiry.options].findIndex((o) => o.textContent?.trim() === 'Never');
    expiry.dispatchEvent(new Event('change'));
    submit();
    const request = http.expectOne((r) => r.method === 'POST' && r.url === '/api/auth/api-tokens');
    expect(request.request.body).toEqual({ name: 'Homepage', scope: 'read', expiresInDays: null });
    request.flush({ ...apiToken({ id: 7 }), token: 'rw_AbCd1234secret' }, { status: 201, statusText: 'Created' });
    await settle(fixture);
    expect(el.querySelector('.new-token code')!.textContent).toBe('rw_AbCd1234secret');
    expect(el.querySelectorAll('[aria-labelledby=tokens-title] .list-item').length).toBe(1);

    [...el.querySelectorAll<HTMLButtonElement>('.new-token button')].find((b) => b.textContent?.trim() === 'Done')!.click();
    await settle(fixture);
    expect(el.querySelector('.new-token')).toBeNull();
    expect(el.textContent).not.toContain('rw_AbCd1234secret');
  });

  it('shows a token created after the page opened as just created', async () => {
    const { fixture, el } = await create();
    // The page has been open for a minute when the token is created.
    const later = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    type(el, '#token-name', 'Homepage');
    el.querySelector<HTMLButtonElement>('.token-form button[type=submit]')!.click();
    http
      .expectOne((r) => r.method === 'POST' && r.url === '/api/auth/api-tokens')
      .flush({ ...apiToken({ id: 8, createdAt: new Date(later).toISOString() }), token: 'rw_x' });
    await settle(fixture);
    const meta = el.querySelector('[aria-labelledby=tokens-title] .item-meta')!.textContent!;
    vi.restoreAllMocks();
    expect(meta).toContain('created just now');
  });

  it('revokes an API token after confirmation', async () => {
    const { fixture, el } = await create(true, true, [passkey], [apiToken({ id: 3 })]);
    el.querySelector<HTMLButtonElement>('[aria-label="Revoke API token Homepage"]')!.click();
    await settle(fixture);
    [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'Revoke')!.click();
    http.expectOne((r) => r.method === 'DELETE' && r.url === '/api/auth/api-tokens/3').flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    expect(el.querySelector('[aria-labelledby=tokens-title]')!.textContent).toContain('No API tokens yet.');
  });
});
