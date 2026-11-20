import { afterEach, beforeEach, describe, it, spyOn } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/log.ts';

const lines = (file: string) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('log file', () => {
  let dir: string;
  let consoleLog: ReturnType<typeof spyOn>;
  let consoleError: ReturnType<typeof spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'releasewatcher-log-'));
    consoleLog = spyOn(console, 'log').mockImplementation(() => {});
    consoleError = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLog.mockRestore();
    consoleError.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the same JSON lines as the console and creates missing directories', () => {
    const file = join(dir, 'logs', 'app.log');
    const log = createLogger('info', { file: { path: file, maxSizeBytes: 0, maxFiles: 0 } });
    log.debug({}, 'hidden');
    log.info({ repository: 'a/b' }, 'Checked');
    log.error({ err: new Error('boom') }, 'Failed');
    log.close();

    const entries = lines(file);
    assert.deepEqual(
      entries.map((e) => [e['level'], e['msg']]),
      [
        ['info', 'Checked'],
        ['error', 'Failed'],
      ],
    );
    assert.equal(entries[0]?.['repository'], 'a/b');
    assert.equal((entries[1]?.['err'] as { message: string }).message, 'boom');
    assert.equal(consoleLog.mock.calls.length, 1);
    assert.equal(consoleError.mock.calls.length, 1);
  });

  it('appends to an existing file', () => {
    const file = join(dir, 'app.log');
    writeFileSync(file, '{"msg":"old"}\n');
    const log = createLogger('info', { file: { path: file, maxSizeBytes: 0, maxFiles: 0 } });
    log.info({}, 'new');
    log.close();
    assert.deepEqual(
      lines(file).map((e) => e['msg']),
      ['old', 'new'],
    );
  });

  it('rotates by size and keeps at most maxFiles old files', () => {
    const file = join(dir, 'app.log');
    const log = createLogger('info', { file: { path: file, maxSizeBytes: 150, maxFiles: 2 } });
    for (let i = 1; i <= 8; i++) {
      log.info({ i }, 'line');
    }
    log.close();

    assert.deepEqual(readdirSync(dir).sort(), ['app.log', 'app.log.1', 'app.log.2']);
    const current = lines(file).map((e) => e['i']);
    const previous = lines(`${file}.1`).map((e) => e['i']);
    const oldest = lines(`${file}.2`).map((e) => e['i']);
    // newest lines in the current file, older ones shifted down, the oldest dropped
    assert.equal(current.at(-1), 8);
    assert.ok((previous.at(-1) as number) < (current[0] as number));
    assert.ok((oldest.at(-1) as number) < (previous[0] as number));
    assert.ok(!(oldest as number[]).includes(1));
    for (const name of readdirSync(dir)) {
      assert.ok(readFileSync(join(dir, name)).length <= 150, `${name} exceeds the size limit`);
    }
  });

  it('starts the file over when no rotated files are kept', () => {
    const file = join(dir, 'app.log');
    const log = createLogger('info', { file: { path: file, maxSizeBytes: 150, maxFiles: 0 } });
    for (let i = 1; i <= 5; i++) {
      log.info({ i }, 'line');
    }
    log.close();
    assert.deepEqual(readdirSync(dir), ['app.log']);
    assert.equal(lines(file).at(-1)?.['i'], 5);
  });

  it('keeps logging to the console when the file cannot be written', () => {
    const blocker = join(dir, 'not-a-directory');
    writeFileSync(blocker, '');
    const log = createLogger('info', { file: { path: join(blocker, 'app.log'), maxSizeBytes: 0, maxFiles: 0 } });
    log.info({}, 'first');
    log.info({}, 'second');
    log.close();

    assert.equal(consoleLog.mock.calls.length, 2);
    // the failure is reported once, not for every line
    assert.equal(consoleError.mock.calls.length, 1);
    assert.match(String(consoleError.mock.calls[0]?.[0]), /Writing the log file failed/);
  });

  it('does not create the file for the silent level', () => {
    const file = join(dir, 'app.log');
    const log = createLogger('silent', { file: { path: file, maxSizeBytes: 0, maxFiles: 0 } });
    log.error({}, 'hidden');
    log.close();
    assert.equal(existsSync(file), false);
  });
});

describe('log configuration', () => {
  it('logs to the console only by default', () => {
    assert.deepEqual(loadConfig({}).log, { level: 'info', file: null });
  });

  it('reads the log file, its size limit and the number of rotated files', () => {
    const config = loadConfig({
      LOG_LEVEL: 'debug',
      LOG_FILE: '/data/releasewatcher.log',
      LOG_FILE_MAX_SIZE_MB: '0.5',
      LOG_FILE_MAX_FILES: '3',
    });
    assert.deepEqual(config.log, {
      level: 'debug',
      file: { path: '/data/releasewatcher.log', maxSizeBytes: 524_288, maxFiles: 3 },
    });
  });

  it('defaults to 10 MB and 5 rotated files', () => {
    assert.deepEqual(loadConfig({ LOG_FILE: 'app.log' }).log.file, {
      path: 'app.log',
      maxSizeBytes: 10 * 1024 * 1024,
      maxFiles: 5,
    });
  });
});
