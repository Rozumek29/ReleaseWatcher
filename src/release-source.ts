import type { SecurityAdvisory } from './advisories.ts';
import { fullName, PROVIDER_LABELS, type ReleaseInfo, type RepositoryProvider, type RepositoryRef } from './domain.ts';

export interface ReleaseFetchResult {
  releases: ReleaseInfo[];
  etag: string | null;
  notModified: boolean;
}

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

/** Fetches releases from a remote provider (GitHub, Gitea/Forgejo, GitLab). */
export interface ReleaseSource {
  /** Current API quota (GitHub), or null when the provider doesn't report one. */
  getRateLimit?(): Promise<RateLimit | null>;
  /** `token` is the repository's own token (on GitHub it overrides the global token). */
  repositoryExists(repo: RepositoryRef, token?: string | null): Promise<boolean>;
  /** Most recent published releases (drafts excluded). Pass the previous ETag to get a cheap 304. */
  getRecentReleases(repo: RepositoryRef, etag: string | null, token?: string | null): Promise<ReleaseFetchResult>;
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

  getRecentReleases(repo: RepositoryRef, etag: string | null, token?: string | null): Promise<ReleaseFetchResult> {
    return this.sources[repo.provider].getRecentReleases(repo, etag, token);
  }

  getSecurityAdvisories(repo: RepositoryRef, etag: string | null, token?: string | null): Promise<AdvisoryFetchResult> {
    const source = this.sources[repo.provider];
    if (!source.getSecurityAdvisories) {
      return Promise.reject(new Error(`${PROVIDER_LABELS[repo.provider]} has no security advisories (${fullName(repo)}).`));
    }
    return source.getSecurityAdvisories(repo, etag, token);
  }
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
