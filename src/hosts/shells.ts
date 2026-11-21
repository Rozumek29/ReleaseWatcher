import { type NodeShell, ShellNotConfiguredError, type SshOptions, SshShell } from '../proxmox/ssh.ts';
import type { HostStore } from './store.ts';

/** Opens the shell of one host; `options` is read again for every command, so edits apply at once. */
export type ShellFactory = (options: () => SshOptions) => NodeShell & { dispose?(): void };

/** Shell of a host that does not exist (or no host at all). */
export const unconfiguredShell: NodeShell = {
  isConfigured: false,
  run: () => Promise.reject(new ShellNotConfiguredError()),
};

/**
 * One SSH shell per host, created on first use. Connection settings (address, user, key) are read from the store
 * for every command, so changing a host or its key needs no restart.
 */
export class ShellPool {
  private readonly shells = new Map<number, NodeShell & { dispose?(): void }>();
  private readonly hosts: HostStore;
  private readonly knownHostsFile: string;
  private readonly factory: ShellFactory;

  constructor(deps: { hosts: HostStore; knownHostsFile: string; factory?: ShellFactory }) {
    this.hosts = deps.hosts;
    this.knownHostsFile = deps.knownHostsFile;
    this.factory = deps.factory ?? ((options) => new SshShell(options));
  }

  /** Shell of a host; an unconfigured one for null or a host that no longer exists. */
  forHost(hostId: number | null): NodeShell {
    if (hostId === null || !this.hosts.getHost(hostId)) {
      return unconfiguredShell;
    }
    let shell = this.shells.get(hostId);
    if (!shell) {
      shell = this.factory(() => this.options(hostId));
      this.shells.set(hostId, shell);
    }
    return shell;
  }

  /** SSH options of a host as stored right now (host null = removed meanwhile). */
  options(hostId: number): SshOptions {
    const host = this.hosts.getHost(hostId);
    const key = host?.sshKeyId == null ? null : this.hosts.getKey(host.sshKeyId);
    return {
      host: host?.address ?? null,
      port: host?.port ?? 22,
      user: host?.user ?? 'root',
      privateKey: key?.privateKey ?? null,
      knownHostsFile: this.knownHostsFile,
    };
  }

  /** Forgets the shell of a removed host (and its temporary key file). */
  remove(hostId: number): void {
    this.shells.get(hostId)?.dispose?.();
    this.shells.delete(hostId);
  }

  dispose(): void {
    for (const shell of this.shells.values()) {
      shell.dispose?.();
    }
    this.shells.clear();
  }
}
