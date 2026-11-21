import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { describeError, fieldErrors } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { Icon } from '../../shared/icon';

export const MIN_PASSWORD_LENGTH = 10;

/** First run: creates the only account (needs the one-time setup code printed by the server). */
@Component({
  selector: 'app-setup-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, Icon],
  templateUrl: './setup.page.html',
  styleUrl: './auth.scss',
})
export class SetupPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly minLength = MIN_PASSWORD_LENGTH;
  protected code = '';
  protected username = 'admin';
  protected password = '';
  protected confirm = '';
  protected readonly saving = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly error = signal<string | null>(null);

  protected async create(): Promise<void> {
    if (this.saving()) {
      return;
    }
    const errors: Record<string, string> = {};
    if (!this.code.trim()) {
      errors['code'] = 'Enter the setup code.';
    }
    if (this.password.length < MIN_PASSWORD_LENGTH) {
      errors['password'] = `The password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
    } else if (this.password !== this.confirm) {
      errors['confirm'] = 'The passwords do not match.';
    }
    this.errors.set(errors);
    this.error.set(null);
    if (Object.keys(errors).length > 0) {
      return;
    }

    this.saving.set(true);
    try {
      await this.auth.setup(this.code.trim(), this.username.trim(), this.password);
      await this.router.navigateByUrl('/');
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) {
        this.errors.set(fields);
      } else {
        this.error.set(describeError(error));
      }
    } finally {
      this.saving.set(false);
    }
  }
}
