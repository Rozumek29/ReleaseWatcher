import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
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
import { ApiService, describeError } from '../../core/api.service';
import {
  Container,
  ContainerApp,
  ContainerAppRequest,
  DetectedApp,
  LatestSource,
  WatchedRepository,
} from '../../core/models';
import { targetLabel } from './target';
import { Icon } from '../../shared/icon';
import { Switch } from '../../shared/switch';
import { BackdropClose } from '../../shared/backdrop-close';
import { repositoryLabel } from '../../shared/repository-host';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** Editable state of the application form. */
interface AppForm {
  /** null = a new application. */
  id: number | null;
  name: string;
  versionCommand: string;
  latestSource: LatestSource;
  repositoryId: number | null;
  latestCommand: string;
  updateCommand: string;
  useTty: boolean;
  timeoutSeconds: number;
  /** Installed version entered by hand (used only without a version command). */
  installedVersion: string;
}

const DEFAULT_TIMEOUT_SECONDS = 1800;

const emptyForm = (): AppForm => ({
  id: null,
  name: '',
  versionCommand: '',
  latestSource: 'none',
  repositoryId: null,
  latestCommand: '',
  updateCommand: '',
  useTty: false,
  timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
  installedVersion: '',
});

/** Applications in alphabetical order, like the server lists them. */
const byName = (list: ContainerApp[]): ContainerApp[] =>
  [...list].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id - b.id);

/** Settings of one container and its applications (version check + update command). */
@Component({
  selector: 'app-container-settings-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, NgTemplateOutlet, Icon, Switch, UnsavedChanges],
  templateUrl: './container-settings.dialog.html',
  styleUrls: ['./dialog.scss', './container-settings.dialog.scss'],
})
export class ContainerSettingsDialog {
  private readonly api = inject(ApiService);
  private readonly injector = inject(Injector);

  /** Container being edited; null closes the dialog. */
  readonly container = input<Container | null>(null);
  /** Global check schedule, shown as the placeholder of the override. */
  readonly globalCron = input('');
  /** Global "back up before updates" default and the backup storage, shown in the backup choice. */
  readonly globalBackup = input(false);
  readonly backupStorage = input<string | null>(null);
  readonly saved = output<Container>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected name = '';
  protected isEnabled = true;
  protected packagesEnabled = true;
  protected startWhenStopped = false;
  protected dockerEnabled = true;
  /** 'default' = follow the global setting. */
  protected backupChoice: 'default' | 'yes' | 'no' = 'default';
  protected checkCron = '';
  protected updateCores: number | null = null;
  protected updateMemoryMb: number | null = null;
  protected homeAssistantUrl = '';
  /** A new token; empty = keep the saved one. */
  protected homeAssistantToken = '';
  /** Remove the saved token on save. */
  protected removeToken = false;
  protected homeAssistantInstall = false;
  protected readonly showToken = signal(false);
  /** The container fields as opened, to tell whether they have unsaved changes. */
  private savedValues: unknown = null;

  protected readonly label = targetLabel;
  protected readonly apps = signal<ContainerApp[]>([]);
  protected readonly repositories = signal<WatchedRepository[]>([]);
  protected readonly repoLabel = repositoryLabel;
  /** The watched repositories by their label (A–Z), for the repository picker of an application. */
  protected readonly sortedRepositories = computed(() =>
    [...this.repositories()].sort((a, b) =>
      repositoryLabel(a).localeCompare(repositoryLabel(b), undefined, { sensitivity: 'base', numeric: true }),
    ),
  );
  protected readonly appForm = signal<AppForm | null>(null);
  /** The application form as it was opened, to tell whether it has unsaved changes. */
  private readonly appFormInitial = signal<AppForm | null>(null);
  /** The open application form differs from what it was opened with ("Save container" does not save it). */
  protected readonly appFormDirty = computed(() => {
    const form = this.appForm();
    return form !== null && !sameValues(form, this.appFormInitial());
  });
  protected readonly confirmDeleteAppId = signal<number | null>(null);

  /** Suggestions of the last detection; null = not detected (hidden). */
  protected readonly detected = signal<DetectedApp[] | null>(null);
  protected readonly detecting = signal(false);
  /** Names of detected applications being added right now. */
  protected readonly addingDetected = signal<ReadonlySet<string>>(new Set());
  protected readonly detectError = signal<string | null>(null);

