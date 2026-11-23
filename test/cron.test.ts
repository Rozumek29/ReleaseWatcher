import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { intervalToCron, parseCron, validateCron } from '../src/cron.ts';

const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi);

describe('cron', () => {
  it('matches every 6 hours on the hour', () => {
    const cron = parseCron('0 */6 * * *');
    assert.equal(cron.matches(at(2026, 11, 16, 6, 0)), true);
    assert.equal(cron.matches(at(2026, 11, 16, 6, 1)), false);
    assert.equal(cron.matches(at(2026, 11, 16, 7, 0)), false);
    assert.deepEqual(cron.next(at(2026, 11, 16, 6, 0)), at(2026, 11, 16, 12, 0));
  });

  it('finds the next time months ahead and gives up after a year', () => {
    assert.deepEqual(parseCron('0 0 1 1 *').next(at(2026, 1, 1, 0, 0)), at(2027, 1, 1, 0, 0));
    assert.deepEqual(parseCron('30 4 29 2 *').next(at(2027, 3, 1, 0, 0)), at(2028, 2, 29, 4, 30));
    assert.equal(parseCron('0 0 29 2 *').next(at(2026, 3, 1, 0, 0)), null, 'the next 29 February is too far ahead');
    assert.equal(parseCron('0 0 31 2 *').next(at(2026, 1, 1, 0, 0)), null);
    // Either day field matches when both are restricted (1st or 15th, or a Friday).
    assert.deepEqual(parseCron('0 0 1,15 * 5').next(at(2026, 11, 23, 10, 0)), at(2026, 11, 27, 0, 0));
    // Day of week 7 is Sunday, like 0.
    assert.deepEqual(parseCron('5 4 * * 7').next(at(2026, 11, 23, 10, 0)), at(2026, 11, 29, 4, 5));
  });

  it('supports ranges, lists and steps', () => {
    const cron = parseCron('15,45 8-18/2 * * 1-5');
    assert.equal(cron.matches(at(2026, 11, 16, 8, 15)), true); // Monday
    assert.equal(cron.matches(at(2026, 11, 16, 9, 15)), false);
    assert.equal(cron.matches(at(2026, 11, 15, 8, 15)), false); // Sunday
  });

  it('treats 7 as Sunday and ORs restricted day fields', () => {
    assert.equal(parseCron('0 3 * * 7').matches(at(2026, 11, 15, 3, 0)), true);
    const cron = parseCron('0 0 1 * 1');
    assert.equal(cron.matches(at(2026, 12, 1, 0, 0)), true); // the 1st (Tuesday)
    assert.equal(cron.matches(at(2026, 11, 16, 0, 0)), true); // a Monday
    assert.equal(cron.matches(at(2026, 11, 17, 0, 0)), false);
  });

  it('understands shortcuts', () => {
    assert.equal(parseCron('@daily').matches(at(2026, 1, 2, 0, 0)), true);
    assert.equal(parseCron('@weekly').next(at(2026, 11, 16, 12, 0))?.getDay(), 0);
  });

  it('rejects invalid expressions with a readable message', () => {
    assert.match(validateCron('* * *') ?? '', /5 fields/);
    assert.match(validateCron('60 * * * *') ?? '', /minute must be between 0 and 59/);
    assert.match(validateCron('*/0 * * * *') ?? '', /Step/);
    assert.match(validateCron('5-1 * * * *') ?? '', /range/);
    assert.equal(validateCron('*/15 * * * *'), null);
  });

  it('converts former polling intervals, rounding to a more frequent schedule when needed', () => {
    assert.equal(intervalToCron(1), '* * * * *');
    assert.equal(intervalToCron(15), '*/15 * * * *');
    assert.equal(intervalToCron(45), '*/30 * * * *');
    assert.equal(intervalToCron(60), '0 * * * *');
    assert.equal(intervalToCron(90), '0 * * * *');
    assert.equal(intervalToCron(360), '0 */6 * * *');
    assert.equal(intervalToCron(300), '0 */4 * * *');
    assert.equal(intervalToCron(1440), '0 0 * * *');
    assert.equal(intervalToCron(5000), '0 0 * * *');
    for (const minutes of [1, 7, 15, 45, 90, 300, 1440]) {
      assert.equal(validateCron(intervalToCron(minutes)), null);
    }
  });
});
