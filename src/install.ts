// `releasewatcher --install` / `--uninstall [--purge]`: the release executable installs itself as a systemd service.
// The scripts and the unit from `deploy/` are embedded as text, written to a temporary directory and run with `sh` –
// the same `install.sh` that `bun run deploy` uses, so both ways install exactly the same.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import envExample from '../.env.example' with { type: 'text' };
import installScript from '../deploy/install.sh' with { type: 'text' };
import unit from '../deploy/releasewatcher.service' with { type: 'text' };
import uninstallScript from '../deploy/uninstall.sh' with { type: 'text' };

export type ServiceCommand = 'install' | 'uninstall';

/** Runs a script; resolves with its exit code. */
export type ScriptRunner = (command: string[], env: Record<string, string>) => Promise<number>;

export interface ServiceSetupOptions {
  /** Path of the running executable (`process.execPath`). */
  executable: string;
  /** Whether this is the `bun build --compile` executable (not `bun src/main.ts`). */
  compiled: boolean;
  platform: NodeJS.Platform;
  /** `--purge` for `--uninstall`: also remove data, configuration and the user. */
  purge?: boolean;
  run?: ScriptRunner;
  stderr?: (line: string) => void;
}

/** The command given on the command line, if any. */
export function serviceCommand(argv: readonly string[]): ServiceCommand | null {
  if (argv.includes('--install')) return 'install';
  if (argv.includes('--uninstall')) return 'uninstall';
  return null;
}

const runScript: ScriptRunner = async (command, env) => {
  const child = Bun.spawn(command, { env: { ...process.env, ...env }, stdio: ['inherit', 'inherit', 'inherit'] });
  return await child.exited;
};

/** Installs or removes the systemd service; returns the exit code for the process. */
export async function setUpService(command: ServiceCommand, options: ServiceSetupOptions): Promise<number> {
  const stderr = options.stderr ?? ((line: string) => console.error(line));
  if (options.platform !== 'linux') {
    stderr(`--${command} sets up a systemd service and works only on Linux.`);
    return 1;
  }
  if (command === 'install' && !options.compiled) {
    stderr('--install works only with the release executable (releasewatcher-<version>-linux-*), not with `bun src/main.ts`.');
    return 1;
  }
  const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-setup-'));
  try {
    if (command === 'install') {
      writeFileSync(join(dir, 'install.sh'), installScript);
      writeFileSync(join(dir, 'releasewatcher.service'), unit);
      writeFileSync(join(dir, '.env.example'), envExample);
      return await (options.run ?? runScript)(['sh', join(dir, 'install.sh'), dir], {
        RELEASEWATCHER_BINARY: options.executable,
      });
    }
    writeFileSync(join(dir, 'uninstall.sh'), uninstallScript);
    return await (options.run ?? runScript)(['sh', join(dir, 'uninstall.sh')], { PURGE: options.purge ? '1' : '0' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
