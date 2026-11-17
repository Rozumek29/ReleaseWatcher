export interface WatchedRepository {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  /** Avatar of the owner (user or organization). */
  avatarUrl: string;
  includePrereleases: boolean;
  isEnabled: boolean;
  lastSeenTag: string | null;
  lastSeenPublishedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  installedVersionUrl: string | null;
  installedVersionField: string | null;
  /** Header names only – values are secrets and never leave the server. */
  installedVersionHeaders: { name: string; hasValue: boolean }[];
  installedVersion: string | null;
  installedVersionCheckedAt: string | null;
  installedVersionError: string | null;
  /** True when the latest release is newer than the installed version; null when unknown. */
  updateAvailable: boolean | null;
  /** The repository uses its own token instead of the global one (the token itself is never returned). */
  hasOwnToken: boolean;
  githubTokenMasked: string | null;
}

export interface AddRepositoryRequest {
  repository: string;
  includePrereleases: boolean;
  /** Token for a private repository the global token cannot read. */
  githubToken?: string | null;
}

export interface UpdateRepositoryRequest {
  includePrereleases: boolean;
  isEnabled: boolean;
  /** Omit to keep, null to clear. */
  installedVersionUrl?: string | null;
  installedVersionField?: string | null;
  installedVersionHeaders?: HeaderInput[] | null;
  /** Omit to keep, null to remove the repository's own token. */
  githubToken?: string | null;
}

/** A header sent to the server. `value: null` keeps the value already saved under that name. */
export interface HeaderInput {
  name: string;
  value: string | null;
}

export interface InstalledVersionTestResult {
  version: string;
  preview: string;
}

export interface CheckResult {
  repository: WatchedRepository;
  notifiedCount: number;
}

export interface Notifier {
  name: string;
  isEnabled: boolean;
}

export interface TestNotificationResult {
  sent: string[];
  failed: string[];
}

/** Where an effective setting value comes from: saved in the UI, environment variable, or not set. */
export type SettingSource = 'ui' | 'env' | null;

export interface AppSettings {
  discord: {
    webhookConfigured: boolean;
    webhookUrlMasked: string | null;
    webhookSource: SettingSource;
    mention: string | null;
    username: string | null;
  };
  github: {
    tokenConfigured: boolean;
    tokenMasked: string | null;
    tokenSource: SettingSource;
  };
  polling: {
    intervalMinutes: number;
    intervalSource: SettingSource;
    minIntervalMinutes: number;
    maxIntervalMinutes: number;
  };
  proxmox: {
    /** True when host and SSH key are set. */
    configured: boolean;
    host: string | null;
    hostSource: SettingSource;
    port: number;
    user: string;
    /** The key itself is never returned. */
    sshKeyConfigured: boolean;
    sshKeySource: SettingSource;
    checkCron: string;
    checkCronSource: SettingSource;
    /** How many containers are checked at the same time. */
    checkConcurrency: number;
    checkConcurrencySource: SettingSource;
    minCheckConcurrency: number;
    maxCheckConcurrency: number;
    /** Storage that receives backups (vzdump) made before updates. */
    backupStorage: string | null;
    backupStorageSource: SettingSource;
    /** Back up before updates by default (containers can override, every update can change it). */
    backupBeforeUpdate: boolean;
    backupBeforeUpdateSource: SettingSource;
  };
}

/** A storage on the node that accepts backups. */
export interface BackupStorage {
  name: string;
  type: string;
  status: string;
  availableBytes: number | null;
}

/** `undefined` keeps a value, `null` resets it to the environment default. */
export interface SettingsPatch {
  discordWebhookUrl?: string | null;
  discordMention?: string | null;
  discordUsername?: string | null;
  githubToken?: string | null;
  pollIntervalMinutes?: number | null;
  proxmoxHost?: string | null;
  proxmoxPort?: number | null;
  proxmoxUser?: string | null;
  proxmoxSshKey?: string | null;
  containerCheckCron?: string | null;
  containerCheckConcurrency?: number | null;
  backupStorage?: string | null;
  backupBeforeUpdate?: boolean | null;
}

export interface AppStatus {
  /** Version of the running server, e.g. "1.2.3". */
  version: string;
  poller: {
    intervalMinutes: number;
    isRunning: boolean;
    lastRunStartedAt: string | null;
    lastRunFinishedAt: string | null;
    nextRunAt: string | null;
  };
  repositories: {
    total: number;
    enabled: number;
    withErrors: number;
    updatesAvailable: number;
  };
  containers?: {
    total: number;
    enabled: number;
    withErrors: number;
    aptPending: number;
    appUpdatesAvailable: number;
  };
}

export interface RateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

