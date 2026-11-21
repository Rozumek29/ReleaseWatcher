import { describeCron } from './cron';

describe('describeCron', () => {
  it('describes common schedules', () => {
    expect(describeCron('* * * * *')).toBe('Every minute');
    expect(describeCron('*/15 * * * *')).toBe('Every 15 min');
    expect(describeCron('0 * * * *')).toBe('Hourly');
    expect(describeCron('@hourly')).toBe('Hourly');
    expect(describeCron('30 * * * *')).toBe('Hourly at :30');
    expect(describeCron('0 */6 * * *')).toBe('Every 6 hours');
    expect(describeCron('15 */6 * * *')).toBe('Every 6 hours at :15');
    expect(describeCron('0 3 * * *')).toBe('Daily at 03:00');
    expect(describeCron('@daily')).toBe('Daily at 00:00');
    expect(describeCron('@weekly')).toBe('Weekly on Sunday at 00:00');
  });

  it('returns other expressions as they are', () => {
    expect(describeCron('0 9-17 * * 1-5')).toBe('0 9-17 * * 1-5');
    expect(describeCron('  0  3 1 * * ')).toBe('0 3 1 * *');
    expect(describeCron('often')).toBe('often');
  });
});
