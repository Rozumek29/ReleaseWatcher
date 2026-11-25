/**
 * Reading the version of an installed (self-hosted) application from its URL: a JSON API, a plain text endpoint or a
 * web page. Formats other than auto use the extraction engine of web sources (`web-source/extract.ts`).
 */

import { PatternError } from './pattern.ts';
import {
  extractVersion,
  findVersionText,
  InstalledVersionError,
  type HttpHeader,
  type InstalledVersionResult,
} from './version.ts';
import { validateWebSource, WebSourceError, type WebSourceConfig, type WebSourceFormat } from './web-source/domain.ts';
import { extractReleases } from './web-source/extract.ts';
import { MAX_WEB_SOURCE_BYTES } from './web-source/fetch.ts';

/** How the version is found in the response of the version URL. */
export interface InstalledVersionLocator {
  /**
   * `null` = auto: a JSON string or number, the dot path `field` or a common key of a JSON object, else the first
   * version in the text. Otherwise the response is read as text (with `pattern`), JSON (path) or HTML/XML (selector).
   */
  format: WebSourceFormat | null;
  /** auto: dot path into JSON; json: path (`data.version`, `items[0].tag`); html/xml: CSS selector; text: unused. */
  field: string | null;
  /** Regular expression that picks the version out of the located text; required for `text`, unused for auto. */
  pattern: string | null;
}

/** Locator of a version URL configured before formats existed. */
export const autoLocator = (field: string | null = null): InstalledVersionLocator => ({ format: null, field, pattern: null });

/** Stored form of a locator: trimmed values, no path for `text` and no pattern for auto. */
export function normalizeLocator(locator: InstalledVersionLocator): InstalledVersionLocator {
  const field = locator.format === 'text' ? null : locator.field?.trim() || null;
  const pattern = locator.format === null ? null : locator.pattern?.trim() || null;
  return { format: locator.format, field, pattern };
}

const toConfig = (locator: InstalledVersionLocator): WebSourceConfig => ({
  // Only the locators are checked and used here; the URL is validated (and fetched) on its own.
  url: 'http://localhost/',
  format: locator.format ?? 'text',
  items: null,
  version: locator.field,
  date: null,
  link: null,
  userAgent: null,
});

/**
 * Checks a normalized locator; returns the problems per field (`installedVersionFormat`, `installedVersionField`,
 * `installedVersionPattern`) as full sentences, or `null` when it can be used.
 */
export function validateLocator(locator: InstalledVersionLocator): Record<string, string[]> | null {
  if (locator.format === null) {
    return locator.field !== null && locator.field.length > 200
      ? { installedVersionField: ['The JSON field must be at most 200 characters long.'] }
      : null;
  }
  const problems = validateWebSource(toConfig(locator), locator.pattern);
  if (!problems) return null;
  const names: Record<string, string> = {
    format: 'installedVersionFormat',
    version: 'installedVersionField',
    pattern: 'installedVersionPattern',
  };
  const errors: Record<string, string[]> = {};
  for (const [key, messages] of Object.entries(problems)) {
    const name = names[key];
    if (name) errors[name] = messages;
  }
  return Object.keys(errors).length > 0 ? errors : null;
}

/** Finds the installed version in a response body. Throws `InstalledVersionError` with a message for the user. */
export async function readInstalledVersion(body: string, locator: InstalledVersionLocator): Promise<string> {
  if (locator.format === null) {
    return extractVersion(body, locator.field);
  }
  if (body.length > MAX_WEB_SOURCE_BYTES) {
    throw new InstalledVersionError(`The response is larger than ${MAX_WEB_SOURCE_BYTES / 1024 / 1024} MB.`);
  }
  let found: string | undefined;
  try {
    found = (await extractReleases(body, toConfig(locator), locator.pattern))[0]?.version;
  } catch (error) {
    if (error instanceof WebSourceError || error instanceof PatternError) {
      throw new InstalledVersionError(error.message);
    }
    throw error;
  }
  if (!found) {
    const what =
      locator.format === 'text' ? 'the version pattern' : `the ${locator.format === 'json' ? 'path' : 'selector'}${locator.pattern ? ' and the version pattern' : ''}`;
    throw new InstalledVersionError(`No version found in the response – check ${what}.`);
  }
  return locator.pattern === null ? fromVersion(found) : found.trim();
}

/**
 * A located text without a pattern, from its first version on: an element such as "Version 4.2.1" gives "4.2.1",
 * while a suffix stays ("2.0 beta").
 */
function fromVersion(text: string): string {
  const version = findVersionText(text);
  const at = version === null ? -1 : text.indexOf(version);
  return (at > 0 ? text.slice(at) : text).trim();
}

/** Fetches the installed version from a URL such as https://vault.lan/api/version or an app's about page. */
export async function fetchInstalledVersion(
  url: string,
  locator: InstalledVersionLocator,
  headers: readonly HttpHeader[] = [],
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<InstalledVersionResult> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        Accept:
          locator.format === 'html' || locator.format === 'xml'
            ? 'text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.5'
            : 'application/json, text/plain;q=0.9, */*;q=0.5',
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

  const version = await readInstalledVersion(body, locator);
  if (!version) {
    throw new InstalledVersionError('The version field is empty.');
  }
  return { version, preview: body.length > 300 ? `${body.slice(0, 300)}…` : body };
}
