/**
 * Docker / Podman containers: image references, versions read from tags and labels, links to watched repositories
 * and the image update state. Pure logic – no I/O.
 */
import { fullName, parseRepositoryReference } from '../domain.ts';
import { compareVersions, parseVersion } from '../version.ts';

export const DOCKER_RUNTIMES = ['docker', 'podman'] as const;
export type DockerRuntime = (typeof DOCKER_RUNTIMES)[number];

/** A running container as the engine reports it (before registry data). */
export interface EngineContainer {
  /** Container ID (64 hex digits). */
  id: string;
  /** Name without the leading slash. */
  name: string;
  /** Image reference the container was created from, e.g. `lscr.io/linuxserver/sonarr:latest`. */
  image: string;
  /** Local image ID (`sha256:…`). */
  imageId: string;
  /** running, paused, restarting, … */
  state: string;
  /** Labels of the container (they include the labels of its image). */
  labels: Record<string, string>;
  /** `repository@sha256:…` digests the local image was pulled with. */
  repoDigests: string[];
}

/** Everything one engine reported. */
export interface EngineListing {
  runtime: DockerRuntime;
  /** Engine version, e.g. "27.3.1"; null when unknown. */
  version: string | null;
  containers: EngineContainer[];
}

/** A parsed image reference. */
export interface ImageRef {
  /** Registry host as written in references (`docker.io`, `ghcr.io`, `lscr.io`, `registry.lan:5000`). */
  registry: string;
  /** Repository path inside the registry (`library/nginx`, `linuxserver/sonarr`). */
  repository: string;
  /** null = only a digest was given. */
  tag: string | null;
  /** `sha256:…` when the reference pins a digest. */
  digest: string | null;
}

export const DOCKER_HUB = 'docker.io';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG_PATTERN = /^[\w][\w.-]{0,127}$/;

/**
 * Parses `[registry/]repository[:tag][@digest]` like Docker does: the first component is a registry when it contains
 * a dot or a port or is `localhost`; Docker Hub images without a namespace live in `library/`. A bare image ID
 * (a container whose image was re-tagged since) or anything malformed gives null.
 */
export function parseImageRef(input: string): ImageRef | null {
  let rest = input.trim();
  if (!rest || DIGEST_PATTERN.test(rest) || /^[0-9a-f]{64}$/.test(rest)) {
    return null;
  }
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST_PATTERN.test(digest)) {
      return null;
    }
  }
  let tag: string | null = null;
  const colon = rest.lastIndexOf(':');
  if (colon > rest.lastIndexOf('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG_PATTERN.test(tag)) {
      return null;
    }
  }
  const parts = rest.split('/');
  let registry = DOCKER_HUB;
  const first = parts[0] ?? '';
  if (parts.length > 1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first.toLowerCase();
    parts.shift();
  }
  if (registry === 'index.docker.io' || registry === 'registry-1.docker.io') {
    registry = DOCKER_HUB;
  }
  if (parts.length === 0 || !parts.every((p) => COMPONENT_PATTERN.test(p))) {
    return null;
  }
  if (registry === DOCKER_HUB && parts.length === 1) {
    parts.unshift('library');
  }
  if (tag === null && digest === null) {
    tag = 'latest';
  }
  return { registry, repository: parts.join('/'), tag, digest };
}

/** `registry/repository`, the key of an image repository (e.g. `docker.io/library/nginx`). */
export const repositoryKey = (ref: Pick<ImageRef, 'registry' | 'repository'>): string => `${ref.registry}/${ref.repository}`;

/** `registry/repository:tag` – the key of a tag whose registry digest is checked; null for digest-pinned references. */
export const tagKey = (ref: ImageRef): string | null => (ref.digest || !ref.tag ? null : `${repositoryKey(ref)}:${ref.tag}`);

/** Short form for display: `nginx:1.27`, `ghcr.io/owner/app:latest`. */
export function displayImage(ref: ImageRef): string {
  const path = ref.registry === DOCKER_HUB && ref.repository.startsWith('library/') ? ref.repository.slice(8) : ref.repository;
  const name = ref.registry === DOCKER_HUB ? path : `${ref.registry}/${path}`;
  return `${name}${ref.tag ? `:${ref.tag}` : ''}${ref.digest && !ref.tag ? `@${ref.digest.slice(0, 19)}` : ''}`;
}

/** Digests of the local image pulled from the same repository as `ref` (RepoDigests may list several registries). */
export function localDigests(ref: ImageRef, repoDigests: readonly string[]): string[] {
  const key = repositoryKey(ref);
  const result: string[] = [];
  for (const entry of repoDigests) {
    const parsed = parseImageRef(entry);
    if (parsed?.digest && repositoryKey(parsed) === key && !result.includes(parsed.digest)) {
      result.push(parsed.digest);
    }
  }
  return result;
}

