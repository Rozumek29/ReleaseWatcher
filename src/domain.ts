/** A GitHub repository the user wants to be notified about. */
export interface WatchedRepository {
  id: number;
  owner: string;
  name: string;
  includePrereleases: boolean;
  isEnabled: boolean;
  /** Tag of the newest release already processed. */
  lastSeenTag: string | null;
  /** ISO date of the newest release already processed. */
  lastSeenPublishedAt: string | null;
  /** GitHub ETag used for conditional requests (304s don't count against the rate limit). */
  etag: string | null;
  /** ISO date of the last successful check. Null means no baseline has been established yet. */
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** Optional endpoint of the self-hosted app returning its version, e.g. https://vault.lan/api/version. */
  installedVersionUrl: string | null;
  /** Dot path to the version in a JSON response; null = auto-detect. */
  installedVersionField: string | null;
  /** Extra request headers for the version URL (e.g. Authorization). Values are secrets – never returned by the API. */
  installedVersionHeaders: { name: string; value: string }[];
  installedVersion: string | null;
  installedVersionCheckedAt: string | null;
  installedVersionError: string | null;
  /** Token used for this repository instead of the global one (private repository of another account). Secret. */
  githubToken: string | null;
  /** GitHub ETag of the security advisories request. */
  advisoriesEtag: string | null;
  /** ISO date of the last successful advisories fetch. Null = none yet (the first fetch only sets the baseline). */
  advisoriesCheckedAt: string | null;
  advisoriesError: string | null;
  /** OSV.dev package of the app, e.g. ecosystem "npm" + name "n8n"; null = OSV.dev is not queried. */
  osvEcosystem: string | null;
  osvPackage: string | null;
  /**
   * Advisory sources already read once for this repository (`sourceKey()`, e.g. "github", "osv:npm/n8n"). The first
   * read of a source only stores a baseline, so enabling a source or changing the package does not flood notifications.
   */
  advisoryBaselines: string[];
  /** Custom icon: an image URL or a selfh.st/icons shorthand (`sh:<slug>`); null = the owner's avatar. */
  icon: string | null;
}

/** Source-agnostic description of a single release. */
export interface ReleaseInfo {
  tag: string;
  name: string | null;
  htmlUrl: string;
  body: string | null;
  isPrerelease: boolean;
  /** ISO date. */
  publishedAt: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
}

/** Avatar of the repository owner (user or organization); served by GitHub without an API call. */
export const ownerAvatarUrl = (owner: string, size = 64): string =>
  `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=${size}`;

/** Longest custom icon value (URL or `sh:` shorthand). */
export const ICON_MAX_LENGTH = 2000;

/** jsDelivr mirror of https://github.com/selfhst/icons (the CDN behind selfh.st/icons). */
const SELFHST_CDN = 'https://cdn.jsdelivr.net/gh/selfhst/icons';
const SELFHST_FORMATS = ['svg', 'png', 'webp'] as const;
/** `sh:<slug>` with an optional format, e.g. `sh:frigate`, `sh:frigate-light`, `sh:frigate.png`. */
const SELFHST_PATTERN = /^sh:(?<slug>[a-z0-9]+(?:[-_][a-z0-9]+)*)(?:\.(?<format>svg|png|webp))?$/;

/**
 * Checks a custom icon value: an http(s) image URL or the `sh:<slug>` shorthand of selfh.st/icons.
 * Returns an error message for the user, or null when the value is valid.
 */
export function validateIcon(icon: string): string | null {
  if (icon.length > ICON_MAX_LENGTH) {
    return `The icon must be at most ${ICON_MAX_LENGTH} characters long.`;
  }
  if (/^sh:/i.test(icon)) {
    return SELFHST_PATTERN.test(icon.toLowerCase())
      ? null
      : 'Use a selfh.st icon name like sh:frigate or sh:frigate-light (letters, digits and dashes).';
  }
  let url: URL;
  try {
    url = new URL(icon);
  } catch {
    return 'Enter an image URL (https://…) or a selfh.st icon name like sh:frigate.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'The icon URL must start with http:// or https://.';
  }
  if (url.username || url.password) {
    return 'The icon URL must not contain credentials.';
  }
  return null;
}

