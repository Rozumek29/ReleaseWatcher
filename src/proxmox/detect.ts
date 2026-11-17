import { shQuote } from './domain.ts';

/**
 * Detection of applications installed in a container, and of the GitHub repository each one is released from.
 *
 * Proxmox VE Helper Scripts (community-scripts) leave two traces in their containers:
 * - `/usr/bin/update` runs the script the container was created with (`…/ct/<slug>.sh`),
 * - the installed version in `~/.<app>` (newer scripts) or `/opt/<App>_version.txt` (older ones).
 * The `ct/<slug>.sh` script itself names the upstream repository (a `# Source: …github.com/owner/repo` header or
 * `fetch_and_deploy_gh_release "app" "owner/repo"`). Everything here is pure; the service runs the commands.
 */

/**
 * Runs inside the container and prints `update<TAB><ct/slug.sh>` and `file<TAB><path><TAB><first line>` for small
 * version files. Always exits 0 – missing files are simply not reported.
 */
export const DETECT_SCRIPT = [
  "if [ -f /usr/bin/update ]; then printf 'update\\t%s\\n' \"$(grep -o 'ct/[A-Za-z0-9_.-]*\\.sh' /usr/bin/update | head -n 1)\"; fi",
  'for f in /opt/*_version.txt "$HOME"/.[!.]*; do',
  '  [ -f "$f" ] || continue',
  '  s=$(wc -c < "$f")',
  '  [ $s -le 200 ] || continue',
  "  printf 'file\\t%s\\t%s\\n' \"$f\" \"$(head -n 1 \"$f\" | tr -d '\\r')\"",
  'done',
  'exit 0',
].join('\n');

export const DETECT_TIMEOUT_SECONDS = 20;

/** URL of the community-scripts container script of an application. */
export const communityScriptUrl = (slug: string): string =>
  `https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/${encodeURIComponent(slug)}.sh`;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/i;

/** Something that looks like a version number or a commit hash. */
const VERSION_PATTERN = /^(?:v?\d+(?:[.\-_+]\w+)*|[0-9a-f]{7,40})$/i;

export interface VersionFile {
  path: string;
  /** Name of the application derived from the file name (`~/.vaultwarden`, `/opt/Vaultwarden_version.txt`). */
  appName: string;
  version: string;
}

export interface DetectionProbe {
  /** Slug of the community-scripts script from `/usr/bin/update` (e.g. `vaultwarden`); null when there is none. */
  scriptSlug: string | null;
  versionFiles: VersionFile[];
}

/** Parses the output of {@link DETECT_SCRIPT}. */
export function parseDetectOutput(output: string): DetectionProbe {
  let scriptSlug: string | null = null;
  const versionFiles: VersionFile[] = [];
  for (const line of output.split('\n')) {
    const parts = line.replace(/\r$/, '').split('\t');
    if (parts[0] === 'update') {
      const slug = parts[1]?.match(/ct\/([^/]+)\.sh$/)?.[1];
      if (slug && SLUG_PATTERN.test(slug)) {
        scriptSlug = slug;
      }
    } else if (parts[0] === 'file' && parts.length >= 3) {
      const path = parts[1]!;
      const version = parts.slice(2).join('\t').trim();
      const fileName = path.slice(path.lastIndexOf('/') + 1);
      const appName = fileName.endsWith('_version.txt') ? fileName.slice(0, -'_version.txt'.length) : fileName.replace(/^\./, '');
      if (appName && VERSION_PATTERN.test(version)) {
        versionFiles.push({ path, appName, version });
      }
    }
  }
  return { scriptSlug, versionFiles };
}

/** Lower-case letters and digits only: `Uptime-Kuma`, `uptimekuma` and `uptime_kuma` are the same application. */
export const normalizeAppName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

export interface KnownApp {
  name: string;
  /** `owner/repo` on GitHub. */
  repository: string;
}

/**
 * Popular self-hosted applications by normalized name (community-scripts slug or version file name). Used before
 * downloading the community-scripts script, and for applications installed without it.
 */
