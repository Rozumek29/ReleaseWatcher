import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
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
import { ApiService, describeError, fieldErrors } from '../../core/api.service';
import { AddGitRepositoryRequest, ReleaseSourceKind, WatchedRepository } from '../../core/models';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { unknownRepositoryHost } from '../../shared/repository-host';
import { Switch } from '../../shared/switch';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';
import { versionPatternError } from '../../shared/version-pattern';

type Provider = NonNullable<AddGitRepositoryRequest['provider']>;
/** Fields the server reports validation errors for. */
type Field = 'repository' | 'provider' | 'releaseSource' | 'versionPattern' | 'accessToken';
const FIELDS: readonly string[] = [
  'repository',
  'provider',
  'releaseSource',
  'versionPattern',
  'accessToken',
];

/** Adds a repository on GitHub, Gitea/Forgejo or GitLab to watch. */
@Component({
  selector: 'app-add-repository-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon, Switch, UnsavedChanges],
  templateUrl: './add-repository.dialog.html',
  styleUrl: './add-repository.dialog.scss',
})
export class AddRepositoryDialog {
  private readonly api = inject(ApiService);

  /** Whether the dialog is open; every opening starts with an empty form. */
  readonly open = input(false);
  readonly saved = output<WatchedRepository>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly repository = signal('');
  /** Host of the entered URL when its provider is not known (then Gitea/Forgejo or GitLab can be chosen). */
  protected readonly host = computed(() => unknownRepositoryHost(this.repository()));
  protected readonly provider = signal<'' | Provider>('');
  protected readonly includePrereleases = signal(false);
  protected readonly releaseSource = signal<ReleaseSourceKind>('releases');
  protected readonly versionPattern = signal('');
  protected readonly patternError = computed(() => versionPatternError(this.versionPattern()));
  /** Token of a private repository the global token cannot read, or one on another host. */
  protected readonly token = signal('');
  /** Whether the token is shown as plain text. */
  protected readonly showToken = signal(false);

  protected readonly errors = signal<Partial<Record<Field, string>>>({});
  /** The provider can be chosen for an unknown host, or when the server could not detect it. */
  protected readonly showProvider = computed(() => !!this.host() || !!this.errors().provider);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  /** The empty form, to tell whether it has unsaved changes. */
  private savedValues: unknown = null;

  constructor() {
    effect(() => {
      const open = this.open();
      const dialog = this.dialog().nativeElement;
      if (open) {
        untracked(() => {
          this.repository.set('');
          this.provider.set('');
          this.includePrereleases.set(false);
          this.releaseSource.set('releases');
          this.versionPattern.set('');
          this.token.set('');
          this.showToken.set(false);
          this.errors.set({});
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
    return [
      this.repository().trim(),
      this.provider(),
      this.includePrereleases(),
      this.releaseSource(),
      this.versionPattern().trim(),
      this.token().trim(),
    ];
  }

  /** Whether the form differs from the empty one (read by the template on every check). */
  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  protected async save(): Promise<void> {
    const repository = this.repository().trim();
    if (this.saving()) {
      return;
    }
    if (!repository) {
      this.errors.set({ repository: 'Enter owner/repo or the URL of a repository.' });
      return;
    }
    if (this.patternError()) {
      this.errors.set({});
      this.saveError.set('Fix the version pattern first.');
      return;
    }
    const provider = this.showProvider() ? this.provider() : '';
    const pattern = this.versionPattern().trim();
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const created = await firstValueFrom(
        this.api.addRepository({
          repository,
          includePrereleases: this.includePrereleases(),
          ...(provider ? { provider } : {}),
          ...(this.releaseSource() === 'tags' ? { releaseSource: 'tags' as const } : {}),
          ...(pattern ? { versionPattern: pattern } : {}),
          ...(this.token().trim() ? { accessToken: this.token().trim() } : {}),
        }),
      );
      this.saved.emit(created);
    } catch (error) {
      this.fail(error);
    } finally {
      this.saving.set(false);
    }
  }

  /** Shows validation errors at their fields; anything else (e.g. a host that can't be reached) above the buttons. */
  private fail(error: unknown): void {
    const errors = fieldErrors(error);
    if (!errors) {
      this.saveError.set(describeError(error));
      return;
    }
    const shown: Partial<Record<Field, string>> = {};
    const rest: string[] = [];
    for (const [key, message] of Object.entries(errors)) {
      if (FIELDS.includes(key)) {
        shown[key as Field] = message;
      } else {
        rest.push(message);
      }
    }
    this.errors.set(shown);
    this.saveError.set(rest.length > 0 ? rest.join(' ') : null);
  }

  protected close(): void {
    this.closed.emit();
  }
}
