import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import { RepositoryGroup } from '../../core/models';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { IconPickerDialog } from '../../shared/icon-picker.dialog';
import { iconUrls } from '../../shared/icon-urls';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** Options of a custom repository group: its name and icon, or removing it (its repositories stay). */
@Component({
  selector: 'app-repository-group-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, BackdropClose, Icon, IconPickerDialog, UnsavedChanges],
  templateUrl: './repository-group.dialog.html',
  styleUrl: './repository-group.dialog.scss',
})
export class RepositoryGroupDialog {
  private readonly api = inject(ApiService);

  /** Group being edited; null closes the dialog. */
  readonly group = input<RepositoryGroup | null>(null);
  readonly saved = output<RepositoryGroup>();
  readonly removed = output<RepositoryGroup>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly name = signal('');
  /** Custom icon as typed (URL or `sh:<slug>`); the header previews it. */
  protected readonly icon = signal('');
  protected readonly iconPreview = computed(() => iconUrls(this.icon()));
  /** Index of the preview image that failed to load last; the next one is tried, then the folder. */
  protected readonly failed = signal(-1);
  protected readonly previewUrl = computed(() => this.iconPreview()[this.failed() + 1] ?? null);
  /** Value the icon picker opens with; null = closed. */
  protected readonly picking = signal<string | null>(null);
  protected readonly confirmRemove = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  private readonly savedValues = signal<[string, string]>(['', '']);

  /** Whether the form differs from the saved group. */
  protected readonly changed = computed(() => !sameValues([this.name(), this.icon()], this.savedValues()));

  constructor() {
    effect(() => {
      const group = this.group();
      const dialog = this.dialog().nativeElement;
      if (group) {
        untracked(() => {
          this.name.set(group.name);
          this.icon.set(group.icon ?? '');
          this.savedValues.set([group.name, group.icon ?? '']);
          this.failed.set(-1);
          this.picking.set(null);
          this.confirmRemove.set(false);
          this.saveError.set(null);
        });
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  protected setIcon(value: string): void {
    this.icon.set(value);
    this.failed.set(-1);
  }

  protected async save(): Promise<void> {
    const group = this.group();
    const name = this.name().trim();
    if (!group || this.saving()) return;
    if (!name) {
      this.saveError.set('Enter a name for the group.');
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const updated = await firstValueFrom(
        this.api.updateRepositoryGroup(group.id, { name, icon: this.icon().trim() || null }),
      );
      this.saved.emit(updated);
    } catch (error) {
      this.saveError.set(describeError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const group = this.group();
    if (!group || this.saving()) return;
    this.saving.set(true);
    this.saveError.set(null);
    try {
      await firstValueFrom(this.api.deleteRepositoryGroup(group.id));
      this.removed.emit(group);
    } catch (error) {
      this.confirmRemove.set(false);
      this.saveError.set(describeError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.closed.emit();
  }
}
