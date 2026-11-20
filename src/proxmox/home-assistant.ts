/**
 * Home Assistant OS in a virtual machine: pending updates and how to install them. Pure logic – the guest commands
 * run through `qm guest exec` (see {@link HA_CHECK_SCRIPT}), the Home Assistant API is called by
 * `home-assistant-api.ts`.
 *
 * Two kinds of updates exist:
 * - **Supervisor** components – Home Assistant Core, the operating system, the Supervisor and apps (add-ons). They are
 *   read live with the `ha` CLI on the HAOS host and installed with it; no token is needed.
 * - **Update entities** of integrations – e.g. integrations installed from the built-in marketplace (formerly HACS) or
 *   device firmware. Without a token they are read from `core.restore_state`, which Home Assistant writes every
 *   15 minutes; with a long-lived access token they are read live from the REST API. Installing them needs the token.
 */

/** Where an update comes from. */
export const HA_UPDATE_SOURCES = ['core', 'os', 'supervisor', 'app', 'entity'] as const;
export type HomeAssistantUpdateSource = (typeof HA_UPDATE_SOURCES)[number];

/** One pending update of Home Assistant. */
export interface HomeAssistantUpdate {
  /** `core`, `os`, `supervisor`, `app:<slug>` or the entity ID (`update.…`). */
  id: string;
  source: HomeAssistantUpdateSource;
  name: string;
  installedVersion: string | null;
  latestVersion: string;
  releaseUrl: string | null;
  /** Integration that provides the update entity (e.g. `marketplace`); null for Supervisor components. */
  platform: string | null;
  /** Home Assistant can install it (`update.install`); false for entities that only announce an update. */
  installable: boolean;
}

/** Home Assistant OS found in a virtual machine by the last check. */
export interface HomeAssistantState {
  coreVersion: string | null;
  osVersion: string | null;
  updates: HomeAssistantUpdate[];
  /**
   * When Home Assistant last saved the states the update entities were read from (no token); null when they were
   * read live through the API.
   */
  entitiesSavedAt: string | null;
}

/** Storage directory of Home Assistant Core on the HAOS host. */
const HA_STORAGE = '/mnt/data/supervisor/homeassistant/.storage';

/**
 * Check step run on the HAOS host (as root, through the QEMU guest agent). Prints `none` outside Home Assistant OS;
 * otherwise one `<key> <single-line JSON>` line per source:
 * - `core` / `os` / `supervisor` – `ha <x> info --raw-json` (the Supervisor's lists its apps with their versions),
 * - `entities` – update entities that are `on` in `core.restore_state` (saved every 15 minutes, read without a token),
 * - `registry` – `[entity_id, platform]` of every update entity (tells Supervisor entities and integrations apart),
 * - `saved` – modification time of `core.restore_state` (Unix seconds).
 * Reads only; never prints a secret (the files hold no tokens in the selected fields).
 */
export const HA_CHECK_SCRIPT = String.raw`grep -qs '^ID=haos$' /etc/os-release || { echo none; exit 0; }
s=${HA_STORAGE}
echo haos
for c in core os supervisor; do printf '%s ' "$c"; ha "$c" info --raw-json 2>&1 | tr -d '\n'; echo; done
printf 'entities '; jq -c '[.data[].state | select(.entity_id | startswith("update.")) | select(.state == "on") | {id: .entity_id, name: (.attributes.title // .attributes.friendly_name), installed: .attributes.installed_version, latest: .attributes.latest_version, url: .attributes.release_url, features: .attributes.supported_features}]' "$s/core.restore_state" 2>&1 | tr -d '\n'; echo
printf 'registry '; jq -c '[.data.entities[] | select(.entity_id | startswith("update.")) | [.entity_id, .platform]]' "$s/core.entity_registry" 2>&1 | tr -d '\n'; echo
printf 'saved '; stat -c %Y "$s/core.restore_state" 2>&1`;

