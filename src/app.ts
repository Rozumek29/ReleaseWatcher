import { resolve } from 'node:path';
import { APP_VERSION } from './app-version.ts';
import {
  advisoryImpact,
  installedVersions,
  OSV_ECOSYSTEMS,
  sortAdvisories,
  type AdvisorySeverity,
  type AdvisorySource,
  type AdvisorySummary,
  type SecurityAdvisory,
} from './advisories.ts';
import { AdvisoryImpacts } from './advisory-impacts.ts';
import { PUBLIC_ROUTES, authRoutes } from './auth/routes.ts';
import { AuthService, apiTokenFrom, requestContext, sessionTokenFrom } from './auth/service.ts';
import { AuthStore } from './auth/store.ts';
import { ReleaseChecker } from './checker.ts';
import { type AdvisoryCursor, type AdvisoryFilter, type RepositoryStore, SECRET_SETTING_KEYS } from './db.ts';
import { fullName, ICON_MAX_LENGTH, iconUrls, ownerAvatarUrl, parseRepositoryName, validateIcon, type WatchedRepository } from './domain.ts';
import type { ReleaseSource } from './github.ts';
import { errorMessage } from './errors.ts';
import { noStore, problem, validationProblem } from './http.ts';
import { createLogger, type Logger } from './log.ts';
import { CHANNEL_NAMES, CHANNEL_SETTINGS, MASK_VISIBLE_START } from './notifiers/channels.ts';
import { NotificationDispatcher } from './notifiers/dispatcher.ts';
import { parseWebhookHeaders } from './notifiers/webhook.ts';
import type { Notifier } from './notifiers/notifier.ts';
import type { OsvClient } from './osv.ts';
import { CronJob } from './cron-job.ts';
import { RunSequencer } from './run-sequencer.ts';
import { cachedByRevision } from './revision-cache.ts';
import { containerRoutes, containerStatus } from './proxmox/routes.ts';
import { ContainerScheduler } from './proxmox/scheduler.ts';
import { ContainerUpdater } from './proxmox/updater.ts';
import { ContainerService } from './proxmox/service.ts';
import type { NodeShell } from './proxmox/ssh.ts';
import { MAX_RUN_HISTORY, MIN_RUN_HISTORY } from './proxmox/domain.ts';
import { ContainerStore } from './proxmox/store.ts';
import { type KeyTool, SshKeygen } from './hosts/keys.ts';
import { hostRoutes } from './hosts/routes.ts';
import type { DockerEngine } from './docker/engine.ts';
import { OciRegistryClient, type RegistryClient } from './docker/registry.ts';
import { dockerRoutes } from './docker/routes.ts';
import { DockerService } from './docker/service.ts';
import { DockerStore } from './docker/store.ts';
import { seedNodeBackupStorage, seedProxmoxHost } from './hosts/seed.ts';
import { type ShellFactory, ShellPool } from './hosts/shells.ts';
import { HostStore } from './hosts/store.ts';
import {
  MAX_CHECK_CONCURRENCY,
  maskSecret,
  MIN_CHECK_CONCURRENCY,
  SettingsValidationError,
  type SettingsPatch,
  type SettingsService,
} from './settings.ts';
import { scanDirectory, StaticUi } from './static-ui.ts';
import { parseId, readBody, RequestValidationError, validate, type ObjectSchema, type Schema } from './validation.ts';
import {
  compareVersions,
  fetchInstalledVersion,
  type HttpHeader,
  InstalledVersionError,
  MAX_CUSTOM_HEADERS,
  validateHeaders,
  validateVersionUrl,
} from './version.ts';

/** Header as sent by the UI. A missing/null value means "keep the value already saved for this name". */
interface HeaderInput {
  name: string;
  value?: string | null;
}

const headersSchema: Schema = {
  type: 'array',
  nullable: true,
  maxItems: MAX_CUSTOM_HEADERS,
  items: {
    type: 'object',
    properties: { name: { type: 'string', maxLength: 100 }, value: { type: 'string', nullable: true, maxLength: 4000 } },
    required: ['name'],
  },
};

/** Merges submitted headers with saved ones so secrets don't have to be sent back to the UI. */
function resolveHeaders(input: readonly HeaderInput[], saved: readonly HttpHeader[]): HttpHeader[] | { error: string } {
  const result: HttpHeader[] = [];
  for (const header of input) {
    const name = header.name.trim();
    if (!name) {
      continue;
    }
    const value = header.value ?? saved.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    if (value === undefined) {
      return { error: `Enter a value for header "${name}".` };
    }
    result.push({ name, value: value.trim() });
  }
  return result;
}

export interface AppDeps {
  store: RepositoryStore;
  source: ReleaseSource;
  notifiers: readonly Notifier[];
  settings: SettingsService;
  /** Override for tests; defaults to a real HTTP fetch. */
  fetchInstalledVersion?: (
    url: string,
    field: string | null,
    headers: readonly HttpHeader[],
  ) => Promise<{ version: string; preview: string }>;
  /** OSV.dev client for security advisories of packages; without it OSV.dev is not queried. */
  osv?: OsvClient | null;
  /** Directory with the built Angular UI; skipped when missing. */
  publicDir?: string;
  /** UI files embedded in a compiled executable (URL path → embedded file); takes precedence over `publicDir`. */
  embeddedUi?: ReadonlyMap<string, string>;
  /** Defaults to an `info` level logger. */
  log?: Logger;
  /** Test double for every host's SSH shell (each host gets this one); defaults to `openShell`. */
  shell?: NodeShell;
  /** Opens the SSH shell of a host; defaults to the system `ssh` client (`SshShell`). */
  openShell?: ShellFactory;
  /** known_hosts file pinning the host keys (trust on first use); defaults to `./known_hosts`. */
  knownHostsFile?: string;
  /** `ssh-keygen` operations (key inspection, generation, forgetting host keys); tests pass a fake. */
  keyTool?: KeyTool;
  /** Pause before reconnecting to an update on the node after the SSH connection dropped (tests use 0). */
  reconnectDelayMs?: number;
  /** Pause between checks whether a container already sees CPU cores raised for an update (tests use 0). */
  resourcePollMs?: number;
  /** How long an update may wait at an interactive prompt before it is stopped (tests use a few ms). */
  promptIdleMs?: number;
  /** Downloads community-scripts scripts for app detection (tests pass a fake; defaults to GitHub). */
  fetchAppScript?: (slug: string) => Promise<string | null>;
  /** `fetch` for the Home Assistant REST API (tests pass a fake; defaults to the global `fetch`). */
  homeAssistantFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Pause between polls of Home Assistant during updates (tests use 0). */
  homeAssistantPollMs?: number;
  /** Wait after scheduling a machine reboot before polling it again, and the polling interval (tests use 0). */
  machineRestartWaitMs?: number;
  machinePollMs?: number;
  /** Container registries (digests and tags of Docker images); tests pass a fake. Defaults to the OCI registry API. */
  registry?: RegistryClient;
  /** Engine client of a Docker endpoint URL; tests pass a fake. Defaults to the Docker Engine API over HTTP/socket. */
  dockerEngine?: (url: string) => DockerEngine;
  /** Login. Defaults: sessions required, origin/RP ID from the request, X-Forwarded-For not trusted. */
  auth?: {
    /** false turns the session check off – only for tests of other features. */
    requireAuth?: boolean;
    /** PUBLIC_URL: pins the origin and the WebAuthn RP ID (e.g. https://watcher.example.com). */
    publicUrl?: string | null;
    /** TRUST_PROXY: take the client IP from X-Forwarded-For (only behind a reverse proxy). */
    trustProxy?: boolean;
    /** Directory for the setup-code file (null = only logged). */
    dataDir?: string | null;
    /** Creates the account from these credentials when none exists (former BASIC_AUTH_*). */
    bootstrap?: { username: string; password: string } | null;
  };
}

