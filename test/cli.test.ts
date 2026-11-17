import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../package.json';

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');

describe('command line', () => {
  it('prints the version for --version and exits without creating files or starting the server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-cli-'));
    try {
      const result = Bun.spawnSync([process.execPath, MAIN, '--version'], {
        cwd: dir,
        env: { ...process.env, DATABASE_PATH: join(dir, 'test.db'), PORT: '1', RELEASEWATCHER_VERSION: '' },
        timeout: 20_000,
      });
      assert.equal(result.exitCode, 0, result.stderr.toString());
      assert.equal(result.stdout.toString().trim(), pkg.version);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
