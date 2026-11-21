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
import { ApiService, describeError } from '../../core/api.service';
import { HeaderInput, InstalledVersionTestResult, WatchedRepository } from '../../core/models';

/** Editable header row. `saved` = a value exists on the server; an empty value field keeps it. */
interface HeaderRow {
  id: number;
  name: string;
  value: string;
  saved: boolean;
}
import { Avatar } from '../../shared/avatar';
import { Icon } from '../../shared/icon';
import { OSV_ECOSYSTEMS } from '../../shared/severity';
import { Switch } from '../../shared/switch';
import { BackdropClose } from '../../shared/backdrop-close';

/** Per-repository settings, including the URL of the installed (self-hosted) app's version endpoint. */
@Component({
  selector: 'app-repository-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Avatar, Icon, Switch],
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
  private nextHeaderId = 1;

  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  protected readonly testResult = signal<InstalledVersionTestResult | null>(null);
  protected readonly testError = signal<string | null>(null);
  protected readonly saveError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const repo = this.repository();
      const dialog = this.dialog().nativeElement;
      if (repo) {
        this.url = repo.installedVersionUrl ?? '';
        this.field = repo.installedVersionField ?? '';
        this.includePrereleases = repo.includePrereleases;
        this.isEnabled = repo.isEnabled;
        this.token = '';
        this.removeToken = false;
        this.osvEcosystem = repo.osvEcosystem ?? '';
        this.osvPackage = repo.osvPackage ?? '';
        this.headers = repo.installedVersionHeaders.map((h) => ({ id: this.nextHeaderId++, name: h.name, value: '', saved: h.hasValue }));
        this.showValues.set(false);
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
    try {
      const updated = await firstValueFrom(
        this.api.updateRepository(repo.id, {
          includePrereleases: this.includePrereleases,
          isEnabled: this.isEnabled,
          installedVersionUrl: this.url.trim() || null,
          installedVersionField: this.field.trim() || null,
          installedVersionHeaders: this.headerInputs(),
          // The token is never sent back to the UI: empty = keep, "Remove" = null.
          ...(this.token.trim() ? { githubToken: this.token.trim() } : this.removeToken ? { githubToken: null } : {}),
          // Both or neither: an ecosystem without a package removes the OSV.dev package.
          osvEcosystem: hasOsv ? this.osvEcosystem : null,
          osvPackage: hasOsv ? this.osvPackage.trim() : null,
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
