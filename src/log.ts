/** Minimal structured logger (one JSON object per line), replacing the pino logger Fastify used to provide. */
import { closeSync, fstatSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

type LogFn = (fields: Record<string, unknown>, message: string) => void;
export type Logger = Record<LogLevel, LogFn>;

/** Optional copy of the log in a file, rotated by size (`app.log` → `app.log.1` → … → `app.log.<maxFiles>`). */
export interface LogFileOptions {
  path: string;
  /** Rotate when the file would grow beyond this many bytes; 0 = never rotate. */
  maxSizeBytes: number;
  /** Rotated files to keep next to the current one; 0 = start the file over instead of keeping a copy. */
  maxFiles: number;
}

export interface LoggerOptions {
  file?: LogFileOptions | null;
}

/** Errors are not JSON-serializable (`message`/`stack` are non-enumerable), so expand them explicitly. */
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    const cause = value.cause === undefined ? {} : { cause: serialize(value.cause) };
    return { type: value.name, message: value.message, stack: value.stack, ...cause };
  }
  return value;
}

/**
 * Appends lines to a file with size-based rotation. Writes are synchronous so lines logged right before
 * `process.exit()` are not lost; the volume of this app is low enough for that not to matter.
 * A failing file (full disk, missing permissions) never breaks the app: the error is reported once on stderr
 * and the console output keeps working.
 */
export class LogFile {
  private fd: number | null = null;
  private size = 0;
  private failed = false;

  constructor(private readonly options: LogFileOptions) {}

  write(line: string): void {
    if (this.failed) {
      return;
    }
    try {
      const bytes = Buffer.byteLength(line);
      if (this.fd === null) {
        this.open();
      }
      if (this.options.maxSizeBytes > 0 && this.size > 0 && this.size + bytes > this.options.maxSizeBytes) {
        this.rotate();
      }
      writeSync(this.fd!, line);
      this.size += bytes;
    } catch (err) {
      this.failed = true;
      this.close();
      console.error(
        JSON.stringify({
          time: new Date().toISOString(),
          level: 'error',
          msg: 'Writing the log file failed – logging to the console only from now on',
          file: this.options.path,
          err: serialize(err),
        }),
      );
    }
  }

  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // already closed or never fully opened – nothing to release
      }
      this.fd = null;
    }
  }

  private open(): void {
    mkdirSync(dirname(this.options.path), { recursive: true });
    this.fd = openSync(this.options.path, 'a', 0o640);
    this.size = fstatSync(this.fd).size;
  }

  private rotate(): void {
    this.close();
    const { path, maxFiles } = this.options;
    if (maxFiles > 0) {
      rmSync(`${path}.${maxFiles}`, { force: true });
      for (let i = maxFiles - 1; i >= 1; i--) {
        renameIfExists(`${path}.${i}`, `${path}.${i + 1}`);
      }
      renameIfExists(path, `${path}.1`);
    } else {
      rmSync(path, { force: true });
    }
    this.open();
  }
}

function renameIfExists(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

/** Logger with a `close()` that releases the log file (call it on shutdown). */
export type ClosableLogger = Logger & { close(): void };

/**
 * Creates a logger writing to stdout (debug/info) and stderr (warn/error) and, when `options.file` is set,
 * the same JSON lines to that file. `level` is the minimum level to emit; `'silent'` (or any unknown value)
 * disables output entirely.
 */
export function createLogger(level: string = 'info', options: LoggerOptions = {}): ClosableLogger {
  const min = LOG_LEVELS.indexOf(level as LogLevel);
  const file = options.file && min !== -1 ? new LogFile(options.file) : null;
  const write = (lvl: LogLevel, fields: Record<string, unknown>, msg: string) => {
    if (min === -1 || LOG_LEVELS.indexOf(lvl) < min) {
      return;
    }
    const entry: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg };
    for (const [key, value] of Object.entries(fields)) {
      entry[key] = serialize(value);
    }
    const line = JSON.stringify(entry);
    (lvl === 'warn' || lvl === 'error' ? console.error : console.log)(line);
    file?.write(`${line}\n`);
  };
  return {
    debug: (fields, msg) => write('debug', fields, msg),
    info: (fields, msg) => write('info', fields, msg),
    warn: (fields, msg) => write('warn', fields, msg),
    error: (fields, msg) => write('error', fields, msg),
    close: () => file?.close(),
  };
}

/** Logger that discards everything (tests). */
export const silentLogger: Logger = createLogger('silent');