/** Tags that move to new builds instead of naming a version. */
const FLOATING_TAGS = new Set([
  'latest',
  'stable',
  'main',
  'master',
  'edge',
  'nightly',
  'dev',
  'develop',
  'development',
  'release',
  'rolling',
  'lts',
  'beta',
  'alpha',
  'testing',
  'unstable',
  'current',
  'mainline',
  'preview',
  'next',
  'production',
  'prod',
]);

/** Tag names a version (`1.2.3`, `v2.0`, `2024.10.1-alpine`, `version-4.0.11`); false for `latest`, `stable`, …. */
export function isVersionTag(tag: string | null | undefined): boolean {
  if (!tag || FLOATING_TAGS.has(tag.toLowerCase())) {
    return false;
  }
  return /^(?:v|version-|release-)?\d+(?:\.\d+)*(?:[-+_.][0-9A-Za-z][0-9A-Za-z._-]*)?$/i.test(tag) && parseVersion(tag) !== null;
}

/** Splits a version tag into its prefix, version numbers and the rest (`v1.2-alpine` → `v`, `[1, 2]`, `-alpine`). */
function splitVersionTag(tag: string): { prefix: string; numbers: number[]; rest: string } | null {
  const match = /^(v|version-|release-)?(\d+(?:\.\d+)*)(.*)$/i.exec(tag);
  if (!match?.[2]) return null;
  return { prefix: (match[1] ?? '').toLowerCase(), numbers: match[2].split('.').map(Number), rest: (match[3] ?? '').toLowerCase() };
}

/** Fewest version numbers of a tag that names one release (`1.2.3`); shorter ones (`17-alpine`, `1.25`) move along. */
const PINNED_VERSION_PARTS = 3;

/**
 * Whether the registry is asked which exact version a container runs: floating tags (`latest`, `alpine`) and version
 * tags that move along with new releases (`17-alpine`, `1.25`) – both are re-pushed for every release.
 */
export function needsResolving(tag: string | null | undefined): boolean {
  if (!isVersionTag(tag)) return true;
  return (splitVersionTag(tag!)?.numbers.length ?? PINNED_VERSION_PARTS) < PINNED_VERSION_PARTS;
}

/** Whether version `exact` is a more specific form of `tag` (`17.7-alpine3.22` of `17-alpine`, `1.25.3` of `1.25`). */
export function refinesTag(exact: string, tag: string): boolean {
  const a = splitVersionTag(exact);
  const b = splitVersionTag(tag);
  return !!a && !!b && a.numbers.length > b.numbers.length && b.numbers.every((n, i) => a.numbers[i] === n);
}

/** Labels read from containers (everything else is dropped before it is stored). */
export const LABELS = {
  version: 'org.opencontainers.image.version',
  legacyVersion: 'org.label-schema.version',
  /** linuxserver.io: `Linuxserver.io version:- 4.0.11.2680-ls263 Build-date:- …`. */
  linuxserverBuild: 'build_version',
  source: 'org.opencontainers.image.source',
  legacySource: 'org.label-schema.vcs-url',
  url: 'org.opencontainers.image.url',
  /** Own label: the watched repository (`owner/name`, a GitHub URL or the URL of a Gitea/Forgejo or GitLab repository). */
  repository: 'releasewatcher.repo',
  /** Own label: `true` hides the container (it can still be shown again in the UI). */
  ignore: 'releasewatcher.ignore',
  composeProject: 'com.docker.compose.project',
  composeService: 'com.docker.compose.service',
  podmanComposeProject: 'io.podman.compose.project',
} as const;

const KEPT_LABELS: ReadonlySet<string> = new Set(Object.values(LABELS));

/** The labels ReleaseWatcher uses (keeps the database small; other labels may hold secrets). */
export function keptLabels(labels: Readonly<Record<string, unknown>> | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (KEPT_LABELS.has(key) && typeof value === 'string' && value.trim()) {
      result[key] = value.trim().slice(0, 500);
    }
  }
  return result;
}

/** Version from the image labels; null when none names a version. */
export function labelVersion(labels: Readonly<Record<string, string>>): string | null {
  const build = labels[LABELS.linuxserverBuild]?.match(/version:-\s*(\S+)/i)?.[1];
  for (const candidate of [labels[LABELS.version], labels[LABELS.legacyVersion], build]) {
    const value = candidate?.trim();
    if (value && !FLOATING_TAGS.has(value.toLowerCase()) && parseVersion(value) !== null && value.length <= 100) {
      return value;
    }
  }
  return null;
}

