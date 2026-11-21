import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { RunSequencer } from '../src/run-sequencer.ts';

describe('RunSequencer', () => {
  it('runs the tasks of one minute one after another by their order, as one batch', async () => {
    const log: string[] = [];
    let batches = 0;
    const sequencer = new RunSequencer({
      settleMs: 0,
      batch: async (task) => {
        batches++;
        return task();
      },
    });
    const at = new Date(2026, 10, 20, 12, 0, 0, 5);
    const task = (name: string) => async () => {
      log.push(`start ${name}`);
      await Bun.sleep(2);
      log.push(`end ${name}`);
      return name;
    };
    // Fired in "wrong" order within the same minute.
    const results = await Promise.all([
      sequencer.slot(3)(new Date(2026, 10, 20, 12, 0, 0, 50), task('containers')),
      sequencer.slot(1)(at, task('releases')),
      sequencer.slot(2)(at, task('vulnerabilities')),
    ]);

    assert.deepEqual(results, ['containers', 'releases', 'vulnerabilities']);
    assert.deepEqual(log, [
      'start releases', 'end releases',
      'start vulnerabilities', 'end vulnerabilities',
      'start containers', 'end containers',
    ]);
    assert.equal(batches, 1);
  });

  it('keeps going after a failed task and does not chain different minutes', async () => {
    const sequencer = new RunSequencer({ settleMs: 0 });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const slow = sequencer.slot(1)(new Date(2026, 10, 20, 12, 0), () => new Promise<void>((resolve) => (releaseFirst = resolve)));
    const failing = sequencer.slot(2)(new Date(2026, 10, 20, 12, 0), async () => {
      throw new Error('boom');
    });
    const other = sequencer.slot(3)(new Date(2026, 10, 20, 12, 1), async () => {
      order.push('12:01');
    });
    await other; // not blocked by the 12:00 group
    order.push('12:00 still running');
    releaseFirst();
    await slow;
    await assert.rejects(failing, /boom/);
    assert.deepEqual(order, ['12:01', '12:00 still running']);
  });
});
