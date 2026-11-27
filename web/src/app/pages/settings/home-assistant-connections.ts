import { ChangeDetectionStrategy, Component, OnInit, computed, effect, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { ClockService } from '../../core/clock.service';
import { HomeAssistantConnection } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { HomeAssistantConnectionDialog, HomeAssistantConnectionDialogData } from './home-assistant-connection.dialog';

/** While a connection is being read, the list reloads this often. */
const POLL_MS = 2000;

/**
 * Settings → Connections: the Home Assistant instances whose update entities are read (address + long-lived access
 * token). What was read is shown on the Home Assistant page.
 */
@Component({
  selector: 'app-home-assistant-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HomeAssistantConnectionDialog, Icon, RelativeTimePipe],
  templateUrl: './home-assistant-connections.html',
  styleUrl: './home-assistant-connections.scss',
})
export class HomeAssistantConnections implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  protected readonly connections = signal<HomeAssistantConnection[] | null>(null);
  /** Connection IDs with an action in progress. */
  protected readonly busy = signal<ReadonlySet<number>>(new Set());
  /** Connection whose removal is being confirmed. */
  protected readonly confirming = signal<number | null>(null);
  protected readonly editing = signal<HomeAssistantConnectionDialogData | null>(null);
  protected readonly now = inject(ClockService).now;

  /** Some connection is being read: reload until it finished. */
  private readonly checking = computed(() => !!this.connections()?.some((c) => c.isChecking));

  constructor() {
    effect((onCleanup) => {
      // Read the list too: `checking` stays true across a reload, and the effect only runs again when what it read
      // changed – without this it would reload once and then wait forever.
      this.connections();
      if (!this.checking()) return;
      const timer = setTimeout(() => void this.reload(), POLL_MS);
      onCleanup(() => clearTimeout(timer));
    });
  }

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  protected async reload(): Promise<void> {
    try {
      this.connections.set(await firstValueFrom(this.api.getHomeAssistantConnections()));
    } catch (error) {
      this.toast.error(error);
      this.connections.update((c) => c ?? []);
    }
  }

  protected saved(connection: HomeAssistantConnection, added: boolean): void {
    this.editing.set(null);
    this.toast.success(added ? `${connection.name} added – reading it now.` : 'Connection saved.');
    void this.reload();
  }

  protected async check(connection: HomeAssistantConnection): Promise<void> {
    await this.run(connection.id, async () => {
      const checking = await firstValueFrom(this.api.checkHomeAssistantConnection(connection.id));
      this.connections.update((list) => list?.map((c) => (c.id === checking.id ? checking : c)) ?? null);
    });
  }

  protected async remove(connection: HomeAssistantConnection): Promise<void> {
    this.confirming.set(null);
    await this.run(connection.id, async () => {
      await firstValueFrom(this.api.deleteHomeAssistantConnection(connection.id));
      this.toast.success(`${connection.name} removed.`);
      await this.reload();
    });
  }

  /** Runs an action with its row marked busy; errors become a toast. */
  private async run(id: number, action: () => Promise<void>): Promise<void> {
    this.busy.update((s) => new Set(s).add(id));
    try {
      await action();
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }
}