/** An update entity as read from `core.restore_state` or the REST API. */
export interface UpdateEntity {
  id: string;
  name: string | null;
  installed: string | null;
  latest: string | null;
  url: string | null;
  /** The entity supports `update.install` (bit 1 of `supported_features`). */
  installable: boolean;
}

/** `UpdateEntityFeature.INSTALL` – entities without it only announce an update (e.g. a server running elsewhere). */
const FEATURE_INSTALL = 1;

/** Reads the install feature; unknown features count as installable (Home Assistant decides when installing). */
const supportsInstall = (features: unknown): boolean => typeof features !== 'number' || (features & FEATURE_INSTALL) !== 0;

/** Output of {@link HA_CHECK_SCRIPT}; `null` when the guest is not Home Assistant OS. */
export interface HomeAssistantProbe {
  coreVersion: string | null;
  osVersion: string | null;
  /** Pending Supervisor components (Core, OS, Supervisor, apps). */
  supervisorUpdates: HomeAssistantUpdate[];
  /** Pending update entities from `core.restore_state`; null when the file could not be read. */
  savedEntities: UpdateEntity[] | null;
  /** Integration of every update entity (entity ID → platform). */
  platforms: Map<string, string>;
  savedAt: string | null;
  /** Problems reading single sources (the rest of the result is still valid). */
  errors: string[];
}

const PLATFORM_SUPERVISOR = 'hassio';

/** Platforms whose updates need a restart of Home Assistant Core to take effect (custom integrations). */
const RESTART_PLATFORMS = new Set(['marketplace', 'hacs']);

const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);

/** Parses one `ha … --raw-json` answer (`{"result":"ok","data":{…}}`). */
function parseCli(text: string | undefined, label: string, errors: string[]): Record<string, unknown> | null {
  if (text === undefined) {
    errors.push(`${label}: no answer`);
    return null;
  }
  try {
    const json = JSON.parse(text) as { result?: unknown; data?: unknown; message?: unknown };
    if (json.result === 'ok' && typeof json.data === 'object' && json.data !== null) {
      return json.data as Record<string, unknown>;
    }
    errors.push(`${label}: ${str(json.message) ?? 'unexpected answer'}`);
  } catch {
    errors.push(`${label}: ${text.slice(0, 200) || 'no answer'}`);
  }
  return null;
}

/** A pending Supervisor component from its `info` data; null when it is up to date. */
function supervisorUpdate(
  data: Record<string, unknown> | null,
  id: string,
  source: HomeAssistantUpdateSource,
  name: string,
): HomeAssistantUpdate | null {
  const latest = str(data?.['version_latest']);
  if (!data || data['update_available'] !== true || !latest) {
    return null;
  }
  return {
    id,
    source,
    name,
    installedVersion: str(data['version']),
    latestVersion: latest,
    releaseUrl: null,
    platform: null,
    installable: true,
  };
}

/** Parses an array of update entities (`entities` line or the REST API mapped to the same shape). */
export function parseUpdateEntities(value: unknown): UpdateEntity[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null && typeof e['id'] === 'string')
    .map((e) => ({
      id: e['id'] as string,
      name: str(e['name']),
      installed: str(e['installed']),
      latest: str(e['latest']),
      url: str(e['url']),
      installable: supportsInstall(e['features']),
    }));
}

