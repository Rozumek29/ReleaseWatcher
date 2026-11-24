/**
 * Backup file of the configuration (Settings → Backup): what is exported, how items are matched on import and how
 * secrets are left out. Pure types and helpers – no I/O.
 */
import type { SettingKey } from '../settings.ts';

/** Marks a JSON file as a ReleaseWatcher backup. */
export const BACKUP_FORMAT = 'releasewatcher-backup';
/** Version of the file layout; bump it (and keep reading older versions) when the layout changes incompatibly. */
export const BACKUP_SCHEMA_VERSION = 1;

/** How an import treats what is already configured. */
export const IMPORT_MODES = ['merge', 'replace'] as const;
/**
 * `merge` adds new items and updates matching ones, nothing is removed. `replace` also removes repositories,
 * machines and Docker endpoints that are not in the file and resets settings the file does not set.
 */
export type ImportMode = (typeof IMPORT_MODES)[number];

/** A watched repository without its state (releases seen, check results) and without secrets. */
export interface BackupRepository {
  owner: string;
  name: string;
  includePrereleases: boolean;
  isEnabled: boolean;
  icon: string | null;
  installedVersionUrl: string | null;
  installedVersionField: string | null;
  /** Names of the headers sent to the version URL; their values are secrets and are not exported. */
  installedVersionHeaderNames: string[];
  /** Installed version entered by hand (only without a version URL). */
  installedVersion: string | null;
  osvEcosystem: string | null;
  osvPackage: string | null;
  /** The repository has its own GitHub token (not exported). */
  hasGithubToken: boolean;
}

export interface BackupApp {
  name: string;
  versionCommand: string | null;
  latestSource: string;
  /** Watched repository the latest version comes from, as `owner/name` (ids differ between databases). */
  repository: string | null;
  latestCommand: string | null;
  updateCommand: string | null;
  useTty: boolean;
  timeoutSeconds: number;
  /** Installed version entered by hand (only without a version command). */
  installedVersion: string | null;
}

/** A container, virtual machine, the Proxmox node itself or a server – its settings, not its check results. */
export interface BackupTarget {
  kind: string;
  vmid: number;
  name: string;
  isEnabled: boolean;
  aptEnabled: boolean;
  backupBeforeUpdate: boolean | null;
  startWhenStopped: boolean;
  checkCron: string | null;
  updateCores: number | null;
  updateMemoryMb: number | null;
  dockerEnabled: boolean;
  homeAssistantUrl: string | null;
  homeAssistantInstall: boolean;
  /** A Home Assistant access token is saved (not exported). */
  hasHomeAssistantToken: boolean;
  apps: BackupApp[];
}

/** A machine reached over SSH with its targets. The private key is not exported, only the name of the key. */
export interface BackupHost {
  type: string;
  name: string;
  address: string;
  port: number;
  user: string;
  sshKeyName: string | null;
  backupStorage: string | null;
  targets: BackupTarget[];
}

export interface BackupDockerEndpoint {
  name: string;
  url: string;
  isEnabled: boolean;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  /** ReleaseWatcher version that wrote the file. */
  appVersion: string;
  exportedAt: string;
  /** Settings saved in the UI (environment values are not exported), without secrets. */
  settings: Partial<Record<SettingKey, string | number | boolean>>;
  repositories: BackupRepository[];
  hosts: BackupHost[];
  dockerEndpoints: BackupDockerEndpoint[];
  /** Secrets that were configured but left out – they have to be entered again after an import. */
  secretsOmitted: string[];
}

/**
 * Settings that go into a backup: everything editable on the Settings page except secrets. Single sign-on (OIDC)
 * belongs to the account and stays out, like the password, passkeys and API tokens.
 */
export const EXPORTABLE_SETTING_KEYS = [
  'discordMention',
  'discordUsername',
  'releaseCheckCron',
  'advisoryCheckCron',
  'containerCheckCron',
  'dockerCheckCron',
  'containerCheckConcurrency',
  'backupBeforeUpdate',
  'runHistoryChecks',
  'runHistoryUpdates',
  'smtpHost',
  'smtpPort',
  'smtpSecurity',
  'smtpUsername',
  'emailFrom',
  'emailTo',
  'ntfyUrl',
  'ntfyTopic',
  'gotifyUrl',
  'telegramChatId',
  'webhookMethod',
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
] as const satisfies readonly SettingKey[];

/** Secret settings saved in the UI, as named in a backup's list of omitted secrets (OIDC is not part of backups). */
export const SECRET_SETTING_LABELS: Partial<Record<SettingKey, string>> = {
  discordWebhookUrl: 'Discord webhook URL',
  githubToken: 'GitHub token',
  smtpPassword: 'SMTP password',
  ntfyToken: 'ntfy access token',
  gotifyToken: 'Gotify application token',
  telegramBotToken: 'Telegram bot token',
  slackWebhookUrl: 'Slack webhook URL',
  pushoverUserKey: 'Pushover user key',
  pushoverAppToken: 'Pushover application token',
  webhookUrl: 'Webhook URL',
  webhookHeaders: 'Webhook headers',
};

/** "releaseCheckCron" → "Release check cron" (names of settings in the import preview). */
export function settingLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Matching keys: items of a file match existing ones by these (case-insensitive where the app compares so). */
export const repositoryKey = (r: { owner: string; name: string }): string => `${r.owner}/${r.name}`.toLowerCase();
export const hostKey = (h: { type: string; address: string; port: number }): string => `${h.type}|${h.address.toLowerCase()}|${h.port}`;
export const targetKey = (t: { kind: string; vmid: number }): string => `${t.kind}|${t.vmid}`;
export const appKey = (a: { name: string }): string => a.name.trim().toLowerCase();

/** True when two items carry the same values (property order does not matter). */
export const sameItem = (a: unknown, b: unknown): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/** What an import does to one kind of item, for the preview. */
export interface ImportSectionPreview {
  key: 'settings' | 'repositories' | 'machines' | 'dockerEndpoints';
  title: string;
  added: string[];
  updated: string[];
  removed: string[];
  unchanged: number;
}

export interface ImportPreview {
  mode: ImportMode;
  /** Version and time of the export (from the file). */
  appVersion: string | null;
  exportedAt: string | null;
  sections: ImportSectionPreview[];
  /** Secrets missing after the import (new items, or ones never saved here). */
  secretsToReenter: string[];
  /** Things the import adjusts or skips (e.g. an application whose repository is not watched). */
  warnings: string[];
}

export const emptySection = (key: ImportSectionPreview['key'], title: string): ImportSectionPreview => ({
  key,
  title,
  added: [],
  updated: [],
  removed: [],
  unchanged: 0,
});
