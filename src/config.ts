import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Application configuration read from environment variables (see .env.example). */
export interface Config {
  port: number;
  host: string;
  databasePath: string;
  /** Key for secrets stored in the database (base64/hex, 32 bytes); null = key file next to the database. */
  encryptionKey: string | null;
  pollIntervalMs: number;
  initialDelayMs: number;
  github: {
    apiBaseUrl: string;
    token: string | null;
    releasesPerPage: number;
  };
  discord: {
    webhookUrl: string | null;
    username: string | null;
    avatarUrl: string | null;
    mention: string | null;
    maxBodyLength: number;
  };
  proxmox: {
    host: string | null;
    port: number;
    user: string;
    /** Private key content, read from PROXMOX_SSH_KEY_FILE. */
    privateKey: string | null;
    knownHostsFile: string;
    checkCron: string;
    checkConcurrency: number;
    backupStorage: string | null;
    backupBeforeUpdate: boolean;
  };
  /** Former Basic auth credentials – create the login account on the first start (migration). */
  basicAuth: { username: string; password: string } | null;
  /** Public URL behind a reverse proxy (pins the origin / WebAuthn RP ID). */
  publicUrl: string | null;
  /** Trust X-Forwarded-For for the client IP (only behind a reverse proxy that sets it). */
  trustProxy: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const databasePath = str(env, 'DATABASE_PATH') ?? 'releasewatcher.db';
  const keyFile = str(env, 'PROXMOX_SSH_KEY_FILE');
  const authUser = str(env, 'BASIC_AUTH_USERNAME');
  const authPassword = str(env, 'BASIC_AUTH_PASSWORD');
  return {
    port: int(env, 'PORT', 8080),
    host: str(env, 'HOST') ?? '0.0.0.0',
    databasePath,
    encryptionKey: str(env, 'ENCRYPTION_KEY'),
    pollIntervalMs: int(env, 'POLL_INTERVAL_MINUTES', 15) * 60_000,
    initialDelayMs: int(env, 'POLL_INITIAL_DELAY_SECONDS', 10) * 1000,
    github: {
      apiBaseUrl: str(env, 'GITHUB_API_URL') ?? 'https://api.github.com',
      token: str(env, 'GITHUB_TOKEN'),
      releasesPerPage: int(env, 'GITHUB_RELEASES_PER_PAGE', 10),
    },
    discord: {
      webhookUrl: str(env, 'DISCORD_WEBHOOK_URL'),
      username: str(env, 'DISCORD_USERNAME') ?? 'ReleaseWatcher',
      avatarUrl: str(env, 'DISCORD_AVATAR_URL'),
      mention: str(env, 'DISCORD_MENTION'),
      maxBodyLength: int(env, 'DISCORD_MAX_BODY_LENGTH', 1500),
    },
    proxmox: {
      host: str(env, 'PROXMOX_HOST'),
      port: int(env, 'PROXMOX_SSH_PORT', 22),
      user: str(env, 'PROXMOX_SSH_USER') ?? 'root',
      privateKey: keyFile ? readKeyFile(keyFile) : null,
      knownHostsFile:
        str(env, 'SSH_KNOWN_HOSTS_FILE') ??
        join(databasePath === ':memory:' ? '.' : dirname(databasePath), 'known_hosts'),
      checkCron: str(env, 'CONTAINER_CHECK_CRON') ?? '0 */6 * * *',
      checkConcurrency: Math.min(10, Math.max(1, int(env, 'CONTAINER_CHECK_CONCURRENCY', 3))),
      backupStorage: str(env, 'PROXMOX_BACKUP_STORAGE'),
      backupBeforeUpdate: (str(env, 'BACKUP_BEFORE_UPDATE') ?? 'false').toLowerCase() === 'true',
    },
    basicAuth: authUser && authPassword ? { username: authUser, password: authPassword } : null,
    publicUrl: publicUrl(str(env, 'PUBLIC_URL')),
    trustProxy: (str(env, 'TRUST_PROXY') ?? 'false').toLowerCase() === 'true',
  };
}

function str(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function int(env: Env, key: string, fallback: number): number {
  const raw = str(env, key);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Environment variable ${key} must be a non-negative number, got "${raw}".`);
  }
  return value;
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read PROXMOX_SSH_KEY_FILE "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
}

function publicUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`PUBLIC_URL must be a URL like https://watcher.example.com, got "${value}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PUBLIC_URL must use http(s).');
  }
  return url.origin;
}
