import type { Logger } from './log.ts';
import type { RepositoryStore } from './db.ts';
import { fullName, selectNewReleases, type WatchedRepository } from './domain.ts';
import type { ReleaseSource } from './github.ts';
import type { NotificationDispatcher } from './notifiers/dispatcher.ts';
import { compareVersions, fetchInstalledVersion, type HttpHeader, type InstalledVersionResult } from './version.ts';

export type InstalledVersionFetcher = (
  url: string,
  field: string | null,
  headers: readonly HttpHeader[],
) => Promise<InstalledVersionResult>;

export interface CheckResult {
  notifiedCount: number;
  error: string | null;
}

/** Checks watched repositories for new releases, dispatches notifications and updates the baseline. */
export class ReleaseChecker {
  private readonly store: RepositoryStore;
  private readonly source: ReleaseSource;
  private readonly dispatcher: NotificationDispatcher;
  private readonly log: Pick<Logger, 'info' | 'warn'>;
  private readonly now: () => Date;
  private readonly fetchInstalled: InstalledVersionFetcher;

  constructor(deps: {
    store: RepositoryStore;
    source: ReleaseSource;
    dispatcher: NotificationDispatcher;
    log: Pick<Logger, 'info' | 'warn'>;
    now?: () => Date;
    fetchInstalledVersion?: InstalledVersionFetcher;
  }) {
    this.store = deps.store;
    this.source = deps.source;
    this.dispatcher = deps.dispatcher;
    this.log = deps.log;
    this.now = deps.now ?? (() => new Date());
    this.fetchInstalled = deps.fetchInstalledVersion ?? ((url, field, headers) => fetchInstalledVersion(url, field, headers));
  }

  /**
   * Reads the version of the self-hosted app (if configured). Failures are stored on the repository
   * but never block the release check.
   */
  async refreshInstalledVersion(repo: WatchedRepository): Promise<void> {
    if (!repo.installedVersionUrl) {
      repo.installedVersion = null;
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
      repo.installedVersionError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      this.log.warn({ repo: fullName(repo), err: error }, 'Reading installed version failed');
    }
    repo.installedVersionCheckedAt = this.now().toISOString();
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

  /** Checks a single repository. Mutates and persists the passed entity. */
  async check(repo: WatchedRepository): Promise<CheckResult> {
    let notifiedCount = 0;
    await this.refreshInstalledVersion(repo);
    try {
      const fetched = await this.source.getRecentReleases(repo.owner, repo.name, repo.etag, repo.githubToken);

      if (!fetched.notModified) {
        const { newReleases, newest } = selectNewReleases(repo, fetched.releases);

        for (const release of newReleases) {
          // Already running this version (or newer)? Then the release is not news.
          const alreadyInstalled = repo.installedVersion !== null && (compareVersions(release.tag, repo.installedVersion) ?? 1) <= 0;
          if (!alreadyInstalled) {
            await this.dispatcher.dispatch({
              owner: repo.owner,
              repository: repo.name,
              release,
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
      const message = error instanceof Error ? error.message : String(error);
      this.log.warn({ err: error, repo: fullName(repo) }, 'Checking repository failed');
      repo.lastError = message.slice(0, 1000);
    }

    this.store.save(repo);
    return { notifiedCount, error: repo.lastError };
  }
}
