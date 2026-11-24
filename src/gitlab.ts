import { repositoryUrl, type ReleaseInfo, type RepositoryRef } from './domain.ts';
import {
  ensureJson,
  instanceRequest,
  isJson,
  type InstanceOptions,
  type ReleaseFetchResult,
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

  async getRecentReleases(repo: RepositoryRef, etag: string | null, token?: string | null): Promise<ReleaseFetchResult> {
    const response = await this.request(repo, `/releases?per_page=${this.options.releasesPerPage}`, token, etag);
    if (response.status === 304) {
      return { releases: [], etag, notModified: true };
    }
    await ensureJson(response, label(repo));
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
    return { releases, etag: response.headers.get('etag'), notModified: false };
  }

  private request(repo: RepositoryRef, path: string, token?: string | null, etag: string | null = null): Promise<Response> {
    const project = encodeURIComponent(`${repo.owner}/${repo.name}`);
    return instanceRequest(this.fetch, `https://${repo.host}/api/v4/projects/${project}${path}`, token ? { 'PRIVATE-TOKEN': token } : {}, etag);
  }
}

const label = (repo: RepositoryRef): string => `GitLab (${repo.host})`;
