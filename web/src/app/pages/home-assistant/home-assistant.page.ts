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

export type HomeAssistantFilter = 'all' | 'updates';

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
  ];

  protected readonly counts = computed(() => {
    const components = this.overview()?.components ?? [];
    return { all: components.length, updates: components.filter((c) => c.homeAssistantUpdate).length };
  });

  protected readonly cards = computed<ConnectionCard[]>(() => {
    const data = this.overview();
    if (!data) return [];
    const updatesOnly = this.filter() === 'updates';
    const cards = data.connections.map((connection) => ({
      connection,
      components: data.components.filter((c) => c.connectionId === connection.id && (!updatesOnly || c.homeAssistantUpdate)),
    }));
    return updatesOnly ? cards.filter((card) => card.components.length > 0) : cards;
  });

  /** Something is being read: reload until it finished. */
  private readonly checking = computed(
    () => this.checkingAll() || !!this.overview()?.check.isRunning || !!this.overview()?.connections.some((c) => c.isChecking),
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
