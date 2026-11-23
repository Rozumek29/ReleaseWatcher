import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { intervalToCron } from './cron.ts';
import { errorMessage } from './errors.ts';
import type { LogFileOptions } from './log.ts';
import { SMTP_SECURITY, type SmtpSecurity } from './notifiers/smtp.ts';
import { WEBHOOK_METHODS, type WebhookMethod } from './notifiers/webhook.ts';

/** Application configuration read from environment variables (see .env.example). */
export interface Config {
  port: number;
  host: string;
  databasePath: string;
  /** Key for secrets stored in the database (base64/hex, 32 bytes); null = key file next to the database. */
  encryptionKey: string | null;
  /** Cron schedule of release checks (falls back to the former POLL_INTERVAL_MINUTES, converted). */
  releaseCheckCron: string;
  /** Cron schedule of vulnerability (security advisory) checks. */
  advisoryCheckCron: string;
  /** Cron schedule of Docker endpoint checks and registry checks of Docker images. */
  dockerCheckCron: string;
  /** Delay of the first release check (and vulnerability catch-up) after startup. */
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
  email: {
    smtpHost: string | null;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
    smtpUsername: string | null;
    smtpPassword: string | null;
    /** Sender, "a@example.com" or "Name <a@example.com>". */
    from: string | null;
    /** Recipients, comma-separated. */
    to: string | null;
    maxBodyLength: number;
  };
  ntfy: { url: string | null; topic: string | null; token: string | null };
  gotify: { url: string | null; token: string | null };
  telegram: { botToken: string | null; chatId: string | null };
  slack: { webhookUrl: string | null };
  pushover: { userKey: string | null; appToken: string | null };
  /** Generic JSON webhook. */
  webhook: { url: string | null; method: WebhookMethod | null };
  /** Collect the notifications of one check run into one summary message. */
  notificationDigest: boolean;
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
  log: {
    /** Minimum level (`debug`, `info`, `warn`, `error`) or `silent`. */
    level: string;
    /** Copy of the log in a file (rotated by size); null = console only. */
    file: LogFileOptions | null;
  };
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const databasePath = str(env, 'DATABASE_PATH') ?? 'releasewatcher.db';
  const keyFile = str(env, 'PROXMOX_SSH_KEY_FILE');
  const authUser = str(env, 'BASIC_AUTH_USERNAME');
  const authPassword = str(env, 'BASIC_AUTH_PASSWORD');
  const logFile = str(env, 'LOG_FILE');
  return {
    port: int(env, 'PORT', 8080),
    host: str(env, 'HOST') ?? '0.0.0.0',
    databasePath,
    encryptionKey: str(env, 'ENCRYPTION_KEY'),
    releaseCheckCron:
      str(env, 'RELEASE_CHECK_CRON') ??
      (str(env, 'POLL_INTERVAL_MINUTES') ? intervalToCron(int(env, 'POLL_INTERVAL_MINUTES', 15)) : '*/15 * * * *'),
    advisoryCheckCron: str(env, 'ADVISORY_CHECK_CRON') ?? '0 */6 * * *',
    dockerCheckCron: str(env, 'DOCKER_CHECK_CRON') ?? '0 */6 * * *',
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
    email: {
      smtpHost: str(env, 'SMTP_HOST'),
      smtpPort: int(env, 'SMTP_PORT', 587),
      smtpSecurity: smtpSecurity(str(env, 'SMTP_SECURITY')),
      smtpUsername: str(env, 'SMTP_USERNAME'),
      smtpPassword: str(env, 'SMTP_PASSWORD'),
      from: str(env, 'EMAIL_FROM'),
      to: str(env, 'EMAIL_TO'),
      maxBodyLength: int(env, 'EMAIL_MAX_BODY_LENGTH', 5000),
    },
    ntfy: { url: str(env, 'NTFY_URL'), topic: str(env, 'NTFY_TOPIC'), token: str(env, 'NTFY_TOKEN') },
    gotify: { url: str(env, 'GOTIFY_URL'), token: str(env, 'GOTIFY_TOKEN') },
    telegram: { botToken: str(env, 'TELEGRAM_BOT_TOKEN'), chatId: str(env, 'TELEGRAM_CHAT_ID') },
    slack: { webhookUrl: str(env, 'SLACK_WEBHOOK_URL') },
    pushover: { userKey: str(env, 'PUSHOVER_USER_KEY'), appToken: str(env, 'PUSHOVER_APP_TOKEN') },
    webhook: { url: str(env, 'WEBHOOK_URL'), method: webhookMethod(str(env, 'WEBHOOK_METHOD')) },
    notificationDigest: (str(env, 'NOTIFICATION_DIGEST') ?? 'false').toLowerCase() === 'true',
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
    log: {
      level: str(env, 'LOG_LEVEL') ?? 'info',
      file: logFile
        ? {
            path: logFile,
            maxSizeBytes: Math.round(int(env, 'LOG_FILE_MAX_SIZE_MB', 10) * 1024 * 1024),
            maxFiles: Math.floor(int(env, 'LOG_FILE_MAX_FILES', 5)),
          }
        : null,
    },
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

function webhookMethod(value: string | null): WebhookMethod | null {
  if (value === null) {
    return null;
  }
  const normalized = value.toUpperCase();
  if (!(WEBHOOK_METHODS as readonly string[]).includes(normalized)) {
    throw new Error(`WEBHOOK_METHOD must be one of ${WEBHOOK_METHODS.join(', ')}, got "${value}".`);
  }
  return normalized as WebhookMethod;
}

function smtpSecurity(value: string | null): SmtpSecurity {
  const normalized = (value ?? 'starttls').toLowerCase();
  if (!(SMTP_SECURITY as readonly string[]).includes(normalized)) {
    throw new Error(`SMTP_SECURITY must be one of ${SMTP_SECURITY.join(', ')}, got "${value}".`);
  }
  return normalized as SmtpSecurity;
}

function readKeyFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read PROXMOX_SSH_KEY_FILE "${path}": ${errorMessage(error)}`);
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
