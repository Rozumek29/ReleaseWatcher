/**
 * Version parsing/comparison and reading the version of an installed (self-hosted) application.
 */

export interface ParsedVersion {
  numbers: number[];
  /** Pre-release suffix such as "beta.1" (empty for stable versions). */
  prerelease: string;
}

const VERSION_PATTERN = /(\d+(?:\.\d+)*)(?:[-+_.]?((?:alpha|beta|rc|pre|preview|dev|nightly)[\w.]*))?/i;

/**
 * Extracts a comparable version from tags/strings like "v1.2.3", "release-2024.10.1", "1.32.0-beta.2".
 * Returns null when no number is found.
 */
export function parseVersion(input: string | null | undefined): ParsedVersion | null {
  const match = input?.match(VERSION_PATTERN);
  if (!match?.[1]) {
    return null;
  }
  return {
    numbers: match[1].split('.').map(Number),
    prerelease: (match[2] ?? '').toLowerCase(),
  };
}

/** Returns a negative number if a < b, 0 if equal, positive if a > b. Null if either can't be parsed. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) {
    return null;
  }

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let i = 0; i < length; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  // Same numbers: a stable version is newer than any pre-release.
  if (left.prerelease === right.prerelease) {
    return 0;
  }
  if (!left.prerelease) {
    return 1;
  }
  if (!right.prerelease) {
    return -1;
  }
  return left.prerelease.localeCompare(right.prerelease, 'en', { numeric: true });
}

/** Keys tried (in order) when no explicit JSON field is configured. */
const COMMON_VERSION_KEYS = [
  'version',
  'Version',
  'appVersion',
  'app_version',
  'serverVersion',
  'server_version',
  'currentVersion',
  'current_version',
  'tag',
  'tag_name',
  'build.version',
  'data.version',
  'info.version',
];

const TEXT_VERSION_PATTERN = /v?\d+(?:\.\d+)+(?:[-+][\w.]+)?/;

export class InstalledVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstalledVersionError';
  }
}

export interface InstalledVersionResult {
  version: string;
  /** Short preview of the response, useful when testing the configuration in the UI. */
  preview: string;
}

/**
 * Pulls a version out of a response body.
 * @param field Dot path into a JSON body (e.g. "data.version"). Empty = auto-detect.
 */
export function extractVersion(body: string, field: string | null): string {
  const trimmed = body.trim();
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    json = undefined;
  }

  if (field) {
    if (json === undefined) {
      throw new InstalledVersionError(`Response is not JSON, so field "${field}" can't be read.`);
    }
    const value = getPath(json, field);
    if (value === undefined || value === null || typeof value === 'object') {
      throw new InstalledVersionError(`Field "${field}" was not found in the response.`);
    }
    return String(value).trim();
  }

  // Plain JSON string ("1.32.0") or number – e.g. Vaultwarden's /api/version.
  if (typeof json === 'string' || typeof json === 'number') {
    return String(json).trim();
  }
  if (json && typeof json === 'object') {
    for (const key of COMMON_VERSION_KEYS) {
      const value = getPath(json, key);
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value).trim();
      }
    }
  }

  const match = trimmed.match(TEXT_VERSION_PATTERN);
  if (match) {
    return match[0];
  }
  throw new InstalledVersionError('No version found in the response. Set the JSON field explicitly.');
}

function getPath(value: unknown, path: string): unknown {
  return path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>((current, key) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined), value);
}

/** Custom request header (e.g. Authorization) sent to the installed-version URL. */
export interface HttpHeader {
  name: string;
  value: string;
}

export const MAX_CUSTOM_HEADERS = 10;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;

/** Returns an error message for invalid headers, or null. */
export function validateHeaders(headers: readonly HttpHeader[]): string | null {
  if (headers.length > MAX_CUSTOM_HEADERS) {
    return `At most ${MAX_CUSTOM_HEADERS} headers are allowed.`;
  }
  const seen = new Set<string>();
  for (const { name, value } of headers) {
    if (!HEADER_NAME_PATTERN.test(name)) {
      return `"${name}" is not a valid header name.`;
    }
    if (seen.has(name.toLowerCase())) {
      return `Header "${name}" is defined twice.`;
    }
    seen.add(name.toLowerCase());
    if (/[\r\n\0]/.test(value) || value.length > 4000) {
      return `Value of "${name}" is invalid.`;
    }
  }
  return null;
}

/** Fetches the installed version from a URL such as https://vault.lan/api/version. */
export async function fetchInstalledVersion(
  url: string,
  field: string | null,
  headers: readonly HttpHeader[] = [],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<InstalledVersionResult> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept: 'application/json, text/plain;q=0.9, */*;q=0.5',
        'User-Agent': 'ReleaseWatcher/1.0',
        ...Object.fromEntries(headers.map((h) => [h.name, h.value])),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const cause = error instanceof Error ? ((error.cause as Error | undefined)?.message ?? error.message) : String(error);
    throw new InstalledVersionError(`Could not reach ${url}: ${cause}`);
  }

  const body = await response.text();
  if (!response.ok) {
    const hint = response.status === 401 || response.status === 403 ? ' Check the authorization headers.' : '';
    throw new InstalledVersionError(`${url} returned HTTP ${response.status}.${hint}`);
  }

  const version = extractVersion(body, field);
  if (!version) {
    throw new InstalledVersionError('The version field is empty.');
  }
  return { version, preview: body.length > 300 ? `${body.slice(0, 300)}…` : body };
}

/**
 * URL of this server's own `/api/version` endpoint as reachable from the same machine. A wildcard bind address
 * (`0.0.0.0`, `::`) is replaced by the loopback address; IPv6 addresses are put in brackets.
 */
export function localVersionUrl(host: string, port: number): string {
  const wildcard = host === '' || host === '0.0.0.0' || host === '::' || host === '[::]';
  const address = wildcard ? '127.0.0.1' : host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${address}:${port}/api/version`;
}

export function validateVersionUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : 'URL must use http(s).';
  } catch {
    return 'Enter a valid URL, e.g. https://vault.local/api/version.';
  }
}
