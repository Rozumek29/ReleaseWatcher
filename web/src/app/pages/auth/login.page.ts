import { HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { describeError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Icon } from '../../shared/icon';

/**
 * Sign-in with the password, a passkey or single sign-on. Without password sign-in and single sign-on the passkey prompt
 * opens right away.
 */
@Component({
  selector: 'app-login-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon],
  templateUrl: './login.page.html',
  styleUrl: './auth.scss',
})
export class LoginPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Where to go after signing in (query parameter set by the guard/interceptor). */
  readonly returnUrl = input<string | undefined>();
  /** Set by the server when single sign-on failed (it redirects here). */
  readonly ssoError = input<string | undefined>();

  protected username = '';
  protected password = '';
  protected readonly busy = signal<'password' | 'passkey' | 'sso' | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly showPasskey = () =>
    this.auth.passkeysSupported && (this.auth.state()?.hasPasskeys ?? false);
  /** False when the password does not sign in. */
  protected readonly passwordLogin = computed(() => this.auth.state()?.passwordLogin ?? true);
  /** Name of the single sign-on provider, or null when it is not available. */
  protected readonly sso = computed(() => this.auth.state()?.oidcLogin ?? null);
  /** What signs in when the password does not: "a passkey", "Pocket ID" or "a passkey or Pocket ID". */
  protected readonly alternatives = computed(() => {
    const sso = this.sso();
    return sso && this.showPasskey() ? `a passkey or ${sso}` : (sso ?? 'a passkey');
  });

  ngOnInit(): void {
    const ssoError = this.ssoError();
    if (ssoError) {
      this.error.set(ssoError);
      // Drop the message from the address bar, so a reload does not show it again.
      void this.router.navigate([], { queryParams: { ssoError: null }, queryParamsHandling: 'merge', replaceUrl: true });
    }
    // Passkeys only: open the prompt without a click – except right after signing out or a failed single sign-on,
    // where it would be in the way.
    const signedOut = this.auth.takeSignedOutByUser();
    if (!this.passwordLogin() && !this.sso() && this.auth.passkeysSupported && !signedOut && !ssoError) {
      void this.signInWithPasskey();
    }
  }

  protected async signInWithSso(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set('sso');
    this.error.set(null);
    try {
      await this.auth.loginWithSso(); // leaves the page; the busy state stays until then
    } catch (error) {
      this.error.set(describeError(error));
      this.busy.set(null);
    }
  }

  protected async signIn(): Promise<void> {
    if (!this.username.trim() || !this.password || this.busy()) {
      return;
    }
    await this.run('password', () => this.auth.login(this.username.trim(), this.password));
  }

  protected async signInWithPasskey(): Promise<void> {
    if (this.busy()) {
      return;
    }
    await this.run('passkey', () => this.auth.loginWithPasskey());
  }

  private async run(kind: 'password' | 'passkey', action: () => Promise<void>): Promise<void> {
    this.busy.set(kind);
    this.error.set(null);
    try {
      await action();
      this.password = '';
      await this.router.navigateByUrl(this.safeReturnUrl());
    } catch (error) {
      this.error.set(this.describe(error, kind));
      if (error instanceof HttpErrorResponse && error.status === 409 && kind === 'password') {
        void this.auth.load(); // password sign-in was turned off meanwhile – show the passkey screen
      }
    } finally {
      this.busy.set(null);
    }
  }

  private describe(error: unknown, kind: 'password' | 'passkey'): string {
    if (error instanceof HttpErrorResponse && error.status === 429) {
      return describeError(error); // "Too many failed attempts – try again in N s."
    }
    if (error instanceof HttpErrorResponse && error.status === 401 && kind === 'password') {
      return 'Wrong user name or password.';
    }
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      return 'The passkey prompt was cancelled or timed out.';
    }
    return describeError(error);
  }

  /** Only paths inside the app – never an absolute URL to another site. */
  private safeReturnUrl(): string {
    const url = this.returnUrl();
    // Only paths inside the app: no "//host" or "/\host" (browsers treat "\" as "/"), no loop back to /login.
    return url && url.startsWith('/') && !/^\/[/\\]/.test(url) && !url.startsWith('/login') ? url : '/';
  }
}
