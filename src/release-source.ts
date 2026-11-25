import type { SecurityAdvisory } from './advisories.ts';
import {
  fullName,
  PROVIDER_LABELS,
  type ReleaseInfo,
  type RepositoryProvider,
  type RepositoryRef,
  type WatchedRepository,
} from './domain.ts';
import { matchPattern } from './pattern.ts';
import { isPrereleaseTag, looksLikeVersionTag, parseVersion } from './version.ts';

/**
 * A repository and what of it is read: releases (default) or tags, filtered by an optional version pattern; for a web
 * source (provider `web`) the page and its locators.
 */
export type ReleaseQuery = RepositoryRef & Partial<Pick<WatchedRepository, 'releaseSource' | 'versionPattern' | 'webSource'>>;

export interface ReleaseFetchResult {
  releases: ReleaseInfo[];
  etag: string | null;
  notModified: boolean;
  /** How the newest release is found: by publication date (releases) or by version (tags). */
  order: 'date' | 'version';
}

/** Tags read per repository (one page). */
export const TAGS_PER_PAGE = 100;

/** `order` of a query's results. */
export const releaseOrder = (query: Pick<ReleaseQuery, 'releaseSource'>): ReleaseFetchResult['order'] =>
  query.releaseSource === 'tags' ? 'version' : 'date';

/** A tag name as a URL path (moved to `domain.ts`; kept here for imports of it). */
export { tagPath } from './domain.ts';

export interface AdvisoryFetchResult {
  advisories: SecurityAdvisory[];
  etag: string | null;
  notModified: boolean;
}

export interface RateLimit {
  limit: number;
  remaining: number;
  /** ISO date when the limit resets. */
  resetAt: string;
}

/** Fetches releases from a remote provider (GitHub, Gitea/Forgejo, GitLab) or a web source. */
export interface ReleaseSource {
  /** Current API quota (GitHub), or null when the provider doesn't report one. */
  getRateLimit?(): Promise<RateLimit | null>;
  /** `token` is the repository's own token (on GitHub it overrides the global token). */
  repositoryExists(repo: RepositoryRef, token?: string | null): Promise<boolean>;
  /**
   * Most recent published releases (drafts excluded) or, with `releaseSource: 'tags'`, tags as releases. Pass the
   * previous ETag to get a cheap 304. The version pattern is applied by {@link ProviderReleaseSource}.
   */
  getRecentReleases(repo: ReleaseQuery, etag: string | null, token?: string | null): Promise<ReleaseFetchResult>;
  /** Published security advisories of the repository (withdrawn ones excluded). Optional: only GitHub has them. */
  getSecurityAdvisories?(repo: RepositoryRef, etag: string | null, token?: string | null): Promise<AdvisoryFetchResult>;
}

/** An API answered with an error status. */
export class ReleaseSourceError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ReleaseSourceError';
    this.status = status;
  }
}

/** Asks the source of each repository's provider: GitHub's for GitHub, the instance clients for the others. */
export class ProviderReleaseSource implements ReleaseSource {
  private readonly sources: Readonly<Record<RepositoryProvider, ReleaseSource>>;

  constructor(sources: Readonly<Record<RepositoryProvider, ReleaseSource>>) {
    this.sources = sources;
  }

  getRateLimit(): Promise<RateLimit | null> {
    return this.sources.github.getRateLimit?.() ?? Promise.resolve(null);
  }

  repositoryExists(repo: RepositoryRef, token?: string | null): Promise<boolean> {
    return this.sources[repo.provider].repositoryExists(repo, token);
  }

  async getRecentReleases(repo: ReleaseQuery, etag: string | null, token?: string | null): Promise<ReleaseFetchResult> {
    const result = await this.sources[repo.provider].getRecentReleases(repo, etag, token);
    // A web source applies its pattern while reading the page.
    return repo.provider === 'web' ? result : applyVersionPattern(result, repo);
  }

  getSecurityAdvisories(repo: RepositoryRef, etag: string | null, token?: string | null): Promise<AdvisoryFetchResult> {
    const source = this.sources[repo.provider];
    if (!source.getSecurityAdvisories) {
      return Promise.reject(new Error(`${PROVIDER_LABELS[repo.provider]} has no security advisories (${fullName(repo)}).`));
    }
    return source.getSecurityAdvisories(repo, etag, token);
  }
}

/**
 * Skips releases/tags whose tag does not match the query's version pattern. With tags, the version the pattern picks
 * becomes the tag shown and compared (the URL keeps the real tag); without a pattern only tags that look like a version
 * are kept ({@link looksLikeVersionTag} – not `build-20231010`). Throws `PatternError` when the pattern is invalid or
 * too slow.
 */
export async function applyVersionPattern(result: ReleaseFetchResult, query: ReleaseQuery): Promise<ReleaseFetchResult> {
  const tags = query.releaseSource === 'tags';
  if (result.notModified || (!query.versionPattern && !tags)) {
    return result;
  }
  if (!query.versionPattern) {
    return { ...result, releases: result.releases.filter((r) => looksLikeVersionTag(r.tag)) };
  }
  const matches = await matchPattern(query.versionPattern, result.releases.map((r) => r.tag));
  const releases = result.releases.flatMap((release, i): ReleaseInfo[] => {
    const version = matches[i]?.[0];
    if (version === undefined) {
      return [];
    }
    return tags ? [{ ...release, ...pickedVersion(release, version) }] : [release];
  });
  return { ...result, releases };
}

/**
 * The version a pattern picked from a tag. `matchPattern()` already keeps a pre-release suffix right after the group
 * (`^v(\d+\.\d+\.\d+)` on `v2.0.0-rc1` → `2.0.0-rc1`); when the group ends elsewhere (`^v(\d+)\.` → `2`) and the tag
 * is still a pre-release, the tag's suffix is added here (`2-rc1`) – otherwise the stable version would compare equal to
 * it and never be announced.
 */
function pickedVersion(release: ReleaseInfo, version: string): Pick<ReleaseInfo, 'tag' | 'isPrerelease'> {
  if (isPrereleaseTag(version)) {
    return { tag: version, isPrerelease: true };
  }
  const suffix = parseVersion(release.tag)?.prerelease ?? '';
  return suffix ? { tag: `${version}-${suffix}`, isPrerelease: true } : { tag: version, isPrerelease: release.isPrerelease };
}

/** Shared request options of the instance clients. */
export interface InstanceOptions {
  releasesPerPage: number;
  fetch?: typeof fetch;
}

/** GET of an instance API (JSON); `etag` makes it conditional. */
export function instanceRequest(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  etag: string | null = null,
): Promise<Response> {
  return fetcher(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'ReleaseWatcher/1.0',
      ...(etag ? { 'If-None-Match': etag } : {}),
      ...headers,
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });
}

/** True when the response is a JSON document (a web server answering any path with HTML is not an API). */
export const isJson = (response: Response): boolean => /\bjson\b/i.test(response.headers.get('content-type') ?? '');

/** Throws a {@link ReleaseSourceError} for an error status or a response that is not JSON. */
export async function ensureJson(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    throw new ReleaseSourceError(`${label} API returned ${response.status}: ${truncate(await response.text(), 300)}`, response.status);
  }
  if (!isJson(response)) {
    throw new ReleaseSourceError(`${label} API did not answer with JSON – is this the right host and provider?`, response.status);
  }
}

export const truncate = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max)}…`);