export const KNOWN_APPS: ReadonlyMap<string, KnownApp> = new Map(
  (
    [
      ['vaultwarden', 'Vaultwarden', 'dani-garcia/vaultwarden'],
      ['jellyfin', 'Jellyfin', 'jellyfin/jellyfin'],
      ['jellyseerr', 'Jellyseerr', 'Fallenbagel/jellyseerr'],
      ['overseerr', 'Overseerr', 'sct/overseerr'],
      ['sonarr', 'Sonarr', 'Sonarr/Sonarr'],
      ['radarr', 'Radarr', 'Radarr/Radarr'],
      ['prowlarr', 'Prowlarr', 'Prowlarr/Prowlarr'],
      ['lidarr', 'Lidarr', 'Lidarr/Lidarr'],
      ['readarr', 'Readarr', 'Readarr/Readarr'],
      ['bazarr', 'Bazarr', 'morpheus65535/bazarr'],
      ['jackett', 'Jackett', 'Jackett/Jackett'],
      ['sabnzbd', 'SABnzbd', 'sabnzbd/sabnzbd'],
      ['tautulli', 'Tautulli', 'Tautulli/Tautulli'],
      ['adguard', 'AdGuard Home', 'AdguardTeam/AdGuardHome'],
      ['adguardhome', 'AdGuard Home', 'AdguardTeam/AdGuardHome'],
      ['uptimekuma', 'Uptime Kuma', 'louislam/uptime-kuma'],
      ['paperlessngx', 'Paperless-ngx', 'paperless-ngx/paperless-ngx'],
      ['immich', 'Immich', 'immich-app/immich'],
      ['gitea', 'Gitea', 'go-gitea/gitea'],
      ['homepage', 'Homepage', 'gethomepage/homepage'],
      ['mealie', 'Mealie', 'mealie-recipes/mealie'],
      ['audiobookshelf', 'Audiobookshelf', 'advplyr/audiobookshelf'],
      ['navidrome', 'Navidrome', 'navidrome/navidrome'],
      ['nginxproxymanager', 'Nginx Proxy Manager', 'NginxProxyManager/nginx-proxy-manager'],
      ['zigbee2mqtt', 'Zigbee2MQTT', 'Koenkk/zigbee2mqtt'],
      ['nodered', 'Node-RED', 'node-red/node-red'],
      ['grafana', 'Grafana', 'grafana/grafana'],
      ['prometheus', 'Prometheus', 'prometheus/prometheus'],
      ['syncthing', 'Syncthing', 'syncthing/syncthing'],
      ['n8n', 'n8n', 'n8n-io/n8n'],
      ['actualbudget', 'Actual Budget', 'actualbudget/actual'],
      ['pihole', 'Pi-hole', 'pi-hole/pi-hole'],
      ['wikijs', 'Wiki.js', 'requarks/wiki'],
      ['stirlingpdf', 'Stirling-PDF', 'Stirling-Tools/Stirling-PDF'],
      ['changedetection', 'changedetection.io', 'dgtlmoon/changedetection.io'],
      ['esphome', 'ESPHome', 'esphome/esphome'],
      ['frigate', 'Frigate', 'blakeblackshear/frigate'],
      ['memos', 'Memos', 'usememos/memos'],
      ['traefik', 'Traefik', 'traefik/traefik'],
      ['caddy', 'Caddy', 'caddyserver/caddy'],
      ['komga', 'Komga', 'gotson/komga'],
      ['kavita', 'Kavita', 'Kareadita/Kavita'],
      ['freshrss', 'FreshRSS', 'FreshRSS/FreshRSS'],
      ['photoprism', 'PhotoPrism', 'photoprism/photoprism'],
      ['bookstack', 'BookStack', 'BookStackApp/BookStack'],
      ['gotify', 'Gotify', 'gotify/server'],
      ['ntfy', 'ntfy', 'binwiederhier/ntfy'],
      ['umami', 'Umami', 'umami-software/umami'],
      ['dashy', 'Dashy', 'Lissy93/dashy'],
      ['linkwarden', 'Linkwarden', 'linkwarden/linkwarden'],
    ] as const
  ).map(([key, name, repository]) => [key, { name, repository }]),
);

/** Owners whose repositories host install scripts, not the applications themselves. */
const SCRIPT_OWNERS = new Set(['community-scripts', 'tteck']);

const REPO_PART = '[A-Za-z0-9_.-]+';

