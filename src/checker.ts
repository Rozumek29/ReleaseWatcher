import {
  advisoriesDue,
  advisoryImpact,
  advisoryKeys,
  installedVersions,
  sourceKey,
  type AdvisoryImpact,
  type AdvisorySource,
  type SecurityAdvisory,
} from './advisories.ts';
import { type CronSchedule, parseCron } from './cron.ts';
import type { Logger } from './log.ts';
import type { RepositoryStore } from './db.ts';
import { fullName, MAX_NOTIFICATIONS_PER_CHECK, selectNewReleases, type WatchedRepository } from './domain.ts';
import type { ReleaseSource } from './github.ts';
import { errorMessage } from './errors.ts';
import type { NotificationDispatcher } from './notifiers/dispatcher.ts';
import type { OsvClient } from './osv.ts';
import { compareVersions, fetchInstalledVersion, type HttpHeader, type InstalledVersionResult } from './version.ts';

export type InstalledVersionFetcher = (
  url: string,
  field: string | null,
  headers: readonly HttpHeader[],
) => Promise<InstalledVersionResult>;

export interface CheckResult {
  /** Releases newer than the baseline found by this check (notified or not – e.g. already installed). */
  newReleaseCount: number;
  /** Notifications about new releases. */
  notifiedCount: number;
  /** Notifications about new security advisories. */
  advisoryCount: number;
  error: string | null;
}

export interface AdvisorySourceSettings {
  github: boolean;
  osv: boolean;
}

/** Waits for a promise without throwing, so requests started together can be awaited one after another. */
const settle = <T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/** Checks watched repositories for new releases, dispatches notifications and updates the baseline. */
export class ReleaseChecker {
  private readonly store: RepositoryStore;
  private readonly source: ReleaseSource;
  private readonly dispatcher: NotificationDispatcher;
  private readonly log: Pick<Logger, 'info' | 'warn'>;
  private readonly now: () => Date;
  private readonly fetchInstalled: InstalledVersionFetcher;
  private readonly osv: OsvClient | null;
  private readonly advisorySources: () => AdvisorySourceSettings;
  private readonly linkedVersions: (repositoryId: number) => (string | null)[];
  private readonly advisoryCron: () => string;
  private advisorySchedule: { expression: string; schedule: CronSchedule | null } | null = null;

  constructor(deps: {
    store: RepositoryStore;
    source: ReleaseSource;
    dispatcher: NotificationDispatcher;
    log: Pick<Logger, 'info' | 'warn'>;
    now?: () => Date;
    fetchInstalledVersion?: InstalledVersionFetcher;
    /** OSV.dev client; without it OSV.dev is never queried. */
    osv?: OsvClient | null;
    /** Enabled advisory sources (Settings); read on every check. Default: all. */
    advisorySources?: () => AdvisorySourceSettings;
    /** Installed versions of container apps linked to a repository; compared with its advisories. Default: none. */
    linkedVersions?: (repositoryId: number) => (string | null)[];
    /** Cron schedule of vulnerability checks (Settings); decides which advisories are due. Default: every 6 hours. */
    advisoryCron?: () => string;
  }) {
    this.store = deps.store;
    this.source = deps.source;
    this.dispatcher = deps.dispatcher;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
    this.fetchInstalled = deps.fetchInstalledVersion ?? ((url, field, headers) => fetchInstalledVersion(url, field, headers));
    this.osv = deps.osv ?? null;
    this.advisorySources = deps.advisorySources ?? (() => ({ github: true, osv: true }));
    this.linkedVersions = deps.linkedVersions ?? (() => []);
    this.advisoryCron = deps.advisoryCron ?? (() => '0 */6 * * *');
  }

  /** Parsed vulnerability check schedule (null when the expression is invalid). */
  private currentAdvisorySchedule(): CronSchedule | null {
    const expression = this.advisoryCron();
    if (this.advisorySchedule?.expression !== expression) {
      let schedule: CronSchedule | null = null;
      try {
        schedule = parseCron(expression);
      } catch (error) {
        this.log.warn({ err: error, expression }, 'Invalid vulnerability check schedule');
      }
      this.advisorySchedule = { expression, schedule };
    }
    return this.advisorySchedule.schedule;
  }

  /**
   * Reads the version of the self-hosted app (if configured). Failures are stored on the repository
   * but never block the release check. Without a URL the installed version is the one entered by hand (or none) and is kept.
   */
  async refreshInstalledVersion(repo: WatchedRepository): Promise<void> {
    if (!repo.installedVersionUrl) {
      repo.installedVersionError = null;
      repo.installedVersionCheckedAt = null;
      return;
    }
    try {
      const { version } = await this.fetchInstalled(
        repo.installedVersionUrl,
        repo.installedVersionField,
        repo.installedVersionHeaders,
      );
      repo.installedVersion = version;
      repo.installedVersionError = null;
    } catch (error) {
      repo.installedVersionError = errorMessage(error).slice(0, 500);
      this.log.warn({ repo: fullName(repo), err: error }, 'Reading installed version failed');
    }
    repo.installedVersionCheckedAt = this.now().toISOString();
  }

