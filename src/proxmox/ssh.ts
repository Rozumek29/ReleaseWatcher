import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanOutput, shQuote } from './domain.ts';

export interface CommandResult {
  exitCode: number;
  /** stdout and stderr interleaved, ANSI sequences removed. */
  output: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs: number;
  /** Allocate a pseudo-terminal (`ssh -tt`). */
  tty?: boolean;
  /** Receives cleaned output as it arrives. */
  onOutput?: (chunk: string) => void;
}

/** Runs shell commands on the Proxmox node. Faked in tests. */
export interface NodeShell {
  /** False until host, user and key are configured. */
  readonly isConfigured: boolean;
  run(command: string, options: RunOptions): Promise<CommandResult>;
}

export interface SshOptions {
  host: string | null;
  port: number;
  user: string;
  /** Private key (OpenSSH/PEM). Keys protected with a passphrase are not supported. */
  privateKey: string | null;
  /** Host keys are trusted on first use and pinned in this file. */
  knownHostsFile: string;
}

/** Thrown when a command is run before SSH is configured. */
export class ShellNotConfiguredError extends Error {
  override name = 'ShellNotConfiguredError';
  constructor() {
    super('The Proxmox node is not configured (host and SSH key are required).');
  }
}

/**
 * Connects with the system OpenSSH client using public-key authentication only (no passwords, no agent,
 * no user ssh config). The key is written to a private temp file readable only by this process' user.
 */
export class SshShell implements NodeShell {
  private readonly getOptions: () => SshOptions;
  private keyDir: string | null = null;
  private writtenKey: string | null = null;

  constructor(options: SshOptions | (() => SshOptions)) {
    this.getOptions = typeof options === 'function' ? options : () => options;
  }

  get isConfigured(): boolean {
    const o = this.getOptions();
    return !!o.host && !!o.privateKey;
  }

  /** Builds the `ssh` argument list (exported for tests). */
  buildArgs(options: SshOptions, keyFile: string, command: string, tty: boolean): string[] {
    // No ControlMaster multiplexing on purpose: a persisted master keeps stderr open, so reading output
    // until EOF would hang until it expires.
    return [
      'ssh',
      '-F',
      'none',
      '-i',
      keyFile,
      '-p',
      String(options.port),
      '-l',
      options.user,
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'IdentityAgent=none',
      '-o',
      'PreferredAuthentications=publickey',
      '-o',
      'PasswordAuthentication=no',
      '-o',
      'KbdInteractiveAuthentication=no',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      `UserKnownHostsFile=${options.knownHostsFile}`,
      // Hide warnings such as "Permanently added … to known hosts" – they would end up in the command output
      // (and could be read as a version). Errors (auth failure, changed host key) are still printed.
      '-o',
      'LogLevel=ERROR',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=4',
      tty ? '-tt' : '-T',
      '--',
      options.host!,
      // pct needs root; other users must be allowed to run it through passwordless sudo
      options.user === 'root' ? command : `sudo -n -- sh -c ${shQuote(command)}`,
    ];
  }

  async run(command: string, options: RunOptions): Promise<CommandResult> {
    const ssh = this.getOptions();
    if (!ssh.host || !ssh.privateKey) {
      throw new ShellNotConfiguredError();
    }
    const keyFile = this.ensureKeyFile(ssh.privateKey);
    const proc = Bun.spawn(this.buildArgs(ssh, keyFile, command, options.tty ?? false), {
      stdin: options.tty ? 'pipe' : 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, options.timeoutMs);

    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = cleanOutput(decoder.decode(chunk, { stream: true }));
        output += text;
        options.onOutput?.(text);
      }
    };
    try {
      await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const exitCode = await proc.exited;
      return { exitCode: timedOut ? -1 : exitCode, output, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Removes the temporary key file. */
  dispose(): void {
    if (this.keyDir) {
      rmSync(this.keyDir, { recursive: true, force: true });
      this.keyDir = null;
      this.writtenKey = null;
    }
  }

  private ensureKeyDir(): string {
    this.keyDir ??= mkdtempSync(join(tmpdir(), 'releasewatcher-ssh-'));
    return this.keyDir;
  }

  private ensureKeyFile(privateKey: string): string {
    const file = join(this.ensureKeyDir(), 'id');
    if (this.writtenKey !== privateKey) {
      // OpenSSH rejects keys without a trailing newline and keys readable by others.
      writePrivateKeyFile(file, privateKey);
      this.writtenKey = privateKey;
    }
    return file;
  }
}

/**
 * Writes an SSH private key readable only by the current user. OpenSSH refuses keys others can read: on Unix that
 * is the file mode; Windows OpenSSH checks the ACL instead, and files in %TEMP% inherit entries for other users or
 * groups – so inheritance is removed and only the current user is granted access.
 */
export function writePrivateKeyFile(file: string, privateKey: string): void {
  // OpenSSH also rejects keys without a trailing newline.
  writeFileSync(file, `${privateKey.replace(/\r\n/g, '\n').trim()}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  if (process.platform === 'win32') {
    const user = process.env['USERDOMAIN'] ? `${process.env['USERDOMAIN']}\\${process.env['USERNAME']}` : process.env['USERNAME'];
    const result = Bun.spawnSync(['icacls', file, '/inheritance:r', '/grant:r', `${user}:F`], { stdout: 'ignore', stderr: 'pipe' });
    if (result.exitCode !== 0) {
      throw new Error(`Could not restrict access to the SSH key file: ${result.stderr.toString().trim()}`);
    }
  }
}

/** Human readable explanation of a failed SSH connection (exit code 255). */
export function describeSshFailure(result: CommandResult): string {
  if (result.timedOut) {
    return 'The command timed out.';
  }
  const text = result.output.trim();
  if (result.exitCode === 255) {
    if (/Permission denied/i.test(text)) return `SSH authentication failed (only key authentication is allowed): ${text}`;
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(text)) {
      return `The host key of the node changed – remove its entry from the known_hosts file if this is expected. ${text}`;
    }
    return `SSH connection failed: ${text || 'no details'}`;
  }
  return text ? `Exit code ${result.exitCode}: ${text.slice(-500)}` : `Exit code ${result.exitCode}.`;
}
