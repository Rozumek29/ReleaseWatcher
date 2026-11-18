import type { Config } from './config.ts';
import { validateCron } from './cron.ts';
import { STORAGE_ID_PATTERN } from './proxmox/domain.ts';
import type { RepositoryStore } from './db.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './notifiers/dispatcher.ts';
import { parseAddress, parseRecipients } from './notifiers/email.ts';
import { SMTP_SECURITY, type SmtpSecurity } from './notifiers/smtp.ts';

/** Runtime settings editable from the UI. Values stored in the database override environment defaults. */
export interface Settings {
  discordWebhookUrl: string | null;
  discordMention: string | null;
  discordUsername: string | null;
  githubToken: string | null;
  pollIntervalMinutes: number;
  proxmoxHost: string | null;
  proxmoxPort: number;
  proxmoxUser: string;
  /** SSH private key used to log in to the Proxmox node. Secret. */
  proxmoxSshKey: string | null;
  /** Default cron schedule of container checks. */
  containerCheckCron: string;
  /** How many containers are checked at the same time. */
  containerCheckConcurrency: number;
  /** Storage that receives backups made before updates. */
  backupStorage: string | null;
  /** Default of "back up before updating" (containers can override it, and it can be changed per update). */
  backupBeforeUpdate: boolean;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string | null;
  /** Secret. */
  smtpPassword: string | null;
  emailFrom: string | null;
  /** Comma-separated recipients. */
  emailTo: string | null;
  /** Send the notifications of one check run as one summary. */
  notificationDigest: boolean;
  notifyReleases: boolean;
  notifyAppUpdates: boolean;
  notifyAptUpdates: boolean;
  notifyUpdateSucceeded: boolean;
  notifyUpdateFailed: boolean;
}

/** On/off settings (stored as "true"/"false"). */
const BOOLEAN_SETTINGS: ReadonlySet<SettingKey> = new Set([
  'backupBeforeUpdate',
  'notificationDigest',
  'notifyReleases',
  'notifyAppUpdates',
  'notifyAptUpdates',
  'notifyUpdateSucceeded',
  'notifyUpdateFailed',
]);

export const MIN_CHECK_CONCURRENCY = 1;
export const MAX_CHECK_CONCURRENCY = 10;

export type SettingKey = keyof Settings;
export type SettingsPatch = { [K in SettingKey]?: Settings[K] | null };

export const MIN_POLL_INTERVAL_MINUTES = 1;
export const MAX_POLL_INTERVAL_MINUTES = 24 * 60;

export class SettingsValidationError extends Error {
  readonly field: SettingKey;

  constructor(field: SettingKey, message: string) {
    super(message);
    this.name = 'SettingsValidationError';
    this.field = field;
  }
}

/** Where the effective value of a setting comes from. */
export type SettingSource = 'ui' | 'env' | null;

export class SettingsService {
  private readonly store: RepositoryStore;
  private readonly defaults: Settings;
  private overrides: Partial<Record<SettingKey, string>>;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(store: RepositoryStore, config: Config) {
    this.store = store;
    this.defaults = {
      discordWebhookUrl: config.discord.webhookUrl,
      discordMention: config.discord.mention,
      discordUsername: config.discord.username,
      githubToken: config.github.token,
      pollIntervalMinutes: config.pollIntervalMs / 60_000,
      proxmoxHost: config.proxmox.host,
      proxmoxPort: config.proxmox.port,
      proxmoxUser: config.proxmox.user,
      proxmoxSshKey: config.proxmox.privateKey,
      containerCheckCron: config.proxmox.checkCron,
      containerCheckConcurrency: config.proxmox.checkConcurrency,
      backupStorage: config.proxmox.backupStorage,
      backupBeforeUpdate: config.proxmox.backupBeforeUpdate,
      smtpHost: config.email.smtpHost,
      smtpPort: config.email.smtpPort,
      smtpSecurity: config.email.smtpSecurity,
      smtpUsername: config.email.smtpUsername,
      smtpPassword: config.email.smtpPassword,
      emailFrom: config.email.from,
      emailTo: config.email.to,
      notificationDigest: config.notificationDigest,
      notifyReleases: DEFAULT_NOTIFICATION_PREFERENCES.releases,
      notifyAppUpdates: DEFAULT_NOTIFICATION_PREFERENCES.appUpdates,
      notifyAptUpdates: DEFAULT_NOTIFICATION_PREFERENCES.aptUpdates,
      notifyUpdateSucceeded: DEFAULT_NOTIFICATION_PREFERENCES.updateSucceeded,
      notifyUpdateFailed: DEFAULT_NOTIFICATION_PREFERENCES.updateFailed,
    };
    this.overrides = store.readSettings() as Partial<Record<SettingKey, string>>;
  }

