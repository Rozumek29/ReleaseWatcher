import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AuthService, WEBAUTHN } from '../../core/auth.service';
import { PasskeyInfo, SessionInfo } from '../../core/models';
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

const type = (el: HTMLElement, selector: string, value: string) => {
  const input = el.querySelector<HTMLInputElement>(selector)!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
};

describe('AccountPage', () => {
  let http: HttpTestingController;
  const webauthn = { supported: vi.fn(() => true), authenticate: vi.fn(), register: vi.fn() };

  const create = async (supported = true) => {
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
    TestBed.inject(AuthService).state.set({ setupRequired: false, authenticated: true, username: 'admin', hasPasskeys: true });
    const fixture = TestBed.createComponent(AccountPage);
    fixture.detectChanges();
    http.expectOne('/api/auth/passkeys').flush([passkey]);
    http.expectOne('/api/auth/sessions').flush([
      session({ id: 'me', current: true }),
      session({ id: 'phone', method: 'passkey', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }),
    ]);
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
    type(el, '#account-new', 'another long password');
    type(el, '#account-confirm', 'another long password');
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
});
