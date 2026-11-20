import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { Notifier, WatchedRepository } from '../../core/models';
import { PreferencesService } from '../../core/preferences.service';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { Avatar } from '../../shared/avatar';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { Switch } from '../../shared/switch';
import { AdvisoriesDialog } from './advisories.dialog';
import { RepositorySettingsDialog } from './repository-settings.dialog';

type Filter = 'all' | 'enabled' | 'paused' | 'updates' | 'vulnerable' | 'errors';

@Component({
  selector: 'app-repositories-page',
  imports: [FormsModule, DatePipe, RouterLink, Avatar, Icon, Switch, RelativeTimePipe, RepositorySettingsDialog, AdvisoriesDialog],
  templateUrl: './repositories.page.html',
  styleUrl: './repositories.page.scss',
})
export class RepositoriesPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly statusService = inject(StatusService);
  protected readonly preferences = inject(PreferencesService);

  protected readonly repositories = signal<WatchedRepository[]>([]);
  protected readonly notifiers = signal<Notifier[]>([]);
  protected readonly loading = signal(true);
  protected readonly busyIds = signal<ReadonlySet<number>>(new Set());
  protected readonly adding = signal(false);
  protected readonly confirmDeleteId = signal<number | null>(null);
  /** Repository whose settings dialog is open. */
  protected readonly editing = signal<WatchedRepository | null>(null);
  /** Repository whose security advisories are shown. */
  protected readonly viewingAdvisories = signal<WatchedRepository | null>(null);

  protected readonly query = signal('');
  protected readonly filter = signal<Filter>('all');

  protected newRepository = '';
  protected newIncludePrereleases = false;
  /** Optional token of a private repository the global token cannot read. */
  protected newToken = '';
  protected readonly showNewToken = signal(false);

  protected readonly hasEnabledNotifier = computed(() => this.notifiers().some((n) => n.isEnabled));

  protected readonly counts = computed(() => {
    const list = this.repositories();
    return {
      all: list.length,
      enabled: list.filter((r) => r.isEnabled).length,
      paused: list.filter((r) => !r.isEnabled).length,
      updates: list.filter((r) => r.updateAvailable).length,
      vulnerable: list.filter((r) => r.advisories.affecting > 0).length,
      errors: list.filter((r) => r.lastError || r.installedVersionError).length,
    };
  });

  protected readonly filters: { value: Filter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'enabled', label: 'Active' },
    { value: 'paused', label: 'Paused' },
    { value: 'updates', label: 'Updates' },
    { value: 'vulnerable', label: 'Vulnerable' },
    { value: 'errors', label: 'Errors' },
  ];

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    return this.repositories().filter(
      (r) =>
        (!q || r.fullName.toLowerCase().includes(q) || r.lastSeenTag?.toLowerCase().includes(q)) &&
        (f === 'all' ||
          (f === 'enabled' && r.isEnabled) ||
          (f === 'paused' && !r.isEnabled) ||
          (f === 'updates' && !!r.updateAvailable) ||
          (f === 'vulnerable' && r.advisories.affecting > 0) ||
          (f === 'errors' && !!(r.lastError || r.installedVersionError))),
    );
  });

  constructor() {
    // Reload whenever "Check all now" finished in the sidebar.
    effect(() => {
      this.statusService.revision();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    try {
      const [repositories, notifiers] = await Promise.all([
        firstValueFrom(this.api.getRepositories()),
        firstValueFrom(this.api.getNotifiers()),
      ]);
      this.repositories.set(repositories);
      this.notifiers.set(notifiers);
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected async add(): Promise<void> {
    const repository = this.newRepository.trim();
    if (!repository || this.adding()) {
      return;
    }

    this.adding.set(true);
    try {
      const created = await firstValueFrom(
        this.api.addRepository({
          repository,
          includePrereleases: this.newIncludePrereleases,
          ...(this.newToken.trim() ? { githubToken: this.newToken.trim() } : {}),
        }),
      );
      this.repositories.update((list) => [...list, created].sort(byName));
      this.newRepository = '';
      this.newIncludePrereleases = false;
      this.newToken = '';
      this.showNewToken.set(false);
      this.toast.success(`Watching ${created.fullName}.`);
      void this.statusService.refresh();
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.adding.set(false);
    }
  }

  protected async toggle(repo: WatchedRepository, field: 'isEnabled' | 'includePrereleases'): Promise<void> {
    await this.withBusy(repo.id, async () => {
      const updated = await firstValueFrom(
        this.api.updateRepository(repo.id, {
          isEnabled: repo.isEnabled,
          includePrereleases: repo.includePrereleases,
          [field]: !repo[field],
        }),
      );
      this.replace(updated);
      void this.statusService.refresh();
    });
  }

  protected async checkNow(repo: WatchedRepository): Promise<void> {
    await this.withBusy(repo.id, async () => {
      const result = await firstValueFrom(this.api.checkNow(repo.id));
      this.replace(result.repository);
      if (result.repository.lastError) {
        this.toast.error(result.repository.lastError);
      } else if (result.notifiedCount > 0) {
        this.toast.success(`${repo.fullName}: sent ${result.notifiedCount} notification(s).`);
      } else {
        this.toast.info(`${repo.fullName}: no new releases.`);
      }
    });
  }

  protected async remove(repo: WatchedRepository): Promise<void> {
    this.confirmDeleteId.set(null);
    await this.withBusy(repo.id, async () => {
      await firstValueFrom(this.api.deleteRepository(repo.id));
      this.repositories.update((list) => list.filter((r) => r.id !== repo.id));
      this.toast.success(`Stopped watching ${repo.fullName}.`);
      void this.statusService.refresh();
    });
  }

  protected onSettingsSaved(updated: WatchedRepository): void {
    this.replace(updated);
    this.editing.set(null);
    this.toast.success(
      updated.installedVersionError
        ? `Saved, but the installed version could not be read: ${updated.installedVersionError}`
        : `Settings of ${updated.fullName} saved.`,
    );
    void this.statusService.refresh();
  }

  /** Tooltip of the advisories badge. */
  protected advisoryTitle(repo: WatchedRepository): string {
    const { total, affecting, highestSeverity } = repo.advisories;
    const severity = highestSeverity && highestSeverity !== 'unknown' ? `, highest severity ${highestSeverity}` : '';
    return affecting > 0
      ? `${affecting} of ${total} security advisories affect installed ${repo.installedVersion}${severity}`
      : `${total} security ${total === 1 ? 'advisory' : 'advisories'}${severity} – show details`;
  }

  protected isBusy(id: number): boolean {
    return this.busyIds().has(id);
  }

  private async withBusy(id: number, action: () => Promise<void>): Promise<void> {
    this.busyIds.update((ids) => new Set(ids).add(id));
    try {
      await action();
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busyIds.update((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }

  private replace(updated: WatchedRepository): void {
    this.repositories.update((list) => list.map((r) => (r.id === updated.id ? updated : r)));
  }
}

/** Same order as the server: repository name first, owner only breaks ties. */
function byName(a: WatchedRepository, b: WatchedRepository): number {
  return a.name.localeCompare(b.name) || a.owner.localeCompare(b.owner);
}
