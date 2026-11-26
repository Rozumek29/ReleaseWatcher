import { compareVersions, parseVersion } from './version.ts';
import type { WebSourceConfig, WebSourceFormat } from './web-source/domain.ts';

/**
 * Where releases of a repository are read from: GitHub, a Gitea/Forgejo instance (Codeberg …), a GitLab instance or a
 * web page, feed or JSON API (`web`).
 */
export const PROVIDERS = ['github', 'gitea', 'gitlab', 'web'] as const;
export type RepositoryProvider = (typeof PROVIDERS)[number];

/** Providers of real repositories (everything a repository URL can name). */
export const GIT_PROVIDERS = ['github', 'gitea', 'gitlab'] as const satisfies readonly RepositoryProvider[];

/**
 * `owner` of every web source: a web source is stored like a repository with `host` = the host of its URL and
 * `name` = the name the user gave it, so its key (`fullName()`) is `host/web/name`.
 */
export const WEB_OWNER = 'web';

/** Longest name of a web source. */
export const WEB_SOURCE_NAME_MAX_LENGTH = 100;

/** A repository on one of the {@link PROVIDERS}. */
export interface RepositoryRef {
  provider: RepositoryProvider;
  /** Host name (with an optional port) of a Gitea/Forgejo or GitLab instance; null for GitHub. */
  host: string | null;
  /** User, organization or (GitLab) group path, e.g. `gitlab-org/charts`. */
  owner: string;
  name: string;
}

/** What of a repository is watched: its releases, or its tags (projects that tag versions without releases). */
export const RELEASE_SOURCES = ['releases', 'tags'] as const;
export type ReleaseSourceKind = (typeof RELEASE_SOURCES)[number];

/** A repository the user wants to be notified about. */
export interface WatchedRepository extends RepositoryRef {
  id: number;
  includePrereleases: boolean;
  /** Releases (newest by date) or tags (newest by version). */
  releaseSource: ReleaseSourceKind;
  /**
   * Regular expression (case-insensitive) tags must match; others are skipped. With tags, its group `version` (or group
   * 1) becomes the version shown and compared, e.g. `^TS-(.+)$`. Null = every tag.
   */
  versionPattern: string | null;
  isEnabled: boolean;
  /** Tag of the newest release already processed. */
  lastSeenTag: string | null;
  /** ISO date of the newest release already processed. */
  lastSeenPublishedAt: string | null;
  /** ETag of the releases request, used for conditional requests (304s don't count against the rate limit). */
  releasesEtag: string | null;
  /** ISO date of the last successful check. Null means no baseline has been established yet. */
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
  /** Optional endpoint of the self-hosted app returning its version, e.g. https://vault.lan/api/version. */
  installedVersionUrl: string | null;
  /** Path (JSON) or CSS selector (HTML/XML) of the version in the response; null = auto-detect / the whole response. */
  installedVersionField: string | null;
  /** How the response of the version URL is read: null = auto (JSON or the first version in the text), or a web format. */
  installedVersionFormat: WebSourceFormat | null;
  /** Regular expression that picks the version out of the located text (required for `text`); null = none. */
  installedVersionPattern: string | null;
  /** Extra request headers for the version URL (e.g. Authorization). Values are secrets – never returned by the API. */
  installedVersionHeaders: { name: string; value: string }[];
  installedVersion: string | null;
  installedVersionCheckedAt: string | null;
  installedVersionError: string | null;
  /**
   * App on a machine the installed version is read from (then `installedVersion`, `installedVersionCheckedAt` and
   * `installedVersionError` follow that app); null = the version URL, entered by hand or none. Changed only through
   * `RepositoryStore.setInstalledVersionApp()`.
   */
  installedVersionApp: MachineAppRef | null;
  /**
   * Token used for this repository: on GitHub instead of the global one (private repository of another account), on
   * Gitea/Forgejo and GitLab the only one sent (the global token is GitHub's). Secret.
   */
  accessToken: string | null;
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
  /** Custom group (`repository_groups`) the repository is shown in on the Repositories page; null = none. */
  groupId: number | null;
  /** Where and how a web source (provider `web`) reads its versions; null for repositories. */
  webSource: WebSourceConfig | null;
}

