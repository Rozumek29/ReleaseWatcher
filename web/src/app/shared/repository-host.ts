/** Hosts whose provider the server knows – keep in sync with `KNOWN_HOSTS` in `src/domain.ts`. */
const KNOWN_HOSTS = new Set(['github.com', 'gitlab.com', 'codeberg.org', 'gitea.com', 'code.forgejo.org']);

/**
 * Host of a repository URL (or `host/owner/repo`) whose provider is not known, so the user may choose Gitea/Forgejo or
 * GitLab; null for `owner/repo` (GitHub), a well-known host or input that is no repository.
 */
export function unknownRepositoryHost(input: string): string | null {
  const value = input.trim().replace(/^git\+/, '');
  if (!value.includes('/')) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase().replace(/^www\./, '');
  // `owner/repo` parses as host "owner": a GitHub owner has no dot, a host name usually has one (or a port).
  const looksLikeHost = /^https?:\/\//i.test(value) || host.includes('.') || host.includes(':');
  const segments = url.pathname.split('/').filter(Boolean);
  return looksLikeHost && segments.length >= 2 && !KNOWN_HOSTS.has(host) ? host : null;
}
