import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { describeError, fieldErrors } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { PasskeyInfo, SessionInfo } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { Switch } from '../../shared/switch';
import { MIN_PASSWORD_LENGTH } from '../auth/setup.page';

/** The single account: user name, password, passkeys and signed-in sessions. */
@Component({
  selector: 'app-account-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon, RelativeTimePipe, Switch],
  templateUrl: './account.page.html',
  styleUrl: './account.page.scss',
})
export class AccountPage implements OnInit {
  protected readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  protected readonly minLength = MIN_PASSWORD_LENGTH;
  protected readonly now = signal(Date.now());

  // Account form
  protected username = '';
  protected currentPassword = '';
  protected newPassword = '';
  protected confirmPassword = '';
  protected readonly savingAccount = signal(false);
  protected readonly errors = signal<Record<string, string>>({});

  // Passkeys
  protected readonly passkeys = signal<PasskeyInfo[]>([]);
  protected newPasskeyName = '';
  protected readonly addingPasskey = signal(false);
  protected readonly passkeyError = signal<string | null>(null);
  protected readonly renaming = signal<string | null>(null);
  protected renameValue = '';
  protected readonly confirmDelete = signal<string | null>(null);

  // Password sign-in (off = passkeys only)
  protected readonly passwordLogin = computed(() => this.auth.state()?.passwordLogin ?? true);
  /** The value being confirmed with the current password; null = no change in progress. */
  protected readonly passwordLoginTarget = signal<boolean | null>(null);
  protected passwordLoginPassword = '';
  protected readonly savingPasswordLogin = signal(false);
  protected readonly passwordLoginError = signal<string | null>(null);

  // Sessions
  protected readonly sessions = signal<SessionInfo[]>([]);