  /**
   * Refreshes the security advisories of all enabled repositories that are due (a scheduled time of the vulnerability
   * check schedule passed since their last read) as one run. Missed runs are caught up, e.g. after a restart.
   */
  async checkAllAdvisories(signal?: AbortSignal): Promise<void> {
    await this.dispatcher.batch(async () => {
      const schedule = this.currentAdvisorySchedule();
      for (const repo of this.store.listEnabled()) {
        if (signal?.aborted) {
          return;
        }
        if (advisoriesDue(repo.advisoriesCheckedAt, schedule, this.now())) {
          await this.refreshAdvisories(repo);
          this.store.save(repo);
        }
      }
    });
  }

  /** Checks all enabled repositories as one run (in digest mode its notifications go out as one summary). */
  async checkAll(signal?: AbortSignal): Promise<void> {
    await this.dispatcher.batch(async () => {
      for (const repo of this.store.listEnabled()) {
        if (signal?.aborted) {
          return;
        }
        await this.check(repo);
      }
    });
  }

  /**
   * Reads the security advisories of a repository from the enabled sources, stores them and
   * notifies about new ones that may affect the installed version. The first read of each source (GitHub, an OSV.dev
   * package) only establishes a baseline. A disabled source drops its advisories. Failures are stored in
   * `advisoriesError` and never fail the release check. Returns the number of notifications.
   */
  async refreshAdvisories(repo: WatchedRepository): Promise<number> {
    const enabled = this.advisorySources();
    const errors: string[] = [];
    const baselines = new Set<string>();
    let notified = 0;

    const osv = this.osv;
    const osvPackage = repo.osvEcosystem && repo.osvPackage ? { ecosystem: repo.osvEcosystem, name: repo.osvPackage } : null;
    // OSV.dev is asked while GitHub is read; its result is filtered once GitHub's advisories are stored.
    const osvQuery =
      enabled.osv && osv && osvPackage ? settle(osv.queryPackage(osvPackage.ecosystem, osvPackage.name)) : null;

    const githubKey = sourceKey('github');
    if (enabled.github && this.source.getSecurityAdvisories) {
      try {
        const fetched = await this.source.getSecurityAdvisories(repo.owner, repo.name, repo.advisoriesEtag, repo.githubToken);
        if (!fetched.notModified) {
          notified += await this.storeAdvisories(repo, 'github', githubKey, fetched.advisories, notified);
          repo.advisoriesEtag = fetched.etag;
        }
        baselines.add(githubKey);
      } catch (error) {
        errors.push(`GitHub: ${errorMessage(error)}`);
        if (repo.advisoryBaselines.includes(githubKey)) {
          baselines.add(githubKey);
        }
      }
    } else {
      this.store.removeAdvisoriesExcept(repo.id, 'github');
      repo.advisoriesEtag = null;
    }

    if (osvQuery && osvPackage) {
      const osvKey = sourceKey('osv', osvPackage);
      try {
        const fetched = await osvQuery;
        if (!fetched.ok) {
          throw fetched.error;
        }
        // Vulnerabilities GitHub already reported (same GHSA/CVE) are not listed twice.
        const github = new Set(this.store.listAdvisoryKeys(repo.id, 'github').flatMap(advisoryKeys));
        const advisories = fetched.value.filter((a) => !advisoryKeys(a).some((key) => github.has(key)));
        notified += await this.storeAdvisories(repo, 'osv', osvKey, advisories, notified);
        baselines.add(osvKey);
      } catch (error) {
        errors.push(`OSV.dev: ${errorMessage(error)}`);
        if (repo.advisoryBaselines.includes(osvKey)) {
          baselines.add(osvKey);
        }
      }
    } else {
      this.store.removeAdvisoriesExcept(repo.id, 'osv');
    }

    repo.advisoryBaselines = [...baselines];
    repo.advisoriesCheckedAt = this.now().toISOString();
    repo.advisoriesError = errors.length > 0 ? errors.join(' ').slice(0, 1000) : null;
    if (errors.length > 0) {
      this.log.warn({ repo: fullName(repo), errors }, 'Reading security advisories failed');
    }
    if (notified > 0) {
      this.log.info({ repo: fullName(repo), count: notified }, 'New security advisories found');
    }
    return notified;
  }

