/**
 * Where a repository lives: GitHub, a Gitea/Forgejo instance (Codeberg …), a GitLab instance – or `web`: versions
 * read from a web page, feed or JSON API (`webSource`).
 */
export type RepositoryProvider = 'github' | 'gitea' | 'gitlab' | 'web';

/** How the response of a web source is read. */
export type WebSourceFormat = 'text' | 'json' | 'html' | 'xml';

/** A web page, feed or JSON API versions are read from (provider `web`). */
export interface WebSource {
  url: string;
  format: WebSourceFormat;
  /** Selector (HTML, XML) or path (JSON) of each release; null = the whole document is one item. */
  items: string | null;
  /** Selector or path of the version inside an item; null for the text format (the pattern finds it). */
  version: string | null;
  date: string | null;
  link: string | null;
  /** User-Agent sent to the site; null = ReleaseWatcher's own. */
  userAgent: string | null;
}

/** What of a repository is watched: its releases, or its tags (projects that tag versions without releases). */
export type ReleaseSourceKind = 'releases' | 'tags';

export interface WatchedRepository {
  id: number;
  provider: RepositoryProvider;
  /** Host of a Gitea/Forgejo or GitLab instance, or of a web source's URL; null on GitHub. */
  host: string | null;
  /** `web` for a web source. */
  owner: string;
  /** Repository name, or the display name of a web source (e.g. "UniFi Network"). */
  name: string;
  /** The page versions are read from; non-null only for provider `web`. */
  webSource: WebSource | null;
  /** `owner/name` on GitHub, `host/owner/name` elsewhere. */
  fullName: string;
  url: string;
  /** Avatar of the owner (user or organization); null when the provider has none (GitLab). */
  avatarUrl: string | null;
  /** Custom icon as entered: an image URL or a selfh.st/icons shorthand (`sh:<slug>`); null = owner avatar. */
  icon: string | null;
  /** Image URLs of the custom icon, best first; empty without one. Shown before `avatarUrl`. */
  iconUrls: string[];
  /** Custom group on the Repositories page (`RepositoryGroup`); null = none. */
  groupId: number | null;
  includePrereleases: boolean;
  /** `releases` (newest by date) or `tags` (newest by version); not used by web sources. */
  releaseSource: ReleaseSourceKind;
  /** Regular expression tags must match; with tags its group picks the version. Null = none. */
  versionPattern: string | null;
  isEnabled: boolean;
  lastSeenTag: string | null;
  /** Page of the latest release or tag; null without one or for a version picked by a pattern from tags. */
  lastSeenUrl: string | null;
  lastSeenPublishedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  installedVersionUrl: string | null;
  /** Path (JSON) or CSS selector (HTML/XML) of the version; null = auto-detect / the whole response. */
  installedVersionField: string | null;
  /** How the version URL is read; null = auto (JSON or the first version in the text). */
  installedVersionFormat: WebSourceFormat | null;
  /** Regular expression that picks the version out of the located text; null = none. */
  installedVersionPattern: string | null;
  /** Header names only – values are secrets and never leave the server. */
  installedVersionHeaders: { name: string; hasValue: boolean }[];
  installedVersion: string | null;
  /** Where the installed version comes from: the version URL, entered by hand, an app on a machine, or nowhere. */
  installedVersionSource: InstalledVersionSource;
  /** The app on a machine the installed version is read from (source = machine). */
  installedVersionApp: InstalledVersionApp | null;
  installedVersionCheckedAt: string | null;
  installedVersionError: string | null;
  /** Versions advisories are compared with: the own installed version plus those of linked container apps. */
  installedVersions: string[];
  /** True when the latest release is newer than the installed version; null when unknown. */
  updateAvailable: boolean | null;
  /** The repository uses its own token instead of the global one (the token itself is never returned). */
  hasAccessToken: boolean;
  accessTokenMasked: string | null;
  /** OSV.dev package of the app (both set or both null). */
  osvEcosystem: string | null;
  osvPackage: string | null;
  /** Security advisories (GitHub, OSV.dev) published for the repository. */
  advisories: AdvisorySummary;
}

export type InstalledVersionSource = 'none' | 'url' | 'manual' | 'machine';

/** An app on a machine: an application of a target or a Docker container. */
export interface MachineAppRef {
  kind: 'app' | 'docker';
  id: number;
}

