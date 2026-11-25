import {
  ChangeDetectionStrategy,
  Component,
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
import { ApiService } from '../../core/api.service';
import { WatchedRepository } from '../../core/models';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { Switch } from '../../shared/switch';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';
import { WebSourceDraft, WebSourceForm } from './web-source-form';

/** Adds a web page, feed or JSON API to watch for new versions (edited later in the repository settings). */
@Component({
  selector: 'app-web-source-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon, Switch, UnsavedChanges, WebSourceForm],
  templateUrl: './web-source.dialog.html',
  styleUrl: './web-source.dialog.scss',
})
export class WebSourceDialog {
  private readonly api = inject(ApiService);

  /** Whether the dialog is open; every opening starts with an empty form. */
  readonly open = input(false);
  readonly saved = output<WatchedRepository>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly draft = signal(new WebSourceDraft());
  protected readonly includePrereleases = signal(false);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  /** The form as opened, to tell whether it has unsaved changes. */
  private savedValues: unknown = null;

  constructor() {
    effect(() => {
      const open = this.open();
      const dialog = this.dialog().nativeElement;
      if (open) {
        untracked(() => {
          this.draft.set(new WebSourceDraft());
          this.includePrereleases.set(false);
          this.saveError.set(null);
          this.savedValues = this.values();
        });
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  private values(): unknown {
    return [this.draft().values(), this.includePrereleases()];
  }

  /** Whether the form differs from the empty one (read by the template on every check). */
  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  protected async save(): Promise<void> {
    const draft = this.draft();
    if (this.saving()) {
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    draft.errors.set({});
    try {
      const created = await firstValueFrom(
        this.api.addRepository({
          name: draft.name().trim(),
          webSource: draft.webSource(),
          versionPattern: draft.versionPattern(),
          includePrereleases: this.includePrereleases(),
        }),
      );
      this.saved.emit(created);
    } catch (error) {
      this.saveError.set(draft.fail(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected close(): void {
    this.closed.emit();
  }
}