/**
 * Image URLs of a custom icon, best first; the UI tries them in order and falls back to the owner's avatar.
 * `sh:<slug>` resolves to the selfh.st/icons CDN – SVG first, then PNG and WebP (not every icon has an SVG).
 * An explicit format (`sh:<slug>.png`) is used alone. Empty for no or an invalid icon.
 */
export function iconUrls(icon: string | null): string[] {
  if (!icon) {
    return [];
  }
  const shorthand = icon.toLowerCase().match(SELFHST_PATTERN);
  if (shorthand) {
    const slug = shorthand.groups?.['slug'] ?? '';
    const format = shorthand.groups?.['format'];
    const formats = format ? [format] : SELFHST_FORMATS;
    return formats.map((f) => `${SELFHST_CDN}/${f}/${slug}.${f}`);
  }
  return validateIcon(icon) === null ? [icon] : [];
}

/**
 * One raster image URL of a custom icon, for clients that can't show SVG (Discord embeds): `sh:<slug>` → the PNG of
 * selfh.st/icons (or the WebP when asked for), an image URL as it is unless it points to an SVG. Null = use the avatar.
 */
export function rasterIconUrl(icon: string | null): string | null {
  const urls = iconUrls(icon);
  if (icon && SELFHST_PATTERN.test(icon.toLowerCase())) {
    const slug = icon.toLowerCase().match(SELFHST_PATTERN)?.groups?.['slug'] ?? '';
    return urls.find((u) => !u.endsWith('.svg')) ?? `${SELFHST_CDN}/png/${slug}.png`;
  }
  const url = urls[0];
  return url && !/\.svg$/i.test(new URL(url).pathname) ? url : null;
}

export const fullName = (repo: Pick<WatchedRepository, 'owner' | 'name'>): string => `${repo.owner}/${repo.name}`;

const REPOSITORY_PATTERN =
  /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?(?<owner>[A-Za-z0-9][A-Za-z0-9-]{0,38})\/(?<name>[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/;

/** Parses "owner/repo" or "https://github.com/owner/repo" into its parts. Returns null for invalid input. */
export function parseRepositoryName(input: string | null | undefined): { owner: string; name: string } | null {
  const match = input?.trim().match(REPOSITORY_PATTERN);
  const owner = match?.groups?.['owner'];
  const name = match?.groups?.['name'];
  if (!owner || !name || name === '.' || name === '..') {
    return null;
  }
  return { owner, name };
}

/** Upper bound of notifications sent for one repository in a single check (protects against spam). */
export const MAX_NOTIFICATIONS_PER_CHECK = 5;

export interface ReleaseSelection {
  /** Releases to notify about, oldest first. */
  newReleases: ReleaseInfo[];
  /** Newest relevant release; becomes the new baseline. */
  newest: ReleaseInfo | null;
}

/**
 * Decides which fetched releases are "new" for a watched repository.
 * On the very first check nothing is reported – only the baseline is established.
 */
export function selectNewReleases(
  repo: Pick<WatchedRepository, 'includePrereleases' | 'lastCheckedAt' | 'lastSeenPublishedAt' | 'lastSeenTag'>,
  releases: readonly ReleaseInfo[],
): ReleaseSelection {
  const relevant = releases
    .filter((r) => repo.includePrereleases || !r.isPrerelease)
    .toSorted((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));

  const newest = relevant.at(-1) ?? null;

  if (repo.lastCheckedAt === null) {
    return { newReleases: [], newest };
  }

  const seenAt = repo.lastSeenPublishedAt === null ? null : Date.parse(repo.lastSeenPublishedAt);
  const newReleases = relevant
    .filter((r) => seenAt === null || Date.parse(r.publishedAt) > seenAt)
    .filter((r) => r.tag !== repo.lastSeenTag)
    .slice(-MAX_NOTIFICATIONS_PER_CHECK);

  return { newReleases, newest };
}
