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
  MachineAppGroup,
  MachineAppOption,
  MachineAppRef,
  WatchedRepository,
} from '../../core/models';

/** Key of a machine (`target:3`, `endpoint:1`) or an app (`app:5`, `docker:7`) in the selects. */
const machineKey = (m: MachineAppGroup['machine']): string => `${m.kind}:${m.id}`;
const appKey = (a: MachineAppRef): string => `${a.kind}:${a.id}`;

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
  /** Machine and app the installed version is read from (source = machine); keys as built by `machineKey` / `appKey`. */
  protected machine = '';
  protected app = '';
  /** Apps on machines to choose from; null = not loaded (yet). */
  protected readonly machines = signal<MachineAppGroup[] | null>(null);
  protected readonly machinesError = signal<string | null>(null);
  protected readonly machineKey = machineKey;
  protected readonly appKey = appKey;
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
      this.machine,
      this.app,
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
        const current = repo.installedVersionApp;
        this.app = current ? appKey(current) : '';
        this.machine = '';
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
        this.machines.set(null);
        if (this.source === 'machine') {
          void this.loadMachines(repo);
        }
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  /** Loads the apps on machines and selects the machine of the current app (a default: the snapshot follows). */
  private async loadMachines(repo: WatchedRepository): Promise<void> {
    this.machinesError.set(null);
    try {
      const groups = await firstValueFrom(this.api.machineApps());
      if (this.repository()?.id !== repo.id) {
        return;
      }
      const pristine = !this.changed();
      const current = repo.installedVersionApp;
      const found = current ? groups.find((g) => g.apps.some((a) => appKey(a) === appKey(current))) : undefined;
      // Without a current app, start with the only machine – or the one with an app linked to this repository.
      const preselected =
        found ?? (groups.length === 1 ? groups[0] : groups.find((g) => g.apps.some((a) => a.repositoryId === repo.id)));
      this.machines.set(groups);
      if (found) {
        this.machine = machineKey(found.machine);
      } else if (!this.machine && preselected) {
        this.chooseMachine(machineKey(preselected.machine));
      }
      if (pristine) {
        this.savedValues = this.values();
      }
    } catch (error) {
      this.machines.set([]);
      this.machinesError.set(describeError(error));
    }
  }

  /** Switches the source; the apps on machines are loaded the first time they are needed. */
  protected chooseSource(source: InstalledVersionSource): void {
    this.source = source;
    const repo = this.repository();
    if (source === 'machine' && repo && this.machines() === null) {
      void this.loadMachines(repo);
    }
  }

  /** Apps of the chosen machine. */
  protected appsOf(key: string): MachineAppOption[] {
    return this.machines()?.find((g) => machineKey(g.machine) === key)?.apps ?? [];
  }

  /** The chosen app (null = none chosen or no longer on the machine). */
  protected chosenApp(): MachineAppOption | null {
    return this.appsOf(this.machine).find((a) => appKey(a) === this.app) ?? null;
  }

  protected chooseMachine(key: string): void {
    this.machine = key;
    const apps = this.appsOf(key);
    // An app already linked to this repository is the likely choice; otherwise the user picks one.
    const linked = apps.find((a) => a.repositoryId === this.repository()?.id);
    this.app = linked ? appKey(linked) : apps.length === 1 ? appKey(apps[0]!) : '';
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
    const fromUrl = this.source === 'url';
    const fromMachine = this.source === 'machine';
    const chosen = fromMachine ? this.chosenApp() : null;
    if (fromMachine && !chosen) {
      this.saveError.set('Choose the app to read the installed version from.');
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
          installedVersionUrl: fromUrl ? this.url.trim() || null : null,
          installedVersionField: fromUrl ? this.field.trim() || null : null,
          installedVersionHeaders: fromUrl ? this.headerInputs() : [],
          // A version read from the URL or an app is not sent back; otherwise the value entered by hand (or none).
          ...(fromUrl || fromMachine ? {} : { installedVersion: this.source === 'manual' ? this.manualVersion.trim() || null : null }),
          // Choosing an app links it to this repository; any other source stops reading it.
          ...(chosen
            ? { installedVersionApp: { kind: chosen.kind, id: chosen.id } }
            : repo.installedVersionApp
              ? { installedVersionApp: null }
              : {}),
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