  /** Stores the advisories read from one source and notifies about new ones; returns the number of notifications. */
  private async storeAdvisories(
    repo: WatchedRepository,
    source: AdvisorySource,
    key: string,
    advisories: readonly SecurityAdvisory[],
    alreadyNotified: number,
  ): Promise<number> {
    const isBaseline = !repo.advisoryBaselines.includes(key);
    const known = this.store.advisoryIds(repo.id);
    const versions = installedVersions(repo.installedVersion, this.linkedVersions(repo.id));
    const news: { advisory: SecurityAdvisory; impact: AdvisoryImpact }[] = [];
    const quiet: SecurityAdvisory[] = [];
    // Oldest first, so notifications arrive in publication order.
    for (const advisory of advisories.toSorted((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt))) {
      const impact = advisoryImpact(advisory, versions);
      // Not news when the running version is known to be outside the vulnerable ranges.
      if (
        !known.has(advisory.id) &&
        !isBaseline &&
        impact.affects !== false &&
        alreadyNotified + news.length < MAX_NOTIFICATIONS_PER_CHECK
      ) {
        news.push({ advisory, impact });
      } else {
        quiet.push(advisory);
      }
    }
    // Advisories without a notification are stored at once (one transaction); the others each right after their
    // notification went out, so a crash mid-way neither repeats nor loses one.
    this.store.saveAdvisories(repo.id, quiet, this.now());
    this.store.removeAdvisoriesExcept(repo.id, source, advisories.map((a) => a.id));
    for (const { advisory, impact } of news) {
      const shownVersions = impact.affects === true ? impact.affectedVersions : versions;
      await this.dispatcher.dispatchVulnerability({
        owner: repo.owner,
        repository: repo.name,
        advisory,
        icon: repo.icon,
        installedVersion: shownVersions.length > 0 ? shownVersions.join(', ') : null,
        affectsInstalled: impact.affects,
      });
      this.store.saveAdvisory(repo.id, advisory, this.now());
    }
    return news.length;
  }

  /**
   * Checks a single repository. Mutates and persists the passed entity. Security advisories are fetched on the first
   * check and with `forceAdvisories` (manual check); otherwise they follow their own schedule ({@link checkAllAdvisories}).
   */
  async check(repo: WatchedRepository, options: { forceAdvisories?: boolean } = {}): Promise<CheckResult> {
    let notifiedCount = 0;
    let newReleaseCount = 0;
    // The installed version and the releases are read at the same time; both are needed before comparing them.
    const [, releases] = await Promise.all([
      this.refreshInstalledVersion(repo),
      settle(this.source.getRecentReleases(repo.owner, repo.name, repo.etag, repo.githubToken)),
    ]);
    try {
      if (!releases.ok) {
        throw releases.error;
      }
      const fetched = releases.value;

      if (!fetched.notModified) {
        const { newReleases, newest } = selectNewReleases(repo, fetched.releases);
        newReleaseCount = newReleases.length;

        for (const release of newReleases) {
          // Already running this version (or newer)? Then the release is not news.
          const alreadyInstalled = repo.installedVersion !== null && (compareVersions(release.tag, repo.installedVersion) ?? 1) <= 0;
          if (!alreadyInstalled) {
            await this.dispatcher.dispatch({
              owner: repo.owner,
              repository: repo.name,
              release,
              icon: repo.icon,
              installedVersion: repo.installedVersion,
            });
            notifiedCount++;
          }
          // Advance the baseline per release, so a crash mid-way does not cause duplicates.
          repo.lastSeenTag = release.tag;
          repo.lastSeenPublishedAt = release.publishedAt;
          this.store.save(repo);
        }

        if (newest && (repo.lastSeenPublishedAt === null || Date.parse(newest.publishedAt) > Date.parse(repo.lastSeenPublishedAt))) {
          repo.lastSeenTag = newest.tag;
          repo.lastSeenPublishedAt = newest.publishedAt;
        }
        repo.etag = fetched.etag;
      }

      repo.lastCheckedAt = this.now().toISOString();
      repo.lastError = null;

      if (notifiedCount > 0) {
        this.log.info({ repo: fullName(repo), count: notifiedCount }, 'New releases found');
      }
    } catch (error) {
      const message = errorMessage(error);
      this.log.warn({ err: error, repo: fullName(repo) }, 'Checking repository failed');
      repo.lastError = message.slice(0, 1000);
    }
    const advisoryCount =
      options.forceAdvisories || repo.advisoriesCheckedAt === null ? await this.refreshAdvisories(repo) : 0;

    this.store.save(repo);
    return { newReleaseCount, notifiedCount, advisoryCount, error: repo.lastError };
  }
}
