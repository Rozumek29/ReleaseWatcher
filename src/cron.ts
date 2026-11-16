/**
 * Minimal 5-field cron expressions ("minute hour day-of-month month day-of-week"), evaluated in the server's
 * local time zone (set `TZ` to change it). Supports `*`, numbers, ranges `a-b`, steps `*\/n` / `a-b/n`, lists
 * `a,b` and the shortcuts `@hourly`, `@daily`, `@weekly`, `@monthly`. Day of week: 0–7 (0 and 7 = Sunday).
 * As in classic cron, when both day fields are restricted a date matches if either of them matches.
 */

export interface CronSchedule {
  readonly expression: string;
  matches(date: Date): boolean;
  /** First matching minute strictly after `from` (null when none within ~1 year). */
  next(from: Date): Date | null;
}

export class CronError extends Error {
  override name = 'CronError';
}

const SHORTCUTS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
};

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const;

function parseField(text: string, field: (typeof FIELDS)[number]): Set<number> {
  const values = new Set<number>();
  const number = (raw: string): number => {
    if (!/^\d+$/.test(raw)) {
      throw new CronError(`Invalid ${field.name} value "${raw}".`);
    }
    const value = Number(raw);
    if (value < field.min || value > field.max) {
      throw new CronError(`${field.name} must be between ${field.min} and ${field.max}, got ${value}.`);
    }
    return value;
  };

  for (const part of text.split(',')) {
    const [range = '', stepText] = part.split('/');
    const step = stepText === undefined ? 1 : number(stepText);
    if (step < 1) {
      throw new CronError(`Step in ${field.name} must be at least 1.`);
    }
    let from: number;
    let to: number;
    if (range === '*') {
      [from, to] = [field.min, field.max];
    } else if (range.includes('-')) {
      const [a = '', b = ''] = range.split('-');
      [from, to] = [number(a), number(b)];
      if (from > to) {
        throw new CronError(`Invalid ${field.name} range "${range}".`);
      }
    } else {
      from = number(range);
      to = stepText === undefined ? from : field.max;
    }
    for (let v = from; v <= to; v += step) {
      values.add(v);
    }
  }
  return values;
}

/** Parses a cron expression; throws {@link CronError} with a readable message when invalid. */
export function parseCron(expression: string): CronSchedule {
  const normalized = expression.trim().replace(/\s+/g, ' ');
  const parts = (SHORTCUTS[normalized.toLowerCase()] ?? normalized).split(' ');
  if (parts.length !== 5) {
    throw new CronError('A cron expression needs 5 fields: minute hour day-of-month month day-of-week.');
  }
  const [minutes, hours, days, months, weekdays] = parts.map((p, i) => parseField(p, FIELDS[i]!)) as [
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
    Set<number>,
  ];
  if (weekdays.has(7)) {
    weekdays.add(0);
  }
  const dayRestricted = parts[2] !== '*';
  const weekdayRestricted = parts[4] !== '*';

  const matches = (date: Date): boolean => {
    if (!minutes.has(date.getMinutes()) || !hours.has(date.getHours()) || !months.has(date.getMonth() + 1)) {
      return false;
    }
    const dayOk = days.has(date.getDate());
    const weekdayOk = weekdays.has(date.getDay());
    if (dayRestricted && weekdayRestricted) {
      return dayOk || weekdayOk;
    }
    return dayOk && weekdayOk;
  };

  return {
    expression: normalized,
    matches,
    next(from) {
      const date = new Date(from);
      date.setSeconds(0, 0);
      for (let i = 0; i < 366 * 24 * 60; i++) {
        date.setMinutes(date.getMinutes() + 1);
        if (matches(date)) {
          return new Date(date);
        }
      }
      return null;
    },
  };
}

/** Returns an error message for an invalid expression, or null. */
export function validateCron(expression: string): string | null {
  try {
    parseCron(expression);
    return null;
  } catch (error) {
    return error instanceof CronError ? error.message : String(error);
  }
}