  get current(): Settings {
    const o = this.overrides;
    const flag = (key: SettingKey & keyof Settings): boolean =>
      o[key] !== undefined ? o[key] === 'true' : (this.defaults[key] as boolean);
    return {
      discordWebhookUrl: o.discordWebhookUrl ?? this.defaults.discordWebhookUrl,
      discordMention: o.discordMention ?? this.defaults.discordMention,
      discordUsername: o.discordUsername ?? this.defaults.discordUsername,
      githubToken: o.githubToken ?? this.defaults.githubToken,
      pollIntervalMinutes: o.pollIntervalMinutes !== undefined ? Number(o.pollIntervalMinutes) : this.defaults.pollIntervalMinutes,
      proxmoxHost: o.proxmoxHost ?? this.defaults.proxmoxHost,
      proxmoxPort: o.proxmoxPort !== undefined ? Number(o.proxmoxPort) : this.defaults.proxmoxPort,
      proxmoxUser: o.proxmoxUser ?? this.defaults.proxmoxUser,
      proxmoxSshKey: o.proxmoxSshKey ?? this.defaults.proxmoxSshKey,
      containerCheckCron: o.containerCheckCron ?? this.defaults.containerCheckCron,
      containerCheckConcurrency:
        o.containerCheckConcurrency !== undefined
          ? Number(o.containerCheckConcurrency)
          : this.defaults.containerCheckConcurrency,
      backupStorage: o.backupStorage ?? this.defaults.backupStorage,
      backupBeforeUpdate: flag('backupBeforeUpdate'),
      smtpHost: o.smtpHost ?? this.defaults.smtpHost,
      smtpPort: o.smtpPort !== undefined ? Number(o.smtpPort) : this.defaults.smtpPort,
      smtpSecurity: (o.smtpSecurity as SmtpSecurity | undefined) ?? this.defaults.smtpSecurity,
      smtpUsername: o.smtpUsername ?? this.defaults.smtpUsername,
      smtpPassword: o.smtpPassword ?? this.defaults.smtpPassword,
      emailFrom: o.emailFrom ?? this.defaults.emailFrom,
      emailTo: o.emailTo ?? this.defaults.emailTo,
      notificationDigest: flag('notificationDigest'),
      notifyReleases: flag('notifyReleases'),
      notifyAppUpdates: flag('notifyAppUpdates'),
      notifyAptUpdates: flag('notifyAptUpdates'),
      notifyUpdateSucceeded: flag('notifyUpdateSucceeded'),
      notifyUpdateFailed: flag('notifyUpdateFailed'),
    };
  }

  sourceOf(key: SettingKey): SettingSource {
    if (this.overrides[key] !== undefined) {
      return 'ui';
    }
    const value = this.defaults[key];
    return value === null || value === '' ? null : 'env';
  }

  /**
   * Applies a partial update. `undefined` keeps a value, `null` or an empty string removes the override
   * (the environment default applies again).
   */
  update(patch: SettingsPatch): Settings {
    const normalized = new Map<SettingKey, string | null>();

    for (const [key, raw] of Object.entries(patch) as [SettingKey, unknown][]) {
      if (raw === undefined) {
        continue;
      }
      const text = raw === null ? '' : String(raw).trim();
      if (text === '') {
        normalized.set(key, null);
        continue;
      }
      validate(key, text);
      normalized.set(key, text);
    }

    for (const [key, value] of normalized) {
      this.store.writeSetting(key, value);
    }
    this.overrides = this.store.readSettings() as Partial<Record<SettingKey, string>>;

    const settings = this.current;
    for (const listener of this.listeners) {
      listener(settings);
    }
    return settings;
  }

  onChange(listener: (settings: Settings) => void): void {
    this.listeners.add(listener);
  }
}

