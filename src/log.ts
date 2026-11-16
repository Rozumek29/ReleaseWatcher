/** Minimal structured logger (one JSON object per line), replacing the pino logger Fastify used to provide. */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type LogFn = (fields: Record<string, unknown>, message: string) => void;
export type Logger = Record<LogLevel, LogFn>;

/** Errors are not JSON-serializable (`message`/`stack` are non-enumerable), so expand them explicitly. */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? {} : { cause: serialize(value.cause) };
    return { type: value.name, message: value.message, stack: value.stack, ...cause };
  }
  return value;
}

/**
 * Creates a logger writing to stdout (debug/info) and stderr (warn/error).
 * `level` is the minimum level to emit; `'silent'` (or any unknown value) disables output entirely.
 */
export function createLogger(level: string = 'info'): Logger {
  const min = LOG_LEVELS.indexOf(level as LogLevel);
  const write = (lvl: LogLevel, fields: Record<string, unknown>, msg: string) => {
    if (min === -1 || LOG_LEVELS.indexOf(lvl) < min) {
      return;
    }
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = serialize(value);
    }
    (lvl === 'warn' || lvl === 'error' ? console.error : console.log)(JSON.stringify(entry));
  };
  return {
    debug: (fields, msg) => write('debug', fields, msg),
    info: (fields, msg) => write('info', fields, msg),
    warn: (fields, msg) => write('warn', fields, msg),
    error: (fields, msg) => write('error', fields, msg),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = createLogger('silent');
