import { DatePipe } from '@angular/common';
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
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import { SecurityAdvisory, WatchedRepository } from '../../core/models';
import { Avatar } from '../../shared/avatar';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { impactRank, SEVERITY_LABELS, SOURCE_LABELS } from '../../shared/severity';

/** Security advisories (GHSA) of one repository, with their impact on the installed version. */
@Component({
  selector: 'app-advisories-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, DatePipe, Avatar, Icon, RelativeTimePipe],
  templateUrl: './advisories.dialog.html',
  styleUrl: './advisories.dialog.scss',
})
export class AdvisoriesDialog {
  private readonly api = inject(ApiService);

  /** Repository whose advisories are shown; null closes the dialog. */
  readonly repository = input<WatchedRepository | null>(null);
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly advisories = signal<SecurityAdvisory[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Advisories affecting the installed version first, then newest first (as sent by the server). */
  protected readonly sorted = computed(() =>
    [...this.advisories()].sort((a, b) => impactRank(b.affectsInstalled) - impactRank(a.affectsInstalled)),
  );

  protected readonly severityLabels = SEVERITY_LABELS;
  protected readonly sourceLabels = SOURCE_LABELS;

  constructor() {
    effect(() => {
      const repo = this.repository();
      const dialog = this.dialog().nativeElement;
      if (repo) {
        void this.load(repo.id);
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  protected close(): void {
    const dialog = this.dialog().nativeElement;
    if (dialog.open) {
      dialog.close();
    }
    this.closed.emit();
  }

  private async load(id: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.advisories.set([]);
    try {
      const advisories = await firstValueFrom(this.api.getAdvisories(id));
      // Ignore a late answer for a repository that is no longer shown.
      if (this.repository()?.id === id) {
        this.advisories.set(advisories);
      }
    } catch (error) {
      this.error.set(describeError(error));
    } finally {
      this.loading.set(false);
    }
  }
}