/** A custom group of repositories on the Repositories page. */
export interface RepositoryGroup {
  id: number;
  name: string;
  /** Custom icon: an image URL or a selfh.st/icons shorthand (`sh:<slug>`); null = a folder. */
  icon: string | null;
  /** Repositories in the group (a group without any is removed). */
  repositoryCount: number;
}

/** An app on a machine: an application of a target (`target_apps`) or a Docker container (`docker_containers`). */
export interface MachineAppRef {
  kind: 'app' | 'docker';
  id: number;
}

/** Source-agnostic description of a single release. */
export interface ReleaseInfo {
  tag: string;
  name: string | null;
  htmlUrl: string;
  body: string | null;
  isPrerelease: boolean;
  /** ISO date; empty for a tag without a date (GitHub) – {@link selectNewVersions} fills in the check time. */
  publishedAt: string;
  authorLogin: string | null;
  authorAvatarUrl: string | null;
}

/** Avatar of the repository owner (user or organization); served by GitHub without an API call. */
export const ownerAvatarUrl = (owner: string, size = 64): string =>
  `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=${size}`;

/** Longest custom group name. */
export const GROUP_NAME_MAX_LENGTH = 60;

/** A custom group name as stored: trimmed, inner whitespace collapsed; null for none. */
export function normalizeGroupName(value: string | null | undefined): string | null {
  return value?.trim().replace(/\s+/g, ' ') || null;
}

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

/**
 * Name shown for a repository and used to match it (case-insensitive): `owner/name` on GitHub,
 * `host/owner/name` elsewhere (e.g. `codeberg.org/forgejo/forgejo`).
 */
export const fullName = (repo: { host?: string | null; owner: string; name: string }): string =>
  repo.host ? `${repo.host}/${repo.owner}/${repo.name}` : `${repo.owner}/${repo.name}`;

/** Label of a provider in messages ("GitHub", "Gitea/Forgejo", "GitLab"). */
export const PROVIDER_LABELS: Readonly<Record<RepositoryProvider, string>> = {
  github: 'GitHub',
  gitea: 'Gitea/Forgejo',
  gitlab: 'GitLab',
  web: 'Web page',
};

/** Web page of a repository. */
export const repositoryUrl = (repo: { host?: string | null; owner: string; name: string }): string =>
  `https://${repo.host ?? 'github.com'}/${repo.owner}/${repo.name}`;

/** A tag name as a URL path (slashes kept, everything else encoded). */
export const tagPath = (tag: string): string => encodeURIComponent(tag).replaceAll('%2F', '/');

/**
 * Web page of a release or tag: GitHub `…/releases/tag/<tag>` (also for tags), Gitea/Forgejo `…/releases/tag/<tag>` or
 * `…/src/tag/<tag>`, GitLab `…/-/releases/<tag>` or `…/-/tags/<tag>`.
 */
export function releasePageUrl(
  repo: Pick<RepositoryRef, 'provider' | 'host' | 'owner' | 'name'> & { releaseSource?: ReleaseSourceKind },
  tag: string,
): string {
  const tags = repo.releaseSource === 'tags';
  const base = repositoryUrl(repo);
  switch (repo.provider) {
    case 'github':
      return `${base}/releases/tag/${tagPath(tag)}`;
    case 'gitea':
      return `${base}/${tags ? 'src/tag' : 'releases/tag'}/${tagPath(tag)}`;
    case 'gitlab':
      return `${base}/-/${tags ? 'tags' : 'releases'}/${tagPath(tag)}`;
    case 'web':
      // Versions of a web source have no page of their own here (see `lastSeenUrl`).
      return `https://${repo.host}/`;
  }
}

