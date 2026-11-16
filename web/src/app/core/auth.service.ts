import { HttpClient } from '@angular/common/http';
import { Injectable, InjectionToken, computed, inject, signal } from '@angular/core';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { firstValueFrom } from 'rxjs';
import { AccountUpdate, AuthState, PasskeyInfo, SessionInfo } from './models';

type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];
type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

/** Browser WebAuthn calls – a token so tests can replace the authenticator. */
export interface WebAuthnClient {
  /** Passkeys need a secure context (HTTPS with a host name, or localhost) and WebAuthn support. */
  supported(): boolean;
  authenticate(options: AuthenticationOptions): Promise<unknown>;
  register(options: RegistrationOptions): Promise<unknown>;
}

export const WEBAUTHN = new InjectionToken<WebAuthnClient>('WEBAUTHN', {
  providedIn: 'root',
  factory: () => ({
    supported: () =>
      typeof window !== 'undefined' && window.isSecureContext && 'PublicKeyCredential' in window,
    authenticate: (optionsJSON) => startAuthentication({ optionsJSON }),
    register: (optionsJSON) => startRegistration({ optionsJSON }),
  }),
});

const SIGNED_OUT: AuthState = {
  setupRequired: false,
  authenticated: false,
  username: null,
  hasPasskeys: false,
};

/** Login state and all /api/auth calls. */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly webauthn = inject(WEBAUTHN);
  private readonly baseUrl = '/api/auth';
  private loading: Promise<AuthState> | null = null;

  /** Null until the first load. */
  readonly state = signal<AuthState | null>(null);
  readonly authenticated = computed(() => this.state()?.authenticated ?? false);
  readonly username = computed(() => this.state()?.username ?? null);

  get passkeysSupported(): boolean {
    return this.webauthn.supported();
  }

  /** Fetches the state from the server (concurrent callers share one request). */
  load(): Promise<AuthState> {
    this.loading ??= firstValueFrom(this.http.get<AuthState>(`${this.baseUrl}/state`))
      .catch(() => SIGNED_OUT)
      .then((state) => {
        this.state.set(state);
        return state;
      })
      .finally(() => (this.loading = null));
    return this.loading;
  }

  /** The known state, loading it first if needed (route guards). */
  async ensureLoaded(): Promise<AuthState> {
    return this.state() ?? this.load();
  }

  /** Called when the API answers 401: the session ended (expired, signed out elsewhere, password changed). */
  markSignedOut(): void {
    const state = this.state();
    this.state.set({ ...(state ?? SIGNED_OUT), authenticated: false, username: null });
  }

  async setup(code: string, username: string, password: string): Promise<void> {
    this.state.set(
      await firstValueFrom(
        this.http.post<AuthState>(`${this.baseUrl}/setup`, { code, username, password }),
      ),
    );
  }

  async login(username: string, password: string): Promise<void> {
    this.state.set(
      await firstValueFrom(this.http.post<AuthState>(`${this.baseUrl}/login`, { username, password })),
    );
  }

  /** Signs in with a discoverable passkey (no user name needed). */
  async loginWithPasskey(): Promise<void> {
    const { challengeId, options } = await firstValueFrom(
      this.http.post<{ challengeId: string; options: AuthenticationOptions }>(
        `${this.baseUrl}/passkey/options`,
        {},
      ),
    );
    const response = await this.webauthn.authenticate(options);
    this.state.set(
      await firstValueFrom(
        this.http.post<AuthState>(`${this.baseUrl}/passkey/login`, { challengeId, response }),
      ),
    );
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post<void>(`${this.baseUrl}/logout`, {}));
    } finally {
      this.markSignedOut();
    }
  }

  async updateAccount(update: AccountUpdate): Promise<void> {
    this.state.set(await firstValueFrom(this.http.put<AuthState>(`${this.baseUrl}/account`, update)));
  }

  listPasskeys(): Promise<PasskeyInfo[]> {
    return firstValueFrom(this.http.get<PasskeyInfo[]>(`${this.baseUrl}/passkeys`));
  }

  /** Registers a passkey of this device; returns the updated list. */
  async addPasskey(name: string): Promise<PasskeyInfo[]> {
    const options = await firstValueFrom(
      this.http.post<RegistrationOptions>(`${this.baseUrl}/passkeys/options`, {}),
    );
    const response = await this.webauthn.register(options);
    const passkeys = await firstValueFrom(
      this.http.post<PasskeyInfo[]>(`${this.baseUrl}/passkeys`, { name, response }),
    );
    this.state.update((s) => (s ? { ...s, hasPasskeys: true } : s));
    return passkeys;
  }

  renamePasskey(id: string, name: string): Promise<PasskeyInfo[]> {
    return firstValueFrom(
      this.http.patch<PasskeyInfo[]>(`${this.baseUrl}/passkeys/${encodeURIComponent(id)}`, { name }),
    );
  }

  async deletePasskey(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/passkeys/${encodeURIComponent(id)}`));
  }

  listSessions(): Promise<SessionInfo[]> {
    return firstValueFrom(this.http.get<SessionInfo[]>(`${this.baseUrl}/sessions`));
  }

  /** Signs out every other session. */
  endOtherSessions(): Promise<{ ended: number }> {
    return firstValueFrom(this.http.delete<{ ended: number }>(`${this.baseUrl}/sessions`));
  }

  async endSession(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${this.baseUrl}/sessions/${encodeURIComponent(id)}`));
  }
}
