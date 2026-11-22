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
  /** Versions advisories are compared with: the own installed version plus those of linked container apps. */
  installedVersions: string[];
  /** True when the latest release is newer than the installed version; null when unknown. */
  updateAvailable: boolean | null;
  /** The repository uses its own token instead of the global one (the token itself is never returned). */
  hasOwnToken: boolean;
  githubTokenMasked: string | null;
  /** OSV.dev package of the app (both set or both null). */
  osvEcosystem: string | null;
  osvPackage: string | null;
  /** Security advisories (GitHub, OSV.dev) published for the repository. */
  advisories: AdvisorySummary;
}

export type AdvisorySource = 'github' | 'osv';

export type AdvisorySeverity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export interface AdvisorySummary {
  total: number;
  /** Advisories whose vulnerable range contains the installed version. */
  affecting: number;
  /** Highest severity among the affecting advisories (or among all when none affects the installed version). */
  highestSeverity: AdvisorySeverity | null;
  /** Last successful fetch; null = not fetched yet. */
  checkedAt: string | null;
  error: string | null;
}

export interface SecurityAdvisory {
  /** e.g. "GHSA-…", "GO-2025-…", "PYSEC-…". */
  id: string;
  source: AdvisorySource;
  /** Other ids of the same vulnerability. */
  aliases: string[];
  cveId: string | null;
  summary: string;
  severity: AdvisorySeverity;
  /** CVSS base score (0–10). */
  cvssScore: number | null;
  htmlUrl: string;
  publishedAt: string;
  updatedAt: string | null;
  vulnerabilities: { packageName: string | null; vulnerableRange: string | null; patchedVersions: string | null }[];
  /** True when an installed version is affected, false when all are known to be safe, otherwise null. */
  affectsInstalled: boolean | null;
  /** Installed versions inside the vulnerable ranges. */
  affectedVersions: string[];
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
  /** OSV.dev package; omit to keep, null to remove. */
  osvEcosystem?: string | null;
  osvPackage?: string | null;
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
  /** Linked containers whose check was started because the check found a new release. */
  containerChecks: number;
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
  /** Cron schedules (server time zone) of the scheduled release and vulnerability checks. */
  polling: {
    releaseCron: string;
    releaseCronSource: SettingSource;
    advisoryCron: string;
    advisoryCronSource: SettingSource;
  };
  proxmox: {
    /** True when a Proxmox node is added (Settings → Connections) and has an SSH key. */
    configured: boolean;
    /** Proxmox nodes guests can be added from (the first one is the default). */
    nodes: ProxmoxNode[];
    checkCron: string;
    checkCronSource: SettingSource;
    /** How many containers are checked at the same time. */
    checkConcurrency: number;
    checkConcurrencySource: SettingSource;
    minCheckConcurrency: number;
    maxCheckConcurrency: number;
    /** Back up before updates by default (containers can override, every update can change it). */
    backupBeforeUpdate: boolean;
    backupBeforeUpdateSource: SettingSource;
  };
  email: {
    /** True when host, sender and recipients are set. */
    configured: boolean;
    smtpHost: string | null;
    smtpHostSource: SettingSource;
    smtpPort: number;
    smtpSecurity: SmtpSecurity;
    smtpUsername: string | null;
    /** The password itself is never returned. */
    smtpPasswordConfigured: boolean;
    smtpPasswordSource: SettingSource;
    from: string | null;
    /** Comma-separated recipients. */
    to: string | null;
    toSource: SettingSource;
  };
  notifications: NotificationPreferences & { digestSource: SettingSource };
  /** Enabled sources of security advisories. */
  advisories: { github: boolean; osv: boolean; osvEcosystems: string[] };
}

/** `starttls`: port 587, upgraded with STARTTLS; `tls`: TLS from the start (465); `none`: unencrypted. */
export type SmtpSecurity = 'starttls' | 'tls' | 'none';