  async ngOnInit(): Promise<void> {
    this.username = this.auth.username() ?? '';
    this.newPasskeyName = defaultPasskeyName();
    try {
      const [passkeys, sessions] = await Promise.all([
        this.auth.listPasskeys(),
        this.auth.listSessions(),
      ]);
      this.passkeys.set(passkeys);
      this.sessions.set(sessions);
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected async saveAccount(): Promise<void> {
    const errors: Record<string, string> = {};
    if (!this.currentPassword) {
      errors['currentPassword'] = 'Enter your current password.';
    }
    if (this.newPassword) {
      if (this.newPassword.length < MIN_PASSWORD_LENGTH) {
        errors['newPassword'] = `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
      } else if (this.newPassword !== this.confirmPassword) {
        errors['confirmPassword'] = 'The passwords do not match.';
      }
    }
    this.errors.set(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    this.savingAccount.set(true);
    try {
      const passwordChanged = !!this.newPassword;
      await this.auth.updateAccount({
        currentPassword: this.currentPassword,
        username: this.username.trim(),
        ...(passwordChanged ? { newPassword: this.newPassword } : {}),
      });
      this.currentPassword = this.newPassword = this.confirmPassword = '';
      this.username = this.auth.username() ?? this.username;
      this.toast.success(
        passwordChanged ? 'Password changed – other sessions were signed out.' : 'Account saved.',
      );
      if (passwordChanged) {
        await this.reloadSessions();
      }
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) {
        this.errors.set(fields);
      } else {
        this.toast.error(error);
      }
    } finally {
      this.savingAccount.set(false);
    }
  }

  protected async addPasskey(): Promise<void> {
    this.addingPasskey.set(true);
    this.passkeyError.set(null);
    try {
      this.passkeys.set(await this.auth.addPasskey(this.newPasskeyName.trim() || 'Passkey'));
      this.newPasskeyName = defaultPasskeyName();
      this.toast.success('Passkey added – you can sign in with it now.');
    } catch (error) {
      this.passkeyError.set(
        error instanceof DOMException && error.name === 'NotAllowedError'
          ? 'The passkey prompt was cancelled or timed out.'
          : describeError(error),
      );
    } finally {
      this.addingPasskey.set(false);
    }
  }

  protected startPasswordLoginChange(): void {
    this.passwordLoginPassword = '';
    this.passwordLoginError.set(null);
    this.passwordLoginTarget.set(!this.passwordLogin());
  }

  protected async savePasswordLogin(): Promise<void> {
    const target = this.passwordLoginTarget();
    if (target === null || this.savingPasswordLogin()) {
      return;
    }
    if (!this.passwordLoginPassword) {
      this.passwordLoginError.set('Enter your current password.');
      return;
    }
    this.savingPasswordLogin.set(true);
    this.passwordLoginError.set(null);
    try {
      await this.auth.updateAccount({
        currentPassword: this.passwordLoginPassword,
        passwordLogin: target,
      });
      this.passwordLoginPassword = '';
      this.passwordLoginTarget.set(null);
      this.toast.success(
        target
          ? 'Password sign-in turned on.'
          : 'Password sign-in turned off – only passkeys sign in now.',
      );
      if (!target) {
        await this.reloadSessions();
      }
    } catch (error) {
      this.passwordLoginError.set(fieldErrors(error)?.['currentPassword'] ?? describeError(error));
    } finally {
      this.savingPasswordLogin.set(false);
    }
  }

  protected startRename(passkey: PasskeyInfo): void {
    this.renaming.set(passkey.id);
    this.renameValue = passkey.name;
  }

  protected async rename(passkey: PasskeyInfo): Promise<void> {
    try {
      this.passkeys.set(await this.auth.renamePasskey(passkey.id, this.renameValue));
      this.renaming.set(null);
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected async deletePasskey(passkey: PasskeyInfo): Promise<void> {
    this.confirmDelete.set(null);
    try {
      await this.auth.deletePasskey(passkey.id);
      this.passkeys.update((list) => list.filter((p) => p.id !== passkey.id));
      if (this.passkeys().length === 0) {
        this.auth.state.update((s) => (s ? { ...s, hasPasskeys: false } : s));
      }
      this.toast.success(`Passkey "${passkey.name}" removed.`);
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected async endSession(session: SessionInfo): Promise<void> {
    try {
      await this.auth.endSession(session.id);
      this.sessions.update((list) => list.filter((s) => s.id !== session.id));
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected async endOtherSessions(): Promise<void> {
    try {
      const { ended } = await this.auth.endOtherSessions();
      this.toast.success(ended > 0 ? `Signed out ${ended} other session(s).` : 'No other sessions.');
      await this.reloadSessions();
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }

  protected methodLabel(method: SessionInfo['method']): string {
    return method === 'passkey' ? 'Passkey' : method === 'setup' ? 'Setup' : 'Password';
  }

  /** "Firefox on Windows"-style summary of a user agent. */
  protected browserOf(userAgent: string | null): string {
    if (!userAgent) {
      return 'Unknown browser';
    }
    const browser =
      /Edg\//.test(userAgent) ? 'Edge'
      : /OPR\//.test(userAgent) ? 'Opera'
      : /Firefox\//.test(userAgent) ? 'Firefox'
      : /Chrome\//.test(userAgent) ? 'Chrome'
      : /Safari\//.test(userAgent) ? 'Safari'
      : null;
    const os =
      /Windows/.test(userAgent) ? 'Windows'
      : /Android/.test(userAgent) ? 'Android'
      : /iPhone|iPad/.test(userAgent) ? 'iOS'
      : /Mac OS X/.test(userAgent) ? 'macOS'
      : /Linux/.test(userAgent) ? 'Linux'
      : null;
    return browser && os ? `${browser} on ${os}` : (browser ?? os ?? userAgent.slice(0, 60));
  }

  private async reloadSessions(): Promise<void> {
    this.sessions.set(await this.auth.listSessions());
  }
}

function defaultPasskeyName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const device =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : 'This device';
  return `${device} passkey`;
}
