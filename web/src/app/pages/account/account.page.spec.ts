import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { AuthService, OPEN_EXTERNAL, WEBAUTHN } from '../../core/auth.service';
import { ApiTokenInfo, OidcSettings, PasskeyInfo, SessionInfo } from '../../core/models';
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

const oidcSettings = (overrides: Partial<OidcSettings> = {}): OidcSettings => ({
  configured: false,
  issuer: null,
  issuerSource: null,
  clientId: null,
  clientIdSource: null,
  hasClientSecret: false,
  clientSecretMasked: null,
  clientSecretSource: null,
  name: null,
  nameSource: null,
  redirectUri: 'https://watcher.test/api/auth/oidc/callback',
  link: null,
  ...overrides,
});

const pocketId = (overrides: Partial<OidcSettings> = {}): OidcSettings =>
  oidcSettings({
    configured: true,
    issuer: 'https://id.example.test',
    issuerSource: 'ui',
    clientId: 'release-watcher',
    clientIdSource: 'ui',
    hasClientSecret: true,
    clientSecretMasked: 'to…alue',
    clientSecretSource: 'ui',
    name: 'Pocket ID',
    nameSource: 'ui',
    ...overrides,
  });

const linked = { issuer: 'https://id.example.test', subject: 'user-1', label: 'alex', linkedAt: '2026-01-01T00:00:00Z' };

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('AccountPage', () => {
  let http: HttpTestingController;
  const webauthn = { supported: vi.fn(() => true), authenticate: vi.fn(), register: vi.fn() };
  const openExternal = vi.fn();

  const create = async (
    supported = true,
    passwordLogin = true,
    passkeys = [passkey],
    apiTokens: ApiTokenInfo[] = [],
    oidc = oidcSettings(),
    inputs: Record<string, string> = {},
  ) => {
    openExternal.mockClear();
    webauthn.supported.mockReturnValue(supported);
    await TestBed.configureTestingModule({
      imports: [AccountPage],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: WEBAUTHN, useValue: webauthn },
        { provide: OPEN_EXTERNAL, useValue: openExternal },
      ],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuthService).state.set({
      setupRequired: false,
      authenticated: true,
      username: 'admin',
      hasPasskeys: passkeys.length > 0,
      passwordLogin,
      oidcLogin: oidc.configured && oidc.link ? (oidc.name ?? 'OIDC') : null,
    });
    const fixture = TestBed.createComponent(AccountPage);
    for (const [name, value] of Object.entries(inputs)) {
      fixture.componentRef.setInput(name, value);
    }
    fixture.detectChanges();
    http.expectOne('/api/auth/passkeys').flush(passkeys);
    http.expectOne('/api/auth/sessions').flush([
      session({ id: 'me', current: true }),
      session({ id: 'phone', method: 'passkey', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }),
    ]);
    http.expectOne('/api/auth/api-tokens').flush(apiTokens);
    http.expectOne({ method: 'GET', url: '/api/auth/oidc' }).flush(oidc);
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
    expect(el.querySelector('.password-login')?.textContent).toContain('Add a passkey or link single sign-on to turn this off.');
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
  it('sets up single sign-on: sends only changed fields and shows the redirect URI', async () => {
    const { fixture, el } = await create();
    expect(el.textContent).toContain('Not set up.');
    expect(el.querySelector<HTMLInputElement>('#sso-redirect')!.value).toBe('https://watcher.test/api/auth/oidc/callback');
    expect(el.querySelector('.sso-link-action')).toBeNull();
    const unsaved = () => el.querySelector('.sso-form app-unsaved-changes');
    expect(unsaved()).toBeNull();

    type(el, '#sso-issuer', 'https://id.example.test');
    type(el, '#sso-client-id', 'release-watcher');
    type(el, '#sso-secret', 'top-secret-client-value');
    type(el, '#sso-name', 'Pocket ID');
    await settle(fixture);
    expect(unsaved()).not.toBeNull();
    el.querySelector<HTMLButtonElement>('.sso-form button[type=submit]')!.click();
    await settle(fixture);
    http.expectNone('/api/auth/oidc');
    expect(el.querySelector('.sso-form')?.textContent).toContain('Enter your current password.');

    type(el, '#sso-current', 'correct horse battery');
    el.querySelector<HTMLButtonElement>('.sso-form button[type=submit]')!.click();
    const request = http.expectOne({ method: 'PUT', url: '/api/auth/oidc' });
    expect(request.request.body).toEqual({
      currentPassword: 'correct horse battery',
      issuer: 'https://id.example.test',
      clientId: 'release-watcher',
      name: 'Pocket ID',
      clientSecret: 'top-secret-client-value',
    });
    request.flush(pocketId());
    await settle(fixture);
    http.expectOne('/api/auth/state').flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: true, passwordLogin: true, oidcLogin: null });
    await settle(fixture);
    expect(unsaved()).toBeNull();
    expect(el.querySelector<HTMLInputElement>('#sso-secret')!.placeholder).toBe('to…alue');

    // Linking opens the provider.
    const link = el.querySelector<HTMLButtonElement>('.sso-link-action button')!;
    expect(link.textContent).toContain('Link with Pocket ID');
    link.click();
    http.expectOne({ method: 'POST', url: '/api/auth/oidc/link' }).flush({ url: 'https://id.example.test/authorize?x' });
    await settle(fixture);
    expect(openExternal).toHaveBeenCalledWith('https://id.example.test/authorize?x');
  });

  it('keeps values from the environment unless they are changed', async () => {
    const { fixture, el } = await create(true, true, [passkey], [], pocketId({ issuerSource: 'env', clientIdSource: 'env' }));
    expect(el.querySelector('.sso-form')?.textContent).toContain('OIDC_ISSUER');
    type(el, '#sso-name', 'SSO');
    type(el, '#sso-current', 'correct horse battery');
    await settle(fixture);
    // Saved settings must be saved before linking.
    expect(el.querySelector<HTMLButtonElement>('.sso-link-action button')!.disabled).toBe(true);
    el.querySelector<HTMLButtonElement>('.sso-form button[type=submit]')!.click();
    const request = http.expectOne({ method: 'PUT', url: '/api/auth/oidc' });
    expect(request.request.body).toEqual({ currentPassword: 'correct horse battery', name: 'SSO' });
    request.flush({ status: 400, title: 'Invalid request.', errors: { currentPassword: ['The current password is wrong.'] } }, { status: 400, statusText: 'Bad Request' });
    await settle(fixture);
    expect(el.querySelector('.sso-form')?.textContent).toContain('The current password is wrong.');
  });

  it('shows the linked identity, unlinks it and allows password-off with single sign-on only', async () => {
    const { fixture, el } = await create(true, true, [], [], pocketId({ link: linked }));
    expect(el.querySelector('.sso-link')?.textContent).toContain('alex');
    expect(el.querySelector('.sso-link .badge')?.textContent).toContain('Linked');
    expect(el.querySelector('.sso-link-action')).toBeNull();
    // Single sign-on is enough to turn the password off.
    expect(el.querySelector<HTMLButtonElement>('.password-login [role=switch]')!.disabled).toBe(false);

    const unlink = () => [...el.querySelectorAll<HTMLButtonElement>('.sso-link button')].find((b) => b.textContent?.includes('Unlink'))!;
    unlink().click();
    await settle(fixture);
    expect(el.querySelector('.sso-link')?.textContent).toContain('Unlink?');
    el.querySelector<HTMLButtonElement>('.sso-link .btn-danger-ghost')!.click();
    http.expectOne({ method: 'DELETE', url: '/api/auth/oidc/link' }).flush(null);
    await settle(fixture);
    http.expectOne('/api/auth/state').flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: false, passwordLogin: true, oidcLogin: null });
    await settle(fixture);
    http.expectOne({ method: 'GET', url: '/api/auth/oidc' }).flush(pocketId());
    await settle(fixture);
    http.expectOne('/api/auth/sessions').flush([session({ id: 'me', current: true })]);
    await settle(fixture);
    expect(el.querySelector('.sso-link')).toBeNull();
    expect(el.querySelector('.sso-link-action')).not.toBeNull();
  });

  it('cannot unlink single sign-on while it is the only way to sign in', async () => {
    const { el } = await create(true, false, [], [], pocketId({ link: linked }));
    const unlink = [...el.querySelectorAll<HTMLButtonElement>('.sso-link button')].find((b) => b.textContent?.includes('Unlink'))!;
    expect(unlink.disabled).toBe(true);
    expect(el.querySelector('.password-login')?.textContent).toContain('--enable-password-login');
  });

  it('reports the result of linking sent back by the server', async () => {
    const navigate = vi.spyOn(Router.prototype, 'navigate').mockResolvedValue(true);
    try {
      const { fixture } = await create(true, true, [passkey], [], pocketId({ link: linked }), { sso: 'linked' });
      http.expectOne('/api/auth/state').flush({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: true, passwordLogin: true, oidcLogin: 'Pocket ID' });
      await settle(fixture);
      expect(navigate).toHaveBeenCalledWith([], expect.objectContaining({ queryParams: { sso: null, ssoError: null }, replaceUrl: true }));
    } finally {
      navigate.mockRestore();
    }
  });
});
