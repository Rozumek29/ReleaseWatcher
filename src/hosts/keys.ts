import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateKeyFile } from '../proxmox/ssh.ts';
import { normalizePrivateKey } from './domain.ts';

/** Public key and fingerprint derived from a private key. */
export interface KeyInfo {
  publicKey: string;
  fingerprint: string;
}

/** Thrown when `ssh-keygen` rejects a private key. */
export class InvalidKeyError extends Error {
  override name = 'InvalidKeyError';
}

/** Key operations of the system OpenSSH tools (`ssh-keygen`). Faked in tests. */
export interface KeyTool {
  /** Derives the public key and fingerprint; null when `ssh-keygen` is not installed. Throws {@link InvalidKeyError}. */
  inspect(privateKey: string): Promise<KeyInfo | null>;
  /** Creates a new Ed25519 key pair without a passphrase and returns the private key. */
  generate(comment: string): Promise<string>;
  /** Removes the pinned host key of `address`/`port` from a known_hosts file (after a reinstall of the host). */
  forgetHostKey(knownHostsFile: string, address: string, port: number): Promise<void>;
}

const TIMEOUT_MS = 15_000;

async function run(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the error says that the program could not be started at all. */
const isMissingProgram = (error: unknown): boolean =>
  error instanceof Error && /ENOENT|not found|No such file/i.test(error.message);

/** {@link KeyTool} on top of `ssh-keygen` (part of openssh-client, which ReleaseWatcher needs anyway). */
export class SshKeygen implements KeyTool {
  async inspect(privateKey: string): Promise<KeyInfo | null> {
    const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-key-'));
    try {
      const file = join(dir, 'id');
      writePrivateKeyFile(file, normalizePrivateKey(privateKey));
      let pub;
      try {
        // -P '' fails instead of prompting when the key has a passphrase.
        pub = await run(['ssh-keygen', '-y', '-P', '', '-f', file]);
      } catch (error) {
        if (isMissingProgram(error)) return null;
        throw error;
      }
      if (pub.exitCode !== 0) {
        throw new InvalidKeyError(
          /passphrase|incorrect/i.test(pub.stderr)
            ? 'Keys protected with a passphrase are not supported.'
            : 'This is not a valid private key.',
        );
      }
      const publicKey = pub.stdout.trim();
      const fp = await run(['ssh-keygen', '-l', '-E', 'sha256', '-f', file]);
      const fingerprint = fp.stdout.match(/SHA256:\S+/)?.[0] ?? null;
      return fingerprint ? { publicKey, fingerprint } : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async generate(comment: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'releasewatcher-keygen-'));
    try {
      const file = join(dir, 'id');
      const result = await run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file]);
      if (result.exitCode !== 0) {
        throw new Error(`ssh-keygen failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      }
      return readFileSync(file, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async forgetHostKey(knownHostsFile: string, address: string, port: number): Promise<void> {
    const entry = port === 22 ? address : `[${address}]:${port}`;
    const result = await run(['ssh-keygen', '-R', entry, '-f', knownHostsFile]);
    // Exit code 255 with "not found" / a missing file: nothing was pinned – fine.
    if (result.exitCode !== 0 && !/not found|No such file/i.test(result.stderr)) {
      throw new Error(`ssh-keygen -R failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    }
    rmSync(`${knownHostsFile}.old`, { force: true });
  }
}
