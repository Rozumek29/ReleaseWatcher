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
import { SshKey } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** `add` pastes a private key, `generate` creates a key pair on the server, `rename` changes the name. */
export type SshKeyDialogMode = { kind: 'add' } | { kind: 'generate' } | { kind: 'rename'; key: SshKey };

/** Adds, generates or renames a named SSH key. A generated key shows its public key before the dialog closes. */
@Component({
  selector: 'app-ssh-key-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon, UnsavedChanges],
  templateUrl: './ssh-key.dialog.html',
  styleUrl: './ssh-key.dialog.scss',
})
export class SshKeyDialog {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** What to do; null closes the dialog. */
  readonly mode = input<SshKeyDialogMode | null>(null);
  readonly saved = output<SshKey>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected name = '';
  protected privateKey = '';
  /** The key just generated (its public key is shown). */
  protected readonly generated = signal<SshKey | null>(null);
  protected readonly saving = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly saveError = signal<string | null>(null);
  /** The form as opened, to tell whether it has unsaved changes. */
  private savedValues: unknown = null;

  constructor() {
    effect(() => {
      const mode = this.mode();
      const dialog = this.dialog().nativeElement;
      if (mode) {
        this.name = mode.kind === 'rename' ? mode.key.name : '';
        this.privateKey = '';
        this.savedValues = this.values();
        this.generated.set(null);
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
    return [this.name, this.privateKey];
  }

  /** Whether the form differs from what it was opened with (read by the template on every check). */
  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  protected title(mode: SshKeyDialogMode): string {
    return mode.kind === 'add' ? 'Add SSH key' : mode.kind === 'generate' ? 'Generate SSH key' : 'Rename SSH key';
  }

  protected async save(): Promise<void> {
    const mode = this.mode();
    if (!mode) return;
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const name = this.name.trim();
      const key = await firstValueFrom(
        mode.kind === 'add'
          ? this.api.addSshKey(name, this.privateKey)
          : mode.kind === 'generate'
            ? this.api.generateSshKey(name)
            : this.api.renameSshKey(mode.key.id, name),
      );
      // Not kept in memory longer than needed.
      this.privateKey = '';
      if (mode.kind === 'generate') {
        this.generated.set(key);
      }
      this.saved.emit(key);
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

  protected async copy(publicKey: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(publicKey);
      this.toast.success('Public key copied.');
    } catch {
      this.toast.error('Copying failed – select the key and copy it by hand.');
    }
  }

  protected close(): void {
    this.privateKey = '';
    this.closed.emit();
  }
}