/**
 * Watched repository named by the labels as its lower-case `fullName()`: `owner/name` on GitHub, `host/owner/name` on a
 * Gitea/Forgejo or GitLab instance (e.g. `org.opencontainers.image.source=https://codeberg.org/forgejo/forgejo`). The
 * `url` label often names a project or registry page, so it counts only when it points to GitHub. An image inherits
 * the labels of its base image unless it sets its own, so a repository named like a base image (e.g.
 * `linuxserver/docker-baseimage-ubuntu`) counts only in the own label. Null when none fits.
 */
export function labelRepository(labels: Readonly<Record<string, string>>): string | null {
  for (const key of [LABELS.repository, LABELS.source, LABELS.legacySource, LABELS.url]) {
    const parsed = parseRepositoryReference(labels[key]);
    if (parsed && (parsed.host === null || key !== LABELS.url) && (key === LABELS.repository || !BASE_IMAGE_NAME.test(parsed.name))) {
      return fullName(parsed).toLowerCase();
    }
  }
  return null;
}

/** Repository names of base images: `docker-baseimage-ubuntu`, `baseimage-alpine`, `base-image`. */
const BASE_IMAGE_NAME = /(?:^|[-_.])base[-_]?image(?:[-_.]|$)/i;

/** Compose project (Docker Compose or podman-compose); null for containers started on their own. */
export const composeProject = (labels: Readonly<Record<string, string>>): string | null =>
  labels[LABELS.composeProject] ?? labels[LABELS.podmanComposeProject] ?? null;

export const isIgnoredByLabel = (labels: Readonly<Record<string, string>>): boolean =>
  /^(?:true|1|yes|on)$/i.test(labels[LABELS.ignore] ?? '');

export const VERSION_SOURCES = ['tag', 'label', 'digest'] as const;
/** Where the installed version came from: the image tag, an image label or the registry tag with the same digest. */
export type VersionSource = (typeof VERSION_SOURCES)[number];

/**
 * Installed version of a container: a version tag wins (it is what the user chose; a label or the registry tag with the
 * same digest that refines it, e.g. tag `16` and label `16.4` or tag `17-alpine` and `17.7-alpine3.22`, is used
 * instead). A floating tag (`latest`) is resolved through the registry – the version tag
 * with the same digest – and falls back to the version label (which may be inherited from a base image, so the
 * registry is preferred). null = unknown.
 */
export function installedVersion(input: {
  tag: string | null;
  labels: Readonly<Record<string, string>>;
  resolvedVersion: string | null;
}): { version: string; source: VersionSource } | null {
  const label = labelVersion(input.labels);
  if (input.tag && isVersionTag(input.tag)) {
    const tagNumbers = parseVersion(input.tag)?.numbers ?? [];
    const labelNumbers = label ? (parseVersion(label)?.numbers ?? []) : [];
    const refines = labelNumbers.length > tagNumbers.length && tagNumbers.every((n, i) => labelNumbers[i] === n);
    if (refines && label) return { version: label, source: 'label' };
    if (input.resolvedVersion && refinesTag(input.resolvedVersion, input.tag)) {
      return { version: input.resolvedVersion, source: 'digest' };
    }
    return { version: input.tag, source: 'tag' };
  }
  if (input.resolvedVersion) {
    return { version: input.resolvedVersion, source: 'digest' };
  }
  return label ? { version: label, source: 'label' } : null;
}

export const IMAGE_STATES = ['up-to-date', 'update-available', 'unknown'] as const;
/** Registry state of the tag a container runs: same digest, newer image pushed, or not known (pinned, error, …). */
export type ImageState = (typeof IMAGE_STATES)[number];

/** Compares the local digests with the registry's current digest of the same tag. */
export function imageState(local: readonly string[], remote: string | null): ImageState {
  if (!remote || local.length === 0) {
    return 'unknown';
  }
  return local.includes(remote) ? 'up-to-date' : 'update-available';
}

/** Most tags whose digest is fetched when a digest is resolved to a version (each costs one registry request). */
export const MAX_RESOLVE_CANDIDATES = 40;

/**
 * Version tags worth comparing with a digest, newest and most specific first, at most {@link MAX_RESOLVE_CANDIDATES}:
 * - a floating tag: tags of the same flavour (`latest` → plain versions, `alpine` → `1.2-alpine`);
 * - a moving version tag: more specific tags of the same line and variant (`17-alpine` → `17.7-alpine`,
 *   `17.7-alpine3.22`; `1.25` → `1.25.3`).
 */
