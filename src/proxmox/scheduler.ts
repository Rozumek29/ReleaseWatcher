import { type CronSchedule, parseCron } from '../cron.ts';
import type { Logger } from '../log.ts';
import type { Container, RunTrigger } from './domain.ts';
import type { ContainerService } from './service.ts';
import type { ContainerStore } from './store.ts';

/**
 * Runs container checks according to cron expressions: each container uses its own `checkCron` or the
 * global default. Wakes up at the start of every minute; checks run one after another.
 */
export class ContainerScheduler {
  private timer: Timer | null = null;
  private stopped = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly store: ContainerStore;
  private readonly service: ContainerService;
  private readonly defaultCron: () => string;
  private readonly log: Pick<Logger, 'warn' | 'error'>;
  private readonly cache = new Map<string, CronSchedule | null>();

  constructor(deps: {
    store: ContainerStore;
    service: ContainerService;
    defaultCron: () => string;
    log: Pick<Logger, 'warn' | 'error'>;
  }) {
    this.store = deps.store;
    this.service = deps.service;
    this.defaultCron = deps.defaultCron;
    this.log = deps.log;
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
    await this.queue;
  }

  /** Runs the checks due at `now` (exposed for tests). Resolves when they are finished. */
  tick(now: Date): Promise<void> {
    if (!this.service.shell.isConfigured) {
      return this.queue;
    }
    const due = this.store.listEnabled().filter((c) => this.scheduleOf(c)?.matches(now));
    for (const container of due) {
      this.queue = this.queue.then(() => this.checkOne(container.id, 'schedule'));
    }
    return this.queue;
  }

  /** Checks all enabled containers one after another (manual "check all"). */
  checkAll(): Promise<void> {
    for (const container of this.store.listEnabled()) {
      this.queue = this.queue.then(() => this.checkOne(container.id, 'manual'));
    }
    return this.queue;
  }

  private async checkOne(containerId: number, trigger: RunTrigger): Promise<void> {
    if (this.stopped) {
      return;
    }
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
    const now = Date.now();
    const delay = 60_000 - (now % 60_000) + 50;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick(new Date()).catch((error: unknown) => this.log.error({ err: error }, 'Container scheduler failed'));
      this.arm();
    }, delay);
  }
}
