import type { Config } from './config.ts';
import { intervalToCron, validateCron } from './cron.ts';
import type { RepositoryStore } from './db.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from './notifiers/dispatcher.ts';
import { parseAddress, parseRecipients } from './notifiers/email.ts';
import { SMTP_SECURITY, type SmtpSecurity } from './notifiers/smtp.ts';
import { WEBHOOK_METHODS, type WebhookMethod } from './notifiers/webhook.ts';
import { type HttpHeader, validateHeaders } from './version.ts';
import { DEFAULT_RUN_HISTORY, MAX_RUN_HISTORY, MIN_RUN_HISTORY } from './proxmox/domain.ts';

/** Runtime settings editable from the UI. Values stored in the database override environment defaults. */
export interface Settings {
  discordWebhookUrl: string | null;
  discordMention: string | null;
  discordUsername: string | null;
  githubToken: string | null;
  /** Cron schedule of release checks. */
  releaseCheckCron: string;
  /** Cron schedule of vulnerability (security advisory) checks. */
  advisoryCheckCron: string;
  /** Default cron schedule of container checks. */
  containerCheckCron: string;
  /** Cron schedule of Docker endpoint checks and registry checks of Docker images. */
  dockerCheckCron: string;
  /** How many containers are checked at the same time. */
  containerCheckConcurrency: number;
  /** Default of "back up before updating" (containers can override it, and it can be changed per update). */
  backupBeforeUpdate: boolean;
  /** Checks kept in the run history of each container; null = all (set only in the UI, no env variable). */
  runHistoryChecks: number | null;
  /** Other runs (updates, upgrades, restarts) kept per container; null = all (UI only). */
  runHistoryUpdates: number | null;
  smtpHost: string | null;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  smtpUsername: string | null;
  /** Secret. */
  smtpPassword: string | null;
  emailFrom: string | null;
  /** Comma-separated recipients. */
  emailTo: string | null;
  /** ntfy server; null = https://ntfy.sh. */
  ntfyUrl: string | null;
  ntfyTopic: string | null;
  /** Secret: access token or `user:password`. */
  ntfyToken: string | null;
  gotifyUrl: string | null;
  /** Secret: application token. */
  gotifyToken: string | null;
  /** Secret. */
  telegramBotToken: string | null;
  telegramChatId: string | null;
  /** Secret: Slack incoming webhook URL. */
  slackWebhookUrl: string | null;
  /** Secret. */
  pushoverUserKey: string | null;
  /** Secret. */
  pushoverAppToken: string | null;
  /** Secret: URL of the generic JSON webhook. */
  webhookUrl: string | null;
  /** HTTP method of the generic webhook; null = POST. */
  webhookMethod: WebhookMethod | null;
  /** Secret: extra headers of the generic webhook, JSON `[{ name, value }]` (UI only). */
  webhookHeaders: string | null;
  /** Send the notifications of one check run as one summary. */
  notificationDigest: boolean;
  notifyReleases: boolean;
  /** New security advisories of watched repositories. */
  notifyVulnerabilities: boolean;
  notifyAppUpdates: boolean;
  notifyAptUpdates: boolean;
  notifyUpdateSucceeded: boolean;
  notifyUpdateFailed: boolean;
  /** Newer images of the tags Docker containers run. */
  notifyDockerUpdates: boolean;
  /** Read GitHub repository security advisories. */
  advisoriesGithub: boolean;
  /** Query OSV.dev for repositories with an OSV package. */
  advisoriesOsv: boolean;
  /** OpenID Connect provider: issuer or discovery URL (edited on the Account page, not through PUT /api/settings). */
  oidcIssuer: string | null;
  oidcClientId: string | null;
  /** Secret: null = public client (PKCE only). */
  oidcClientSecret: string | null;
  /** Name on the sign-in button; null = "OIDC". */
  oidcName: string | null;
}

/** On/off settings (stored as "true"/"false"). */
const BOOLEAN_SETTINGS: ReadonlySet<SettingKey> = new Set([
  'backupBeforeUpdate',
  'notificationDigest',
  'notifyReleases',
  'notifyVulnerabilities',
  'notifyAppUpdates',
  'notifyAptUpdates',
  'notifyUpdateSucceeded',
  'notifyUpdateFailed',
  'notifyDockerUpdates',
  'advisoriesGithub',
  'advisoriesOsv',
]);

export const MIN_CHECK_CONCURRENCY = 1;
export const MAX_CHECK_CONCURRENCY = 10;

export type SettingKey = keyof Settings;
export type SettingsPatch = { [K in SettingKey]?: Settings[K] | null };