  protected readonly saving = signal(false);
  protected readonly savingApp = signal(false);
  protected readonly saveError = signal<string | null>(null);
  protected readonly appError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const container = this.container();
      const dialog = this.dialog().nativeElement;
      untracked(() => {
        if (container) {
          this.name = container.name;
          this.isEnabled = container.isEnabled;
          this.packagesEnabled = container.packagesEnabled;
          this.startWhenStopped = container.startWhenStopped;
          this.dockerEnabled = container.docker.enabled;
          this.backupChoice =
            container.backupBeforeUpdate === null ? 'default' : container.backupBeforeUpdate ? 'yes' : 'no';
          this.checkCron = container.checkCron ?? '';
          this.updateCores = container.updateCores;
          this.updateMemoryMb = container.updateMemoryMb;
          this.homeAssistantUrl = container.homeAssistant?.url ?? '';
          this.homeAssistantToken = '';
          this.removeToken = false;
          this.homeAssistantInstall = container.homeAssistant?.installEnabled ?? false;
          this.showToken.set(false);
          this.savedValues = this.values();
          this.apps.set(container.apps);
          this.appForm.set(null);
          this.confirmDeleteAppId.set(null);
          this.saveError.set(null);
          this.appError.set(null);
          this.detected.set(null);
          this.detectError.set(null);
          void this.loadRepositories();
          if (!dialog.open) {
            dialog.showModal?.();
          }
        } else if (dialog.open) {
          dialog.close();
        }
      });
    });
  }

  protected async save(): Promise<void> {
    const container = this.container();
    if (!container) {
      return;
    }
    this.saving.set(true);
    this.saveError.set(null);
    try {
      const updated = await firstValueFrom(
        this.api.updateContainer(container.id, {
          name: this.name.trim(),
          isEnabled: this.isEnabled,
          packagesEnabled: this.packagesEnabled,
          startWhenStopped: this.startWhenStopped,
          dockerEnabled: this.dockerEnabled,
          backupBeforeUpdate: this.backupChoice === 'default' ? null : this.backupChoice === 'yes',
          checkCron: this.checkCron.trim() || null,
          ...(container.capabilities.updateResources
            ? { updateCores: this.updateCores || null, updateMemoryMb: this.updateMemoryMb || null }
            : {}),
          ...(container.capabilities.homeAssistant
            ? {
                homeAssistantUrl: this.homeAssistantUrl.trim() || null,
                homeAssistantInstall: this.homeAssistantInstall,
                // Omitted keeps the saved token.
                ...(this.removeToken
                  ? { homeAssistantToken: null }
                  : this.homeAssistantToken.trim()
                    ? { homeAssistantToken: this.homeAssistantToken.trim() }
                    : {}),
              }
            : {}),
        }),
      );
      this.saved.emit(updated);
    } catch (error) {
      this.saveError.set(describeError(error));
    } finally {
      this.saving.set(false);
    }
  }

  /** The container fields (not the applications, which are saved on their own). */
  private values(): unknown {
    return [
      this.name,
      this.isEnabled,
      this.packagesEnabled,
      this.startWhenStopped,
      this.dockerEnabled,
      this.backupChoice,
      this.checkCron,
      this.updateCores,
      this.updateMemoryMb,
      this.homeAssistantUrl,
      this.homeAssistantToken,
      this.removeToken,
      this.homeAssistantInstall,
    ];
  }

  /** Whether the container fields differ from the saved ones (read by the template on every check). */
  protected containerChanged(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  /** Brings the open application form into view (from the footer note). */
  protected showAppForm(): void {
    const name = this.dialog().nativeElement.querySelector<HTMLInputElement>('#app-name');
    name?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    name?.focus({ preventScroll: true });
  }

  protected newApp(): void {
    this.openAppForm(emptyForm());
  }

  protected editApp(app: ContainerApp): void {
    this.openAppForm({
      id: app.id,
      name: app.name,
      versionCommand: app.versionCommand ?? '',
      latestSource: app.latestSource,
      repositoryId: app.repositoryId,
      latestCommand: app.latestCommand ?? '',
      updateCommand: app.updateCommand ?? '',
      useTty: app.useTty,
      timeoutSeconds: app.timeoutSeconds,
      installedVersion: app.versionCommand ? '' : (app.installedVersion ?? ''),
    });
  }

  /** Shows the form (in place of the edited application, or below the list) and moves the focus into it. */
  private openAppForm(form: AppForm): void {
    this.appError.set(null);
    this.confirmDeleteAppId.set(null);
    this.appForm.set(form);
    this.appFormInitial.set(form);
    afterNextRender(
      () => this.showAppForm(),
      { injector: this.injector },
    );
  }

  /** Writes a form field (the form object is replaced so the signal notices). */
  protected setField<K extends keyof AppForm>(key: K, value: AppForm[K]): void {
    this.appForm.update((form) => (form ? { ...form, [key]: value } : form));
  }

  protected async saveApp(): Promise<void> {
    const container = this.container();
    const form = this.appForm();
    if (!container || !form || this.savingApp()) {
      return;
    }
    const versionCommand = form.versionCommand.trim() || null;
    const request: ContainerAppRequest = {
      name: form.name.trim(),
      versionCommand,
      // Without a version command the installed version is the one entered by hand.
      ...(versionCommand ? {} : { installedVersion: form.installedVersion.trim() || null }),
      latestSource: form.latestSource,
      repositoryId: form.latestSource === 'repository' ? form.repositoryId : null,
      latestCommand: form.latestSource === 'command' ? form.latestCommand.trim() || null : null,
      updateCommand: form.updateCommand.trim() || null,
      useTty: form.useTty,
      timeoutSeconds: Number(form.timeoutSeconds) || null,
    };
    this.savingApp.set(true);
    this.appError.set(null);
    try {
      if (form.id === null) {
        const created = await firstValueFrom(this.api.addContainerApp(container.id, request));
        this.apps.update((list) => byName([...list, created]));
      } else {
        const updated = await firstValueFrom(
          this.api.updateContainerApp(container.id, form.id, request),
        );
        this.apps.update((list) => byName(list.map((a) => (a.id === updated.id ? updated : a))));
      }
      this.appForm.set(null);
    } catch (error) {
      this.appError.set(describeError(error));
    } finally {
      this.savingApp.set(false);
    }
  }

  protected async deleteApp(app: ContainerApp): Promise<void> {
    const container = this.container();
    this.confirmDeleteAppId.set(null);
    if (!container) {
      return;
    }
    try {
      await firstValueFrom(this.api.deleteContainerApp(container.id, app.id));
      this.apps.update((list) => list.filter((a) => a.id !== app.id));
      if (this.appForm()?.id === app.id) {
        this.appForm.set(null);
      }
    } catch (error) {
      this.appError.set(describeError(error));
    }
  }

  /** Looks for applications in the container (community-scripts, version files) and their GitHub repositories. */
  protected async detectApps(): Promise<void> {
    const container = this.container();
    if (!container || this.detecting()) {
      return;
    }
    this.detecting.set(true);
    this.detectError.set(null);
    try {
      this.detected.set(await firstValueFrom(this.api.detectContainerApps(container.id)));
    } catch (error) {
      this.detected.set(null);
      this.detectError.set(describeError(error));
    } finally {
      this.detecting.set(false);
    }
  }

  /** Adds a detected application – and watches its GitHub repository first when it is not watched yet. */
  protected async addDetected(found: DetectedApp): Promise<void> {
    const container = this.container();
    if (!container || this.addingDetected().has(found.name)) {
      return;
    }
    this.addingDetected.update((set) => new Set(set).add(found.name));
    this.detectError.set(null);
    try {
      const repositoryId = found.repository
        ? (found.repositoryId ?? (await this.watch(found.repository)))
        : null;
      const created = await firstValueFrom(
        this.api.addContainerApp(container.id, {
          name: found.name,
          versionCommand: found.versionCommand,
          latestSource: repositoryId === null ? 'none' : 'repository',
          repositoryId,
          latestCommand: null,
          updateCommand: found.updateCommand,
          useTty: false,
          timeoutSeconds: null,
        }),
      );
      this.apps.update((list) => byName([...list, created]));
      this.detected.update(
        (list) =>
          list?.map((d) => (d === found ? { ...d, repositoryId, alreadyAdded: true } : d)) ?? list,
      );
    } catch (error) {
      this.detectError.set(describeError(error));
    } finally {
      this.addingDetected.update((set) => {
        const next = new Set(set);
        next.delete(found.name);
        return next;
      });
    }
  }

  /** ID of the watched repository `owner/repo` – watched now when it is not yet. */
  private async watch(fullName: string): Promise<number> {
    const existing = () =>
      this.repositories().find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
    const known = existing();
    if (known) {
      return known.id;
    }
    try {
      const repo = await firstValueFrom(
        this.api.addRepository({ repository: fullName, includePrereleases: false }),
      );
      this.repositories.update((list) => [...list, repo]);
      return repo.id;
    } catch (error) {
      // Watched in the meantime (e.g. in another tab): use that one.
      await this.loadRepositories();
      const repo = existing();
      if (repo) {
        return repo.id;
      }
      throw error;
    }
  }

  protected sourceLabel(app: ContainerApp): string {
    switch (app.latestSource) {
      case 'repository':
        return `latest from ${app.repositoryFullName ?? 'GitHub'}`;
      case 'command':
        return 'latest from a command';
      default:
        return 'no latest version';
    }
  }

  protected close(): void {
    this.closed.emit();
  }

  private async loadRepositories(): Promise<void> {
    try {
      this.repositories.set(await firstValueFrom(this.api.getRepositories()));
    } catch {
      this.repositories.set([]);
    }
  }
}