export interface App {
  checker: ReleaseChecker;
  /** Release checks on `releaseCheckCron`. Created but not started – call `releaseJob.start()`. */
  releaseJob: CronJob;
  /** Vulnerability checks on `advisoryCheckCron`. Created but not started – call `advisoryJob.start()`. */
  advisoryJob: CronJob;
  /** Docker endpoint and registry checks on `dockerCheckCron`. Created but not started – call `dockerJob.start()`. */
  dockerJob: CronJob;
  docker: DockerService;
  /** Created but not started – call `scheduler.start()`. */
  scheduler: ContainerScheduler;
  /** "Update all" of the containers page. */
  updater: ContainerUpdater;
  containers: ContainerService;
  auth: AuthService;
  log: Logger;
  /** Starts the HTTP server (`port: 0` picks a free port). */
  listen(options: { port: number; hostname: string }): Bun.Server<undefined>;
  /** Stops the poller and the HTTP server (if started). */
  close(): Promise<void>;
}

/** Public fields of a security advisory (without its impact on the installed versions). */
const advisoryFields = (a: SecurityAdvisory) => ({
  id: a.id,
  source: a.source,
  aliases: a.aliases,
  cveId: a.cveId,
  summary: a.summary,
  severity: a.severity,
  cvssScore: a.cvssScore,
  htmlUrl: a.htmlUrl,
  publishedAt: a.publishedAt,
  updatedAt: a.updatedAt,
  vulnerabilities: a.vulnerabilities.map((v) => ({
    packageName: v.packageName,
    vulnerableRange: v.vulnerableRange,
    patchedVersions: v.patchedVersions,
  })),
});

/** Public shape of a security advisory, with its impact on the installed versions. */
export const advisoryDto = (a: SecurityAdvisory, versions: readonly string[]) => {
  const impact = advisoryImpact(a, versions);
  return {
    ...advisoryFields(a),
    /** True when an installed version is affected, false when all are known to be safe, otherwise null. */
    affectsInstalled: impact.affects,
    affectedVersions: impact.affectedVersions,
  };
};

const IMPACT_FILTERS: Record<string, number> = { affecting: 2, unknown: 1, unaffected: 0 };
const SEVERITIES: readonly AdvisorySeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
const ADVISORY_SOURCES: readonly AdvisorySource[] = ['github', 'osv'];
export const ADVISORY_PAGE_SIZE = 50;
const MAX_ADVISORY_PAGE_SIZE = 200;

/** Filters of `GET /api/advisories` from the query string; "all" or a missing parameter = no filter. */
function advisoryFilterFrom(params: URLSearchParams): AdvisoryFilter {
  const filter: AdvisoryFilter = {};
  const impact = params.get('impact');
  if (impact && impact !== 'all') {
    const rank = IMPACT_FILTERS[impact];
    if (rank === undefined) {
      throw new RequestValidationError('impact must be all, affecting, unknown or unaffected.');
    }
    filter.impact = rank;
  }
  const severity = params.get('severity');
  if (severity && severity !== 'all') {
    if (!SEVERITIES.includes(severity as AdvisorySeverity)) {
      throw new RequestValidationError(`severity must be all, ${SEVERITIES.join(', ')}.`);
    }
    filter.severity = severity as AdvisorySeverity;
  }
  const source = params.get('source');
  if (source && source !== 'all') {
    if (!ADVISORY_SOURCES.includes(source as AdvisorySource)) {
      throw new RequestValidationError('source must be all, github or osv.');
    }
    filter.source = source as AdvisorySource;
  }
  const query = params.get('q')?.trim();
  if (query) {
    if (query.length > 200) {
      throw new RequestValidationError('q must be at most 200 characters.');
    }
    filter.query = query;
  }
  return filter;
}

function pageLimitFrom(value: string | null): number {
  if (value === null) {
    return ADVISORY_PAGE_SIZE;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ADVISORY_PAGE_SIZE) {
    throw new RequestValidationError(`limit must be a whole number from 1 to ${MAX_ADVISORY_PAGE_SIZE}.`);
  }
  return limit;
}

/** Opaque cursor: the sort key of the last advisory of a page, as base64url JSON. */
const encodeAdvisoryCursor = (c: AdvisoryCursor): string =>
  Buffer.from(JSON.stringify([c.impact, c.severityRank, c.publishedAt, c.repositoryId, c.advisoryId])).toString('base64url');

function decodeAdvisoryCursor(value: string): AdvisoryCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(parsed) && parsed.length === 5) {
      const [impact, severityRank, publishedAt, repositoryId, advisoryId] = parsed as unknown[];
      if (
        Number.isInteger(impact) &&
        Number.isInteger(severityRank) &&
        typeof publishedAt === 'string' &&
        Number.isInteger(repositoryId) &&
        typeof advisoryId === 'string'
      ) {
        return { impact: impact as number, severityRank: severityRank as number, publishedAt, repositoryId: repositoryId as number, advisoryId };
      }
    }
  } catch {
    // Reported below.
  }
  throw new RequestValidationError('cursor is not valid – load the list from the first page again.');
}

/** A repository without a version URL keeps the installed version entered by hand (`refreshInstalledVersion`). */
const installedVersionSource = (r: Pick<WatchedRepository, 'installedVersionUrl' | 'installedVersion'>): 'none' | 'url' | 'manual' =>
  r.installedVersionUrl ? 'url' : r.installedVersion ? 'manual' : 'none';

/** Longest installed version that can be entered by hand. */
const MANUAL_VERSION_MAX_LENGTH = 100;

