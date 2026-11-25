import { DatePipe, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { Notifier, RepositoryGroup, WatchedRepository } from '../../core/models';
import { PreferencesService, type RepositoryGrouping } from '../../core/preferences.service';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { Avatar } from '../../shared/avatar';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { repositoryLabel } from '../../shared/repository-host';
import { Switch } from '../../shared/switch';
import { AddRepositoryDialog } from './add-repository.dialog';
import { AdvisoriesDialog } from './advisories.dialog';
import { groupKeys, groupRepositories } from './grouping';
import { RepositoryGroupDialog } from './repository-group.dialog';
import { RepositorySettingsDialog } from './repository-settings.dialog';
import { WebSourceDialog } from './web-source.dialog';

type Filter = 'all' | 'enabled' | 'paused' | 'updates' | 'vulnerable' | 'errors';

@Component({
  selector: 'app-repositories-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, NgTemplateOutlet, RouterLink, Avatar, Icon, Switch, RelativeTimePipe, RepositorySettingsDialog, RepositoryGroupDialog, AdvisoriesDialog, AddRepositoryDialog, WebSourceDialog],
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
  /** Custom groups (Group: Custom). */
  protected readonly customGroups = signal<RepositoryGroup[]>([]);
  /** Custom group whose options dialog is open. */
  protected readonly editingGroup = signal<RepositoryGroup | null>(null);
  protected readonly loading = signal(true);
  protected readonly busyIds = signal<ReadonlySet<number>>(new Set());
  protected readonly confirmDeleteId = signal<number | null>(null);
  /** Repository whose settings dialog is open. */
  protected readonly editing = signal<WatchedRepository | null>(null);
  /** Repository whose security advisories are shown. */
  protected readonly viewingAdvisories = signal<WatchedRepository | null>(null);

  protected readonly query = signal('');
  protected readonly filter = signal<Filter>('all');

  /** Whether the dialog that adds a repository is open. */
  protected readonly addingRepository = signal(false);
  /** Whether the dialog that adds a web page is open. */
  protected readonly addingWebSource = signal(false);
  protected readonly label = repositoryLabel;

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

  protected readonly groupings: { value: RepositoryGrouping; label: string; title: string }[] = [
    { value: 'none', label: 'None', title: "Don't group repositories" },
    { value: 'owner', label: 'Owner', title: 'Group owners with several repositories' },
    { value: 'custom', label: 'Custom', title: 'Group by the groups set in the repository settings' },
  ];

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
        (!q ||
          r.fullName.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q) ||
          r.lastSeenTag?.toLowerCase().includes(q)) &&
        (f === 'all' ||
          (f === 'enabled' && r.isEnabled) ||
          (f === 'paused' && !r.isEnabled) ||
          (f === 'updates' && !!r.updateAvailable) ||
          (f === 'vulnerable' && r.advisories.affecting > 0) ||
          (f === 'errors' && !!(r.lastError || r.installedVersionError))),
    );
  });

  /** The visible repositories as shown: group cards first, then repositories in no group. */
  protected readonly entries = computed(() =>
    groupRepositories(this.repositories(), this.visible(), this.preferences.repositoryGrouping(), this.customGroups()),
  );
  protected readonly groups = computed(() => this.entries().flatMap((e) => (e.kind === 'group' ? [e.group] : [])));
  protected readonly ungrouped = computed(() =>
    this.entries().flatMap((e) => (e.kind === 'repository' ? [e.repository] : [])),
  );


  protected readonly collapsed = computed(() => new Set(this.preferences.collapsedGroups()));

  /** Every visible group is collapsed, so the toolbar offers "Expand all". */
  protected readonly allCollapsed = computed(() => {
    const collapsed = this.collapsed();
    return this.groups().every((g) => collapsed.has(g.key));
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
      const [repositories, notifiers, groups] = await Promise.all([
        firstValueFrom(this.api.getRepositories()),
        firstValueFrom(this.api.getNotifiers()),
        firstValueFrom(this.api.getRepositoryGroups()),
      ]);
      this.repositories.set(repositories);
      this.notifiers.set(notifiers);
      this.customGroups.set(groups);
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected onRepositoryAdded(created: WatchedRepository): void {
    this.repositories.update((list) => [...list, created].sort(byName));
    this.addingRepository.set(false);
    this.toast.success(`Watching ${created.fullName}.`);
    void this.statusService.refresh();
  }

  protected onWebSourceAdded(created: WatchedRepository): void {
    this.repositories.update((list) => [...list, created].sort(byName));
    this.addingWebSource.set(false);
    this.toast.success(`Watching ${created.name}.`);
    void this.statusService.refresh();
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
      const containers =
        result.containerChecks > 0 ? ` Checking ${result.containerChecks} linked container(s).` : '';
      if (result.repository.lastError) {
        this.toast.error(result.repository.lastError);
      } else if (result.notifiedCount > 0) {
        this.toast.success(`${repositoryLabel(repo)}: sent ${result.notifiedCount} notification(s).${containers}`);
      } else if (containers) {
        this.toast.success(`${repositoryLabel(repo)}: new release found.${containers}`);
      } else {
        this.toast.info(`${repositoryLabel(repo)}: no new releases.`);
      }
    });
  }

  /** Where the installed version shown on the card comes from. */
  protected installedFrom(repo: WatchedRepository): string {
    const app = repo.installedVersionApp;
    if (app) {
      return `Read from ${app.name} on ${app.machine}`;
    }
    return repo.installedVersionUrl ? `Read from ${repo.installedVersionUrl}` : 'Entered by hand';
  }

  /** A version entered by hand that is not the latest release can be set to it in one click. */
  protected canMarkInstalled(repo: WatchedRepository): boolean {
    return (
      repo.installedVersionSource === 'manual' &&
      repo.lastSeenTag !== null &&
      repo.installedVersion !== repo.lastSeenTag &&
      repo.updateAvailable !== false
    );
  }

  protected async markInstalled(repo: WatchedRepository): Promise<void> {
    await this.withBusy(repo.id, async () => {
      const updated = await firstValueFrom(this.api.markRepositoryInstalled(repo.id));
      this.replace(updated);
      this.toast.success(`${repositoryLabel(repo)}: ${updated.installedVersion} marked as installed.`);
      void this.statusService.refresh();
    });
  }

  protected async remove(repo: WatchedRepository): Promise<void> {
    this.confirmDeleteId.set(null);
    await this.withBusy(repo.id, async () => {
      await firstValueFrom(this.api.deleteRepository(repo.id));
      this.repositories.update((list) => list.filter((r) => r.id !== repo.id));
      this.toast.success(`Stopped watching ${repositoryLabel(repo)}.`);
      void this.statusService.refresh();
    });
  }

  protected onSettingsSaved(updated: WatchedRepository): void {
    this.replace(updated);
    // The repository may have created, joined or left (and so removed) a group.
    void this.loadGroups();
    this.editing.set(null);
    this.toast.success(
      updated.installedVersionError
        ? `Saved, but the installed version could not be read: ${updated.installedVersionError}`
        : `Settings of ${repositoryLabel(updated)} saved.`,
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

  protected toggleGroup(key: string): void {
    this.preferences.collapsedGroups.update((keys) =>
      keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
    );
  }

  /** Collapses every group, or expands them all when they already are. */
  protected toggleAllGroups(): void {
    const grouping = this.preferences.repositoryGrouping();
    const keys = new Set(groupKeys(this.repositories(), grouping, this.customGroups()));
    this.preferences.collapsedGroups.update((collapsed) =>
      this.allCollapsed()
        ? collapsed.filter((key) => !keys.has(key))
        : [...new Set([...collapsed, ...keys])],
    );
  }

  protected onGroupSaved(updated: RepositoryGroup): void {
    this.customGroups.update((groups) => groups.map((g) => (g.id === updated.id ? updated : g)));
    this.editingGroup.set(null);
    this.toast.success(`Group ${updated.name} saved.`);
  }

  protected onGroupRemoved(group: RepositoryGroup): void {
    this.customGroups.update((groups) => groups.filter((g) => g.id !== group.id));
    this.repositories.update((list) => list.map((r) => (r.groupId === group.id ? { ...r, groupId: null } : r)));
    this.editingGroup.set(null);
    this.toast.success(`Group ${group.name} removed.`);
  }

  private async loadGroups(): Promise<void> {
    try {
      this.customGroups.set(await firstValueFrom(this.api.getRepositoryGroups()));
    } catch (error) {
      this.toast.error(error);
    }
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
