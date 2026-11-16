import { HttpErrorResponse } from '@angular/common/http';
import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { describeError } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Icon } from '../../shared/icon';

/** Sign-in with the password or a passkey. */
@Component({
  selector: 'app-login-page',
  imports: [FormsModule, Icon],
  templateUrl: './login.page.html',
  styleUrl: './auth.scss',
})
export class LoginPage {
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  /** Where to go after signing in (query parameter set by the guard/interceptor). */
  readonly returnUrl = input<string | undefined>();

  protected username = '';
  protected password = '';
  protected readonly busy = signal<'password' | 'passkey' | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly showPasskey = () =>
    this.auth.passkeysSupported && (this.auth.state()?.hasPasskeys ?? false);

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
