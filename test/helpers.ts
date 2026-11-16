import type { ReleaseInfo } from '../src/domain.ts';
import type { ReleaseFetchResult, ReleaseSource } from '../src/github.ts';
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

  async repositoryExists(owner: string, name: string): Promise<boolean> {
    return this.existing.has(`${owner}/${name}`.toLowerCase());
  }

  async getRecentReleases(_owner: string, _name: string, etag: string | null): Promise<ReleaseFetchResult> {
    this.calls++;
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
    this.commands.push(command);
    const handler = this.handlers.find(([pattern]) => pattern.test(command))?.[1];
    const partial = typeof handler === 'function' ? await handler(command) : (handler ?? { exitCode: 127, output: 'command not found' });
    const result = { exitCode: 0, output: '', timedOut: false, ...partial };
    if (result.output) {
      options.onOutput?.(result.output);
    }
    return result;
  }
}