/** Parses the output of {@link HA_CHECK_SCRIPT}; null when the guest does not run Home Assistant OS. */
export function parseHomeAssistantProbe(output: string): HomeAssistantProbe | null {
  const lines = new Map<string, string>();
  let haos = false;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === 'haos') {
      haos = true;
      continue;
    }
    const space = trimmed.indexOf(' ');
    if (space > 0) {
      lines.set(trimmed.slice(0, space), trimmed.slice(space + 1));
    }
  }
  if (!haos) {
    return null;
  }
  const errors: string[] = [];
  const core = parseCli(lines.get('core'), 'ha core info', errors);
  const os = parseCli(lines.get('os'), 'ha os info', errors);
  const supervisor = parseCli(lines.get('supervisor'), 'ha supervisor info', errors);

  const supervisorUpdates: HomeAssistantUpdate[] = [];
  const add = (update: HomeAssistantUpdate | null) => update && supervisorUpdates.push(update);
  add(supervisorUpdate(core, 'core', 'core', 'Home Assistant Core'));
  add(supervisorUpdate(os, 'os', 'os', 'Home Assistant Operating System'));
  add(supervisorUpdate(supervisor, 'supervisor', 'supervisor', 'Home Assistant Supervisor'));
  // Add-ons were renamed to apps; newer Supervisors may list them under either key.
  const apps = supervisor?.['addons'] ?? supervisor?.['apps'];
  if (Array.isArray(apps)) {
    for (const app of apps as Record<string, unknown>[]) {
      const slug = str(app?.['slug']);
      if (slug) add(supervisorUpdate(app, `app:${slug}`, 'app', str(app['name']) ?? slug));
    }
  }

  let savedEntities: UpdateEntity[] | null = null;
  try {
    savedEntities = parseUpdateEntities(JSON.parse(lines.get('entities') ?? ''));
  } catch {
    // reported below
  }
  if (!savedEntities) {
    errors.push(`saved entity states: ${(lines.get('entities') ?? 'no answer').slice(0, 200)}`);
  }

  const platforms = new Map<string, string>();
  try {
    const registry = JSON.parse(lines.get('registry') ?? '') as unknown;
    if (Array.isArray(registry)) {
      for (const entry of registry) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
          platforms.set(entry[0], entry[1]);
        }
      }
    }
  } catch {
    errors.push(`entity registry: ${(lines.get('registry') ?? 'no answer').slice(0, 200)}`);
  }

  const seconds = Number(lines.get('saved'));
  return {
    coreVersion: str(core?.['version']),
    osVersion: str(os?.['version']),
    supervisorUpdates,
    savedEntities,
    platforms,
    savedAt: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    errors,
  };
}

/**
 * Pending updates of Home Assistant: the Supervisor components (live) followed by the update entities of
 * integrations. Entities of the Supervisor integration (`hassio`) are left out – they mirror the components – and so
 * are entities without a newer version.
 */
export function homeAssistantUpdates(
  supervisorUpdates: readonly HomeAssistantUpdate[],
  entities: readonly UpdateEntity[],
  platforms: ReadonlyMap<string, string>,
): HomeAssistantUpdate[] {
  const result = [...supervisorUpdates];
  for (const entity of entities) {
    const platform = platforms.get(entity.id) ?? null;
    if (platform === PLATFORM_SUPERVISOR || !entity.latest || entity.latest === entity.installed) {
      continue;
    }
    result.push({
      id: entity.id,
      source: 'entity',
      name: entity.name ?? entity.id,
      installedVersion: entity.installed,
      latestVersion: entity.latest,
      releaseUrl: entity.url,
      platform,
      installable: entity.installable,
    });
  }
  return result;
}

/** Maps `GET /api/states` of the REST API to the pending update entities. */
export function updateEntitiesFromStates(states: unknown): UpdateEntity[] {
  if (!Array.isArray(states)) {
    throw new Error('Home Assistant answered with something other than a list of states.');
  }
  const result: UpdateEntity[] = [];
  for (const state of states as Record<string, unknown>[]) {
    const id = str(state?.['entity_id']);
    if (!id?.startsWith('update.') || state['state'] !== 'on') {
      continue;
    }
    const attributes = (typeof state['attributes'] === 'object' && state['attributes'] !== null ? state['attributes'] : {}) as Record<
      string,
      unknown
    >;
    result.push({
      id,
      name: str(attributes['title']) ?? str(attributes['friendly_name']),
      installed: str(attributes['installed_version']),
      latest: str(attributes['latest_version']),
      url: str(attributes['release_url']),
      installable: supportsInstall(attributes['supported_features']),
    });
  }
  return result;
}

/** What allows installing Home Assistant updates of a virtual machine from ReleaseWatcher. */
export interface InstallContext {
  /** Installing is switched on for the virtual machine (off = updates are only checked and reported). */
  enabled: boolean;
  /** URL and token of the REST API are configured (needed for update entities). */
  hasApi: boolean;
}