/**
 * Page of the newest release already processed; null when there is none or the tag is a version picked by a pattern
 * (not the name of a tag). For a web source, the page it reads.
 */
export const lastSeenUrl = (
  repo: Pick<WatchedRepository, 'provider' | 'host' | 'owner' | 'name' | 'releaseSource' | 'versionPattern' | 'lastSeenTag'> &
    Partial<Pick<WatchedRepository, 'webSource'>>,
): string | null => {
  if (!repo.lastSeenTag) {
    return null;
  }
  if (repo.provider === 'web') {
    return repo.webSource?.url ?? null;
  }
  return repo.releaseSource === 'tags' && repo.versionPattern ? null : releasePageUrl(repo, repo.lastSeenTag);
};

/** Name shown to the user: the given name of a web source, otherwise {@link fullName}. */
export const displayName = (repo: { provider?: RepositoryProvider; host?: string | null; owner: string; name: string }): string =>
  repo.provider === 'web' ? repo.name : fullName(repo);

/** Page a repository or web source is found at: the source URL of a web source, otherwise {@link repositoryUrl}. */
export const sourcePageUrl = (repo: Pick<WatchedRepository, 'provider' | 'host' | 'owner' | 'name' | 'webSource'>): string =>
  repo.provider === 'web' && repo.webSource ? repo.webSource.url : repositoryUrl(repo);

/** Host a web source is stored under: the host (with a non-default port) of its URL, lower-case without `www.`. */
export const webSourceHost = (url: string): string => new URL(url).host.toLowerCase().replace(/^www\./, '');

/** A web source name as stored: trimmed, inner whitespace collapsed; null when empty. */
export const normalizeWebSourceName = (value: string | null | undefined): string | null => value?.trim().replace(/\s+/g, ' ') || null;

/** Checks the name of a web source; returns a message for the user, or null when it is valid. */
export function webSourceNameError(name: string | null): string | null {
  if (!name) {
    return 'Enter a name for the web source, e.g. UniFi Network.';
  }
  if (name.length > WEB_SOURCE_NAME_MAX_LENGTH) {
    return `The name must be at most ${WEB_SOURCE_NAME_MAX_LENGTH} characters long.`;
  }
  if (name.includes('/')) {
    // The name is part of the key `host/web/name`.
    return 'The name must not contain a slash (/).';
  }
  return null;
}

/**
 * Sets where a web source reads its versions. Like {@link setReleaseSource}, a change makes the next check establish
 * a new baseline silently (other page, other versions). Returns true when something changed.
 */
export function setWebSource(repo: WatchedRepository, webSource: WebSourceConfig, versionPattern: string | null): boolean {
  if (sameWebSource(repo.webSource, webSource) && repo.versionPattern === versionPattern) {
    return false;
  }
  // The User-Agent alone does not change what is read.
  const reset = !sameWebSource(repo.webSource, { ...webSource, userAgent: repo.webSource?.userAgent ?? null }) || repo.versionPattern !== versionPattern;
  repo.webSource = webSource;
  repo.versionPattern = versionPattern;
  if (reset) {
    repo.lastSeenTag = null;
    repo.lastSeenPublishedAt = null;
    repo.lastCheckedAt = null;
  }
  repo.releasesEtag = null;
  return true;
}

const WEB_SOURCE_KEYS = ['url', 'format', 'items', 'version', 'date', 'link', 'userAgent'] as const satisfies readonly (keyof WebSourceConfig)[];

const sameWebSource = (a: WebSourceConfig | null, b: WebSourceConfig | null): boolean =>
  a === b || (a !== null && b !== null && WEB_SOURCE_KEYS.every((key) => a[key] === b[key]));

/**
 * Avatar of the repository owner without an API call: GitHub's avatar service, the `/user/avatar/<name>/<size>` route
 * of Gitea/Forgejo; null for GitLab (no such URL – the UI shows a letter).
 */