function validate(key: SettingKey, value: string): void {
  if (BOOLEAN_SETTINGS.has(key)) {
    if (value !== 'true' && value !== 'false') {
      throw new SettingsValidationError(key, 'Must be true or false.');
    }
    return;
  }
  switch (key) {
    case 'discordWebhookUrl': {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new SettingsValidationError(key, 'Webhook URL must be a valid URL.');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new SettingsValidationError(key, 'Webhook URL must use http(s).');
      }
      return;
    }
    case 'pollIntervalMinutes': {
      const minutes = Number(value);
      if (!Number.isFinite(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES || minutes > MAX_POLL_INTERVAL_MINUTES) {
        throw new SettingsValidationError(
          key,
          `Interval must be between ${MIN_POLL_INTERVAL_MINUTES} and ${MAX_POLL_INTERVAL_MINUTES} minutes.`,
        );
      }
      return;
    }
    case 'discordMention':
      if (value.length > 200) {
        throw new SettingsValidationError(key, 'Mention is too long.');
      }
      return;
    case 'discordUsername':
      if (value.length > 80) {
        throw new SettingsValidationError(key, 'Username must be at most 80 characters.');
      }
      return;
    case 'githubToken':
      return;
    case 'proxmoxHost':
      if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(value) || value.length > 253) {
        throw new SettingsValidationError(key, 'Enter a host name or IP address.');
      }
      return;
    case 'proxmoxPort': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new SettingsValidationError(key, 'Port must be between 1 and 65535.');
      }
      return;
    }
    case 'proxmoxUser':
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(value)) {
        throw new SettingsValidationError(key, 'Enter a valid user name.');
      }
      return;
    case 'proxmoxSshKey':
      if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/.test(value)) {
        throw new SettingsValidationError(key, 'Paste the whole private key (-----BEGIN … PRIVATE KEY----- … -----END …).');
      }
      if (/Proc-Type:\s*4,ENCRYPTED/.test(value)) {
        throw new SettingsValidationError(key, 'Keys protected with a passphrase are not supported.');
      }
      return;
    case 'backupStorage':
      if (!STORAGE_ID_PATTERN.test(value)) {
        throw new SettingsValidationError(key, 'Enter a Proxmox storage ID, e.g. "local" or "pbs".');
      }
      return;
    case 'smtpHost':
      if (!/^[A-Za-z0-9][A-Za-z0-9.:_-]*$/.test(value) || value.length > 253) {
        throw new SettingsValidationError(key, 'Enter a host name or IP address, e.g. smtp.gmail.com.');
      }
      return;
    case 'smtpPort': {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new SettingsValidationError(key, 'Port must be between 1 and 65535.');
      }
      return;
    }
    case 'smtpSecurity':
      if (!(SMTP_SECURITY as readonly string[]).includes(value)) {
        throw new SettingsValidationError(key, `Security must be one of: ${SMTP_SECURITY.join(', ')}.`);
      }
      return;
    case 'smtpUsername':
    case 'smtpPassword':
      if (value.length > 500 || /[\r\n]/.test(value)) {
        throw new SettingsValidationError(key, 'Must be a single line of at most 500 characters.');
      }
      return;
    case 'emailFrom':
      if (!parseAddress(value)) {
        throw new SettingsValidationError(key, 'Enter an address like alerts@example.com or "ReleaseWatcher <alerts@example.com>".');
      }
      return;
    case 'emailTo': {
      let recipients: string[];
      try {
        recipients = parseRecipients(value);
      } catch (error) {
        throw new SettingsValidationError(key, (error as Error).message);
      }
      if (recipients.length === 0 || recipients.length > 20) {
        throw new SettingsValidationError(key, 'Enter between 1 and 20 recipients.');
      }
      return;
    }
    case 'containerCheckConcurrency': {
      const count = Number(value);
      if (!Number.isInteger(count) || count < MIN_CHECK_CONCURRENCY || count > MAX_CHECK_CONCURRENCY) {
        throw new SettingsValidationError(
          key,
          `Parallel checks must be between ${MIN_CHECK_CONCURRENCY} and ${MAX_CHECK_CONCURRENCY}.`,
        );
      }
      return;
    }
    case 'containerCheckCron': {
      const error = validateCron(value);
      if (error) {
        throw new SettingsValidationError(key, error);
      }
      return;
    }
  }
}

/** Shows only the beginning and end of a secret, e.g. "https://discord.com/api/webhooks/12…abcd". */
export function maskSecret(value: string | null, visibleStart: number, visibleEnd = 4): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= visibleStart + visibleEnd) {
    return '•'.repeat(value.length);
  }
  return `${value.slice(0, visibleStart)}…${value.slice(-visibleEnd)}`;
}
