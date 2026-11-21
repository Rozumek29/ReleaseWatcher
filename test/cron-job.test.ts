import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'bun:test';
import { CronJob } from '../src/cron-job.ts';
import type { Logger } from '../src/log.ts';
import { silentLog } from './helpers.ts';

type JobLog = Pick<Logger, 'warn' | 'error'>;

const at = (h: number, mi: number, s = 0) => new Date(2026, 10, 20, h, mi, s);

describe('CronJob', () => {
  const jobs: CronJob[] = [];
  const create = (options: { cron: () => string; task?: () => Promise<void>; now?: () => Date; log?: JobLog }) => {
    const job = new CronJob({
      name: 'test',
      task: options.task ?? (async () => {}),
      cron: options.cron,
      log: options.log ?? silentLog,
      now: options.now ?? (() => at(12, 0, 30)),
    });
    jobs.push(job);
    return job;
  };

  afterEach(async () => {
    await Promise.all(jobs.splice(0).map((job) => job.stop()));
  });

  it('plans the next run from the cron expression and follows changes after reschedule()', () => {
    let cron = '*/15 * * * *';
    const job = create({ cron: () => cron });
    job.start();
    assert.deepEqual(job.status, {
      cron: '*/15 * * * *',
      isRunning: false,
      lastRunStartedAt: null,
      lastRunFinishedAt: null,
      nextRunAt: at(12, 15).toISOString(),
    });

    cron = '0 3 * * *';
    job.reschedule();
    assert.equal(job.status.nextRunAt, new Date(2026, 10, 21, 3, 0).toISOString());
  });

  it('is not scheduled while the expression is invalid', () => {
    const warnings: unknown[] = [];
    const job = create({ cron: () => 'often', log: { ...silentLog, warn: (fields: unknown) => void warnings.push(fields) } as JobLog });
    job.start();
    assert.equal(job.status.nextRunAt, null);
    assert.equal(warnings.length, 1);
  });

  it('runs once soon after start when asked to, then continues on the schedule', async () => {
    let runs = 0;
    let finished!: () => void;
    const done = new Promise<void>((resolve) => (finished = resolve));
    const job = create({
      cron: () => '0 * * * *',
      task: async () => {
        runs++;
        finished();
      },
    });
    job.start(5);
    assert.ok(job.status.nextRunAt);
    await done;
    while (job.status.isRunning) {
      await Bun.sleep(1);
    }
    await job.runNow(); // nothing running any more – runs again
    assert.equal(runs, 2);
    assert.equal(job.status.isRunning, false);
    assert.ok(job.status.lastRunFinishedAt);
    assert.equal(job.status.nextRunAt, at(13, 0).toISOString());
  });

  it('never runs twice at the same time and keeps scheduling after a failure', async () => {
    let runs = 0;
    let release!: () => void;
    const errors: unknown[] = [];
    const job = create({
      cron: () => '*/5 * * * *',
      task: () => {
        runs++;
        return new Promise<void>((_, reject) => (release = () => reject(new Error('boom'))));
      },
      log: { ...silentLog, error: (fields: unknown) => void errors.push(fields) } as JobLog,
    });
    const first = job.runNow();
    const second = job.runNow();
    assert.equal(job.status.isRunning, true);
    assert.equal(job.status.nextRunAt, null);
    release();
    await Promise.all([first, second]);
    assert.equal(runs, 1);
    assert.equal(errors.length, 1);
    assert.equal(job.status.nextRunAt, at(12, 5).toISOString());
  });

  it('passes scheduled runs (not manual ones) through the sequence', async () => {
    const sequenced: string[] = [];
    let runs = 0;
    let scheduledRan!: () => void;
    const done = new Promise<void>((resolve) => (scheduledRan = resolve));
    const job = new CronJob({
      name: 'test',
      task: async () => {
        if (++runs === 2) {
          scheduledRan();
        }
      },
      cron: () => '* * * * *',
      log: silentLog,
      // 30 ms before the next minute, so the scheduled run comes right away.
      now: () => new Date(2026, 10, 20, 12, 0, 59, 970),
      sequence: (scheduledAt, task) => {
        sequenced.push(scheduledAt.toISOString());
        return task();
      },
    });
    jobs.push(job);
    await job.runNow();
    assert.deepEqual(sequenced, []);
    job.start();
    await done;
    assert.deepEqual(sequenced, [at(12, 1).toISOString()]);
  });

  it('stops: no next run and the running task is awaited', async () => {
    let finished = false;
    const job = create({
      cron: () => '* * * * *',
      task: async () => {
        await Bun.sleep(5);
        finished = true;
      },
    });
    job.start();
    void job.runNow();
    await job.stop();
    assert.equal(finished, true);
    assert.equal(job.status.nextRunAt, null);
  });
});