/** Which notifications are sent, and whether one check run sends one summary (digest). */
export interface NotificationPreferences {
  digest: boolean;
  releases: boolean;
  vulnerabilities: boolean;
  appUpdates: boolean;
  aptUpdates: boolean;
  updateSucceeded: boolean;
  updateFailed: boolean;
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
  releaseCheckCron?: string | null;
  advisoryCheckCron?: string | null;
  smtpHost?: string | null;
  smtpPort?: number | null;
  smtpSecurity?: SmtpSecurity | null;
  smtpUsername?: string | null;
  smtpPassword?: string | null;
  emailFrom?: string | null;
  emailTo?: string | null;
  notificationDigest?: boolean | null;
  notifyReleases?: boolean | null;
  notifyVulnerabilities?: boolean | null;
  notifyAppUpdates?: boolean | null;
  notifyAptUpdates?: boolean | null;
  notifyUpdateSucceeded?: boolean | null;
  notifyUpdateFailed?: boolean | null;
  advisoriesGithub?: boolean | null;
  advisoriesOsv?: boolean | null;
  containerCheckCron?: string | null;
  containerCheckConcurrency?: number | null;
  backupBeforeUpdate?: boolean | null;
}

/** A security advisory together with its repository (Vulnerabilities page). */
/** Counts of the Vulnerabilities page over all advisories (independent of the filters). */
export interface AdvisoryOverview {
  total: number;
  affecting: number;
  unknown: number;
  unaffected: number;
  /** Critical advisories affecting an installed version. */
  critical: number;
  /** Repositories with an advisory affecting an installed version. */
  repositories: number;
  /** Advisories affecting an installed version without a released fix. */
  noFix: number;
  /** Sources present in the stored advisories. */
  sources: AdvisorySource[];
}

/** Filters and position of `GET /api/advisories`; "all" or a missing value = no filter. */
export interface AdvisoryQuery {
  impact?: 'all' | 'affecting' | 'unknown' | 'unaffected';
  severity?: AdvisorySeverity | 'all';
  source?: AdvisorySource | 'all';
  q?: string;
  /** `nextCursor` of the previous page (keyset pagination). */
  cursor?: string;
  limit?: number;
}

/** One page of advisories: affecting an installed version first, then most severe, then newest. */
export interface AdvisoryPage {
  items: RepositoryAdvisory[];
  /** Cursor of the next page, or null on the last one. */
  nextCursor: string | null;
  /** Advisories matching the filters – first page only (null with a cursor). */
  total: number | null;
  /** First page only (null with a cursor). */
  overview: AdvisoryOverview | null;
}

export interface RepositoryAdvisory extends SecurityAdvisory {
  repository: {
    id: number;
    fullName: string;
    owner: string;
    url: string;
    avatarUrl: string;
    installedVersion: string | null;
    /** Own installed version plus those of linked container apps. */
    installedVersions: string[];
  };
}

/** A job that runs on a cron schedule. */
export interface JobStatus {
  cron: string;
  isRunning: boolean;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  /** Null while running or when the cron expression is invalid. */
  nextRunAt: string | null;
}