export function resolveCandidates(tags: readonly string[], tag: string | null, limit = MAX_RESOLVE_CANDIDATES): string[] {
  const line = tag && isVersionTag(tag) ? splitVersionTag(tag) : null;
  const flavour = !line && tag && !FLOATING_TAGS.has(tag.toLowerCase()) ? tag.toLowerCase() : null;
  const versionTags = tags.filter((t) => {
    if (!isVersionTag(t)) return false;
    if (line) {
      const parts = splitVersionTag(t);
      if (!parts || parts.prefix !== line.prefix || parts.numbers.length <= line.numbers.length) return false;
      if (!line.numbers.every((n, i) => parts.numbers[i] === n)) return false;
      // Same variant: `-alpine` matches `-alpine` and `-alpine3.22`; no variant matches plain builds only.
      return line.rest ? parts.rest === line.rest || new RegExp(`^${escapeRegExp(line.rest)}[\\d.]+$`).test(parts.rest) : isPlainBuild(parts.rest);
    }
    const lower = t.toLowerCase();
    if (flavour) return lower.endsWith(`-${flavour}`);
    return isPlainBuild(splitVersionTag(t)?.rest ?? '');
  });
  return versionTags.toSorted((a, b) => compareTags(b, a)).slice(0, limit);
}

/**
 * The rest of a plain version tag: nothing or a build (linuxserver's `-ls123`, `-r1`, SearXNG's `-<commit>`) – not
 * variants such as `-alpine` or `-arm64`.
 */
const isPlainBuild = (rest: string): boolean => /^(?:-ls\d+|-r\d+|-[0-9a-f]{7,40})?$/i.test(rest);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Orders version tags; on equal numbers the more specific one (more components, longer) is greater. */
function compareTags(a: string, b: string): number {
  const diff = compareVersions(a, b) ?? 0;
  if (diff !== 0) return diff;
  const parts = (parseVersion(a)?.numbers.length ?? 0) - (parseVersion(b)?.numbers.length ?? 0);
  return parts !== 0 ? parts : a.length - b.length;
}

/** A Docker endpoint reached without SSH: a mounted socket, a socket proxy or a remote engine over TCP. */
export interface DockerEndpoint {
  id: number;
  name: string;
  /** `unix:///var/run/docker.sock`, `tcp://socket-proxy:2375`, `http://…` or `https://…`. */
  url: string;
  isEnabled: boolean;
  /** Runtime and version from the last check ("docker 27.3.1"); null = not reached yet. */
  engine: string | null;
  lastCheckedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

/** Where a container runs: on a machine reached over SSH (a target) or at a Docker endpoint. */
export type DockerSource = { kind: 'target'; id: number } | { kind: 'endpoint'; id: number };

/** A container as stored (the last listing of its source plus the user's choices). */
export interface DockerContainer {
  id: number;
  source: DockerSource;
  name: string;
  containerId: string;
  image: string;
  imageId: string | null;
  state: string | null;
  repoDigests: string[];
  labels: Record<string, string>;
  /** false = not seen in the last listing (kept only because the user ignored or linked it). */
  present: boolean;
  ignored: boolean;
  /** true = linked through its labels; false = `repositoryId` chosen by the user (null = no repository). */
  linkAuto: boolean;
  repositoryId: number | null;
  /** Repository named by the labels (`owner/name`, lower case). */
  labelRepository: string | null;
  /** Installed version as last derived (kept for vulnerability impacts and linked repositories). */
  installedVersion: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Registry state of one tag (`registry/repository:tag`). */
export interface ImageTagState {
  key: string;
  remoteDigest: string | null;
  checkedAt: string | null;
  error: string | null;
  /** Remote digest a "new image" notification was sent for (or that was already known). */
  notifiedDigest: string | null;
}

/** Normalizes an endpoint URL; returns where to connect or why the URL is not usable. */
export function parseEndpointUrl(input: string): { baseUrl: string; unixSocket: string | null; url: string } | { error: string } {
  const value = input.trim();
  if (value.startsWith('/')) {
    return { baseUrl: 'http://localhost', unixSocket: value, url: `unix://${value}` };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'Enter unix:///var/run/docker.sock, tcp://host:2375 or an http(s):// URL.' };
  }
  if (parsed.protocol === 'unix:') {
    const path = decodeURIComponent(parsed.pathname);
    if (!path.startsWith('/') || path.length < 2) {
      return { error: 'Enter the absolute path of the socket, e.g. unix:///var/run/docker.sock.' };
    }
    return { baseUrl: 'http://localhost', unixSocket: path, url: `unix://${path}` };
  }
  if (parsed.protocol !== 'tcp:' && parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'Use unix://, tcp://, http:// or https://.' };
  }
  if (!parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { error: 'Enter a host and port without credentials, query or fragment, e.g. tcp://socket-proxy:2375.' };
  }
  const scheme = parsed.protocol === 'https:' ? 'https' : 'http';
  const port = parsed.port || (parsed.protocol === 'tcp:' ? '2375' : '');
  const path = parsed.pathname.replace(/\/+$/, '');
  const base = `${scheme}://${parsed.hostname.includes(':') && !parsed.hostname.startsWith('[') ? `[${parsed.hostname}]` : parsed.hostname}${port ? `:${port}` : ''}${path}`;
  return { baseUrl: base, unixSocket: null, url: parsed.protocol === 'tcp:' ? `tcp://${base.slice(7)}` : base };
}

