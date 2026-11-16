import {
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
import { ApiService, describeError } from '../../core/api.service';
import {
  Container,
  ContainerApp,
  ContainerAppRequest,
  LatestSource,
  WatchedRepository,
} from '../../core/models';
import { targetLabel } from './target';
import { Icon } from '../../shared/icon';
import { Switch } from '../../shared/switch';

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
});

/** Settings of one container and its applications (version check + update command). */
@Component({
  selector: 'app-container-settings-dialog',
  imports: [FormsModule, Icon, Switch],
  templateUrl: './container-settings.dialog.html',
  styleUrls: ['./dialog.scss', './container-settings.dialog.scss'],
})
export class ContainerSettingsDialog {
  private readonly api = inject(ApiService);

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
  protected aptEnabled = true;
  protected startWhenStopped = false;
  /** 'default' = follow the global setting. */
  protected backupChoice: 'default' | 'yes' | 'no' = 'default';
  protected checkCron = '';

  protected readonly label = targetLabel;
  protected readonly apps = signal<ContainerApp[]>([]);
  protected readonly repositories = signal<WatchedRepository[]>([]);
  protected readonly appForm = signal<AppForm | null>(null);
  protected readonly confirmDeleteAppId = signal<number | null>(null);

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
          this.aptEnabled = container.aptEnabled;
          this.startWhenStopped = container.startWhenStopped;
          this.backupChoice =
            container.backupBeforeUpdate === null ? 'default' : container.backupBeforeUpdate ? 'yes' : 'no';
          this.checkCron = container.checkCron ?? '';
          this.apps.set(container.apps);
          this.appForm.set(null);
          this.confirmDeleteAppId.set(null);
          this.saveError.set(null);
          this.appError.set(null);
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
          aptEnabled: this.aptEnabled,
          startWhenStopped: this.startWhenStopped,
          backupBeforeUpdate: this.backupChoice === 'default' ? null : this.backupChoice === 'yes',
          checkCron: this.checkCron.trim() || null,
        }),
      );
      this.saved.emit(updated);
    } catch (error) {
      this.saveError.set(describeError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected newApp(): void {
    this.appError.set(null);
    this.appForm.set(emptyForm());
  }

  protected editApp(app: ContainerApp): void {
    this.appError.set(null);
    this.appForm.set({
      id: app.id,
      name: app.name,
      versionCommand: app.versionCommand ?? '',
      latestSource: app.latestSource,
      repositoryId: app.repositoryId,
      latestCommand: app.latestCommand ?? '',
      updateCommand: app.updateCommand ?? '',
      useTty: app.useTty,
      timeoutSeconds: app.timeoutSeconds,
    });
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
    const request: ContainerAppRequest = {
      name: form.name.trim(),
      versionCommand: form.versionCommand.trim() || null,
      latestSource: form.latestSource,
      repositoryId: form.latestSource === 'github' ? form.repositoryId : null,
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
        this.apps.update((list) => [...list, created]);
      } else {
        const updated = await firstValueFrom(
          this.api.updateContainerApp(container.id, form.id, request),
        );
        this.apps.update((list) => list.map((a) => (a.id === updated.id ? updated : a)));
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

  protected sourceLabel(app: ContainerApp): string {
    switch (app.latestSource) {
      case 'github':
        return `latest from ${app.repositoryFullName ?? 'GitHub'}`;
      case 'command':
        return 'latest from a command';
      default:
        return 'no latest version';
    }
  }

  /** Closes on a backdrop click. Returns nothing on purpose (a `false` result would cancel the click). */
  protected onDialogClick(event: MouseEvent, dialog: HTMLDialogElement): void {
    if (event.target === dialog) {
      this.close();
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
