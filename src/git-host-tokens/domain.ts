import { knownProvider, PROVIDER_LABELS, type RepositoryProvider } from '../domain.ts';

/** Providers whose instances can have a host token (GitHub has its global token in the settings instead). */
export const GIT_HOST_PROVIDERS = ['gitea', 'gitlab'] as const satisfies readonly RepositoryProvider[];
export type GitHostProvider = (typeof GIT_HOST_PROVIDERS)[number];

export const isGitHostProvider = (provider: RepositoryProvider): provider is GitHostProvider =>
  (GIT_HOST_PROVIDERS as readonly RepositoryProvider[]).includes(provider);

/** Longest token accepted (same limit as a repository's own token). */
export const MAX_TOKEN_LENGTH = 1000;

/**
 * The access token of a Gitea/Forgejo or GitLab instance: used by every repository on that host (and provider) that
 * has no token of its own, and sent only to that host.
 */
export interface GitHostToken {
  id: number;
  provider: GitHostProvider;
  /** Lower-case host with an optional port, as in `watched_repositories.host`. */
  host: string;
  token: string;
  createdAt: string;
  updatedAt: string;
  /** Watched repositories on the host without a token of their own – they use this one. */
  repositoryCount: number;
}

/** Why a host can't have a token of this provider (a well-known host such as codeberg.org fixes it), or null. */
export function providerMismatch(provider: GitHostProvider, host: string): string | null {
  const known = knownProvider(host);
  return known !== null && known !== provider ? `${host} is ${PROVIDER_LABELS[known]}, not ${PROVIDER_LABELS[provider]}.` : null;
}

/** The token a repository is read with: its own, otherwise the one of its host (never GitHub's or a web source's). */
export function effectiveToken(
  repo: { provider: RepositoryProvider; host: string | null },
  own: string | null | undefined,
  hostToken: (provider: GitHostProvider, host: string) => string | null,
): string | null | undefined {
  if (own || repo.host === null || !isGitHostProvider(repo.provider)) {
    return own;
  }
  return hostToken(repo.provider, repo.host) ?? own;
}
