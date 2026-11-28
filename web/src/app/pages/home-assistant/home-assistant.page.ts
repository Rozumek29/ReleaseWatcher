import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ClockService } from '../../core/clock.service';
import { HomeAssistantComponent, HomeAssistantConnection, HomeAssistantOverview } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { describeCron } from '../../shared/cron';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

export type HomeAssistantFilter = 'all' | 'updates' | 'unwatched';

/** A newer release of the watched repository, or a newer version known to Home Assistant. */
export const hasUpdate = (c: HomeAssistantComponent): boolean => c.updateAvailable === true || c.homeAssistantUpdate;

/** The version an update would bring: the repository's latest release when it is newer, else what Home Assistant knows. */
export const newerVersion = (c: HomeAssistantComponent): string | null =>
  c.updateAvailable === true ? (c.repository?.latestVersion ?? null) : c.homeAssistantUpdate ? c.latestVersion : null;

/** One card: a connection with the components read from it. */
interface ConnectionCard {
  connection: HomeAssistantConnection;
  components: HomeAssistantComponent[];
}

/** While a connection or the scheduled run is being read, the page reloads this often. */
const POLL_MS = 2000;

/** Link to a repository named by a component (`owner/name` on GitHub, `host/owner/name` elsewhere). */
export const repositoryLink = (repository: string): string =>
  repository.split('/').length > 2 ? `https://${repository}` : `https://github.com/${repository}`;

/**
 * Home Assistant page: what is installed in the Home Assistant instances connected under Settings → Connections –
 * Core, add-ons, integrations and cards whose update entity names a repository.
 */
