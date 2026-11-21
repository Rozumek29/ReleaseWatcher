const SHORTCUTS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

const pad = (value: string) => value.padStart(2, '0');

/**
 * Short English description of common cron expressions ("Every 15 min", "Every 6 hours", "Daily at 03:00");
 * anything else is returned as it is.
 */
export function describeCron(expression: string): string {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  const parts = (SHORTCUTS[normalized.toLowerCase()] ?? normalized).split(' ');
  if (parts.length !== 5) {
    return normalized;
  }
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const everyDay = day === '*' && month === '*' && weekday === '*';
  if (!everyDay) {
    if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && day === '*' && month === '*' && weekday === '0') {
      return `Weekly on Sunday at ${pad(hour)}:${pad(minute)}`;
    }
    return normalized;
  }
  if (minute === '*' && hour === '*') {
    return 'Every minute';
  }
  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === '*') {
    return `Every ${minuteStep[1]} min`;
  }
  if (/^\d+$/.test(minute)) {
    if (hour === '*') {
      return minute === '0' ? 'Hourly' : `Hourly at :${pad(minute)}`;
    }
    const hourStep = /^\*\/(\d+)$/.exec(hour);
    if (hourStep) {
      return `Every ${hourStep[1]} hours${minute === '0' ? '' : ` at :${pad(minute)}`}`;
    }
    if (/^\d+$/.test(hour)) {
      return `Daily at ${pad(hour)}:${pad(minute)}`;
    }
  }
  return normalized;
}