const cleanRepository = (owner: string, name: string): string | null => {
  const repo = name.replace(/\.git$/, '').replace(/\.+$/, '');
  if (!repo || SCRIPT_OWNERS.has(owner.toLowerCase())) {
    return null;
  }
  return `${owner}/${repo}`;
};

/**
 * The upstream GitHub repository named in a community-scripts `ct/<slug>.sh` script: the `# Source:` header
 * first, then the release helpers used by its update function. Null when the script names none.
 */
export function repositoryFromScript(script: string): string | null {
  const header = script
    .split('\n')
    .slice(0, 30)
    .filter((line) => line.startsWith('#'));
  for (const line of header) {
    for (const match of line.matchAll(new RegExp(`github\\.com/(${REPO_PART})/(${REPO_PART})`, 'g'))) {
      const repo = cleanRepository(match[1]!, match[2]!);
      if (repo) {
        return repo;
      }
    }
  }
  const patterns = [
    new RegExp(`(?:fetch_and_deploy_gh_release|check_for_gh_release)\\s+"[^"]*"\\s+"(${REPO_PART})/(${REPO_PART})"`),
    new RegExp(`get_latest_github_release\\s+"(${REPO_PART})/(${REPO_PART})"`),
    new RegExp(`api\\.github\\.com/repos/(${REPO_PART})/(${REPO_PART})`),
  ];
  for (const pattern of patterns) {
    const match = script.match(pattern);
    const repo = match ? cleanRepository(match[1]!, match[2]!) : null;
    if (repo) {
      return repo;
    }
  }
  return null;
}

/** The `APP="Name"` of a community-scripts script. */
export const appNameFromScript = (script: string): string | null =>
  script.match(/^APP="([^"\n]{1,100})"/m)?.[1]?.trim() || null;

/** One application found in a container (a suggestion – nothing is saved). */
export interface DetectedApp {
  name: string;
  /** community-scripts slug, null for applications found by a version file only. */
  slug: string | null;
  versionCommand: string | null;
  installedVersion: string | null;
  updateCommand: string | null;
  /** `owner/repo` on GitHub, null when unknown. */
  repository: string | null;
}

const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const catCommand = (path: string): string => `cat ${/^[\w./-]+$/.test(path) ? path : shQuote(path)}`;

/**
 * Builds the suggestions from what was found in the container. A community-scripts container yields its one
 * application (with `update` as update command); without a script, every `/opt/*_version.txt` file and the dot
 * files of known applications are suggestions.
 * `resolve` returns the repository (and display name) for an application name, or null.
 */
export function detectedApps(
  probe: DetectionProbe,
  resolve: (name: string) => { repository: string | null; name: string | null },
): DetectedApp[] {
  const fromFile = (file: VersionFile) => ({
    versionCommand: catCommand(file.path),
    installedVersion: file.version,
  });

  if (probe.scriptSlug) {
    const slug = probe.scriptSlug;
    const resolved = resolve(slug);
    const keys = new Set([normalizeAppName(slug)]);
    if (resolved.name) keys.add(normalizeAppName(resolved.name));
    if (resolved.repository) keys.add(normalizeAppName(resolved.repository.split('/')[1] ?? ''));
    // The version file of the application itself; a single version file in the container is taken as well.
    const file =
      probe.versionFiles.find((f) => keys.has(normalizeAppName(f.appName))) ??
      (probe.versionFiles.length === 1 ? probe.versionFiles[0] : undefined);
    return [
      {
        name: resolved.name ?? capitalize(slug),
        slug,
        ...(file ? fromFile(file) : { versionCommand: null, installedVersion: null }),
        updateCommand: 'update',
        repository: resolved.repository,
      },
    ];
  }

  const seen = new Set<string>();
  const result: DetectedApp[] = [];
  for (const file of probe.versionFiles) {
    const key = normalizeAppName(file.appName);
    if (!key || seen.has(key)) {
      continue;
    }
    const resolved = resolve(file.appName);
    // Other dot files in the home directory are only taken for known applications.
    if (!file.path.startsWith('/opt/') && !resolved.repository) {
      continue;
    }
    seen.add(key);
    result.push({
      name: resolved.name ?? capitalize(file.appName),
      slug: null,
      ...fromFile(file),
      updateCommand: null,
      repository: resolved.repository,
    });
  }
  return result;
}
