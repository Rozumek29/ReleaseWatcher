import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError, fieldErrors } from '../../core/api.service';
import { GitHostProvider, GitHostToken } from '../../core/models';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** `token: null` adds a new token, otherwise that one is edited. */
export interface GitHostTokenDialogData {
  token: GitHostToken | null;
}

/** Adds or edits the access token of a Gitea/Forgejo or GitLab host. */
@Component({
  selector: 'app-git-host-token-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon, UnsavedChanges],
  templateUrl: './git-host-token.dialog.html',
  styleUrl: './git-host-token.dialog.scss',
})
export class GitHostTokenDialog {
  private readonly api = inject(ApiService);

  /** What to edit; null closes the dialog. */
  readonly data = input<GitHostTokenDialogData | null>(null);
  readonly saved = output<GitHostToken>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected provider: GitHostProvider = 'gitea';
  protected host = '';
  protected token = '';
  protected readonly showToken = signal(false);
  protected readonly saving = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly saveError = signal<string | null>(null);
  /** The form as opened, to tell whether it has unsaved changes. */
  private savedValues: unknown = null;

  constructor() {
    effect(() => {
      const data = this.data();
      const dialog = this.dialog().nativeElement;
      if (data) {
        this.provider = data.token?.provider ?? 'gitea';
        this.host = data.token?.host ?? '';
        this.token = '';
        this.savedValues = this.values();
        this.showToken.set(false);
        this.errors.set({});
        this.saveError.set(null);
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  private values(): unknown {
    return [this.provider, this.host, this.token];
  }

  /** Whether the form differs from what it was opened with (read by the template on every check). */
  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  protected async save(): Promise<void> {
    const data = this.data();
    if (!data) return;
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const host = this.host.trim();
      const token = this.token.trim();
      const saved = await firstValueFrom(
        data.token
          ? this.api.updateGitHostToken(data.token.id, {
              provider: this.provider,
              host,
              ...(token ? { token } : {}),
            })
          : this.api.addGitHostToken({ provider: this.provider, host, token }),
      );
      // Not kept in memory longer than needed.
      this.token = '';
      this.saved.emit(saved);
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) {
        this.errors.set(fields);
      } else {
        this.saveError.set(describeError(error));
      }
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.token = '';
    this.closed.emit();
  }
}
