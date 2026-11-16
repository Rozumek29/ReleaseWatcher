import type { Logger } from './log.ts';
import type { ReleaseChecker } from './checker.ts';

export interface PollerStatus {
  intervalMinutes: number;
  isRunning: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  nextRunAt: string | null;
}

/** Periodically runs {@link ReleaseChecker.checkAll}. Cycles never overlap. */
export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private readonly abort = new AbortController();
  private running: Promise<void> | null = null;
  private readonly checker: ReleaseChecker;
  private readonly getIntervalMs: () => number;
  private readonly log: Pick<Logger, 'error'>;
  private lastRunStartedAt: Date | null = null;
  private lastRunFinishedAt: Date | null = null;
  private nextRunAt: Date | null = null;

  constructor(checker: ReleaseChecker, intervalMs: number | (() => number), log: Pick<Logger, 'error'>) {
    this.checker = checker;
    this.getIntervalMs = typeof intervalMs === 'function' ? intervalMs : () => intervalMs;
    this.log = log;
  }

  get status(): PollerStatus {
    return {
      intervalMinutes: this.getIntervalMs() / 60_000,
      isRunning: this.running !== null,
      lastRunStartedAt: this.lastRunStartedAt?.toISOString() ?? null,
      lastRunFinishedAt: this.lastRunFinishedAt?.toISOString() ?? null,
      nextRunAt: this.nextRunAt?.toISOString() ?? null,
    };
  }

  start(initialDelayMs: number): void {
    this.schedule(initialDelayMs);
  }

  /** Re-plans the next run after the interval changed (counted from the last run). */
  reschedule(): void {
    if (this.running || this.abort.signal.aborted) {
      return; // the running cycle schedules the next one with the new interval
    }
    const base = this.lastRunFinishedAt?.getTime() ?? Date.now();
    this.schedule(Math.max(0, base + this.getIntervalMs() - Date.now()));
  }

  /** Runs a cycle now (unless one is already running) and resets the timer. */
  async runNow(): Promise<void> {
    if (this.running) {
      return this.running;
    }
    this.run();
    await this.running;
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.clearTimer();
    await this.running;
  }

  private schedule(delayMs: number): void {
    if (this.abort.signal.aborted) {
      return;
    }
    this.clearTimer();
    this.nextRunAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => this.run(), delayMs);
  }

  private run(): void {
    this.clearTimer();
    this.nextRunAt = null;
    this.lastRunStartedAt = new Date();
    this.running = this.checker
      .checkAll(this.abort.signal)
      .catch((error: unknown) => this.log.error({ err: error }, 'Polling cycle failed'))
      .finally(() => {
        this.running = null;
        this.lastRunFinishedAt = new Date();
        this.schedule(this.getIntervalMs());
      });
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
