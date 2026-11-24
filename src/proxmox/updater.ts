import type { Logger } from '../log.ts';
import { type Container, type PendingUpdate, pendingUpdates } from './domain.ts';
import { ContainerBusyError, type ContainerService } from './service.ts';
import type { ContainerStore } from './store.ts';

/** Thrown when every requested container is already waiting for (or running) its updates. */
export class UpdateAllRunningError extends Error {
  constructor(message = 'Updates of all containers are already running – wait for them to finish.') {
    super(message);
    this.name = 'UpdateAllRunningError';
  }
}

/** A container to update and the storage to back it up to before its first update (null = no backup). */
export interface UpdateRequest {
  containerId: number;
  backupStorage: string | null;
}

/**
 * Runs "update all" – of every container or of a single one: the pending updates ({@link pendingUpdates}) of the
 * queued containers, one container after another and one update after another. Each update is a normal run of
 * {@link ContainerService}. A failed update skips the remaining updates of that container (it may be in a broken
 * state) and continues with the next container. Containers can be queued while others are being updated.
 */
export class ContainerUpdater {
  private readonly store: ContainerStore;
  private readonly service: ContainerService;
  private readonly log: Pick<Logger, 'info' | 'warn'>;
  /** Containers still waiting for (or running) their updates, with their backup storage. */
  private readonly queued = new Map<number, string | null>();
  private running: Promise<void> | null = null;
  private stopped = false;

  constructor(deps: { store: ContainerStore; service: ContainerService; log: Pick<Logger, 'info' | 'warn'> }) {
    this.store = deps.store;
    this.service = deps.service;
    this.log = deps.log;
  }

  /** The container is waiting for or running its part of "update all". */
  isQueued(containerId: number): boolean {
    return this.queued.has(containerId);
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  /**
   * Pending updates of the given containers (all enabled ones when omitted) that "update all" would run right now
   * (the response of the endpoint is based on it; the updates themselves are worked out again when a container
   * gets its turn). Containers without pending updates are left out.
   */
  plan(containers: readonly Container[] = this.store.listEnabled()): { container: Container; updates: PendingUpdate[] }[] {
    const appsOf = Map.groupBy(this.store.listApps(), (a) => a.containerId);
    return containers
      .map((container) => ({ container, updates: pendingUpdates(container, appsOf.get(container.id) ?? []) }))
      .filter((entry) => entry.updates.length > 0);
  }

  /**
   * Queues containers for updating in the background (containers queued already are skipped) and starts working
   * through the queue unless it runs already. Returns the number of containers added.
   */
  enqueue(requests: readonly UpdateRequest[]): number {
    let added = 0;
    for (const { containerId, backupStorage } of requests) {
      if (!this.queued.has(containerId)) {
        this.queued.set(containerId, backupStorage);
        added++;
      }
    }
    if (added > 0 && !this.running) {
      this.stopped = false;
      this.running = this.runQueue().finally(() => {
        this.queued.clear();
        this.running = null;
      });
    }
    return added;
  }

  /** Resolves when "update all" is not running (tests). */
  async idle(): Promise<void> {
    await this.running;
  }

  /** Stops after the update that is running now (that one finishes in the service). */
  async stop(): Promise<void> {
    this.stopped = true;
    await this.running;
  }

  private async runQueue(): Promise<void> {
    this.log.info({ count: this.queued.size }, 'Updating containers');
    // A Map iterates in insertion order and visits entries added during the iteration.
    for (const [id, backupStorage] of this.queued) {
      if (this.stopped) {
        return;
      }
      try {
        await this.updateContainer(id, backupStorage);
      } catch (error) {
        this.log.warn({ err: error, containerId: id }, 'Update of a container failed');
      } finally {
        this.queued.delete(id);
      }
    }
  }

  private async updateContainer(id: number, backupStorage: string | null): Promise<void> {
    // Back up once, before the first update of the container.
    let backup = backupStorage;
    const done = new Set<string>();
    while (!this.stopped) {
      // Re-read the state: the previous update re-checked the container (versions, packages may have changed).
      const container = this.store.get(id);
      const next = container
        ? pendingUpdates(container, this.store.listApps(id)).find((u) => !done.has(updateKey(u)))
        : undefined;
      if (!container || !next) {
        return;
      }
      done.add(updateKey(next));
      const run = await this.runUpdate(container, next, backup);
      if (run === null) {
        continue; // the application was removed meanwhile
      }
      backup = null;
      if (run.status !== 'succeeded') {
        this.log.warn({ vmid: container.vmid, kind: next.kind }, 'Update failed – skipping the remaining updates of the container');
        return;
      }
    }
  }

  /** Starts one update (waiting for a task of the container that runs already) and waits for it to finish. */
  private async runUpdate(container: Container, update: PendingUpdate, backup: string | null) {
    for (;;) {
      if (this.service.isBusy(container.id)) {
        await this.service.wait(container.id);
        continue;
      }
      try {
        if (update.kind === 'apt-upgrade') {
          this.service.startAptUpgrade(container, backup);
        } else if ('store' in update) {
          this.service.startAppStoreUpdate(container, update.store, backup);
        } else if (update.kind === 'home-assistant-update') {
          this.service.startHomeAssistantUpdate(container, null, backup);
        } else {
          const app = this.store.getApp(container.id, update.appId);
          if (!app) return null;
          this.service.startAppUpdate(container, app, backup);
        }
      } catch (error) {
        if (error instanceof ContainerBusyError) continue;
        throw error;
      }
      return this.service.wait(container.id);
    }
  }
}

const updateKey = (update: PendingUpdate): string =>
  update.kind === 'app-update' ? `app:${update.appId}` : update.kind === 'apt-upgrade' ? 'apt' : update.kind;
