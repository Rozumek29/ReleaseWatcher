import { releasePageUrl, type ReleaseInfo, type RepositoryRef } from './domain.ts';
import {
  ensureJson,
  instanceRequest,
  isJson,
  releaseOrder,
  TAGS_PER_PAGE,
  type InstanceOptions,
  type ReleaseFetchResult,
  type ReleaseQuery,
  type ReleaseSource,
} from './release-source.ts';
import { isPrereleaseTag } from './version.ts';

interface GiteaReleaseDto {
  tag_name: string;
  name: string | null;
  html_url: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string | null;
  created_at: string | null;
  author: { login: string; avatar_url: string | null } | null;
}

interface GiteaTagDto {
  name: string;
  message?: string | null;
  commit?: { created?: string | null } | null;
}

/**
 * {@link ReleaseSource} for Gitea and Forgejo instances (Codeberg, code.forgejo.org, self-hosted): both share the
 * `/api/v1/repos/{owner}/{repo}/releases` API. Only the repository's own token is sent – never GitHub's.
 */
export class GiteaReleaseSource implements ReleaseSource {
  private readonly options: InstanceOptions;
  private readonly fetch: typeof fetch;

  constructor(options: InstanceOptions) {
    this.options = options;
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  async repositoryExists(repo: RepositoryRef, token?: string | null): Promise<boolean> {
    const response = await this.request(repo, '', token);
    if (response.status === 404 || (response.ok && !isJson(response))) {
      return false;
    }
    await ensureJson(response, label(repo));
    return true;
  }

  async getRecentReleases(repo: ReleaseQuery, etag: string | null, token?: string | null): Promise<ReleaseFetchResult> {
    const tags = repo.releaseSource === 'tags';
    const path = tags ? `/tags?limit=${TAGS_PER_PAGE}` : `/releases?limit=${this.options.releasesPerPage}`;
    const response = await this.request(repo, path, token, etag);
    const order = releaseOrder(repo);
    if (response.status === 304) {
      return { releases: [], etag, notModified: true, order };
    }
    await ensureJson(response, label(repo));
    if (tags) {
      const dtos = (await response.json()) as GiteaTagDto[];
      const releases = dtos.map(
        (d): ReleaseInfo => ({
          tag: d.name,
          name: null,
          htmlUrl: releasePageUrl(repo, d.name),
          body: d.message?.trim() || null,
          isPrerelease: isPrereleaseTag(d.name),
          publishedAt: d.commit?.created ? new Date(d.commit.created).toISOString() : '',
          authorLogin: null,
          authorAvatarUrl: null,
        }),
      );
      return { releases, etag: response.headers.get('etag'), notModified: false, order };
    }
    const dtos = (await response.json()) as GiteaReleaseDto[];
    const releases = dtos
      .filter((d) => !d.draft && (d.published_at || d.created_at))
      .map(
        (d): ReleaseInfo => ({
          tag: d.tag_name,
          name: d.name?.trim() ? d.name : null,
          htmlUrl: d.html_url,
          body: d.body?.trim() ? d.body : null,
          isPrerelease: d.prerelease,
          publishedAt: new Date((d.published_at || d.created_at)!).toISOString(),
          authorLogin: d.author?.login ?? null,
          authorAvatarUrl: d.author?.avatar_url ?? null,
        }),
      );
    return { releases, etag: response.headers.get('etag'), notModified: false, order };
  }

  private request(repo: RepositoryRef, path: string, token?: string | null, etag: string | null = null): Promise<Response> {
    const url = `https://${repo.host}/api/v1/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${path}`;
    return instanceRequest(this.fetch, url, token ? { Authorization: `token ${token}` } : {}, etag);
  }
}

const label = (repo: RepositoryRef): string => `Gitea/Forgejo (${repo.host})`;