export interface InstalledVersionApp extends MachineAppRef {
  name: string;
  /** Name of the machine or Docker connection. */
  machine: string;
}

/** An app a repository can read its installed version from (`GET /api/machine-apps`). */
export interface MachineAppOption extends MachineAppRef {
  name: string;
  installedVersion: string | null;
  checkedAt: string | null;
  /** Repository the app is linked to; null = none. */
  repositoryId: number | null;
  /** `owner/name` of that repository. */
  repository: string | null;
}

/** A machine (target) or Docker connection with its apps. */
export interface MachineAppGroup {
  machine: { kind: 'target' | 'endpoint'; id: number; name: string };
  apps: MachineAppOption[];
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

export type AddRepositoryRequest = AddGitRepositoryRequest | AddWebSourceRequest;

export interface AddGitRepositoryRequest {
  /** `owner/repo` (GitHub) or the HTTPS URL of a GitHub, Gitea/Forgejo or GitLab repository. */
  repository: string;
  /** Provider of a host that is not well known; omitted = detected. */
  provider?: Exclude<RepositoryProvider, 'github' | 'web'> | null;
  includePrereleases: boolean;
  /** Releases (default) or tags. */
  releaseSource?: ReleaseSourceKind | null;
  versionPattern?: string | null;
  /** Token of the repository: a private one the global GitHub token cannot read, or one on another host. */
  accessToken?: string | null;
}

/** Watches the versions published on a web page, feed or JSON API. */
export interface AddWebSourceRequest {
  /** Display name, 1–100 characters (unique per host). */
  name: string;
  webSource: WebSource;
  versionPattern?: string | null;
  includePrereleases?: boolean;
}

/** `POST /api/web-sources/preview`: reads a web source without saving it. */
export interface WebSourcePreviewRequest {
  webSource: WebSource;
  versionPattern?: string | null;
  includePrereleases?: boolean;
}

export interface WebSourcePreviewRelease {
  version: string;
  title: string | null;
  publishedAt: string | null;
  url: string | null;
  isPrerelease: boolean;
}

export interface WebSourcePreview {
  contentType: string;
  /** Format the response looks like (may differ from the chosen one). */
  detectedFormat: WebSourceFormat;
  bytes: number;
  /** How the newest version is chosen: by date, or by version number when there are no dates. */
  order: 'date' | 'version';
  /** Found versions in document order (at most 50). */
  releases: WebSourcePreviewRelease[];
  newest: string | null;
}

export interface UpdateRepositoryRequest {
  includePrereleases: boolean;
  isEnabled: boolean;
  /** Omit to keep, null for releases. A change makes the next check set a new baseline without notifying. */
  releaseSource?: ReleaseSourceKind | null;
  /** Display name of a web source; omit to keep. */
  name?: string;
  /** Page of a web source; omit to keep. */
  webSource?: WebSource;
  /** Omit to keep, null to remove. */
  versionPattern?: string | null;
  /** Omit to keep, null to clear. */
  installedVersionUrl?: string | null;
  installedVersionField?: string | null;
  installedVersionFormat?: WebSourceFormat | null;
  installedVersionPattern?: string | null;
  installedVersionHeaders?: HeaderInput[] | null;
  /** Installed version entered by hand (only without a URL); omit to keep, null to clear. */
  installedVersion?: string | null;
  /** App on a machine to read the installed version from (it gets linked); omit to keep, null to stop. */
  installedVersionApp?: MachineAppRef | null;
  /** Omit to keep, null to remove the repository's own token. */
  accessToken?: string | null;
  /** OSV.dev package; omit to keep, null to remove. */
  osvEcosystem?: string | null;
  osvPackage?: string | null;
  /** Image URL or `sh:<slug>`; omit to keep, null for the owner avatar. */
  icon?: string | null;
  /** Custom group by name (created when new); omit to keep, null for none. */
  groupName?: string | null;
}

/** A custom group of repositories (GET /api/repository-groups); it exists while it has repositories. */
export interface RepositoryGroup {
  id: number;
  name: string;
  /** Custom icon as entered: an image URL or `sh:<slug>`; null = a folder. */
  icon: string | null;
  /** Image URLs of the custom icon, best first; empty without one. */
  iconUrls: string[];
  repositoryCount: number;
}

/** PUT /api/repository-groups/:id – omit to keep; `icon: null` for the folder again. */
export interface UpdateRepositoryGroupRequest {
  name?: string;
  icon?: string | null;
}

/** One icon of selfh.st/icons (from its `index.json`). */
export interface SelfhstIcon {
  name: string;
  /** Slug used in `sh:<reference>` and in the CDN paths. */
  reference: string;
  /** Has an SVG (all icons have PNG and WebP). */
  svg: boolean;
  /** Has `-light` / `-dark` variants. */
  light: boolean;
  dark: boolean;
  category: string;
  tags: string[];
}

/** A header sent to the server. `value: null` keeps the value already saved under that name. */
export interface HeaderInput {
  name: string;
  value: string | null;
}

/** How the version is found in the response of a version URL (`POST /api/installed-version/test`). */
export interface InstalledVersionLocator {
  /** null = auto. */
  format: WebSourceFormat | null;
  /** JSON path or CSS selector; null = auto-detect / the whole response. */
  field: string | null;
  pattern: string | null;
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
    /** Runs kept per container: checks and other runs (updates, upgrades, restarts) separately; null = all. UI only. */
    runHistoryChecks: number | null;
    runHistoryUpdates: number | null;
    minRunHistory: number;
    maxRunHistory: number;
  };
  /** Schedule of Docker endpoint listings and registry checks of Docker images. */
  docker: {
    checkCron: string;
    checkCronSource: SettingSource;
  };
  /** Schedule the update entities of the Home Assistant connections are read on. */
  homeAssistant: {
    checkCron: string;
    checkCronSource: SettingSource;
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
  /** ntfy, Gotify, Telegram, Slack, Pushover and the generic webhook. */
  channels: Record<ChannelName, ChannelSettings>;
  notifications: NotificationPreferences & { digestSource: SettingSource };
  /** Enabled sources of security advisories. */
  advisories: { github: boolean; osv: boolean; osvEcosystems: string[] };
}

export type ChannelName = 'ntfy' | 'gotify' | 'telegram' | 'slack' | 'pushover' | 'webhook';

/** Settings of one push channel, keyed by the setting name (e.g. `ntfyTopic`). */
export interface ChannelSettings {
  /** True when everything the channel needs is set. */
  configured: boolean;
  settings: Partial<Record<ChannelSettingKey, ChannelSettingValue>>;
  /** Webhook only: extra request headers (names only; the values are never returned). */
  headers?: { name: string; hasValue: boolean }[];
}

export interface ChannelSettingValue {
  /** The value, or a masked hint for a secret (`…abcd`); null when not set. */
  value: string | null;
  secret: boolean;
  configured: boolean;
  source: SettingSource;
}

export type ChannelSettingKey =
  | 'ntfyUrl'
  | 'ntfyTopic'
  | 'ntfyToken'
  | 'gotifyUrl'
  | 'gotifyToken'
  | 'telegramBotToken'
  | 'telegramChatId'
  | 'slackWebhookUrl'
  | 'pushoverUserKey'
  | 'pushoverAppToken'
  | 'webhookUrl'
  | 'webhookMethod';

/** `starttls`: port 587, upgraded with STARTTLS; `tls`: TLS from the start (465); `none`: unencrypted. */
export type SmtpSecurity = 'starttls' | 'tls' | 'none';

/** Which notifications are sent, and whether one check run sends one summary (digest). */
export interface NotificationPreferences {
  digest: boolean;
  releases: boolean;
  vulnerabilities: boolean;
  appUpdates: boolean;
  packageUpdates: boolean;
  updateSucceeded: boolean;
  updateFailed: boolean;
  /** Newer images of the tags Docker containers run. */
  dockerUpdates: boolean;
}

/** A storage on the node that accepts backups. */
export interface BackupStorage {
  name: string;
  type: string;
  status: string;
  availableBytes: number | null;
}

/** `undefined` keeps a value, `null` resets it to the environment default. */
export interface SettingsPatch extends Partial<Record<ChannelSettingKey, string | null>> {
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
  notifyPackageUpdates?: boolean | null;
  notifyUpdateSucceeded?: boolean | null;
  notifyUpdateFailed?: boolean | null;
  notifyDockerUpdates?: boolean | null;
  /** Replaces the webhook headers; a header with `value: null` keeps its saved value. */
  webhookHeaders?: HeaderInput[] | null;
  advisoriesGithub?: boolean | null;
  advisoriesOsv?: boolean | null;
  containerCheckCron?: string | null;
  dockerCheckCron?: string | null;
  homeAssistantCheckCron?: string | null;
  containerCheckConcurrency?: number | null;
  backupBeforeUpdate?: boolean | null;
  runHistoryChecks?: number | null;
  runHistoryUpdates?: number | null;
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
    avatarUrl: string | null;
    /** Custom icon of the repository, best first; empty without one. */
    iconUrls: string[];
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
  targets?: {
    total: number;
    enabled: number;
    withErrors: number;
    packagesPending: number;
    /** Pending Flatpak / Snap updates, one per store and machine. */
    appStorePending?: number;
    appUpdatesAvailable: number;
    homeAssistantUpdatesAvailable?: number;
  };
  /** Docker / Podman containers shown (not ignored) and those with a newer image or release. */
  docker?: {
    total: number;
    updatesAvailable: number;
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

export type AppStore = 'flatpak' | 'snap';

export interface AppStoreInfo {
  store: AppStore;
  /** "Flatpak", "Snap". */
  label: string;
  packages: PackageUpdate[];
}

export interface PackageUpdate {
  name: string;
  currentVersion: string | null;
  newVersion: string;
}

/** Where the newest available version of an application comes from. */
export type LatestSource = 'none' | 'repository' | 'command';

export interface ContainerApp {
  id: number;
  name: string;
  versionCommand: string | null;
  latestSource: LatestSource;
  repositoryId: number | null;
  repositoryFullName: string | null;
  /** Custom icon of the linked repository, best first; empty = none. */
  iconUrls: string[];
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

/** An application found in a container (`POST /api/targets/:id/detect-apps`) – a suggestion, not saved. */
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
  packagesOptional: boolean;
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

/** Operating system of a target, from `/etc/os-release`. */
/** apt (Debian, Ubuntu), dnf/yum (Fedora, RHEL family), zypper (openSUSE), apk (Alpine), pacman (Arch). */
export type PackageManager = 'apt' | 'dnf' | 'yum' | 'zypper' | 'apk' | 'pacman';

export interface OsRelease {
  /** debian, ubuntu, alpine, haos… */
  id: string | null;
  name: string | null;
  /** "12", "24.04"; null on Debian testing. */
  versionId: string | null;
  /** Debian point release ("12.8"); null elsewhere. */
  pointVersion: string | null;
  codename: string | null;
  prettyName: string | null;
  /** Proxmox VE version ("9.1.1"); only on a Proxmox node. */
  proxmoxVersion: string | null;
  /** For display: "Debian 12.8 (bookworm)", "Proxmox VE 9.1.1 · Debian 13.2 (trixie)". */
  label: string;
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
  packagesEnabled: boolean;
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
  packageUpdates: PackageUpdate[];
  /** Package manager found by the last check; null = not checked yet (or none found). */
  packageManager: PackageManager | null;
  /** Flatpak / Snap found by the last check (only installed ones), with their pending updates. */
  appStores: AppStoreInfo[];
  /** Why a restart is needed (last check); empty = none. */
  restartReasons: string[];
  /** Operating system read by the last check; null = not read yet. */
  os: OsRelease | null;
  /** Home Assistant OS of a virtual machine; null for containers and the host. */
  homeAssistant: HomeAssistantInfo | null;
  /** Docker / Podman containers are listed by checks; `engine` = runtime found by the last check (null = none). */
  docker: { enabled: boolean; engine: string | null; error: string | null };
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
  packagesEnabled: boolean;
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
  /** List Docker / Podman containers during checks. */
  dockerEnabled?: boolean;
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
  /** Installed version entered by hand (only without a version command); omit to keep, null to clear. */
  installedVersion?: string | null;
}

/** A container (`pct list`) or virtual machine (`qm list`) found on the node. */
export interface DiscoveredContainer {
  kind: 'lxc' | 'vm';
  vmid: number;
  status: string;
  name: string;
  added: boolean;
}

export type RunKind = 'check' | 'packages-upgrade' | 'app-update' | 'restart' | 'home-assistant-update' | 'flatpak-update' | 'snap-update';
export type RunStatus = 'running' | 'succeeded' | 'failed';

export interface RunSummary {
  id: number;
  targetId: number;
  appId: number | null;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

/** GET /api/targets/:id/runs – one page of the run history, newest first. */
export interface RunHistoryPage {
  items: RunSummary[];
  /** Cursor of the next page, or null on the last one. */
  nextCursor: string | null;
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
  /** False = the login screen has no password form (passkeys / single sign-on only). */
  passwordLogin: boolean;
  /** Name of the single sign-on provider when signing in with it works (set up and linked), otherwise null. */
  oidcLogin: string | null;
}

/** Single sign-on with an OpenID Connect provider (GET /api/auth/oidc). */
export interface OidcSettings {
  /** Issuer and client ID are set. */
  configured: boolean;
  issuer: string | null;
  issuerSource: SettingSource;
  clientId: string | null;
  clientIdSource: SettingSource;
  hasClientSecret: boolean;
  clientSecretMasked: string | null;
  clientSecretSource: SettingSource;
  name: string | null;
  nameSource: SettingSource;
  /** To register at the provider. */
  redirectUri: string;
  /** The identity at the provider that signs in to the account, or null. */
  link: { issuer: string; subject: string; label: string | null; linkedAt: string } | null;
}

/** PUT /api/auth/oidc – omitted = keep, null = back to the environment value. */
export interface OidcSettingsUpdate {
  currentPassword: string;
  issuer?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  name?: string | null;
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
  method: 'password' | 'passkey' | 'setup' | 'oidc';
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** The session of this browser. */
  current: boolean;
}

/** What an API token may do: `read` = GET only, `full` = everything except the account. */
export type ApiTokenScope = 'read' | 'full';

/** An API token for dashboards and scripts; its value is shown only once, when it is created. */
export interface ApiTokenInfo {
  id: number;
  name: string;
  scope: ApiTokenScope;
  /** Beginning of the token (`rw_` + 8 characters) to recognise it. */
  prefix: string;
  createdAt: string;
  /** null = never expires. */
  expiresAt: string | null;
  expired: boolean;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

/** POST /api/auth/api-tokens */
export interface NewApiToken {
  name: string;
  scope: ApiTokenScope;
  /** null = never expires. */
  expiresInDays: number | null;
}

export interface CreatedApiToken extends ApiTokenInfo {
  /** The full token – send it as `Authorization: Bearer …` or `X-API-Key: …`. */
  token: string;
}

/** PUT /api/auth/account – the current password is always required. */
export interface AccountUpdate {
  currentPassword: string;
  username?: string | null;
  newPassword?: string | null;
  /** False turns password sign-in off (needs a passkey); the current password still confirms changes. */
  passwordLogin?: boolean | null;
}

/** Providers whose instances can have a host token. */
export type GitHostProvider = 'gitea' | 'gitlab';

/**
 * The access token of a Gitea/Forgejo or GitLab instance: used by its repositories without a token of their own, sent
 * only to that host. The token itself never leaves the server.
 */
export interface GitHostToken {
  id: number;
  provider: GitHostProvider;
  /** Lower-case host with an optional port, e.g. `git.example.com:3000`. */
  host: string;
  tokenMasked: string | null;
  /** Watched repositories on the host without a token of their own – they use this one. */
  repositoryCount: number;
  createdAt: string;
  updatedAt: string;
}

/** POST / PUT /api/git-host-tokens – on PUT omitted = keep. */
export interface GitHostTokenInput {
  provider?: GitHostProvider;
  host?: string;
  token?: string | null;
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

/* ---------- Docker ---------- */

/** A Docker endpoint reached without SSH: a mounted socket, a socket proxy or a remote engine over TCP. */
export interface DockerEndpoint {
  id: number;
  name: string;
  /** `unix:///var/run/docker.sock`, `tcp://socket-proxy:2375`, `http(s)://…`. */
  url: string;
  isEnabled: boolean;
  /** Runtime and version from the last check ("docker 27.3.1"); null = not reached yet. */
  engine: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  isChecking: boolean;
}

export type DockerImageState = 'up-to-date' | 'update-available' | 'unknown';

/** A Docker / Podman container on a machine (target) or at a Docker endpoint. */
export interface DockerContainer {
  id: number;
  source: { kind: 'target' | 'endpoint'; id: number; name: string | null };
  name: string;
  image: string;
  /** Short image name (`nginx:1.27`). */
  imageDisplay: string;
  tag: string | null;
  state: string | null;
  /** false = not running any more (kept because it was ignored or linked by hand). */
  present: boolean;
  ignored: boolean;
  composeProject: string | null;
  composeService: string | null;
  /** null = unknown (floating tag without a version label that could not be resolved). */
  installedVersion: string | null;
  /** tag = image tag, label = image label, digest = registry tag with the same digest. */
  installedVersionSource: 'tag' | 'label' | 'digest' | null;
  /** Linked through its labels (true) or chosen by hand (false). */
  linkAuto: boolean;
  repository: { id: number; fullName: string; url: string; latestVersion: string | null; iconUrls: string[] } | null;
  /** Repository named by the labels that is not watched yet (`owner/name`, `host/owner/name` outside GitHub). */
  suggestedRepository: string | null;
  /** The linked repository has a newer release than the installed version; null = unknown. */
  updateAvailable: boolean | null;
  registry: {
    /** Registry digest of the same tag compared with the running image. */
    state: DockerImageState;
    /** Version tag of the newer image, when it could be resolved. */
    latestVersion: string | null;
    checkedAt: string | null;
    error: string | null;
    /** Why the state is unknown (pinned digest, local image, …). */
    note: string | null;
  };
}

export interface DockerOverview {
  endpoints: DockerEndpoint[];
  containers: DockerContainer[];
  /** Scheduled Docker run (endpoints and registry checks). */
  check: JobStatus;
}

export interface DockerEndpointRequest {
  name: string;
  url: string;
  isEnabled?: boolean;
}

/** Omitted = keep; `repositoryId` without `linkAuto` links by hand (null = no repository). */
export interface DockerContainerRequest {
  ignored?: boolean;
  linkAuto?: boolean;
  repositoryId?: number | null;
}

// --- Backup & restore (Settings → Backup) ---

/** Per-browser preferences the UI adds to a backup file (the server ignores them). */
export interface BackupAppearance {
  theme: string;
  accent: string;
  repositoryLayout: string;
  containerSort: string;
  /** Order of the sidebar pages (missing in files from older versions). */
  navOrder?: string[];
}

/** A backup file (`GET /api/backup/export`); secrets are never part of it. */
export interface BackupFile {
  format: string;
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  settings: Record<string, string | number | boolean>;
  repositories: { owner: string; name: string }[];
  hosts: { type: string; name: string; targets: { kind: string; name: string; apps: unknown[] }[] }[];
  dockerEndpoints: { name: string; url: string }[];
  /** Secrets that were configured but left out. */
  secretsOmitted: string[];
  /** Added by the UI when the user includes this browser's appearance. */
  appearance?: BackupAppearance;
}

export type ImportMode = 'merge' | 'replace';

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
  appVersion: string | null;
  exportedAt: string | null;
  sections: ImportSectionPreview[];
  secretsToReenter: string[];
  warnings: string[];
}

/** Response of `POST /api/backup/import`. */
export interface ImportResponse {
  applied: boolean;
  preview: ImportPreview;
}

/* ---------- Home Assistant ---------- */

/** A Home Assistant instance read through its REST API with a long-lived access token. */
export interface HomeAssistantConnection {
  id: number;
  name: string;
  /** Base URL, e.g. `http://homeassistant.local:8123`. */
  url: string;
  /** The access token, masked – it is never returned in full. */
  tokenMasked: string;
  isEnabled: boolean;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  isChecking: boolean;
}

/** An update entity of a connection that names a repository (Core, an add-on, an integration, a card …). */
export interface HomeAssistantComponent {
  id: number;
  connectionId: number;
  /** `update.…` */
  entityId: string;
  name: string;
  installedVersion: string | null;
  /** Newest version Home Assistant knows of. */
  latestVersion: string | null;
  releaseUrl: string | null;
  /** Repository the entity names, lower-case (`owner/name`, or `host/owner/name` outside GitHub). */
  repositoryName: string;
  /** False for a commit hash (a repository without releases). */
  versionComparable: boolean;
  /** Home Assistant knows a version other than the installed one. */
  homeAssistantUpdate: boolean;
}

export interface HomeAssistantOverview {
  connections: HomeAssistantConnection[];
  components: HomeAssistantComponent[];
  /** Scheduled run that reads the connections. */
  check: JobStatus;
}

/** `token` omitted or empty when editing = keep the saved one. */
export interface HomeAssistantConnectionRequest {
  name: string;
  url: string;
  token?: string | null;
  isEnabled?: boolean;
}