/* ---------- Proxmox containers ---------- */

export interface AptPackage {
  name: string;
  currentVersion: string | null;
  newVersion: string;
}

/** Where the newest available version of an application comes from. */
export type LatestSource = 'none' | 'github' | 'command';

export interface ContainerApp {
  id: number;
  name: string;
  versionCommand: string | null;
  latestSource: LatestSource;
  repositoryId: number | null;
  repositoryFullName: string | null;
  latestCommand: string | null;
  updateCommand: string | null;
  useTty: boolean;
  timeoutSeconds: number;
  installedVersion: string | null;
  latestVersion: string | null;
  checkedAt: string | null;
  error: string | null;
  updateAvailable: boolean | null;
}

/** An application found in a container (`POST /api/containers/:id/detect-apps`) – a suggestion, not saved. */
export interface DetectedApp {
  name: string;
  /** community-scripts slug; null when found by a version file only. */
  slug: string | null;
  versionCommand: string | null;
  installedVersion: string | null;
  updateCommand: string | null;
  /** `owner/repo` on GitHub; null when unknown. */
  repository: string | null;
  /** The watched repository with that name; null when it is not watched yet. */
  repositoryId: number | null;
  /** The container already has this application (same repository or name). */
  alreadyAdded: boolean;
}

export interface Container {
  id: number;
  /** `node` = the Proxmox host itself (apt only, vmid 0). */
  kind: 'lxc' | 'node';
  vmid: number;
  name: string;
  isEnabled: boolean;
  aptEnabled: boolean;
  /** Back up before updates; null = use the global default. */
  backupBeforeUpdate: boolean | null;
  /** The value in effect for this container (own setting or the global default). */
  effectiveBackupBeforeUpdate: boolean;
  /** Started temporarily for checks and updates when stopped, shut down again afterwards. */
  startWhenStopped: boolean;
  /** Overrides the global schedule; null = global. */
  checkCron: string | null;
  /** CPU cores during updates (restored afterwards); null = unchanged. */
  updateCores: number | null;
  /** Memory in MiB during updates (restored afterwards); null = unchanged. */
  updateMemoryMb: number | null;
  /** Resources are raised for an update right now (or could not be restored yet). */
  resourcesRaised: boolean;
  nextCheckAt: string | null;
  status: string | null;
  aptUpgradable: AptPackage[];
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** A check or update is running right now. */
  isBusy: boolean;
  /** The check/update running right now (its live log); null while waiting for its turn in "update all". */
  activeRunId: number | null;
  apps: ContainerApp[];
  /** apt counts as one. */
  updatesAvailable: number;
}

export interface UpdateContainerRequest {
  name: string;
  isEnabled: boolean;
  aptEnabled: boolean;
  backupBeforeUpdate: boolean | null;
  startWhenStopped: boolean;
  checkCron: string | null;
  updateCores?: number | null;
  updateMemoryMb?: number | null;
}

export interface ContainerAppRequest {
  name: string;
  versionCommand: string | null;
  latestSource: LatestSource;
  repositoryId: number | null;
  latestCommand: string | null;
  updateCommand: string | null;
  useTty: boolean;
  timeoutSeconds: number | null;
}

/** A container found on the node by `pct list`. */
export interface DiscoveredContainer {
  vmid: number;
  status: string;
  name: string;
  added: boolean;
}

export type RunKind = 'check' | 'apt-upgrade' | 'app-update';
export type RunStatus = 'running' | 'succeeded' | 'failed';

export interface RunSummary {
  id: number;
  containerId: number;
  appId: number | null;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface Run extends RunSummary {
  output: string;
}

/** GET /api/runs/:id – while the run is in progress, `output` may hold only the part after `?after=<cursor>`. */
export interface RunPage extends Run {
  /** `output` continues the output read before (append it) instead of replacing it. */
  outputAppend: boolean;
  /** Pass as `after` on the next poll; null when the run is not in progress. */
  outputCursor: string | null;
}

/** Login state of the browser (GET /api/auth/state). */
export interface AuthState {
  /** No account yet – the setup screen creates it. */
  setupRequired: boolean;
  authenticated: boolean;
  username: string | null;
  hasPasskeys: boolean;
}

export interface PasskeyInfo {
  /** Credential ID (base64url). */
  id: string;
  name: string;
  transports: string[];
  deviceType: string | null;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SessionInfo {
  id: string;
  method: 'password' | 'passkey' | 'setup';
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** The session of this browser. */
  current: boolean;
}

/** PUT /api/auth/account – the current password is always required. */
export interface AccountUpdate {
  currentPassword: string;
  username?: string | null;
  newPassword?: string | null;
}
