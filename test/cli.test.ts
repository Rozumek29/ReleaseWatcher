import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import pkg from '../package.json';
import { serviceCommand, setUpService, type ScriptRunner } from '../src/install.ts';

const ROOT = join(import.meta.dir, '..');
const MAIN = join(ROOT, 'src', 'main.ts');

describe('command line', () => {
  for (const flag of ['--version', '-v']) {
    it(`prints the version for ${flag} and exits without creating files or starting the server`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-cli-'));
      try {
        const result = Bun.spawnSync([process.execPath, MAIN, flag], {
          cwd: dir,
          env: { ...process.env, DATABASE_PATH: join(dir, 'test.db'), PORT: '1', RELEASEWATCHER_VERSION: '' },
          timeout: 20_000,
        });
        assert.equal(result.exitCode, 0, result.stderr.toString());
        assert.equal(result.stdout.toString().trim(), `v${pkg.version}`);
        assert.deepEqual(readdirSync(dir), []);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it('refuses --install when running from source, without creating files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-cli-'));
    try {
      const result = Bun.spawnSync([process.execPath, MAIN, '--install'], {
        cwd: dir,
        env: { ...process.env, DATABASE_PATH: join(dir, 'test.db'), PORT: '1' },
        timeout: 20_000,
      });
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr.toString(), process.platform === 'linux' ? /release executable/ : /only on Linux/);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('service setup (--install / --uninstall)', () => {
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

  /** Records the script call and the files it could see in its directory. */
  function recorder(exitCode = 0) {
    const calls: { command: string[]; env: Record<string, string>; files: Record<string, string> }[] = [];
    const run: ScriptRunner = async (command, env) => {
      const dir = dirname(command[1]!);
      const files = Object.fromEntries(readdirSync(dir).map((name) => [name, readFileSync(join(dir, name), 'utf8')]));
      calls.push({ command, env, files });
      return exitCode;
    };
    return { calls, run };
  }

  it('reads the command from the arguments', () => {
    assert.equal(serviceCommand(['bun', 'main', '--install']), 'install');
    assert.equal(serviceCommand(['bun', 'main', '--uninstall', '--purge']), 'uninstall');
    assert.equal(serviceCommand(['bun', 'main']), null);
  });

  it('runs the embedded install.sh with the unit, the env template and the running executable', async () => {
    const { calls, run } = recorder();
    const code = await setUpService('install', { executable: '/root/rw/releasewatcher-1.0.0-linux-x64', compiled: true, platform: 'linux', run });
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    const call = calls[0]!;
    assert.equal(call.command[0], 'sh');
    assert.equal(call.command[1], join(call.command[2]!, 'install.sh'));
    assert.deepEqual(call.env, { RELEASEWATCHER_BINARY: '/root/rw/releasewatcher-1.0.0-linux-x64' });
    assert.deepEqual(call.files, {
      'install.sh': read('deploy/install.sh'),
      'releasewatcher.service': read('deploy/releasewatcher.service'),
      '.env.example': read('.env.example'),
    });
    assert.equal(existsSync(call.command[2]!), false, 'the temporary directory is removed');
  });

  it('passes the exit code of the script on', async () => {
    const { run } = recorder(3);
    assert.equal(await setUpService('install', { executable: '/x', compiled: true, platform: 'linux', run }), 3);
  });

  it('runs the embedded uninstall.sh, purging only with --purge', async () => {
    const { calls, run } = recorder();
    await setUpService('uninstall', { executable: '/x', compiled: true, platform: 'linux', run });
    await setUpService('uninstall', { executable: '/x', compiled: false, platform: 'linux', purge: true, run });
    assert.deepEqual(calls.map((call) => call.env), [{ PURGE: '0' }, { PURGE: '1' }]);
    assert.deepEqual(calls[0]!.files, { 'uninstall.sh': read('deploy/uninstall.sh') });
  });

  it('refuses outside Linux and --install from source without running anything', async () => {
    const { calls, run } = recorder();
    const errors: string[] = [];
    const stderr = (line: string) => errors.push(line);
    assert.equal(await setUpService('install', { executable: '/x', compiled: true, platform: 'win32', run, stderr }), 1);
    assert.equal(await setUpService('install', { executable: '/x', compiled: false, platform: 'linux', run, stderr }), 1);
    assert.equal(calls.length, 0);
    assert.match(errors[0]!, /only on Linux/);
    assert.match(errors[1]!, /release executable/);
  });
});