/**
 * Connection to the Proxmox node as configured before hosts existed (env PROXMOX_* or saved in the UI). Read once
 * to create the first host (`seedProxmoxHost`); the settings themselves are no longer editable.
 */
export interface LegacyProxmoxConnection {
  host: string | null;
  port: number;
  user: string;
  privateKey: string | null;
}

/** Former key of the global backup storage (now set per Proxmox node; still read for the migration). */
const LEGACY_BACKUP_STORAGE_KEY = 'backupStorage';

/** Keys of the former Proxmox connection settings (still read from the database for the migration). */
const LEGACY_PROXMOX_KEYS = ['proxmoxHost', 'proxmoxPort', 'proxmoxUser', 'proxmoxSshKey'] as const;

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
  private readonly legacyDefaults: LegacyProxmoxConnection;
  private readonly legacyBackupStorageDefault: string | null;
  private overrides: Partial<Record<SettingKey, string>>;
  private readonly listeners = new Set<(settings: Settings) => void>();

  constructor(store: RepositoryStore, config: Config) {
    this.store = store;
    this.defaults = {
      discordWebhookUrl: config.discord.webhookUrl,
      discordMention: config.discord.mention,
      discordUsername: config.discord.username,
      githubToken: config.github.token,
      releaseCheckCron: config.releaseCheckCron,
      advisoryCheckCron: config.advisoryCheckCron,
      containerCheckCron: config.proxmox.checkCron,
      dockerCheckCron: config.dockerCheckCron,
      containerCheckConcurrency: config.proxmox.checkConcurrency,
      backupBeforeUpdate: config.proxmox.backupBeforeUpdate,
      runHistoryChecks: DEFAULT_RUN_HISTORY.checks,
      runHistoryUpdates: DEFAULT_RUN_HISTORY.others,
      smtpHost: config.email.smtpHost,
      smtpPort: config.email.smtpPort,
      smtpSecurity: config.email.smtpSecurity,
      smtpUsername: config.email.smtpUsername,
      smtpPassword: config.email.smtpPassword,
      emailFrom: config.email.from,
      emailTo: config.email.to,
      ntfyUrl: config.ntfy.url,
      ntfyTopic: config.ntfy.topic,
      ntfyToken: config.ntfy.token,
      gotifyUrl: config.gotify.url,
      gotifyToken: config.gotify.token,
      telegramBotToken: config.telegram.botToken,
      telegramChatId: config.telegram.chatId,
      slackWebhookUrl: config.slack.webhookUrl,
      pushoverUserKey: config.pushover.userKey,
      pushoverAppToken: config.pushover.appToken,
      webhookUrl: config.webhook.url,
      webhookMethod: config.webhook.method,
      webhookHeaders: null,
      notificationDigest: config.notificationDigest,
      notifyReleases: DEFAULT_NOTIFICATION_PREFERENCES.releases,
      notifyVulnerabilities: DEFAULT_NOTIFICATION_PREFERENCES.vulnerabilities,
      notifyAppUpdates: DEFAULT_NOTIFICATION_PREFERENCES.appUpdates,
      notifyAptUpdates: DEFAULT_NOTIFICATION_PREFERENCES.aptUpdates,
      notifyUpdateSucceeded: DEFAULT_NOTIFICATION_PREFERENCES.updateSucceeded,
      notifyUpdateFailed: DEFAULT_NOTIFICATION_PREFERENCES.updateFailed,
      notifyDockerUpdates: DEFAULT_NOTIFICATION_PREFERENCES.dockerUpdates,
      advisoriesGithub: true,
      advisoriesOsv: true,
      oidcIssuer: config.oidc.issuer,
      oidcClientId: config.oidc.clientId,
      oidcClientSecret: config.oidc.clientSecret,
      oidcName: config.oidc.name,
    };
    this.legacyDefaults = {
      host: config.proxmox.host,
      port: config.proxmox.port,
      user: config.proxmox.user,
      privateKey: config.proxmox.privateKey,
    };
    this.legacyBackupStorageDefault = config.proxmox.backupStorage;
    this.overrides = store.readSettings() as Partial<Record<SettingKey, string>>;
    this.migrateLegacySettings();
  }

  /** The former Proxmox connection: values saved in the UI first, then the environment. */
  legacyProxmox(): LegacyProxmoxConnection {
    const saved = this.store.readSettings();
    return {
      host: saved['proxmoxHost'] ?? this.legacyDefaults.host,
      port: saved['proxmoxPort'] !== undefined ? Number(saved['proxmoxPort']) : this.legacyDefaults.port,
      user: saved['proxmoxUser'] ?? this.legacyDefaults.user,
      privateKey: saved['proxmoxSshKey'] ?? this.legacyDefaults.privateKey,
    };
  }

  /** Removes the former Proxmox connection settings saved in the UI (after they were moved into a host). */
  clearLegacyProxmox(): void {
    for (const key of LEGACY_PROXMOX_KEYS) {
      this.store.writeSetting(key, null);
    }
  }

  /**
   * The former global backup storage (saved in the UI, then PROXMOX_BACKUP_STORAGE). Read once to give it to the
   * Proxmox nodes without their own storage (`seedNodeBackupStorage`).
   */
  legacyBackupStorage(): string | null {
    return this.store.readSettings()[LEGACY_BACKUP_STORAGE_KEY] ?? this.legacyBackupStorageDefault;
  }

  /** Removes the former global backup storage saved in the UI (after it was moved to the nodes). */
  clearLegacyBackupStorage(): void {
    this.store.writeSetting(LEGACY_BACKUP_STORAGE_KEY, null);
    this.overrides = this.store.readSettings() as Partial<Record<SettingKey, string>>;
  }

  /** Converts a polling interval saved by an older version into a release check cron expression. */
  private migrateLegacySettings(): void {
    const legacy = (this.overrides as Record<string, string | undefined>)['pollIntervalMinutes'];
    if (legacy === undefined) {
      return;
    }
    if (this.overrides.releaseCheckCron === undefined) {
      this.store.writeSetting('releaseCheckCron', intervalToCron(Number(legacy)));
    }
    this.store.writeSetting('pollIntervalMinutes', null);
    this.overrides = this.store.readSettings() as Partial<Record<SettingKey, string>>;
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
      releaseCheckCron: o.releaseCheckCron ?? this.defaults.releaseCheckCron,
      advisoryCheckCron: o.advisoryCheckCron ?? this.defaults.advisoryCheckCron,
      containerCheckCron: o.containerCheckCron ?? this.defaults.containerCheckCron,
      dockerCheckCron: o.dockerCheckCron ?? this.defaults.dockerCheckCron,
      containerCheckConcurrency:
        o.containerCheckConcurrency !== undefined
          ? Number(o.containerCheckConcurrency)
          : this.defaults.containerCheckConcurrency,
      backupBeforeUpdate: flag('backupBeforeUpdate'),
      runHistoryChecks: o.runHistoryChecks !== undefined ? Number(o.runHistoryChecks) : this.defaults.runHistoryChecks,
      runHistoryUpdates: o.runHistoryUpdates !== undefined ? Number(o.runHistoryUpdates) : this.defaults.runHistoryUpdates,
      smtpHost: o.smtpHost ?? this.defaults.smtpHost,
      smtpPort: o.smtpPort !== undefined ? Number(o.smtpPort) : this.defaults.smtpPort,
      smtpSecurity: (o.smtpSecurity as SmtpSecurity | undefined) ?? this.defaults.smtpSecurity,
      smtpUsername: o.smtpUsername ?? this.defaults.smtpUsername,
      smtpPassword: o.smtpPassword ?? this.defaults.smtpPassword,
      emailFrom: o.emailFrom ?? this.defaults.emailFrom,
      emailTo: o.emailTo ?? this.defaults.emailTo,
      ntfyUrl: o.ntfyUrl ?? this.defaults.ntfyUrl,
      ntfyTopic: o.ntfyTopic ?? this.defaults.ntfyTopic,
      ntfyToken: o.ntfyToken ?? this.defaults.ntfyToken,
      gotifyUrl: o.gotifyUrl ?? this.defaults.gotifyUrl,
      gotifyToken: o.gotifyToken ?? this.defaults.gotifyToken,
      telegramBotToken: o.telegramBotToken ?? this.defaults.telegramBotToken,
      telegramChatId: o.telegramChatId ?? this.defaults.telegramChatId,
      slackWebhookUrl: o.slackWebhookUrl ?? this.defaults.slackWebhookUrl,
      pushoverUserKey: o.pushoverUserKey ?? this.defaults.pushoverUserKey,
      pushoverAppToken: o.pushoverAppToken ?? this.defaults.pushoverAppToken,
      webhookUrl: o.webhookUrl ?? this.defaults.webhookUrl,
      webhookMethod: (o.webhookMethod as WebhookMethod | undefined) ?? this.defaults.webhookMethod,
      webhookHeaders: o.webhookHeaders ?? this.defaults.webhookHeaders,
      notificationDigest: flag('notificationDigest'),
      notifyReleases: flag('notifyReleases'),
      notifyVulnerabilities: flag('notifyVulnerabilities'),
      notifyAppUpdates: flag('notifyAppUpdates'),
      notifyAptUpdates: flag('notifyAptUpdates'),
      notifyUpdateSucceeded: flag('notifyUpdateSucceeded'),
      notifyUpdateFailed: flag('notifyUpdateFailed'),
      notifyDockerUpdates: flag('notifyDockerUpdates'),
      advisoriesGithub: flag('advisoriesGithub'),
      advisoriesOsv: flag('advisoriesOsv'),
      oidcIssuer: o.oidcIssuer ?? this.defaults.oidcIssuer,
      oidcClientId: o.oidcClientId ?? this.defaults.oidcClientId,
      oidcClientSecret: o.oidcClientSecret ?? this.defaults.oidcClientSecret,
      oidcName: o.oidcName ?? this.defaults.oidcName,
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
    case 'discordWebhookUrl':
      requireHttpUrl(key, value, 'Webhook URL');
      return;
    case 'ntfyUrl':
    case 'gotifyUrl':
      requireHttpUrl(key, value, 'Server URL');
      return;
    case 'slackWebhookUrl':
    case 'webhookUrl':
      requireHttpUrl(key, value, 'Webhook URL');
      return;
    case 'webhookMethod':
      if (!(WEBHOOK_METHODS as readonly string[]).includes(value)) {
        throw new SettingsValidationError(key, `Method must be one of: ${WEBHOOK_METHODS.join(', ')}.`);
      }
      return;
    case 'webhookHeaders': {
      let headers: unknown;
      try {
        headers = JSON.parse(value);
      } catch {
        throw new SettingsValidationError(key, 'Headers must be a JSON list.');
      }
      const valid =
        Array.isArray(headers) &&
        headers.every((h) => typeof h?.name === 'string' && typeof h?.value === 'string');
      const error = valid ? validateHeaders(headers as HttpHeader[]) : 'Headers must be a list of names and values.';
      if (error) {
        throw new SettingsValidationError(key, error);
      }
      return;
    }
    case 'ntfyTopic':
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
        throw new SettingsValidationError(key, 'Topic may contain only letters, digits, "-" and "_" (at most 64).');
      }
      return;
    case 'ntfyToken':
    case 'gotifyToken':
      if (value.length > 500 || /\s/.test(value)) {
        throw new SettingsValidationError(key, 'Must be a single word of at most 500 characters.');
      }
      return;
    case 'telegramBotToken':
      if (!/^\d{3,}:[A-Za-z0-9_-]{20,}$/.test(value)) {
        throw new SettingsValidationError(key, 'Enter the token @BotFather gave you, e.g. 123456789:AAE…');
      }
      return;
    case 'telegramChatId':
      if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(value)) {
        throw new SettingsValidationError(key, 'Enter a numeric chat id (e.g. -1001234567890) or @channelname.');
      }
      return;
    case 'pushoverUserKey':
    case 'pushoverAppToken':
      if (!/^[A-Za-z0-9]{30}$/.test(value)) {
        throw new SettingsValidationError(key, 'Pushover keys are 30 letters and digits.');
      }
      return;
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
    case 'oidcIssuer': {
      requireHttpUrl(key, value, 'Issuer URL');
      const url = new URL(value);
      if (url.search || url.hash || url.username || url.password) {
        throw new SettingsValidationError(key, 'Enter the issuer URL without query, fragment or credentials.');
      }
      return;
    }
    case 'oidcClientId':
    case 'oidcClientSecret':
      if (value.length > 500 || /\s/.test(value)) {
        throw new SettingsValidationError(key, 'Must be a single word of at most 500 characters.');
      }
      return;
    case 'oidcName':
      if (value.length > 40) {
        throw new SettingsValidationError(key, 'The name can have at most 40 characters.');
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
    case 'runHistoryChecks':
    case 'runHistoryUpdates': {
      const count = Number(value);
      if (!Number.isInteger(count) || count < MIN_RUN_HISTORY || count > MAX_RUN_HISTORY) {
        throw new SettingsValidationError(key, `Keep between ${MIN_RUN_HISTORY} and ${MAX_RUN_HISTORY} runs.`);
      }
      return;
    }
    case 'releaseCheckCron':
    case 'advisoryCheckCron':
    case 'containerCheckCron':
    case 'dockerCheckCron': {
      const error = validateCron(value);
      if (error) {
        throw new SettingsValidationError(key, error);
      }
      return;
    }
  }
}

function requireHttpUrl(key: SettingKey, value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SettingsValidationError(key, `${label} must be a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SettingsValidationError(key, `${label} must use http(s).`);
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