/** Shown for every update while installing from ReleaseWatcher is switched off. */
export const INSTALL_DISABLED_MESSAGE =
  'Installing from ReleaseWatcher is switched off for this virtual machine – install it in Home Assistant.';

/**
 * Why an update cannot be installed from ReleaseWatcher; null when it can. Installing can be switched off per virtual
 * machine (check-only); the operating system reboots the virtual machine (and with it the guest agent connection), so
 * it is installed from Home Assistant itself; update entities need the API token.
 */
export function installBlocker(update: Pick<HomeAssistantUpdate, 'source' | 'installable'>, context: InstallContext): string | null {
  if (!context.enabled) {
    return INSTALL_DISABLED_MESSAGE;
  }
  // Saved by an older version without the flag: let Home Assistant decide.
  if (update.installable === false) {
    return 'Home Assistant only announces this update – install it where it runs.';
  }
  if (update.source === 'os') {
    return 'The operating system update restarts the virtual machine – install it in Home Assistant (Settings → System → Updates).';
  }
  if (update.source === 'entity' && !context.hasApi) {
    return 'Add a Home Assistant access token in the settings of this virtual machine to install integration updates.';
  }
  return null;
}

/** Updates that can be installed from ReleaseWatcher. */
export const installableUpdates = (state: HomeAssistantState | null, context: InstallContext): HomeAssistantUpdate[] =>
  state?.updates.filter((u) => installBlocker(u, context) === null) ?? [];

/** Order of installation: integrations and apps first, then the Supervisor, Home Assistant Core last (it restarts). */
const INSTALL_ORDER: Record<HomeAssistantUpdateSource, number> = { entity: 0, app: 1, supervisor: 2, core: 3, os: 4 };

export const sortForInstall = (updates: readonly HomeAssistantUpdate[]): HomeAssistantUpdate[] =>
  updates.toSorted((a, b) => INSTALL_ORDER[a.source] - INSTALL_ORDER[b.source]);

/** True when installing the update needs a restart of Home Assistant Core afterwards (custom integrations). */
export const needsCoreRestart = (update: Pick<HomeAssistantUpdate, 'source' | 'platform'>): boolean =>
  update.source === 'entity' && update.platform !== null && RESTART_PLATFORMS.has(update.platform);

const SLUG = /^[a-z0-9_-]+$/i;

/**
 * Guest command installing a Supervisor component with the `ha` CLI (newer CLIs call add-ons apps; older ones only
 * know `ha addons`). Throws for update entities, which are installed through the API.
 */
export function supervisorUpdateCommand(update: Pick<HomeAssistantUpdate, 'id' | 'source'>): string {
  switch (update.source) {
    case 'core':
      return 'ha core update';
    case 'supervisor':
      return 'ha supervisor update';
    case 'os':
      return 'ha os update';
    case 'app': {
      const slug = update.id.slice('app:'.length);
      if (!SLUG.test(slug)) {
        throw new Error(`Invalid app slug "${slug}".`);
      }
      return `if ha apps --help >/dev/null 2>&1; then ha apps update ${slug}; else ha addons update ${slug}; fi`;
    }
    case 'entity':
      throw new Error('Update entities are installed through the Home Assistant API.');
  }
}

/** Guest command restarting Home Assistant Core (loads updated custom integrations). */
export const CORE_RESTART_COMMAND = 'ha core restart';

/** Checks a Home Assistant URL; returns the normalised base URL (no trailing slash) or an error message. */
export function normalizeHomeAssistantUrl(value: string): { url: string } | { error: string } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { error: 'Enter a full URL, e.g. http://192.168.1.20:8123.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: 'The URL must start with http:// or https://.' };
  }
  if (url.username || url.password || url.search || url.hash) {
    return { error: 'Enter only the address of Home Assistant, without credentials, query or fragment.' };
  }
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, '')}` };
}
