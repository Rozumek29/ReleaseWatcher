/**
 * Home Assistant as a source of installed versions: a connection (URL + long-lived access token) whose update
 * entities are read through the REST API (`GET /api/states`). Pure logic – the API is called by
 * `../proxmox/home-assistant-api.ts`, the same client the Home Assistant OS check of a virtual machine uses.
 *
 * An update entity names what is installed (`installed_version`) and, in `release_url`, where its releases are. Those
 * that name a repository ReleaseWatcher can watch become components; device firmware and entities without such a link
 * are left out.
 */
import { fullName, parseRepositoryName, parseRepositoryReference } from '../domain.ts';
import { parseVersion } from '../version.ts';

/** A Home Assistant instance reached over HTTP with a long-lived access token. */
export interface HomeAssistantConnection {
  id: number;
  name: string;
  /** Base URL without a trailing slash, e.g. `http://192.168.1.60:8123`. */
  url: string;
  token: string;
  /** Disabled connections are skipped by scheduled checks. */
  isEnabled: boolean;
  /** When the update entities were last read; null = not yet. */
  lastCheckedAt: string | null;
  /** Why the last check failed; null = it worked (or none ran yet). */
  lastError: string | null;
  createdAt: string;
}

/** An update entity of a connection that names a repository. */
export interface HomeAssistantComponent {
  id: number;
  connectionId: number;
  /** `update.…` – unique within a connection. */
  entityId: string;
  name: string;
  /**
   * Home Assistant reports an update (state `on`). Not the same as "installed differs from latest": a newer
   * pre-release than the latest version, or a skipped version, is no update.
   */
  hasUpdate: boolean;
  installedVersion: string | null;
  /** Newest version Home Assistant knows of (it checks on its own schedule). */
  latestVersion: string | null;
  releaseUrl: string | null;
  /** Repository named by the entity as its lower-case `fullName()`. */
  repository: string;
}

/** A component as read from the states, before it is stored. */
export type ReadComponent = Omit<HomeAssistantComponent, 'id' | 'connectionId'>;

/** Longest name accepted for a connection. */
export const MAX_NAME_LENGTH = 100;
/** Longest access token accepted (Home Assistant's are JWTs of about 180 characters). */
export const MAX_TOKEN_LENGTH = 1000;

/** Home Assistant Core links its release notes page instead of a repository. */
export const CORE_ENTITY_ID = 'update.home_assistant_core_update';
export const CORE_REPOSITORY = 'home-assistant/core';

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Repository an update entity names, as its lower-case `fullName()`: from the release URL – on GitHub the repository
 * or its releases (`https://github.com/<owner>/<repo>/releases/tag/<version>`), on a Gitea/Forgejo or GitLab instance
 * the URL of its releases. Null when the URL is something else (a file in a repository, a release notes page, nothing).
 */
export function entityRepository(entityId: string, releaseUrl: string | null): string | null {
  if (entityId === CORE_ENTITY_ID) {
    return CORE_REPOSITORY;
  }
  if (!releaseUrl) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(releaseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  if (url.host.toLowerCase().replace(/^www\./, '') === 'github.com') {
    // The repository itself or its releases – not a file in it (a blueprint, the changelog of one add-on of many).
    const [owner, name, page] = url.pathname.split('/').filter(Boolean);
    if (page !== undefined && page !== 'releases') {
      return null;
    }
    const parsed = parseRepositoryName(`${owner ?? ''}/${name ?? ''}`);
    return parsed ? `${parsed.owner}/${parsed.name}`.toLowerCase() : null;
  }
  // Elsewhere any page has a path, so only the releases of a repository count: `/<owner>/<repo>/releases…` on
  // Gitea/Forgejo, `/<group>/<project>/-/releases…` on GitLab.
  const segments = url.pathname.split('/').filter(Boolean);
  const releases = segments.indexOf('releases');
  const path = segments.slice(0, releases).filter((segment) => segment !== '-');
  if (releases < 0 || path.length < 2) {
    return null;
  }
  const parsed = parseRepositoryReference(`${url.origin}/${path.join('/')}`);
  return parsed ? fullName(parsed).toLowerCase() : null;
}

/**
 * Maps `GET /api/states` to the components: every update entity that names a repository, whether an update is pending
 * or not. Sorted by name.
 */
export function componentsFromStates(states: unknown): ReadComponent[] {
  if (!Array.isArray(states)) {
    throw new Error('Home Assistant answered with something other than a list of states.');
  }
  const result: ReadComponent[] = [];
  for (const state of states as Record<string, unknown>[]) {
    const entityId = str(state?.['entity_id']);
    if (!entityId?.startsWith('update.')) {
      continue;
    }
    const attributes = (typeof state['attributes'] === 'object' && state['attributes'] !== null ? state['attributes'] : {}) as Record<
      string,
      unknown
    >;
    const releaseUrl = str(attributes['release_url']);
    const repository = entityRepository(entityId, releaseUrl);
    if (!repository) {
      continue;
    }
    result.push({
      entityId,
      name: (str(attributes['title']) ?? str(attributes['friendly_name']) ?? entityId).slice(0, 200),
      installedVersion: str(attributes['installed_version'])?.slice(0, 100) ?? null,
      latestVersion: str(attributes['latest_version'])?.slice(0, 100) ?? null,
      releaseUrl: releaseUrl?.slice(0, 500) ?? null,
      repository,
      hasUpdate: state['state'] === 'on',
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));
}

/** A commit hash as version (repositories without releases): hexadecimal with at least one letter, no dots. */
const COMMIT_HASH = /^(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}$/i;

/** Whether a version can be compared with releases; a commit hash can only be shown. */
export const isComparableVersion = (version: string | null): boolean =>
  version !== null && !COMMIT_HASH.test(version) && parseVersion(version) !== null;
