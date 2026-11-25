import { releasePageUrl, repositoryUrl, type ReleaseInfo, type RepositoryRef } from './domain.ts';
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

interface GitLabReleaseDto {
  tag_name: string;
  name: string | null;
  description: string | null;
  created_at: string | null;
  released_at: string | null;
  upcoming_release?: boolean;
  author: { username: string; avatar_url: string | null } | null;
  _links?: { self?: string | null } | null;
}

interface GitLabTagDto {
  name: string;
  message?: string | null;
  created_at?: string | null;
  commit?: { committed_date?: string | null; created_at?: string | null } | null;
}

/**
 * {@link ReleaseSource} for GitLab (gitlab.com and self-managed instances): `/api/v4/projects/{path}/releases`.
 * GitLab has no pre-release flag, so a release is one when its tag says so (`-rc.1`, `-beta` …) or it is scheduled
 * for later. Only the repository's own token is sent – never GitHub's.
 */
export class GitLabReleaseSource implements ReleaseSource {
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
    const path = tags
      ? `/repository/tags?per_page=${TAGS_PER_PAGE}&order_by=version`
      : `/releases?per_page=${this.options.releasesPerPage}`;
    let response = await this.request(repo, path, token, etag);
    if (tags && response.status === 400) {
      // `order_by=version` needs GitLab 15.4+; older instances get the default order (newest commit first).
      response = await this.request(repo, `/repository/tags?per_page=${TAGS_PER_PAGE}`, token, etag);
    }
    const order = releaseOrder(repo);
    if (response.status === 304) {
      return { releases: [], etag, notModified: true, order };
    }
    await ensureJson(response, label(repo));
    if (tags) {
      const dtos = (await response.json()) as GitLabTagDto[];
      const releases = dtos.map((d): ReleaseInfo => {
        const date = d.created_at || d.commit?.committed_date || d.commit?.created_at;
        return {
          tag: d.name,
          name: null,
          htmlUrl: releasePageUrl(repo, d.name),
          body: d.message?.trim() || null,
          isPrerelease: isPrereleaseTag(d.name),
          publishedAt: date ? new Date(date).toISOString() : '',
          authorLogin: null,
          authorAvatarUrl: null,
        };
      });
      return { releases, etag: response.headers.get('etag'), notModified: false, order };
    }
    const dtos = (await response.json()) as GitLabReleaseDto[];
    const releases = dtos
      .filter((d) => d.released_at || d.created_at)
      .map(
        (d): ReleaseInfo => ({
          tag: d.tag_name,
          name: d.name?.trim() && d.name.trim() !== d.tag_name ? d.name : null,
          htmlUrl: d._links?.self || `${repositoryUrl(repo)}/-/releases/${encodeURIComponent(d.tag_name)}`,
          body: d.description?.trim() ? d.description : null,
          isPrerelease: d.upcoming_release === true || isPrereleaseTag(d.tag_name),
          publishedAt: new Date((d.released_at || d.created_at)!).toISOString(),
          authorLogin: d.author?.username ?? null,
          authorAvatarUrl: d.author?.avatar_url ?? null,
        }),
      );
    return { releases, etag: response.headers.get('etag'), notModified: false, order };
  }

  private request(repo: RepositoryRef, path: string, token?: string | null, etag: string | null = null): Promise<Response> {
    const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
    return instanceRequest(this.fetch, `https://${repo.host}/api/v4/projects/${project}${path}`, token ? { 'PRIVATE-TOKEN': token } : {}, etag);
  }
}

const label = (repo: RepositoryRef): string => `GitLab (${repo.host})`;
