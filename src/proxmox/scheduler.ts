import { type CronSchedule, parseCron } from '../cron.ts';
import type { Logger } from '../log.ts';
import type { Sequence } from '../run-sequencer.ts';
import type { Container, RunTrigger } from './domain.ts';
import type { ContainerService } from './service.ts';
import type { ContainerStore } from './store.ts';

/**
 * Runs container checks according to cron expressions: each container uses its own `checkCron` or the
 * global default. Wakes up at the start of every minute. Queued checks run in parallel, at most
 * `concurrency()` at a time; a container is never queued twice.
 */
export class ContainerScheduler {
  private timer: Timer | null = null;
  private stopped = false;
  /** Waiting container IDs (in order) with the trigger they were queued with. */
  private readonly pending = new Map<number, RunTrigger>();
  private readonly inFlight = new Set<number>();
  private idleWaiters: (() => void)[] = [];
  private readonly store: ContainerStore;
  private readonly service: ContainerService;
  private readonly defaultCron: () => string;
  private readonly concurrency: () => number;
  private readonly log: Pick<Logger, 'warn' | 'error'>;
  private readonly batch: <T>(task: () => Promise<T>) => Promise<T>;
  private readonly cache = new Map<string, CronSchedule | null>();
  private readonly sequence: Sequence;

  constructor(deps: {
    store: ContainerStore;
    service: ContainerService;
    defaultCron: () => string;
    /** Maximum number of checks running at the same time (read on every dispatch). */
    concurrency?: () => number;
    log: Pick<Logger, 'warn' | 'error'>;
    /** Groups the checks queued together into one run of notifications (digest mode). */
    batch?: <T>(task: () => Promise<T>) => Promise<T>;
    /** Orders the scheduled checks of a minute after other jobs due in the same minute. */
    sequence?: Sequence;
  }) {
    this.store = deps.store;
    this.service = deps.service;
    this.defaultCron = deps.defaultCron;
    this.concurrency = deps.concurrency ?? (() => 1);
    this.log = deps.log;
    this.batch = deps.batch ?? ((task) => task());
    this.sequence = deps.sequence ?? ((_, task) => task());
  }

  /** Schedule of a container (null when its expression is invalid). */
  scheduleOf(container: Pick<Container, 'checkCron'>): CronSchedule | null {
    const expression = container.checkCron ?? this.defaultCron();
    if (!this.cache.has(expression)) {
      try {
        this.cache.set(expression, parseCron(expression));
      } catch (error) {
        this.log.warn({ err: error, expression }, 'Invalid cron expression');
        this.cache.set(expression, null);
      }
    }
    return this.cache.get(expression) ?? null;
  }

  nextRunOf(container: Container, from = new Date()): Date | null {
    return container.isEnabled ? (this.scheduleOf(container)?.next(from) ?? null) : null;
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    await this.idle();
  }

  /** Queues the checks due at `now` (exposed for tests). Resolves when the queue is empty. */
  tick(now: Date): Promise<void> {
    const due = this.service.shell.isConfigured
      ? this.store.listEnabled().filter((container) => this.scheduleOf(container)?.matches(now))
      : [];
    // Nothing due: resolve right away instead of waiting for manual checks (keeps the run sequence moving).
    return due.length === 0 ? Promise.resolve() : this.queueAll(due.map((c) => c.id), 'schedule');
  }

  /** Queues a check of all enabled containers (manual "check all"). Resolves when the queue is empty. */
  checkAll(): Promise<void> {
    return this.queueAll(this.store.listEnabled().map((c) => c.id), 'manual');
  }

  /** Queues a manual check of the given containers (e.g. after adding several at once). */
  checkMany(containerIds: readonly number[]): Promise<void> {
    return this.queueAll(containerIds, 'manual');
  }

  /** Queues checks as one batch and resolves when the queue is empty. */
  private queueAll(containerIds: readonly number[], trigger: RunTrigger): Promise<void> {
    return this.batch(() => {
      for (const id of containerIds) {
        this.enqueue(id, trigger);
      }
      return this.idle();
    });
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.pending.size === 0 && this.inFlight.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private enqueue(containerId: number, trigger: RunTrigger): void {
    if (this.stopped || this.pending.has(containerId) || this.inFlight.has(containerId)) {
      return;
    }
    this.pending.set(containerId, trigger);
    this.dispatch();
  }

  private dispatch(): void {
    const limit = Math.max(1, this.concurrency());
    while (!this.stopped && this.inFlight.size < limit && this.pending.size > 0) {
      const [containerId, trigger] = this.pending.entries().next().value!;
      this.pending.delete(containerId);
      this.inFlight.add(containerId);
      void this.checkOne(containerId, trigger).finally(() => {
        this.inFlight.delete(containerId);
        this.dispatch();
      });
    }
    if (this.pending.size === 0 && this.inFlight.size === 0) {
      const waiters = this.idleWaiters;
      this.idleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  private async checkOne(containerId: number, trigger: RunTrigger): Promise<void> {
    const container = this.store.get(containerId);
    if (!container || this.service.isBusy(container.id)) {
      return; // deleted meanwhile, or an update is running right now
    }
    try {
      this.service.startCheck(container, trigger);
      await this.service.wait(container.id);
    } catch (error) {
      this.log.error({ err: error, vmid: container.vmid }, 'Scheduled container check failed');
    }
  }

  private arm(): void {
    if (this.stopped) {
      return;
    }
    const delay = 60_000 - (Date.now() % 60_000) + 50;
    this.timer = setTimeout(() => {
      this.timer = null;
      const now = new Date();
      this.sequence(now, () => this.tick(now)).catch((error: unknown) => this.log.error({ err: error }, 'Container scheduler failed'));
      this.arm();
    }, delay);
  }
}