@Component({
  selector: 'app-home-assistant-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, RelativeTimePipe, RouterLink],
  templateUrl: './home-assistant.page.html',
  styleUrl: './home-assistant.page.scss',
})
export class HomeAssistantPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly statusService = inject(StatusService);
  protected readonly describeCron = describeCron;
  protected readonly repositoryLink = repositoryLink;

  protected readonly overview = signal<HomeAssistantOverview | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly filter = signal<HomeAssistantFilter>('all');
  protected readonly checkingAll = signal(false);
  protected readonly now = inject(ClockService).now;

  protected readonly filters: { value: HomeAssistantFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'updates', label: 'Updates' },
    { value: 'unwatched', label: 'Not watched' },
  ];
  /** Search over component and repository names. */
  protected readonly query = signal('');
  /** Component whose installation is being confirmed, and whether a backup is asked for. */
  protected readonly confirming = signal<number | null>(null);
  protected readonly backupFirst = signal(true);
  /** Connection whose restart is being confirmed. */
  protected readonly confirmingRestart = signal<number | null>(null);
  /** Component ids whose repository is being added to the watch list. */
  protected readonly watching = signal<ReadonlySet<number>>(new Set());
  protected readonly hasUpdate = hasUpdate;
  protected readonly newerVersion = newerVersion;

  protected readonly counts = computed(() => {
    const components = this.overview()?.components ?? [];
    return {
      all: components.length,
      updates: components.filter(hasUpdate).length,
      unwatched: components.filter((c) => c.suggestedRepository !== null).length,
    };
  });

  protected readonly cards = computed<ConnectionCard[]>(() => {
    const data = this.overview();
    if (!data) return [];
    const filter = this.filter();
    const query = this.query().trim().toLowerCase();
    const matches = (c: HomeAssistantComponent) =>
      (filter === 'all' || (filter === 'updates' ? hasUpdate(c) : c.suggestedRepository !== null)) &&
      (!query || c.name.toLowerCase().includes(query) || c.repositoryName.includes(query));
    const cards = data.connections.map((connection) => ({
      connection,
      components: data.components.filter((c) => c.connectionId === connection.id && matches(c)),
    }));
    return filter === 'all' && !query ? cards : cards.filter((card) => card.components.length > 0);
  });

  /** Something is being read: reload until it finished. */
  private readonly checking = computed(
    () =>
      this.checkingAll() ||
      !!this.overview()?.check.isRunning ||
      !!this.overview()?.connections.some((c) => c.isChecking || c.isRestarting) ||
      !!this.overview()?.components.some((c) => c.isInstalling),
  );

  constructor() {
    effect(() => {
      this.statusService.revision();
      untracked(() => void this.load());
    });
    effect((onCleanup) => {
      // Read the data too: `checking` stays true across a reload, and the effect only runs again when what it read
      // changed – without this it would reload once and then wait forever.
      this.overview();
      if (!this.checking()) return;
      const timer = setTimeout(() => void this.load(), POLL_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected async load(): Promise<void> {
    try {
      const overview = await firstValueFrom(this.api.getHomeAssistant());
      this.overview.set(overview);
      this.loadError.set(null);
      if (this.checkingAll() && !overview.check.isRunning) {
        this.checkingAll.set(false);
        this.toast.success('Home Assistant checked.');
      }
    } catch (error) {
      this.loadError.set(String((error as { message?: string })?.message ?? error));
      this.checkingAll.set(false);
      this.toast.error(error);
    }
  }

  protected async checkAll(): Promise<void> {
    this.checkingAll.set(true);
    try {
      this.overview.set(await firstValueFrom(this.api.checkHomeAssistant()));
    } catch (error) {
      this.checkingAll.set(false);
      this.toast.error(error);
    }
  }

  /** Watches the repository a component names; the component is linked to it by that name. */
  protected async watch(c: HomeAssistantComponent): Promise<void> {
    const repository = c.suggestedRepository;
    if (!repository) return;
    this.watching.update((s) => new Set(s).add(c.id));
    try {
      await firstValueFrom(this.api.addRepository({ repository, includePrereleases: false }));
      this.toast.success(`Watching ${repository}.`);
      await this.load();
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.watching.update((s) => {
        const next = new Set(s);
        next.delete(c.id);
        return next;
      });
    }
  }

  /** A component whose pending update can be installed from here. */
  protected canInstall(c: HomeAssistantComponent): boolean {
    return c.homeAssistantUpdate && c.installBlocker === null && !c.isInstalling;
  }

  protected askInstall(c: HomeAssistantComponent): void {
    this.backupFirst.set(c.supportsBackup);
    this.confirming.set(c.id);
  }

  /** Installs the version Home Assistant offers; the page reloads until it finished. */
  protected async install(c: HomeAssistantComponent): Promise<void> {
    this.confirming.set(null);
    try {
      const started = await firstValueFrom(this.api.installHomeAssistantComponent(c.id, c.supportsBackup && this.backupFirst()));
      const data = this.overview();
      if (data) {
        this.overview.set({ ...data, components: data.components.map((x) => (x.id === started.id ? started : x)) });
      }
    } catch (error) {
      this.toast.error(error);
    }
  }

  /** Restarts Home Assistant, e.g. to load an updated custom integration; the page reloads until it is back. */
  protected async restart(connection: HomeAssistantConnection): Promise<void> {
    this.confirmingRestart.set(null);
    try {
      this.replaceConnection(await firstValueFrom(this.api.restartHomeAssistant(connection.id)));
    } catch (error) {
      this.toast.error(error);
    }
  }

  private replaceConnection(connection: HomeAssistantConnection): void {
    const data = this.overview();
    if (data) {
      this.overview.set({ ...data, connections: data.connections.map((c) => (c.id === connection.id ? connection : c)) });
    }
  }

  protected async checkConnection(connection: HomeAssistantConnection): Promise<void> {
    try {
      const checking = await firstValueFrom(this.api.checkHomeAssistantConnection(connection.id));
      const data = this.overview();
      if (data) {
        this.overview.set({ ...data, connections: data.connections.map((c) => (c.id === checking.id ? checking : c)) });
      }
    } catch (error) {
      this.toast.error(error);
    }
  }
}