export function repositoryAvatarUrl(repo: Pick<RepositoryRef, 'provider' | 'host' | 'owner'>, size = 64): string | null {
  switch (repo.provider) {
    case 'github':
      return ownerAvatarUrl(repo.owner, size);
    case 'gitea':
      return repo.host ? `https://${repo.host}/user/avatar/${encodeURIComponent(repo.owner)}/${size}` : null;
    case 'gitlab':
    case 'web':
      return null;
  }
}

/** Hosts whose provider is known, so a URL of them needs no provider choice. */
const KNOWN_HOSTS: Readonly<Record<string, RepositoryProvider>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'codeberg.org': 'gitea',
  'gitea.com': 'gitea',
  'code.forgejo.org': 'gitea',
};

/** Provider of a well-known host (github.com, gitlab.com, codeberg.org …); null when it has to be chosen or detected. */
export const knownProvider = (host: string | null): RepositoryProvider | null =>
  host === null ? 'github' : (KNOWN_HOSTS[host.toLowerCase()] ?? null);

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

/** Host name with an optional port, e.g. `codeberg.org` or `git.example.com:3000`. */
const HOST_PATTERN = /^(?=.{1,253}(?::|$))[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*(?::\d{1,5})?$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
/** GitLab groups nest; deeper paths are not supported. */
const MAX_PATH_SEGMENTS = 10;

/**
 * Parses the host of a Gitea/Forgejo or GitLab instance: `git.example.com`, `git.example.com:3000` or an HTTPS URL of
 * it (path ignored). Returned lower-case without `www.`, like the hosts of parsed repositories. Returns null for invalid
 * input, another scheme, credentials in the URL and github.com.
 */
export function parseGitHost(input: string | null | undefined): string | null {
  const value = input?.trim();
  if (!value || (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https:\/\//i.test(value))) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase().replace(/^www\./, '');
  return url.username || url.password || !HOST_PATTERN.test(host) || host === 'github.com' ? null : host;
}

/** A repository named by the user or a label: host (null = GitHub), owner and name; the provider when the host tells it. */
export interface ParsedRepository {
  host: string | null;
  owner: string;
  name: string;
  /** Provider known from the host; null for another host (to be chosen or detected). */
  provider: RepositoryProvider | null;
}

/**
 * Parses a repository of any provider: `owner/repo` or a github.com URL (GitHub), or `[https://]host/owner/repo` of a
 * Gitea/Forgejo or GitLab instance (GitLab groups may nest: `gitlab.com/group/subgroup/project`). Page paths after the
 * repository (`/-/releases` on GitLab; `/releases`, `/src/…` on known Gitea hosts) are ignored. Only HTTPS URLs are
 * accepted. Returns null for invalid input.
 */
export function parseRepositoryReference(input: string | null | undefined): ParsedRepository | null {
  const value = input?.trim().replace(/^git\+/, '').replace(/[#?].*$/, '');
  if (!value) {
    return null;
  }
  const github = parseRepositoryName(value);
  if (github) {
    return { host: null, ...github, provider: 'github' };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) && !/^https:\/\//i.test(value)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  const host = url.host.toLowerCase().replace(/^www\./, '');
  if (url.username || url.password || !HOST_PATTERN.test(host) || host === 'github.com') {
    return null;
  }
  const provider = knownProvider(host);
  let segments = url.pathname.split('/').filter(Boolean);
  const dash = segments.indexOf('-');
  if (dash >= 0) {
    segments = segments.slice(0, dash);
  } else if (provider === 'gitea') {
    segments = segments.slice(0, 2);
  }
  const last = segments.at(-1)?.replace(/\.git$/i, '');
  if (!last || segments.length < 2 || segments.length > MAX_PATH_SEGMENTS) {
    return null;
  }
  segments[segments.length - 1] = last;
  if (!segments.every((s) => SEGMENT_PATTERN.test(s) && s !== '.' && s !== '..')) {
    return null;
  }
  return { host, owner: segments.slice(0, -1).join('/'), name: last, provider };
}

/**
 * Sets what of a repository is watched. A change makes the next check establish a new baseline silently (versions of
 * tags and releases, or before and after a new pattern, can't be compared). Returns true when something changed.
 */
export function setReleaseSource(
  repo: WatchedRepository,
  releaseSource: ReleaseSourceKind,
  versionPattern: string | null,
): boolean {
  if (repo.releaseSource === releaseSource && repo.versionPattern === versionPattern) {
    return false;
  }
  repo.releaseSource = releaseSource;
  repo.versionPattern = versionPattern;
  repo.lastSeenTag = null;
  repo.lastSeenPublishedAt = null;
  repo.releasesEtag = null;
  repo.lastCheckedAt = null;
  return true;
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
  const relevant = releases.filter((r) => repo.includePrereleases || !r.isPrerelease).toSorted(compareReleases);

  const newest = relevant.at(-1) ?? null;

  if (repo.lastCheckedAt === null) {
    return { newReleases: [], newest };
  }

  const newReleases = relevant
    .filter((r) => isNewerRelease(r, repo))
    .filter((r) => r.tag !== repo.lastSeenTag)
    .slice(-MAX_NOTIFICATIONS_PER_CHECK);

  return { newReleases, newest };
}

/**
 * Order of releases by publication date; releases of the same moment (sources with dates only, e.g. `2026-10-23`)
 * by version, so the higher one counts as the newer.
 */
export function compareReleases(a: Pick<ReleaseInfo, 'tag' | 'publishedAt'>, b: Pick<ReleaseInfo, 'tag' | 'publishedAt'>): number {
  return Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || (compareVersions(a.tag, b.tag) ?? 0);
}

/** True when a release comes after the baseline (`lastSeenPublishedAt`, then `lastSeenTag` on the same date); true without one. */
export function isNewerRelease(
  release: Pick<ReleaseInfo, 'tag' | 'publishedAt'>,
  baseline: Pick<WatchedRepository, 'lastSeenPublishedAt' | 'lastSeenTag'>,
): boolean {
  if (baseline.lastSeenPublishedAt === null) {
    return true;
  }
  return compareReleases(release, { tag: baseline.lastSeenTag ?? '', publishedAt: baseline.lastSeenPublishedAt }) > 0;
}

/**
 * Decides which fetched versions are "new" when a source has no usable dates (tags): by version instead of by date.
 * Tags that are not versions are skipped, tags of the same version (`v2.5.0p21`, `v2.5.0p21+security`) count once. On
 * the first check only the baseline is established; later every version above `lastSeenTag` is new (only the newest when
 * the baseline is no version). Undated tags get `now` as their date.
 */
export function selectNewVersions(
  repo: Pick<WatchedRepository, 'includePrereleases' | 'lastCheckedAt' | 'lastSeenTag'>,
  releases: readonly ReleaseInfo[],
  now: Date,
): ReleaseSelection {
  const candidates: ReleaseInfo[] = [];
  for (const release of releases) {
    if ((!repo.includePrereleases && release.isPrerelease) || parseVersion(release.tag) === null) {
      continue;
    }
    const dated = release.publishedAt ? release : { ...release, publishedAt: now.toISOString() };
    const same = candidates.findIndex((c) => compareVersions(c.tag, release.tag) === 0);
    if (same < 0) {
      candidates.push(dated);
    } else if (candidates[same]?.isPrerelease && !release.isPrerelease) {
      candidates[same] = dated;
    }
  }
  candidates.sort((a, b) => compareVersions(a.tag, b.tag) ?? 0);

  const newest = candidates.at(-1) ?? null;
  if (repo.lastCheckedAt === null) {
    return { newReleases: [], newest };
  }
  if (parseVersion(repo.lastSeenTag) === null) {
    return { newReleases: newest ? [newest] : [], newest };
  }
  const newReleases = candidates
    .filter((c) => (compareVersions(c.tag, repo.lastSeenTag) ?? 0) > 0)
    .slice(-MAX_NOTIFICATIONS_PER_CHECK);
  return { newReleases, newest };
}
