import type { Logger } from '../log.ts';
import { type Container, type PendingUpdate, pendingUpdates } from './domain.ts';
import { ContainerBusyError, type ContainerService } from './service.ts';
import type { ContainerStore } from './store.ts';

/** Thrown when "update all" is started while a previous one is still running. */
export class UpdateAllRunningError extends Error {
  constructor() {
    super('Updates of all containers are already running – wait for them to finish.');
    this.name = 'UpdateAllRunningError';
  }
}

/**
 * Runs "update all": the pending updates ({@link pendingUpdates}) of every container, one container after another
 * and one update after another. Each update is a normal run of {@link ContainerService}. A failed update skips the
 * remaining updates of that container (it may be in a broken state) and continues with the next container.
 */
export class ContainerUpdater {
  private readonly store: ContainerStore;
  private readonly service: ContainerService;
  private readonly log: Pick<Logger, 'info' | 'warn'>;
  /** Containers still waiting for (or running) their updates. */
  private readonly queued = new Set<number>();
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
   * Containers that "update all" would update right now, with their updates (the response of the endpoint is
   * based on it; the updates themselves are worked out again when a container gets its turn).
   */
  plan(): { container: Container; updates: PendingUpdate[] }[] {
    return this.store
      .listEnabled()
      .map((container) => ({ container, updates: pendingUpdates(container, this.store.listApps(container.id)) }))
      .filter((entry) => entry.updates.length > 0);
  }

  /**
   * Starts updating the given containers in the background.
   * @param backupStorageOf storage to back up a container to before its first update (null = no backup)
   */
  start(containerIds: readonly number[], backupStorageOf: (container: Container) => string | null): Promise<void> {
    if (this.running) {
      throw new UpdateAllRunningError();
    }
    this.stopped = false;
    for (const id of containerIds) {
      this.queued.add(id);
    }
    const running = this.runAll([...containerIds], backupStorageOf).finally(() => {
      this.queued.clear();
      this.running = null;
    });
    this.running = running;
    return running;
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

  private async runAll(containerIds: number[], backupStorageOf: (container: Container) => string | null): Promise<void> {
    this.log.info({ count: containerIds.length }, 'Updating all containers');
    for (const id of containerIds) {
      try {
        if (!this.stopped) {
          await this.updateContainer(id, backupStorageOf);
        }
      } catch (error) {
        this.log.warn({ err: error, containerId: id }, 'Update of a container failed');
      } finally {
        this.queued.delete(id);
      }
    }
  }

  private async updateContainer(id: number, backupStorageOf: (container: Container) => string | null): Promise<void> {
    const initial = this.store.get(id);
    if (!initial) {
      return;
    }
    // Back up once, before the first update of the container.
    let backup = backupStorageOf(initial);
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

const updateKey = (update: PendingUpdate): string => (update.kind === 'apt-upgrade' ? 'apt' : `app:${update.appId}`);