/** Public shape of a watched repository (internal fields like the ETag are not exposed). */
export const toDto = (
  r: WatchedRepository,
  advisories: AdvisorySummary = { total: 0, affecting: 0, highestSeverity: null },
  linkedVersions: readonly (string | null)[] = [],
) => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  fullName: fullName(r),
  url: `https://github.com/${fullName(r)}`,
  avatarUrl: ownerAvatarUrl(r.owner),
  /** Custom icon as entered (URL or `sh:<slug>`); null = the owner's avatar. */
  icon: r.icon,
  /** Image URLs of the custom icon, best first (the UI falls back to `avatarUrl`). */
  iconUrls: iconUrls(r.icon),
  includePrereleases: r.includePrereleases,
  isEnabled: r.isEnabled,
  lastSeenTag: r.lastSeenTag,
  lastSeenPublishedAt: r.lastSeenPublishedAt,
  lastCheckedAt: r.lastCheckedAt,
  lastError: r.lastError,
  createdAt: r.createdAt,
  installedVersionUrl: r.installedVersionUrl,
  installedVersionField: r.installedVersionField,
  // Only names are exposed; values may contain credentials.
  installedVersionHeaders: r.installedVersionHeaders.map((h) => ({ name: h.name, hasValue: h.value.length > 0 })),
  installedVersion: r.installedVersion,
  /** Where the installed version comes from: the version URL, entered by hand, or nowhere. */
  installedVersionSource: installedVersionSource(r),
  installedVersionCheckedAt: r.installedVersionCheckedAt,
  installedVersionError: r.installedVersionError,
  /** Versions advisories are compared with: the own installed version plus those of linked container apps. */
  installedVersions: installedVersions(r.installedVersion, linkedVersions),
  // The repository's own token is a secret: only whether it is set and a masked hint.
  hasOwnToken: r.githubToken !== null,
  githubTokenMasked: maskSecret(r.githubToken, 4),
  /** True/false when both versions are known and comparable, otherwise null. */
  updateAvailable: (() => {
    const diff = compareVersions(r.lastSeenTag, r.installedVersion);
    return diff === null ? null : diff > 0;
  })(),
  osvEcosystem: r.osvEcosystem,
  osvPackage: r.osvPackage,
  advisories: {
    ...advisories,
    checkedAt: r.advisoriesCheckedAt,
    error: r.advisoriesError,
  },
});

const addRepositorySchema: ObjectSchema = {
  type: 'object',
  properties: {
    repository: { type: 'string' },
    includePrereleases: { type: 'boolean' },
    githubToken: { type: 'string', nullable: true, maxLength: 1000 },
  },
  required: ['repository'],
};

const updateRepositorySchema: ObjectSchema = {
  type: 'object',
  properties: {
    includePrereleases: { type: 'boolean' },
    isEnabled: { type: 'boolean' },
    installedVersionUrl: { type: 'string', nullable: true, maxLength: 2000 },
    installedVersionField: { type: 'string', nullable: true, maxLength: 200 },
    installedVersionHeaders: headersSchema,
    installedVersion: { type: 'string', nullable: true, maxLength: MANUAL_VERSION_MAX_LENGTH },
    githubToken: { type: 'string', nullable: true, maxLength: 1000 },
    osvEcosystem: { type: 'string', nullable: true, maxLength: 50 },
    osvPackage: { type: 'string', nullable: true, maxLength: 300 },
    icon: { type: 'string', nullable: true, maxLength: ICON_MAX_LENGTH },
  },
  required: ['includePrereleases', 'isEnabled'],
};

const testInstalledVersionSchema: ObjectSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', maxLength: 2000 },
    field: { type: 'string', nullable: true, maxLength: 200 },
    headers: headersSchema,
    repositoryId: { type: 'integer', nullable: true },
  },
  required: ['url'],
};

const settingsSchema: ObjectSchema = {
  type: 'object',
  properties: {
    discordWebhookUrl: { type: 'string', nullable: true },
    discordMention: { type: 'string', nullable: true },
    discordUsername: { type: 'string', nullable: true },
    githubToken: { type: 'string', nullable: true },
    releaseCheckCron: { type: 'string', nullable: true, maxLength: 200 },
    advisoryCheckCron: { type: 'string', nullable: true, maxLength: 200 },
    containerCheckCron: { type: 'string', nullable: true, maxLength: 200 },
    dockerCheckCron: { type: 'string', nullable: true, maxLength: 200 },
    containerCheckConcurrency: { type: 'integer', nullable: true },
    backupBeforeUpdate: { type: 'boolean', nullable: true },
    runHistoryChecks: { type: 'integer', nullable: true },
    runHistoryUpdates: { type: 'integer', nullable: true },
    smtpHost: { type: 'string', nullable: true, maxLength: 253 },
    smtpPort: { type: 'integer', nullable: true },
    smtpSecurity: { type: 'string', nullable: true, maxLength: 20 },
    smtpUsername: { type: 'string', nullable: true, maxLength: 500 },
    smtpPassword: { type: 'string', nullable: true, maxLength: 500 },
    emailFrom: { type: 'string', nullable: true, maxLength: 500 },
    emailTo: { type: 'string', nullable: true, maxLength: 5000 },
    ntfyUrl: { type: 'string', nullable: true, maxLength: 2000 },
    ntfyTopic: { type: 'string', nullable: true, maxLength: 64 },
    ntfyToken: { type: 'string', nullable: true, maxLength: 500 },
    gotifyUrl: { type: 'string', nullable: true, maxLength: 2000 },
    gotifyToken: { type: 'string', nullable: true, maxLength: 500 },
    telegramBotToken: { type: 'string', nullable: true, maxLength: 200 },
    telegramChatId: { type: 'string', nullable: true, maxLength: 64 },
    slackWebhookUrl: { type: 'string', nullable: true, maxLength: 2000 },
    pushoverUserKey: { type: 'string', nullable: true, maxLength: 64 },
    pushoverAppToken: { type: 'string', nullable: true, maxLength: 64 },
    webhookUrl: { type: 'string', nullable: true, maxLength: 2000 },
    webhookMethod: { type: 'string', nullable: true, maxLength: 10 },
    webhookHeaders: headersSchema,
    notificationDigest: { type: 'boolean', nullable: true },
    notifyReleases: { type: 'boolean', nullable: true },
    notifyVulnerabilities: { type: 'boolean', nullable: true },
    notifyAppUpdates: { type: 'boolean', nullable: true },
    notifyAptUpdates: { type: 'boolean', nullable: true },
    notifyUpdateSucceeded: { type: 'boolean', nullable: true },
    notifyUpdateFailed: { type: 'boolean', nullable: true },
    notifyDockerUpdates: { type: 'boolean', nullable: true },
    advisoriesGithub: { type: 'boolean', nullable: true },
    advisoriesOsv: { type: 'boolean', nullable: true },
  },
};

const testNotificationSchema: ObjectSchema = {
  type: 'object',
  properties: { notifier: { type: 'string', nullable: true, maxLength: 50 } },
};