export interface AppStatus {
  /** Version of the running server, e.g. "1.2.3". */
  version: string;
  /** Scheduled release checks. */
  poller: JobStatus;
  /** Scheduled vulnerability checks. */
  advisoryPoller: JobStatus;
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
    homeAssistantUpdatesAvailable?: number;
  };
  /** Security advisories of all repositories; `affecting` = those affecting an installed version. */
  advisories?: {
    total: number;
    affecting: number;
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

/** One pending update of Home Assistant OS. */
export interface HomeAssistantUpdate {
  /** `core`, `os`, `supervisor`, `app:<slug>` or the entity ID (`update.…`) of an integration. */
  id: string;
  source: 'core' | 'os' | 'supervisor' | 'app' | 'entity';
  name: string;
  installedVersion: string | null;
  latestVersion: string;
  releaseUrl: string | null;
  /** Integration providing the update entity (e.g. `marketplace`); null for Supervisor components. */
  platform: string | null;
  /** Home Assistant can install it; false = the entity only announces an update. */
  installable: boolean;
  /** Why it cannot be installed from ReleaseWatcher; null = it can. */
  installBlocker: string | null;
}

/** Home Assistant OS in a virtual machine (`null` for containers and the host). */
export interface HomeAssistantInfo {
  /** Found by the last check. */
  detected: boolean;
  coreVersion: string | null;
  osVersion: string | null;
  /** When Home Assistant saved the states the integration updates come from (no token); null = read live. */
  entitiesSavedAt: string | null;
  updates: HomeAssistantUpdate[];
  /** Updates may be installed from ReleaseWatcher; false = they are only checked and reported. */
  installEnabled: boolean;
  /** Base URL of the REST API; null = not configured. */
  url: string | null;
  hasToken: boolean;
  /** Masked hint of the saved token. */
  tokenMasked: string | null;
}

/** What ReleaseWatcher can do with a target – the UI branches on these instead of on `kind`. */
export interface TargetCapabilities {
  /** How the target is backed up before updates; null = it cannot be backed up. */
  backup: 'vzdump' | null;
  /** Can be started and shut down ("Start temporarily when stopped"). */
  power: boolean;
  /** apt can be switched off (false = always on). */
  aptOptional: boolean;
  /** CPU cores and memory can be raised for updates. */
  updateResources: boolean;
  /** Applications can be added and detected. */
  apps: boolean;
  /** Home Assistant OS may run here. */
  homeAssistant: boolean;
  /** Included in "Update all". */
  updateAll: boolean;
  /** `guest` = rebooted by the node; `machine` = the machine itself reboots (restart is only scheduled). */
  restart: 'guest' | 'machine';
}

export interface Container {
  id: number;
  /** Host the target is reached through (its Proxmox node, or the server itself); null = not assigned. */
  hostId: number | null;
  hostName: string | null;
  /** Its host has an SSH key, so checks and updates can run. */
  configured: boolean;
  /**
   * `lxc` = a container, `vm` = a virtual machine (commands through the QEMU guest agent),
   * `node` = the Proxmox host itself (apt only, vmid 0), `server` = a plain Linux machine reached over SSH.
   */
  kind: 'lxc' | 'vm' | 'node' | 'server';
  capabilities: TargetCapabilities;
  vmid: number;
  name: string;
  isEnabled: boolean;
  aptEnabled: boolean;
  /** Back up before updates; null = use the global default. */
  backupBeforeUpdate: boolean | null;
  /** The value in effect for this container (own setting or the global default). */
  effectiveBackupBeforeUpdate: boolean;
  /** Storage its backups go to (its node's, else the global one); null = no backups possible or none chosen. */
  backupStorage: string | null;
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
  /** Why a restart is needed (last check); empty = none. */
  restartReasons: string[];
  /** Home Assistant OS of a virtual machine; null for containers and the host. */
  homeAssistant: HomeAssistantInfo | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** A check or update is running right now. */
  isBusy: boolean;
  /** The check/update running right now (its live log); null while waiting for its turn in "update all". */
  activeRunId: number | null;
  apps: ContainerApp[];
  /** apt counts as one, every Home Assistant update as one. */
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
  /** Virtual machines: Home Assistant REST API URL; null removes it. */
  homeAssistantUrl?: string | null;
  /** Omitted = keep, null = remove, value = set. */
  homeAssistantToken?: string | null;
  /** Install Home Assistant updates from ReleaseWatcher (false = check only). */
  homeAssistantInstall?: boolean;
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

/** A container (`pct list`) or virtual machine (`qm list`) found on the node. */
export interface DiscoveredContainer {
  kind: 'lxc' | 'vm';
  vmid: number;
  status: string;
  name: string;
  added: boolean;
}

export type RunKind = 'check' | 'apt-upgrade' | 'app-update' | 'restart' | 'home-assistant-update';
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

/** A named SSH key; the private part never leaves the server. */
export interface SshKey {
  id: number;
  name: string;
  /** `ssh-ed25519 AAAA… comment` – to add to `authorized_keys`; null when it could not be derived. */
  publicKey: string | null;
  /** `SHA256:…`; null when it could not be derived. */
  fingerprint: string | null;
  /** Hosts that log in with this key. */
  hostCount: number;
  createdAt: string;
}

/** `proxmox` = a Proxmox VE node; `server` = a plain Linux machine. */
export type HostType = 'proxmox' | 'server';

/** A machine reached over SSH. */
export interface Host {
  id: number;
  type: HostType;
  name: string;
  address: string;
  port: number;
  user: string;
  sshKeyId: number | null;
  sshKeyName: string | null;
  /** Proxmox node: storage for backups before updates; null = no backups. */
  backupStorage: string | null;
  /** A key is chosen (whether the host answers shows "Test connection"). */
  configured: boolean;
  /** Containers, virtual machines and the node itself watched through this host. */
  targetCount: number;
  createdAt: string;
}

/** Body of `POST /api/hosts` / `PUT /api/hosts/:id` (omitted = keep on update). */
export interface HostInput {
  type?: HostType;
  name?: string;
  address?: string;
  port?: number | null;
  user?: string | null;
  sshKeyId?: number | null;
  backupStorage?: string | null;
}

/** A Proxmox node as listed in the settings. */
export interface ProxmoxNode {
  id: number;
  name: string;
  configured: boolean;
  backupStorage: string | null;
}
