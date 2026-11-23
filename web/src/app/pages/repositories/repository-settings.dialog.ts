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
import {
  HeaderInput,
  InstalledVersionSource,
  InstalledVersionTestResult,
  WatchedRepository,
} from '../../core/models';

/** Editable header row. `saved` = a value exists on the server; an empty value field keeps it. */
interface HeaderRow {
  id: number;
  name: string;
  value: string;
  saved: boolean;
}
import { Avatar } from '../../shared/avatar';
import { IconPickerDialog } from '../../shared/icon-picker.dialog';
import { iconUrls } from '../../shared/icon-urls';
import { Icon } from '../../shared/icon';
import { OSV_ECOSYSTEMS } from '../../shared/severity';
import { Switch } from '../../shared/switch';
import { BackdropClose } from '../../shared/backdrop-close';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** Per-repository settings, including the URL of the installed (self-hosted) app's version endpoint. */
@Component({
  selector: 'app-repository-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Avatar, Icon, IconPickerDialog, Switch, UnsavedChanges],
  templateUrl: './repository-settings.dialog.html',
  styleUrl: './repository-settings.dialog.scss',
})
export class RepositorySettingsDialog {
  private readonly api = inject(ApiService);

  /** Repository being edited; null closes the dialog. */
  readonly repository = input<WatchedRepository | null>(null);
  readonly saved = output<WatchedRepository>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  /** Where the installed version comes from. */
  protected source: InstalledVersionSource = 'none';
  /** Installed version entered by hand (source = manual). */
  protected manualVersion = '';
  protected url = '';
  protected field = '';
  protected includePrereleases = false;
  protected isEnabled = true;
  protected headers: HeaderRow[] = [];
  /** New repository token; empty keeps the saved one. */
  protected token = '';
  protected removeToken = false;
  protected osvEcosystem = '';
  protected osvPackage = '';
  protected readonly ecosystems = OSV_ECOSYSTEMS;
  protected readonly showValues = signal(false);
  /** Custom icon as typed (URL or `sh:<slug>`); the header previews it. */
  protected readonly icon = signal('');
  protected readonly iconPreview = computed(() => iconUrls(this.icon()));
  /** Value the icon picker opens with; null = closed. */
  protected readonly picking = signal<string | null>(null);
  private nextHeaderId = 1;
  /** The form as opened, to tell whether it has unsaved changes. */
  private savedValues: unknown = null;

  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<InstalledVersionTestResult | null>(null);
  protected readonly testError = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);

  /** The form values compared by `changed()` (header ids are left out). */
  private values(): unknown {
    return [
      this.source,
      this.manualVersion,
      this.url,
      this.field,
      this.includePrereleases,
      this.isEnabled,
      this.headers.map((h) => [h.name, h.value, h.saved]),
      this.token,
      this.removeToken,
      this.osvEcosystem,
      this.osvPackage,
      this.icon(),
    ];
  }

  /** Whether the form differs from the saved repository (read by the template on every check). */
  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  constructor() {
    effect(() => {
      const repo = this.repository();
      const dialog = this.dialog().nativeElement;
      if (repo) {
        this.source = repo.installedVersionSource;
        this.manualVersion = repo.installedVersionSource === 'manual' ? (repo.installedVersion ?? '') : '';
        this.url = repo.installedVersionUrl ?? '';
        this.field = repo.installedVersionField ?? '';
        this.includePrereleases = repo.includePrereleases;
        this.isEnabled = repo.isEnabled;
        this.token = '';
        this.removeToken = false;
        this.osvEcosystem = repo.osvEcosystem ?? '';
        this.osvPackage = repo.osvPackage ?? '';
        this.icon.set(repo.icon ?? '');
        this.picking.set(null);
        this.headers = repo.installedVersionHeaders.map((h) => ({ id: this.nextHeaderId++, name: h.name, value: '', saved: h.hasValue }));
        this.showValues.set(false);
        this.savedValues = untracked(() => this.values());
        this.testResult.set(null);
        this.testError.set(null);
        this.saveError.set(null);
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  protected async test(): Promise<void> {
    if (!this.url.trim()) {
      return;
    }
    this.testing.set(true);
    this.testResult.set(null);
    this.testError.set(null);
    try {
      this.testResult.set(
        await firstValueFrom(
          this.api.testInstalledVersion(this.url.trim(), this.field.trim() || null, this.headerInputs(), this.repository()?.id ?? null),
        ),
      );
    } catch (error) {
      this.testError.set(describeError(error));
    } finally {
      this.testing.set(false);
    }
  }

  protected async save(): Promise<void> {
    const repo = this.repository();
    if (!repo) {
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    const hasOsv = !!this.osvEcosystem && !!this.osvPackage.trim();
    const fromUrl = this.source === 'url';
    try {
      const updated = await firstValueFrom(
        this.api.updateRepository(repo.id, {
          includePrereleases: this.includePrereleases,
          isEnabled: this.isEnabled,
          installedVersionUrl: fromUrl ? this.url.trim() || null : null,
          installedVersionField: fromUrl ? this.field.trim() || null : null,
          installedVersionHeaders: fromUrl ? this.headerInputs() : [],
          // A version read from the URL is not sent back; otherwise the value entered by hand (or none).
          ...(fromUrl ? {} : { installedVersion: this.source === 'manual' ? this.manualVersion.trim() || null : null }),
          // The token is never sent back to the UI: empty = keep, "Remove" = null.
          ...(this.token.trim() ? { githubToken: this.token.trim() } : this.removeToken ? { githubToken: null } : {}),
          // Both or neither: an ecosystem without a package removes the OSV.dev package.
          osvEcosystem: hasOsv ? this.osvEcosystem : null,
          osvPackage: hasOsv ? this.osvPackage.trim() : null,
          icon: this.icon().trim() || null,
        }),
      );
      this.saved.emit(updated);
    } catch (error) {
      this.saveError.set(describeError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected addHeader(name = '', value = ''): void {
    this.headers = [...this.headers, { id: this.nextHeaderId++, name, value, saved: false }];
  }

  protected removeHeader(row: HeaderRow): void {
    this.headers = this.headers.filter((h) => h !== row);
  }

  protected hasAuthorization(): boolean {
    return this.headers.some((h) => h.name.trim().toLowerCase() === 'authorization');
  }

  protected addAuthorization(): void {
    if (!this.headers.some((h) => h.name.toLowerCase() === 'authorization')) {
      this.addHeader('Authorization', 'Bearer ');
    }
  }

  /** Rows with a name; an untouched saved value is sent as null so the server keeps the secret. */
  private headerInputs(): HeaderInput[] {
    return this.headers
      .filter((h) => h.name.trim())
      .map((h) => ({ name: h.name.trim(), value: h.saved && !h.value ? null : h.value }));
  }

  protected close(): void {
    this.closed.emit();
  }
}