/** The UI files to serve: the ones embedded into a compiled executable, else the files of `publicDir`. */
async function loadUi(deps: Pick<AppDeps, 'publicDir' | 'embeddedUi'>): Promise<StaticUi | null> {
  if (deps.embeddedUi?.has('/index.html')) {
    return StaticUi.load(deps.embeddedUi);
  }
  return deps.publicDir === undefined ? null : StaticUi.load(await scanDirectory(resolve(deps.publicDir)));
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const log = deps.log ?? createLogger('info');
  const dispatcher = new NotificationDispatcher(deps.notifiers, log, () => {
    const current = deps.settings.current;
    return {
      digest: current.notificationDigest,
      releases: current.notifyReleases,
      vulnerabilities: current.notifyVulnerabilities,
      appUpdates: current.notifyAppUpdates,
      aptUpdates: current.notifyAptUpdates,
      updateSucceeded: current.notifyUpdateSucceeded,
      updateFailed: current.notifyUpdateFailed,
      dockerUpdates: current.notifyDockerUpdates,
    };
  });
  const containerStore = new ContainerStore(deps.store.database, deps.store.secretBox, () => ({
    checks: deps.settings.current.runHistoryChecks,
    others: deps.settings.current.runHistoryUpdates,
  }));
  const dockerStore = new DockerStore(deps.store.database);
  /** Installed versions of the container apps and Docker containers linked to a repository. */
  const linkedVersions = (repositoryId: number): (string | null)[] => [
    ...containerStore.linkedAppVersions(repositoryId),
    ...dockerStore.linkedVersions(repositoryId),
  ];
  /** Installed versions of container apps and Docker containers per linked repository (compared with its advisories). */
  const linkedAppVersions = (): Map<number, (string | null)[]> => {
    const byRepository = new Map<number, (string | null)[]>();
    for (const { repositoryId, installedVersion } of [...containerStore.listAppVersions(), ...dockerStore.listLinkedVersions()]) {
      if (repositoryId !== null) {
        const versions = byRepository.get(repositoryId);
        if (versions) {
          versions.push(installedVersion);
        } else {
          byRepository.set(repositoryId, [installedVersion]);
        }
      }
    }
    return byRepository;
  };
  /** Stored impacts of the advisories on the installed versions; `refresh()` before reading summaries or pages. */
  const impacts = new AdvisoryImpacts(deps.store, linkedAppVersions);
  const checker = new ReleaseChecker({
    store: deps.store,
    source: deps.source,
    dispatcher,
    log,
    ...(deps.fetchInstalledVersion ? { fetchInstalledVersion: deps.fetchInstalledVersion } : {}),
    osv: deps.osv ?? null,
    advisorySources: () => ({ github: deps.settings.current.advisoriesGithub, osv: deps.settings.current.advisoriesOsv }),
    linkedVersions,
    advisoryCron: () => deps.settings.current.advisoryCheckCron,
  });
  const { store, source, settings } = deps;
  // Scheduled runs due in the same minute run one after another, as one digest: releases → vulnerabilities → containers.
  const sequencer = new RunSequencer({ batch: (task) => dispatcher.batch(task) });
  /** Reachable enabled containers whose apps show an older latest version than their linked repository (all, or one). */
  const staleLinkedContainerIds = (repositoryId?: number) =>
    containerStore.enabledIdsWithStaleLatest(repositoryId).filter((id) => {
      const container = containerStore.get(id);
      return container !== null && containers.shellFor(container).isConfigured;
    });
  const releaseJob = new CronJob({
    name: 'releases',
    // Releases found by a scheduled, startup or "check all" run update the linked container apps right away (same
    // digest), instead of waiting for the next container check.
    task: async (signal) => {
      await checker.checkAll(signal);
      const containerIds = signal.aborted ? [] : staleLinkedContainerIds();
      if (containerIds.length > 0) {
        await scheduler.checkMany(containerIds);
      }
    },
    cron: () => settings.current.releaseCheckCron,
    log,
    sequence: sequencer.slot(1),
  });
  const advisoryJob = new CronJob({
    name: 'vulnerabilities',
    task: (signal) => checker.checkAllAdvisories(signal),
    cron: () => settings.current.advisoryCheckCron,
    log,
    sequence: sequencer.slot(2),
  });
  settings.onChange(() => {
    releaseJob.reschedule();
    advisoryJob.reschedule();
    dockerJob.reschedule();
    // Lowered run history limits apply to every container right away.
    containerStore.pruneRuns();
  });

  const hostStore = new HostStore(store.database, store.secretBox);
  const keyTool = deps.keyTool ?? new SshKeygen();
  const knownHostsFile = deps.knownHostsFile ?? 'known_hosts';
  const testShell = deps.shell;
  const shells = new ShellPool({
    hosts: hostStore,
    knownHostsFile,
    ...(testShell ? { factory: () => testShell } : deps.openShell ? { factory: deps.openShell } : {}),
  });
  // Older versions kept one Proxmox node in the settings: move it into a host (once).
  await seedProxmoxHost({
    hosts: hostStore,
    legacy: settings.legacyProxmox(),
    clearLegacy: () => settings.clearLegacyProxmox(),
    keyTool,
    log,
  });
  // …and its global backup storage into the nodes without their own (once).
  seedNodeBackupStorage({
    hosts: hostStore,
    legacy: settings.legacyBackupStorage(),
    clearLegacy: () => settings.clearLegacyBackupStorage(),
    log,
  });
  const auth = new AuthService(new AuthStore(store.database), { dataDir: deps.auth?.dataDir ?? null, log });
  await auth.bootstrap(deps.auth?.bootstrap ?? null);
  auth.ensureSetupCode();
  const interrupted = containerStore.failInterruptedRuns();
  if (interrupted > 0) {
    log.warn({ count: interrupted }, 'Marked runs interrupted by a restart as failed');
  }
  const packed = containerStore.packFinishedOutputs();
  if (packed > 0) {
    log.info({ count: packed }, 'Compressed the output of earlier runs');
  }
  const docker = new DockerService({
    store: dockerStore,
    registry: deps.registry ?? new OciRegistryClient(),
    log,
    ...(deps.dockerEngine ? { engine: deps.dockerEngine } : {}),
    targetNames: () => containerStore.names(),
    notify: (notification) => dispatcher.dispatchDockerUpdates(notification),
  });
  const dockerJob = new CronJob({
    name: 'docker',
    task: (signal) => docker.checkAll(signal),
    cron: () => settings.current.dockerCheckCron,
    log,
    sequence: sequencer.slot(4),
  });
  const containers = new ContainerService({
    docker,
    containers: containerStore,
    repositories: store,
    shells,
    nodeHostId: () => hostStore.firstProxmoxHost()?.id ?? null,
    dispatcher,
    log,
    ...(deps.reconnectDelayMs === undefined ? {} : { reconnectDelayMs: deps.reconnectDelayMs }),
    ...(deps.resourcePollMs === undefined ? {} : { resourcePollMs: deps.resourcePollMs }),
    ...(deps.promptIdleMs === undefined ? {} : { promptIdleMs: deps.promptIdleMs }),
    ...(deps.fetchAppScript === undefined ? {} : { fetchAppScript: deps.fetchAppScript }),
    ...(deps.homeAssistantFetch === undefined ? {} : { homeAssistantFetch: deps.homeAssistantFetch }),
    ...(deps.homeAssistantPollMs === undefined ? {} : { homeAssistantPollMs: deps.homeAssistantPollMs }),
    ...(deps.machineRestartWaitMs === undefined ? {} : { machineRestartWaitMs: deps.machineRestartWaitMs }),
    ...(deps.machinePollMs === undefined ? {} : { machinePollMs: deps.machinePollMs }),
  });
  const scheduler = new ContainerScheduler({
    store: containerStore,
    service: containers,
    defaultCron: () => settings.current.containerCheckCron,
    concurrency: () => settings.current.containerCheckConcurrency,
    batch: (task) => dispatcher.batch(task),
    sequence: sequencer.slot(3),
    log,
  });
  const updater = new ContainerUpdater({ store: containerStore, service: containers, log });

  const settingsDto = () => {
    const current = settings.current;
    const nodes = hostStore.listProxmoxHosts().map((h) => ({
      id: h.id,
      name: h.name,
      configured: shells.forHost(h.id).isConfigured,
      backupStorage: h.backupStorage,
    }));
    return {
      discord: {
        webhookConfigured: !!current.discordWebhookUrl,
        webhookUrlMasked: maskSecret(current.discordWebhookUrl, 36),
        webhookSource: settings.sourceOf('discordWebhookUrl'),
        mention: current.discordMention,
        username: current.discordUsername,
      },
      github: {
        tokenConfigured: !!current.githubToken,
        tokenMasked: maskSecret(current.githubToken, 4),
        tokenSource: settings.sourceOf('githubToken'),
      },
      polling: {
        releaseCron: current.releaseCheckCron,
        releaseCronSource: settings.sourceOf('releaseCheckCron'),
        advisoryCron: current.advisoryCheckCron,
        advisoryCronSource: settings.sourceOf('advisoryCheckCron'),
      },
      proxmox: {
        // A Proxmox node is added (Settings → Connections) and has an SSH key.
        configured: nodes.some((n) => n.configured),
        /** Proxmox nodes guests can be added from (the first one is the default). */
        nodes,
        checkCron: current.containerCheckCron,
        checkCronSource: settings.sourceOf('containerCheckCron'),
        checkConcurrency: current.containerCheckConcurrency,
        checkConcurrencySource: settings.sourceOf('containerCheckConcurrency'),
        minCheckConcurrency: MIN_CHECK_CONCURRENCY,
        maxCheckConcurrency: MAX_CHECK_CONCURRENCY,
        backupBeforeUpdate: current.backupBeforeUpdate,
        backupBeforeUpdateSource: settings.sourceOf('backupBeforeUpdate'),
        // Set only in the UI (no env variable), so there is no source to show. null = keep all runs.
        runHistoryChecks: current.runHistoryChecks,
        runHistoryUpdates: current.runHistoryUpdates,
        minRunHistory: MIN_RUN_HISTORY,
        maxRunHistory: MAX_RUN_HISTORY,
      },
      docker: {
        checkCron: current.dockerCheckCron,
        checkCronSource: settings.sourceOf('dockerCheckCron'),
      },
      email: {
        configured: deps.notifiers.some((n) => n.name === 'email' && n.isEnabled),
        smtpHost: current.smtpHost,
        smtpHostSource: settings.sourceOf('smtpHost'),
        smtpPort: current.smtpPort,
        smtpSecurity: current.smtpSecurity,
        smtpUsername: current.smtpUsername,
        // The password itself is never returned.
        smtpPasswordConfigured: !!current.smtpPassword,
        smtpPasswordSource: settings.sourceOf('smtpPassword'),
        from: current.emailFrom,
        to: current.emailTo,
        toSource: settings.sourceOf('emailTo'),
      },
      // ntfy, Gotify, Telegram, Slack, Pushover and the generic webhook; secrets only masked.
      channels: Object.fromEntries(
        CHANNEL_NAMES.map((name) => [
          name,
          {
            configured: deps.notifiers.some((n) => n.name === name && n.isEnabled),
            // Names only: the values may hold credentials.
            ...(name === 'webhook'
              ? { headers: parseWebhookHeaders(current.webhookHeaders).map((h) => ({ name: h.name, hasValue: h.value.length > 0 })) }
              : {}),
            settings: Object.fromEntries(
              CHANNEL_SETTINGS[name].map((key) => {
                const value = current[key];
                const secret = SECRET_SETTING_KEYS.has(key);
                return [
                  key,
                  {
                    value: secret ? maskSecret(value, MASK_VISIBLE_START[key] ?? 0) : value,
                    secret,
                    configured: !!value,
                    source: settings.sourceOf(key),
                  },
                ];
              }),
            ),
          },
        ]),
      ),
      notifications: {
        digest: current.notificationDigest,
        digestSource: settings.sourceOf('notificationDigest'),
        releases: current.notifyReleases,
        vulnerabilities: current.notifyVulnerabilities,
        appUpdates: current.notifyAppUpdates,
        aptUpdates: current.notifyAptUpdates,
        updateSucceeded: current.notifyUpdateSucceeded,
        updateFailed: current.notifyUpdateFailed,
        dockerUpdates: current.notifyDockerUpdates,
      },
      advisories: {
        github: current.advisoriesGithub,
        osv: current.advisoriesOsv,
        osvEcosystems: OSV_ECOSYSTEMS,
      },
    };
  };

  /** Docker counts of the status summary – derived only from the database, so rebuilt only after a write. */
  const dockerStatus = cachedByRevision(
    () => store.revision(),
    () => {
      const shown = docker.describe(dockerStore.listContainers()).filter((c) => c.present && !c.ignored);
      return {
        total: shown.length,
        /** A newer image for the tag or a newer release of the linked repository. */
        updatesAvailable: shown.filter((c) => c.registry.state === 'update-available' || c.updateAvailable === true).length,
      };
    },
  );

  const statusDto = () => {
    const repositories = store.listStatusFields();
    return {
      version: APP_VERSION,
      poller: releaseJob.status,
      advisoryPoller: advisoryJob.status,
      repositories: {
        total: repositories.length,
        enabled: repositories.filter((r) => r.isEnabled).length,
        withErrors: repositories.filter((r) => r.lastError).length,
        updatesAvailable: repositories.filter((r) => (compareVersions(r.lastSeenTag, r.installedVersion) ?? 0) > 0).length,
      },
      containers: containerStatus(containerStore),
      docker: dockerStatus(),
      advisories: (() => {
        impacts.refresh();
        return store.advisoryTotals();
      })(),
    };
  };

  const findRepository = (rawId: string) => store.get(parseId(rawId));
  const repositoryDto = (repo: WatchedRepository) => {
    impacts.refresh();
    return toDto(repo, store.advisorySummaries(repo.id).get(repo.id), linkedVersions(repo.id));
  };
  /**
   * Body of the repository list, serialized again only after a database write (`store.revision()`): building it
   * decrypts the tokens of every repository. `impacts.refresh()` runs first, as it may write.
   */
  const repositoriesJson = cachedByRevision(
    () => store.revision(),
    () => {
      const summaries = store.advisorySummaries();
      const linked = linkedAppVersions();
      return JSON.stringify(store.list().map((r) => toDto(r, summaries.get(r.id), linked.get(r.id))));
    },
  );
  /** `GET /api/advisories`: one page (keyset pagination) plus, on the first page, the counts of the page header. */
  const listAdvisories = (req: Request) => {
    const params = new URL(req.url).searchParams;
    const filter = advisoryFilterFrom(params);
    const cursor = params.get('cursor');
    const after = cursor ? decodeAdvisoryCursor(cursor) : null;
    const limit = pageLimitFrom(params.get('limit'));
    impacts.refresh();
    const page = store.pageAdvisories(filter, after, limit);
    const linked = linkedAppVersions();
    const last = page.rows.at(-1);
    return Response.json({
      items: page.rows.map((row) => ({
        ...advisoryFields(row.advisory),
        affectsInstalled: row.affects,
        affectedVersions: row.affectedVersions,
        repository: {
          id: row.repository.id,
          fullName: fullName(row.repository),
          owner: row.repository.owner,
          url: `https://github.com/${fullName(row.repository)}`,
          avatarUrl: ownerAvatarUrl(row.repository.owner),
          iconUrls: iconUrls(row.repository.icon),
          installedVersion: row.repository.installedVersion,
          installedVersions: installedVersions(row.repository.installedVersion, linked.get(row.repository.id)),
        },
      })),
      nextCursor: page.hasMore && last ? encodeAdvisoryCursor(last.cursor) : null,
      // Counts are only needed with the first page; following pages skip the extra queries.
      total: after ? null : store.countAdvisories(filter),
      overview: after ? null : store.advisoryOverview(),
    });
  };
  const jsonBody = (body: string) => new Response(body, { headers: { 'content-type': 'application/json;charset=utf-8' } });

  const addRepository = async (req: Request) => {
    const body = await readBody<{ repository: string; includePrereleases?: boolean; githubToken?: string | null }>(
      req,
      addRepositorySchema,
    );
    const githubToken = body.githubToken?.trim() || null;
    const parsed = parseRepositoryName(body.repository);
    if (!parsed) {
      return validationProblem('repository', "Use the 'owner/repo' format or a https://github.com/owner/repo URL.");
    }

    const { owner, name } = parsed;
    if (store.exists(owner, name)) {
      return problem(409, `${owner}/${name} is already being watched.`);
    }

    try {
      if (!(await source.repositoryExists(owner, name, githubToken))) {
        return validationProblem(
          'repository',
          `Repository ${owner}/${name} was not found on GitHub. A private repository needs a token with access to it.`,
        );
      }
    } catch (error) {
      return problem(502, 'Bad Gateway', { detail: errorMessage(error) });
    }

    const repo = store.add(owner, name, body.includePrereleases ?? false);
    if (githubToken) {
      repo.githubToken = githubToken;
      store.save(repo);
    }
    // Establish the baseline right away so the UI shows the current latest release.
    await checker.check(repo);

    return Response.json(repositoryDto(repo), { status: 201, headers: { location: `/api/repositories/${repo.id}` } });
  };

  const updateRepository = async (req: Request, rawId: string) => {
    const repo = findRepository(rawId);
    const body = await readBody<{
      includePrereleases: boolean;
      isEnabled: boolean;
      installedVersionUrl?: string | null;
      installedVersionField?: string | null;
      installedVersionHeaders?: HeaderInput[] | null;
      /** Installed version entered by hand (only without a version URL); omit = keep, null/"" = none. */
      installedVersion?: string | null;
      /** Omit = keep, null/"" = remove (use the global token). */
      githubToken?: string | null;
      /** OSV.dev package; omit = keep, null/"" = none. Both are set together. */
      osvEcosystem?: string | null;
      osvPackage?: string | null;
      /** Image URL or `sh:<slug>`; omit = keep, null/"" = owner avatar. */
      icon?: string | null;
    }>(req, updateRepositorySchema);
    if (!repo) {
      return problem(404, 'Repository not found.');
    }
    const manualVersion = body.installedVersion === undefined ? undefined : body.installedVersion?.trim() || null;
    const finalUrl = body.installedVersionUrl === undefined ? repo.installedVersionUrl : body.installedVersionUrl?.trim() || null;
    if (manualVersion && finalUrl) {
      return validationProblem('installedVersion', 'Remove the version URL to enter the installed version by hand.');
    }
    const icon = body.icon === undefined ? undefined : body.icon?.trim() || null;
    const iconError = icon ? validateIcon(icon) : null;
    if (iconError) {
      return validationProblem('icon', iconError);
    }
    if (icon !== undefined) {
      repo.icon = icon;
    }
    if (repo.includePrereleases !== body.includePrereleases) {
      // Filter changed: force a full fetch on the next check.
      repo.etag = null;
    }
    if (body.githubToken !== undefined) {
      const token = body.githubToken?.trim() || null;
      if (token !== repo.githubToken) {
        repo.githubToken = token;
        // Another token may see different data.
        repo.etag = null;
        repo.advisoriesEtag = null;
      }
    }
    repo.includePrereleases = body.includePrereleases;
    repo.isEnabled = body.isEnabled;

    // Installed-version settings are optional in the body: undefined = keep, null/"" = clear.
    const { installedVersionUrl, installedVersionField, installedVersionHeaders } = body;
    if (installedVersionUrl !== undefined || installedVersionField !== undefined || installedVersionHeaders !== undefined) {
      const url = installedVersionUrl === undefined ? repo.installedVersionUrl : installedVersionUrl?.trim() || null;
      const field = installedVersionField === undefined ? repo.installedVersionField : installedVersionField?.trim() || null;
      const urlError = url ? validateVersionUrl(url) : null;
      if (urlError) {
        return validationProblem('installedVersionUrl', urlError);
      }
      let headers = repo.installedVersionHeaders;
      if (installedVersionHeaders !== undefined) {
        const resolved = resolveHeaders(installedVersionHeaders ?? [], repo.installedVersionHeaders);
        const headerError = 'error' in resolved ? resolved.error : validateHeaders(resolved);
        if (headerError) {
          return validationProblem('installedVersionHeaders', headerError);
        }
        headers = resolved as HttpHeader[];
      }
      const changed =
        url !== repo.installedVersionUrl ||
        field !== repo.installedVersionField ||
        JSON.stringify(headers) !== JSON.stringify(repo.installedVersionHeaders);
      if (!url && repo.installedVersionUrl) {
        // The version read from the removed URL is not one the user entered.
        repo.installedVersion = null;
      }
      repo.installedVersionUrl = url;
      repo.installedVersionField = field;
      repo.installedVersionHeaders = headers;
      if (changed) {
        await checker.refreshInstalledVersion(repo);
      }
    }
    if (manualVersion !== undefined && !repo.installedVersionUrl) {
      repo.installedVersion = manualVersion;
    }

    let osvChanged = false;
    if (body.osvEcosystem !== undefined || body.osvPackage !== undefined) {
      const ecosystem = body.osvEcosystem === undefined ? repo.osvEcosystem : body.osvEcosystem?.trim() || null;
      const name = body.osvPackage === undefined ? repo.osvPackage : body.osvPackage?.trim() || null;
      if (ecosystem && !(OSV_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
        return validationProblem('osvEcosystem', `Choose one of: ${OSV_ECOSYSTEMS.join(', ')}.`);
      }
      if (!ecosystem !== !name) {
        return validationProblem(ecosystem ? 'osvPackage' : 'osvEcosystem', 'Set both the ecosystem and the package name, or neither.');
      }
      osvChanged = ecosystem !== repo.osvEcosystem || name !== repo.osvPackage;
      repo.osvEcosystem = ecosystem;
      repo.osvPackage = name;
    }
    if (osvChanged) {
      // Read the new package right away (its first read only sets the baseline).
      await checker.refreshAdvisories(repo);
    }

    store.save(repo);
    return Response.json(repositoryDto(repo));
  };

  // Sets the installed version entered by hand to the latest release ("Mark as installed").
  const markRepositoryInstalled = (rawId: string) => {
    const repo = findRepository(rawId);
    if (!repo) {
      return problem(404, 'Repository not found.');
    }
    if (repo.installedVersionUrl) {
      return problem(409, 'The installed version is read from the version URL – remove it to set the version by hand.');
    }
    if (!repo.lastSeenTag) {
      return problem(409, 'No release of this repository is known yet.');
    }
    repo.installedVersion = repo.lastSeenTag;
    store.save(repo);
    return Response.json(repositoryDto(repo));
  };

  // Tries an installed-version URL without saving it (used by the "Test" button in the UI).
  // `repositoryId` lets headers without a value reuse the secret saved for that repository.
  const testInstalledVersion = async (req: Request) => {
    const body = await readBody<{ url: string; field?: string | null; headers?: HeaderInput[] | null; repositoryId?: number | null }>(
      req,
      testInstalledVersionSchema,
    );
    const urlError = validateVersionUrl(body.url.trim());
    if (urlError) {
      return validationProblem('installedVersionUrl', urlError);
    }
    const saved = body.repositoryId ? (store.get(body.repositoryId)?.installedVersionHeaders ?? []) : [];
    const resolved = resolveHeaders(body.headers ?? [], saved);
    const headerError = 'error' in resolved ? resolved.error : validateHeaders(resolved);
    if (headerError) {
      return validationProblem('installedVersionHeaders', headerError);
    }
    try {
      return Response.json(
        await (deps.fetchInstalledVersion ?? fetchInstalledVersion)(body.url.trim(), body.field?.trim() || null, resolved as HttpHeader[]),
      );
    } catch (error) {
      if (error instanceof InstalledVersionError) {
        return problem(422, error.message);
      }
      throw error;
    }
  };

  const updateSettings = async (req: Request) => {
    const { webhookHeaders, ...body } = await readBody<Omit<SettingsPatch, 'webhookHeaders'> & { webhookHeaders?: HeaderInput[] | null }>(
      req,
      settingsSchema,
    );
    const patch: SettingsPatch = body;
    if (webhookHeaders !== undefined) {
      // Headers sent without a value keep the saved one (values are never sent to the UI).
      const resolved = resolveHeaders(webhookHeaders ?? [], parseWebhookHeaders(settings.current.webhookHeaders));
      if ('error' in resolved) {
        return validationProblem('webhookHeaders', resolved.error);
      }
      patch.webhookHeaders = resolved.length > 0 ? JSON.stringify(resolved) : null;
    }
    try {
      settings.update(patch);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return validationProblem(error.field, error.message);
      }
      throw error;
    }
    return Response.json(settingsDto());
  };

  // Login: every route except PUBLIC_ROUTES needs a session or an API token (the API can run commands as root on the node).
  const requireAuth = deps.auth?.requireAuth ?? true;
  const context = (req: Request, server: Bun.Server<undefined>) =>
    requestContext(req, server.requestIP(req)?.address ?? null, {
      publicUrl: deps.auth?.publicUrl ?? null,
      trustProxy: deps.auth?.trustProxy ?? false,
    });
  const signedIn = (req: Request) => auth.sessionFromToken(sessionTokenFrom(req)) !== null;
  /**
   * Access to a protected route: a signed-in browser session, or an API token (`Authorization: Bearer` /
   * `X-API-Key`) for dashboards and scripts. A `read` token only reads (GET/HEAD); no token reaches the account
   * routes (/api/auth/*). Returns null when allowed, otherwise the problem response.
   */
  const denied = (req: Request, server: Bun.Server<undefined>, path: string): Response | null => {
    if (signedIn(req)) {
      return null;
    }
    const value = apiTokenFrom(req);
    if (!value) {
      return problem(401, 'Sign in first.');
    }
    const token = auth.apiTokenFromValue(value, context(req, server).ip);
    if (!token) {
      return problem(401, 'The API token is invalid, expired or revoked.');
    }
    if (path.startsWith('/api/auth/')) {
      return problem(403, 'API tokens cannot manage the account – sign in instead.');
    }
    if (token.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD') {
      return problem(403, 'This API token can only read – use a token with full access to change data.');
    }
    return null;
  };
  /**
   * CSRF defence on top of SameSite=Strict cookies: browsers send Origin with every state-changing request,
   * and it must be this site. Requests without Origin (curl, scripts) carry no browser cookies anyway.
   */
  const sameOrigin = (req: Request): boolean => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      return true;
    }
    const origin = req.headers.get('origin');
    if (!origin) {
      return true;
    }
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    const hosts = [req.headers.get('x-forwarded-host')?.split(',')[0]?.trim(), req.headers.get('host'), new URL(req.url).host];
    if (deps.auth?.publicUrl) {
      hosts.push(new URL(deps.auth.publicUrl).host);
    }
    return hosts.includes(originHost);
  };
  /** Wraps every route handler with the origin and session checks; /health stays public for health checks. */
  const protect = <R extends string>(routes: Bun.Serve.Routes<undefined, R>): Bun.Serve.Routes<undefined, R | '/health'> => {
    type AnyHandler = (req: Request, server: Bun.Server<undefined>) => Response | Promise<Response>;
    const guard =
      (path: string, handler: AnyHandler): AnyHandler =>
      async (req, server) => {
        if (!sameOrigin(req)) {
          return noStore(problem(403, 'Cross-site request refused.'));
        }
        const refused = requireAuth && !PUBLIC_ROUTES.has(path) ? denied(req, server, path) : null;
        if (refused) {
          return noStore(refused);
        }
        // API responses are per-user, live data: never let a browser or proxy cache them.
        return noStore(await handler(req, server));
      };
    const wrapped: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(routes)) {
      wrapped[path] =
        typeof value === 'function'
          ? guard(path, value as AnyHandler)
          : value && typeof value === 'object' && !(value instanceof Response) && !('dir' in value)
            ? Object.fromEntries(
                Object.entries(value).map(([method, h]) => [method, typeof h === 'function' ? guard(path, h as AnyHandler) : h]),
              )
            : value;
    }
    wrapped['/health'] = { GET: () => Response.json({ status: 'ok' }) };
    return wrapped as Bun.Serve.Routes<undefined, R | '/health'>;
  };

  // Angular UI + SPA fallback (see static-ui.ts); everything else (incl. unknown /api routes) is a 404 problem.
  const ui = await loadUi(deps);
  const fallback = (req: Request, server: Bun.Server<undefined>) => {
    const { pathname } = new URL(req.url);
    if (ui && (req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
      return ui.respond(req, pathname);
    }
    return noStore((requireAuth ? denied(req, server, pathname) : null) ?? problem(404, 'Not found.'));
  };

  let server: Bun.Server<undefined> | null = null;

  const listen = (options: { port: number; hostname: string }) => {
    server = Bun.serve({
      port: options.port,
      hostname: options.hostname,
      routes: protect({
        ...authRoutes({ auth, context }),
        ...containerRoutes({
          containers: containerStore,
          repositories: store,
          service: containers,
          scheduler,
          updater,
          backupDefaults: (hostId) => ({
            storage: hostId === null ? null : (hostStore.getHost(hostId)?.backupStorage ?? null),
            enabled: settings.current.backupBeforeUpdate,
          }),
          isProxmoxHost: (hostId) => hostStore.getHost(hostId)?.type === 'proxmox',
          hostName: (hostId) => hostStore.getHost(hostId)?.name ?? null,
          onDockerDisabled: (container) => docker.clearTarget(container),
          // A server's host exists only for its one target: removing the server removes the connection too.
          onTargetDeleted: (container) => {
            if (container.kind === 'server' && container.hostId !== null) {
              hostStore.deleteHost(container.hostId);
              shells.remove(container.hostId);
            }
          },
        }),
        ...dockerRoutes({ store: dockerStore, repositories: store, service: docker, job: dockerJob }),
        ...hostRoutes({
          hosts: hostStore,
          shells,
          keyTool,
          knownHostsFile,
          log,
          // The first Proxmox node takes over containers saved while none was configured.
          onHostAdded: (host) => {
            if (host.type === 'proxmox' && hostStore.firstProxmoxHost()?.id === host.id) {
              hostStore.adoptUnassignedTargets(host.id);
            }
            // A server is watched as soon as it is added (checked right away when it has a key).
            if (host.type === 'server') {
              const target = containerStore.addServer(host.id, host.name);
              if (containers.shellFor(target).isConfigured) containers.startCheck(target, 'manual');
            }
          },
          onHostUpdated: (host, previous) => {
            const target = host.type === 'server' ? containerStore.getServer(host.id) : null;
            if (target && target.name === previous.name && host.name !== previous.name) {
              target.name = host.name;
              containerStore.save(target);
            }
          },
          beforeDeleteHost: (host) => {
            const target = host.type === 'server' ? containerStore.getServer(host.id) : null;
            if (!target) return null;
            if (containers.isBusy(target.id) || updater.isQueued(target.id)) {
              return `A task is running on ${host.name} – wait for it to finish.`;
            }
            containerStore.delete(target.id);
            return null;
          },
        }),

        '/api/repositories': {
          GET: () => {
            impacts.refresh();
            return jsonBody(repositoriesJson());
          },
          POST: addRepository,
        },
        '/api/repositories/:id': {
          GET: (req) => {
            const repo = findRepository(req.params.id);
            return repo ? Response.json(repositoryDto(repo)) : problem(404, 'Repository not found.');
          },
          PUT: (req) => updateRepository(req, req.params.id),
          DELETE: (req) =>
            store.delete(parseId(req.params.id)) ? new Response(null, { status: 204 }) : problem(404, 'Repository not found.'),
        },
        '/api/repositories/:id/mark-installed': {
          POST: (req) => markRepositoryInstalled(req.params.id),
        },
        '/api/repositories/:id/check': {
          POST: async (req) => {
            const repo = findRepository(req.params.id);
            if (!repo) {
              return problem(404, 'Repository not found.');
            }
            const result = await checker.check(repo, { forceAdvisories: true });
            // A new release changes the latest version of linked container apps: check those containers in the background.
            const containerIds = staleLinkedContainerIds(repo.id);
            if (containerIds.length > 0) {
              scheduler.checkMany(containerIds).catch((error: unknown) =>
                log.error({ err: error, repo: fullName(repo) }, 'Checking linked containers failed'),
              );
            }
            return Response.json({
              repository: repositoryDto(repo),
              notifiedCount: result.notifiedCount + result.advisoryCount,
              containerChecks: containerIds.length,
            });
          },
        },
        // Security advisories of all repositories (Vulnerabilities page), newest first.
        '/api/advisories': {
          GET: listAdvisories,
        },
        // Security advisories of the repository, newest first.
        '/api/repositories/:id/advisories': {
          GET: (req) => {
            const repo = findRepository(req.params.id);
            if (!repo) {
              return problem(404, 'Repository not found.');
            }
            const versions = installedVersions(repo.installedVersion, linkedVersions(repo.id));
            return Response.json(sortAdvisories(store.listAdvisories(repo.id)).map((a) => advisoryDto(a, versions)));
          },
        },

        '/api/installed-version/test': { POST: testInstalledVersion },

        '/api/notifiers': {
          GET: () => Response.json(deps.notifiers.map((n) => ({ name: n.name, isEnabled: n.isEnabled }))),
        },
        // Sends a fake release to every enabled notifier (or only `notifier`) to verify the configuration.
        '/api/notifiers/test': {
          POST: async (req) => {
            // The body is optional: without it every enabled channel is tested.
            const text = await req.text();
            const body = text.trim() ? (validate(parseJson(text), testNotificationSchema, 'body') as { notifier?: string | null }) : {};
            const name = body.notifier ?? undefined;
            if (name !== undefined && !deps.notifiers.some((n) => n.name === name && n.isEnabled)) {
              return problem(409, 'Channel not configured', { detail: `The ${name} channel is not configured.` });
            }
            return Response.json(
              await dispatcher.test({
                owner: 'releasewatcher',
                repository: 'test',
                release: {
                  tag: 'v0.0.0-test',
                  name: 'Test notification',
                  htmlUrl: 'https://github.com',
                  body: 'If you can read this, ReleaseWatcher can reach this channel. 🎉',
                  isPrerelease: false,
                  publishedAt: new Date().toISOString(),
                  authorLogin: null,
                  authorAvatarUrl: null,
                },
              }, name),
            );
          },
        },

        '/api/settings': {
          GET: () => Response.json(settingsDto()),
          PUT: updateSettings,
        },

        '/api/status': { GET: () => Response.json(statusDto()) },
        // Public: lets ReleaseWatcher itself (or any monitor) read the running version without a session.
        '/api/version': { GET: () => Response.json({ version: APP_VERSION }) },
        // Checks all enabled repositories right away.
        '/api/check-all': {
          POST: async () => {
            await releaseJob.runNow();
            return Response.json(statusDto());
          },
        },

        '/api/github/rate-limit': {
          GET: async () => {
            try {
              return Response.json((await source.getRateLimit?.()) ?? null);
            } catch (error) {
              return problem(502, 'Bad Gateway', { detail: errorMessage(error) });
            }
          },
        },
      }),
      fetch: fallback,
      error: (error) => {
        if (error instanceof RequestValidationError) {
          return validationProblem('request', error.message);
        }
        log.error({ err: error }, 'Request failed');
        return problem(500, 'An unexpected error occurred.');
      },
    });
    return server;
  };

  const close = async () => {
    await Promise.all([releaseJob.stop(), advisoryJob.stop(), dockerJob.stop()]);
    await scheduler.stop();
    await updater.stop();
    await server?.stop();
    server = null;
    await containers.idle();
    await docker.idle();
    shells.dispose();
  };

  return { checker, releaseJob, advisoryJob, dockerJob, docker, scheduler, updater, containers, auth, log, listen, close };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestValidationError('body must be valid JSON');
  }
}
