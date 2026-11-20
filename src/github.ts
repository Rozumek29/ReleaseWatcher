import { normalizeSeverity, type SecurityAdvisory } from './advisories.ts';
import type { ReleaseInfo } from './domain.ts';

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

/** Fetches releases from a remote provider (GitHub today, possibly GitLab etc. later). */
export interface RateLimit {
  limit: number;
  remaining: number;
  /** ISO date when the limit resets. */
  resetAt: string;
}

export interface ReleaseSource {
  /** Current API quota, or null when the provider doesn't report one. */
  getRateLimit?(): Promise<RateLimit | null>;
  /** `token` overrides the global token for this repository (e.g. a private repository of another account). */
  repositoryExists(owner: string, name: string, token?: string | null): Promise<boolean>;
  /** Most recent published releases (drafts excluded). Pass the previous ETag to get a cheap 304. */
  getRecentReleases(owner: string, name: string, etag: string | null, token?: string | null): Promise<ReleaseFetchResult>;
  /** Published security advisories of the repository (withdrawn ones excluded). Optional: not every provider has them. */
  getSecurityAdvisories?(owner: string, name: string, etag: string | null, token?: string | null): Promise<AdvisoryFetchResult>;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

interface GitHubReleaseDto {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  author: { login: string; avatar_url: string | null } | null;
}

interface GitHubAdvisoryDto {
  ghsa_id: string;
  cve_id: string | null;
  html_url: string;
  summary: string | null;
  severity: string | null;
  cvss?: { score: number | null } | null;
  cvss_severities?: { cvss_v3?: { score: number | null } | null; cvss_v4?: { score: number | null } | null } | null;
  published_at: string | null;
  updated_at: string | null;
  withdrawn_at: string | null;
  vulnerabilities:
    | { package: { name: string | null } | null; vulnerable_version_range: string | null; patched_versions: string | null }[]
    | null;
}

/** Advisories read per repository (one page, newest first). */
const ADVISORIES_PER_PAGE = 100;

export interface GitHubOptions {
  apiBaseUrl: string;
  /** Static token or a getter (lets the token be changed from the UI at runtime). */
  token: string | null | (() => string | null);
  releasesPerPage: number;
  fetch?: typeof fetch;
}

/** {@link ReleaseSource} backed by the GitHub REST API. */
export class GitHubReleaseSource implements ReleaseSource {
  private readonly options: GitHubOptions;
  private readonly fetch: typeof fetch;

  constructor(options: GitHubOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async getRateLimit(): Promise<RateLimit | null> {
    // The /rate_limit endpoint itself does not count against the quota.
    const response = await this.request('/rate_limit');
    await ensureOk(response);
    const data = (await response.json()) as { resources?: { core?: { limit: number; remaining: number; reset: number } } };
    const core = data.resources?.core;
    return core ? { limit: core.limit, remaining: core.remaining, resetAt: new Date(core.reset * 1000).toISOString() } : null;
  }

  async repositoryExists(owner: string, name: string, token?: string | null): Promise<boolean> {
    const response = await this.request(this.repoPath(owner, name), {}, token);
    if (response.status === 404) {
      return false;
    }
    await ensureOk(response);
    return true;
  }

  async getRecentReleases(
    owner: string,
    name: string,
    etag: string | null,
    token?: string | null,
  ): Promise<ReleaseFetchResult> {
    const path = `${this.repoPath(owner, name)}/releases?per_page=${this.options.releasesPerPage}`;
    const response = await this.request(path, etag ? { 'If-None-Match': etag } : {}, token);

    if (response.status === 304) {
      return { releases: [], etag, notModified: true };
    }
    await ensureOk(response);

    const dtos = (await response.json()) as GitHubReleaseDto[];
    const releases = dtos
      .filter((d) => !d.draft && d.published_at)
      .map(
        (d): ReleaseInfo => ({
          tag: d.tag_name,
          name: d.name?.trim() ? d.name : null,
          htmlUrl: d.html_url,
          body: d.body,
          isPrerelease: d.prerelease,
          publishedAt: d.published_at!,
          authorLogin: d.author?.login ?? null,
          authorAvatarUrl: d.author?.avatar_url ?? null,
        }),
      );

    return { releases, etag: response.headers.get('etag'), notModified: false };
  }

  async getSecurityAdvisories(
    owner: string,
    name: string,
    etag: string | null,
    token?: string | null,
  ): Promise<AdvisoryFetchResult> {
    const path =
      `${this.repoPath(owner, name)}/security-advisories?state=published&sort=published&direction=desc&per_page=${ADVISORIES_PER_PAGE}`;
    const response = await this.request(path, etag ? { 'If-None-Match': etag } : {}, token);

    if (response.status === 304) {
      return { advisories: [], etag, notModified: true };
    }
    await ensureOk(response);

    const dtos = (await response.json()) as GitHubAdvisoryDto[];
    const advisories = dtos
      .filter((d) => !d.withdrawn_at && d.published_at)
      .map(
        (d): SecurityAdvisory => ({
          id: d.ghsa_id,
          source: 'github',
          aliases: [],
          cveId: d.cve_id ?? null,
          summary: d.summary?.trim() || d.ghsa_id,
          severity: normalizeSeverity(d.severity),
          cvssScore: d.cvss_severities?.cvss_v4?.score || d.cvss_severities?.cvss_v3?.score || d.cvss?.score || null,
          htmlUrl: d.html_url,
          publishedAt: d.published_at!,
          updatedAt: d.updated_at ?? null,
          vulnerabilities: (d.vulnerabilities ?? []).map((v) => ({
            packageName: v.package?.name ?? null,
            vulnerableRange: v.vulnerable_version_range?.trim() || null,
            patchedVersions: v.patched_versions?.trim() || null,
          })),
        }),
      );

    return { advisories, etag: response.headers.get('etag'), notModified: false };
  }

  private repoPath(owner: string, name: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  }

  /** `tokenOverride` (a repository's own token) wins over the global token. */
  private request(path: string, headers: Record<string, string> = {}, tokenOverride?: string | null): Promise<Response> {
    const token = tokenOverride || (typeof this.options.token === 'function' ? this.options.token() : this.options.token);
    return this.fetch(new URL(path, this.options.apiBaseUrl), {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ReleaseWatcher/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
  }
}

async function ensureOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const rateLimited = (response.status === 403 || response.status === 429) &&
    response.headers.get('x-ratelimit-remaining') === '0';
  const message = rateLimited
    ? 'GitHub API rate limit exceeded. Set GITHUB_TOKEN to raise the limit.'
    : `GitHub API returned ${response.status}: ${truncate(await response.text(), 300)}`;
  throw new GitHubApiError(message, response.status);
}

const truncate = (value: string, max: number): string => (value.length <= max ? value : `${value.slice(0, max)}…`);