/**
 * Lists the running containers with the `docker` or `podman` CLI (whichever exists): one `C {json}` line per container
 * and one `I {json}` line per image (its RepoDigests). Prints `runtime none` when neither is installed.
 */
export const DOCKER_LIST_SCRIPT = [
  'if command -v docker >/dev/null 2>&1; then rt=docker; elif command -v podman >/dev/null 2>&1; then rt=podman; else echo "runtime none"; exit 0; fi',
  `if [ "$rt" = podman ]; then image='{{json .ImageName}}'; else image='{{json .Config.Image}}'; fi`,
  `v=$($rt version --format '{{.Server.Version}}' 2>/dev/null || $rt version --format '{{.Client.Version}}' 2>/dev/null)`,
  'echo "runtime $rt $v"',
  'ids=$($rt ps -q --no-trunc) || exit $?',
  '[ -n "$ids" ] || exit 0',
  `$rt inspect --format "C {\\"id\\":{{json .Id}},\\"name\\":{{json .Name}},\\"image\\":$image,\\"imageId\\":{{json .Image}},\\"state\\":{{json .State.Status}},\\"labels\\":{{json .Config.Labels}}}" $ids || exit $?`,
  `imgs=$($rt inspect --format '{{.Image}}' $ids | sort -u)`,
  `$rt image inspect --format 'I {"id":{{json .Id}},"repoDigests":{{json .RepoDigests}}}' $imgs`,
].join('\n');

/** Adds the `sha256:` prefix Podman leaves out. */
const imageIdOf = (id: string): string => (id.startsWith('sha256:') || !/^[0-9a-f]{64}$/.test(id) ? id : `sha256:${id}`);

/** Parses the output of {@link DOCKER_LIST_SCRIPT}; null when neither Docker nor Podman is installed. */
export function parseDockerListOutput(output: string): EngineListing | null {
  let runtime: DockerRuntime | null = null;
  let version: string | null = null;
  const containers: EngineContainer[] = [];
  const digests = new Map<string, string[]>();
  for (const raw of output.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('runtime ')) {
      const [, name, ver] = line.split(/\s+/);
      if (name === 'none') {
        return null;
      }
      runtime = name === 'podman' ? 'podman' : 'docker';
      version = ver || null;
    } else if (line.startsWith('C {')) {
      const c = parseObject(line.slice(2));
      if (c && typeof c['id'] === 'string') {
        containers.push({
          id: c['id'],
          name: String(c['name'] ?? '').replace(/^\//, ''),
          image: String(c['image'] ?? ''),
          imageId: imageIdOf(String(c['imageId'] ?? '')),
          state: String(c['state'] ?? 'running'),
          labels: keptLabels(c['labels'] as Record<string, unknown> | null),
          repoDigests: [],
        });
      }
    } else if (line.startsWith('I {')) {
      const image = parseObject(line.slice(2));
      if (image && typeof image['id'] === 'string' && Array.isArray(image['repoDigests'])) {
        digests.set(imageIdOf(image['id']), image['repoDigests'].filter((d): d is string => typeof d === 'string'));
      }
    }
  }
  if (!runtime) {
    throw new Error(output.trim().split('\n').slice(-3).join(' ').slice(0, 300) || 'No output from the container runtime.');
  }
  for (const c of containers) {
    c.repoDigests = digests.get(c.imageId) ?? [];
  }
  return { runtime, version, containers };
}

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(json) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** "docker 27.3.1" / "podman 5.2.0". */
export const engineLabel = (listing: Pick<EngineListing, 'runtime' | 'version'>): string =>
  listing.version ? `${listing.runtime} ${listing.version}` : listing.runtime;
