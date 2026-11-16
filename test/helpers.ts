import type { ReleaseInfo } from '../src/domain.ts';
import type { ReleaseFetchResult, ReleaseSource } from '../src/github.ts';
import { pctExec } from '../src/proxmox/domain.ts';
import type { CommandResult, NodeShell, RunOptions } from '../src/proxmox/ssh.ts';
import type { ContainerUpdatesNotification, Notifier, ReleaseNotification } from '../src/notifiers/notifier.ts';

export const silentLog = { info() {}, warn() {}, error() {} };

export function release(tag: string, day: number, isPrerelease = false): ReleaseInfo {
  return {
    tag,
    name: null,
    htmlUrl: `https://github.com/acme/widget/releases/${tag}`,
    body: 'notes',
    isPrerelease,
    publishedAt: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
    authorLogin: 'bob',
    authorAvatarUrl: null,
  };
}

export const dayIso = (day: number): string => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();

export class FakeSource implements ReleaseSource {
  releases: ReleaseInfo[] = [];
  notModified = false;
  error: Error | null = null;
  existing = new Set(['acme/widget']);
  calls = 0;
  /** Repositories visible only with a specific token (full name → token). */
  privateRepos = new Map<string, string>();
  /** Token passed with the last call (null/undefined = global token). */
  lastToken: string | null | undefined;

  async repositoryExists(owner: string, name: string, token?: string | null): Promise<boolean> {
    this.lastToken = token;
    const fullName = `${owner}/${name}`.toLowerCase();
    const required = this.privateRepos.get(fullName);
    return required !== undefined ? token === required : this.existing.has(fullName);
  }

  async getRecentReleases(_owner: string, _name: string, etag: string | null, token?: string | null): Promise<ReleaseFetchResult> {
    this.calls++;
    this.lastToken = token;
    if (this.error) {
      throw this.error;
    }
    return this.notModified
      ? { releases: [], etag, notModified: true }
      : { releases: this.releases, etag: '"etag"', notModified: false };
  }
}

export class RecordingNotifier implements Notifier {
  readonly name = 'recording';
  isEnabled = true;
  fail = false;
  readonly sent: ReleaseNotification[] = [];
  readonly containerSent: ContainerUpdatesNotification[] = [];

  async notify(notification: ReleaseNotification): Promise<void> {
    if (this.fail) {
      throw new Error('boom');
    }
    this.sent.push(notification);
  }

  async notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void> {
    if (this.fail) {
      throw new Error('boom');
    }
    this.containerSent.push(notification);
  }
}

/** Fake Proxmox node: answers commands matching registered patterns (first match wins). */
export class FakeShell implements NodeShell {
  isConfigured = true;
  readonly commands: string[] = [];
  /** Number of `run()` calls – each one is an SSH connection in production. */
  connections = 0;
  private readonly handlers: [RegExp, Partial<CommandResult> | ((command: string) => Partial<CommandResult> | Promise<Partial<CommandResult>>)][] =
    [];

  on(
    pattern: RegExp,
    result: Partial<CommandResult> | ((command: string) => Partial<CommandResult> | Promise<Partial<CommandResult>>),
  ): this {
    this.handlers.unshift([pattern, result]);
    return this;
  }

  async run(command: string, options: RunOptions): Promise<CommandResult> {
    this.connections++;
    const token = command.match(/@@RW-[0-9a-f]+@@/)?.[0];
    const result = token ? await this.runCheckBatch(command, token) : await this.answer(command);
    if (result.output) {
      options.onOutput?.(result.output);
    }
    return result;
  }

  /** Answers one command; every answered command is recorded in {@link commands}. */
  private async answer(command: string): Promise<CommandResult> {
    this.commands.push(command);
    const handler = this.handlers.find(([pattern]) => pattern.test(command))?.[1];
    const partial = typeof handler === 'function' ? await handler(command) : (handler ?? { exitCode: 127, output: 'command not found' });
    return { exitCode: 0, output: '', timedOut: false, ...partial };
  }

  /**
   * Emulates the batched check script (`buildCheckScript`): answers `pct status <vmid>` and – for a running
   * container – every step as `pct exec <vmid> -- sh -lc '<step>'`, so handlers can match single commands.
   */
  private async runCheckBatch(command: string, token: string): Promise<CommandResult> {
    const vmid = Number(command.match(/pct status (\d+)/)?.[1]);
    const status = await this.answer(`pct status ${vmid}`);
    if (status.exitCode === 255) {
      return status; // connection failure: no sections at all
    }
    const section = (id: string, text: string, exitCode: number) =>
      [`${token} begin ${id}`, text, `${token} end ${id} ${exitCode}`, ''].join('\n');
    let output = section('status', status.output.replace(/\n+$/, ''), status.exitCode);
    const encoded = command.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1];
    if (encoded && status.output.includes('status: running')) {
      const inner = Buffer.from(encoded, 'base64').toString('utf8');
      // Steps are single-quoted with shQuote (a quote inside is written as '\'').
      for (const match of inner.matchAll(/^rw_step (\S+) \d+ ('(?:[^']|'\\'')*')/gm)) {
        const script = match[2]!.slice(1, -1).replaceAll("'\\''", "'");
        const result = await this.answer(pctExec(vmid, script));
        output += section(match[1]!, result.output, result.exitCode);
      }
    }
    return { exitCode: 0, output, timedOut: false };
  }
}
