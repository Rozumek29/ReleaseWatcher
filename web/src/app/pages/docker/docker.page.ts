import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { DockerContainer, DockerEndpoint, DockerOverview } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { describeCron } from '../../shared/cron';
import { DockerContainers } from '../../shared/docker-containers';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';

export type DockerFilter = 'all' | 'updates' | 'unknown';

/** One card: a Docker endpoint or a machine with Docker containers. */
interface SourceCard {
  key: string;
  kind: 'endpoint' | 'target';
  id: number;
  name: string;
  endpoint: DockerEndpoint | null;
  containers: DockerContainer[];
}

/** While an endpoint or the scheduled run is checking, the page reloads this often. */
const POLL_MS = 2000;

/** A container with a newer image for its tag or a newer release of its repository. */
export const hasUpdate = (c: DockerContainer): boolean => c.registry.state === 'update-available' || c.updateAvailable === true;

/**
 * Docker page: the containers of the Docker endpoints (socket, socket proxy, TCP – managed under Settings → Connections)
 * and the Docker / Podman containers of every machine, with their versions, newer images and linked repositories.
 */
@Component({
  selector: 'app-docker-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DockerContainers, Icon, RelativeTimePipe, RouterLink],
  templateUrl: './docker.page.html',
  styleUrl: './docker.page.scss',
})
export class DockerPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly statusService = inject(StatusService);
  protected readonly describeCron = describeCron;

  protected readonly overview = signal<DockerOverview | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly filter = signal<DockerFilter>('all');
  protected readonly checkingAll = signal(false);
  protected readonly now = signal(Date.now());

  protected readonly filters: { value: DockerFilter; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'updates', label: 'Updates' },
    { value: 'unknown', label: 'Version unknown' },
  ];

  /** Shown containers (not ignored, still running) per filter. */
  protected readonly counts = computed(() => {
    const shown = (this.overview()?.containers ?? []).filter((c) => !c.ignored && c.present);
    return {
      all: shown.length,
      updates: shown.filter(hasUpdate).length,
      unknown: shown.filter((c) => c.installedVersion === null).length,
    };
  });

  protected readonly cards = computed<SourceCard[]>(() => {
    const data = this.overview();
    if (!data) return [];
    const matches = (c: DockerContainer) =>
      this.filter() === 'all' || (!c.ignored && c.present && (this.filter() === 'updates' ? hasUpdate(c) : c.installedVersion === null));
    const cards: SourceCard[] = data.endpoints.map((e) => ({
      key: `e${e.id}`,
      kind: 'endpoint',
      id: e.id,
      name: e.name,
      endpoint: e,
      containers: data.containers.filter((c) => c.source.kind === 'endpoint' && c.source.id === e.id && matches(c)),
    }));
    const targets = new Map<number, SourceCard>();
    for (const c of data.containers) {
      if (c.source.kind !== 'target') continue;
      const card = targets.get(c.source.id) ?? {
        key: `t${c.source.id}`,
        kind: 'target' as const,
        id: c.source.id,
        name: c.source.name ?? `Machine ${c.source.id}`,
        endpoint: null,
        containers: [],
      };
      if (matches(c)) card.containers.push(c);
      targets.set(c.source.id, card);
    }
    const all = [...cards, ...[...targets.values()].sort((a, b) => a.name.localeCompare(b.name))];
    return this.filter() === 'all' ? all : all.filter((card) => card.containers.length > 0);
  });

  protected readonly isEmpty = computed(() => {
    const data = this.overview();
    return data !== null && data.endpoints.length === 0 && data.containers.length === 0;
  });

  /** Something is being checked: reload until it finished. */
  private readonly checking = computed(
    () => this.checkingAll() || !!this.overview()?.check.isRunning || !!this.overview()?.endpoints.some((e) => e.isChecking),
  );

  constructor() {
    effect(() => {
      this.statusService.revision();
      untracked(() => void this.load());
    });
    effect((onCleanup) => {
      if (!this.checking()) return;
      const timer = setTimeout(() => void this.load(), POLL_MS);
      onCleanup(() => clearTimeout(timer));
    });
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  protected async load(): Promise<void> {
    try {
      const overview = await firstValueFrom(this.api.getDocker());
      this.overview.set(overview);
      this.loadError.set(null);
      if (this.checkingAll() && !overview.check.isRunning) {
        this.checkingAll.set(false);
        this.toast.success('Docker containers checked.');
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
      this.overview.set(await firstValueFrom(this.api.checkDocker()));
    } catch (error) {
      this.checkingAll.set(false);
      this.toast.error(error);
    }
  }

  protected async checkEndpoint(e: DockerEndpoint): Promise<void> {
    try {
      this.replaceEndpoint(await firstValueFrom(this.api.checkDockerEndpoint(e.id)));
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected onContainerChanged(container: DockerContainer): void {
    const data = this.overview();
    if (!data) return;
    this.overview.set({ ...data, containers: data.containers.map((c) => (c.id === container.id ? container : c)) });
  }

  private replaceEndpoint(endpoint: DockerEndpoint): void {
    const data = this.overview();
    if (!data) return;
    this.overview.set({ ...data, endpoints: data.endpoints.map((e) => (e.id === endpoint.id ? endpoint : e)) });
  }
}
