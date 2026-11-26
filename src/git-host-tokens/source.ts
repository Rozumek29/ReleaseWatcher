import type { RepositoryRef } from '../domain.ts';
import type { ReleaseSource } from '../release-source.ts';
import { effectiveToken, type GitHostProvider } from './domain.ts';

/**
 * Wraps a {@link ReleaseSource} so that a repository on a Gitea/Forgejo or GitLab instance without a token of its own is
 * read with the token saved for its host. The token goes only to the source of that repository, i.e. to its own host.
 */
export function withGitHostTokens(
  source: ReleaseSource,
  hostToken: (provider: GitHostProvider, host: string) => string | null,
): ReleaseSource {
  const token = (repo: RepositoryRef, own: string | null | undefined) => effectiveToken(repo, own, hostToken);
  return {
    ...(source.getRateLimit ? { getRateLimit: () => source.getRateLimit!() } : {}),
    repositoryExists: (repo, own) => source.repositoryExists(repo, token(repo, own)),
    getRecentReleases: (repo, etag, own) => source.getRecentReleases(repo, etag, token(repo, own)),
    ...(source.getSecurityAdvisories
      ? { getSecurityAdvisories: (repo, etag, own) => source.getSecurityAdvisories!(repo, etag, token(repo, own)) }
      : {}),
  };
}
