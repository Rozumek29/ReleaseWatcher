import { type CronSchedule, parseCron } from './cron.ts';
import type { Logger } from './log.ts';

export interface CronJobStatus {
  /** Cron expression the job runs on (as configured, also when invalid). */
  cron: string;
  isRunning: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  /** Next scheduled run; null while running, after `stop()` or when the expression is invalid. */
  nextRunAt: string | null;
}

/** Longest single timer; later runs are reached by re-arming (setTimeout overflows after ~24.8 days). */
const MAX_TIMER_MS = 60 * 60 * 1000;

/**
 * Runs a task on a cron schedule (read on every arm, so changes apply after `reschedule()`). Runs never overlap:
 * a scheduled time that passes while the task is still running is skipped.
 */
export class CronJob {
  private timer: Timer | null = null;
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private readonly task: (signal: AbortSignal) => Promise<void>;
  private readonly cron: () => string;
  private readonly log: Pick<Logger, 'warn' | 'error'>;
  private readonly name: string;
  private readonly now: () => Date;
  private schedule: CronSchedule | null = null;
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private nextRunAt: Date | null = null;

  constructor(deps: {
    name: string;
    task: (signal: AbortSignal) => Promise<void>;
    cron: () => string;
    log: Pick<Logger, 'warn' | 'error'>;
    now?: () => Date;
  }) {
    this.name = deps.name;
    this.task = deps.task;
    this.cron = deps.cron;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
  }

  get status(): CronJobStatus {
    return {
      cron: this.cron(),
      isRunning: this.running !== null,
      lastRunStartedAt: this.lastRunStartedAt?.toISOString() ?? null,
      lastRunFinishedAt: this.lastRunFinishedAt?.toISOString() ?? null,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
    };
  }

  /** Arms the schedule; with `runAfterMs` it also runs once that soon (e.g. shortly after startup). */
  start(runAfterMs?: number): void {
    if (runAfterMs === undefined) {
      this.arm();
      return;
    }
    this.clearTimer();
    this.nextRunAt = new Date(this.now().getTime() + runAfterMs);
    this.timer = setTimeout(() => this.run(), runAfterMs);
  }

  /** Re-plans the next run after the cron expression changed. */
  reschedule(): void {
    if (this.running || this.abort.signal.aborted) {
      return; // the running cycle arms the next one with the new expression
    }
    this.arm();
  }

  /** Runs now (unless a run is already in progress, which is awaited instead). */
  async runNow(): Promise<void> {
    if (!this.running) {
      this.run();
    }
    await this.running;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.clearTimer();
    this.nextRunAt = null;
    await this.running;
  }

  private currentSchedule(): CronSchedule | null {
    const expression = this.cron();
    if (this.schedule?.expression !== expression.trim().replace(/\s+/g, ' ')) {
      try {
        this.schedule = parseCron(expression);
      } catch (error) {
        this.log.warn({ err: error, job: this.name, expression }, 'Invalid cron expression – job is not scheduled');
        this.schedule = null;
      }
    }
    return this.schedule;
  }

  /** Plans the next run after `from` (default: now). */
  private arm(from = this.now()): void {
    this.clearTimer();
    this.nextRunAt = null;
    if (this.abort.signal.aborted) {
      return;
    }
    const next = this.currentSchedule()?.next(from) ?? null;
    if (!next) {
      return;
    }
    this.nextRunAt = next;
    this.wait();
  }

  /** Sleeps until `nextRunAt` in steps of at most {@link MAX_TIMER_MS}. */
  private wait(): void {
    const delay = (this.nextRunAt?.getTime() ?? 0) - this.now().getTime();
    this.timer = setTimeout(
      () => (delay > MAX_TIMER_MS ? this.wait() : this.run()),
      Math.max(0, Math.min(delay, MAX_TIMER_MS)),
    );
  }

  private run(): void {
    this.clearTimer();
    this.nextRunAt = null;
    this.lastRunStartedAt = this.now();
    this.running = this.task(this.abort.signal)
      .catch((error: unknown) => this.log.error({ err: error, job: this.name }, 'Scheduled job failed'))
      .finally(() => {
        this.running = null;
        this.lastRunFinishedAt = this.now();
        // A timer that fired a little early must not plan the same minute again.
        const started = this.lastRunStartedAt?.getTime() ?? 0;
        this.arm(new Date(Math.max(this.lastRunFinishedAt.getTime(), started + 1000)));
      });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
