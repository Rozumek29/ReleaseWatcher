import { selectNewReleases, selectNewVersions } from '../domain.ts';
import { errorMessage } from '../errors.ts';
import { problem } from '../http.ts';
import { normalizePattern, PatternError } from '../pattern.ts';
import { ReleaseSourceError } from '../release-source.ts';
import { body, readBody, z } from '../validation.ts';
import {
  detectFormat,
  MAX_SELECTOR_LENGTH,
  MAX_URL_LENGTH,
  MAX_USER_AGENT_LENGTH,
  validateWebSource,
  WEB_SOURCE_FORMATS,
  WebSourceError,
  type WebSourceConfig,
} from './domain.ts';
import { fetchWebDocument } from './fetch.ts';
import { readWebReleases, webReleaseOrder } from './source.ts';

/** Releases listed by a preview at most. */
export const PREVIEW_MAX_RELEASES = 50;

// Twice the real limits, so an over-long value gets the friendly message of `validateWebSource()` instead of Zod's.
const optionalLocator = z.string().max(MAX_SELECTOR_LENGTH * 2).nullish();

/** A web source as sent by the UI; empty strings mean "not set". Checked by {@link checkWebSource}. */
export const webSourceSchema = z.object({
  url: z.string().max(MAX_URL_LENGTH * 2),
  format: z.enum(WEB_SOURCE_FORMATS),
  items: optionalLocator,
  version: optionalLocator,
  date: optionalLocator,
  link: optionalLocator,
  userAgent: z.string().max(MAX_USER_AGENT_LENGTH * 2).nullish(),
});

const previewSchema = body({
  webSource: webSourceSchema,
  versionPattern: z.string().max(2000).nullish(),
  includePrereleases: z.boolean().optional(),
});

/** A web source as stored: values trimmed, empty optional values as null. */
export function normalizeWebSource(input: z.output<typeof webSourceSchema>): WebSourceConfig {
  const optional = (value: string | null | undefined): string | null => value?.trim() || null;
  return {
    url: input.url.trim(),
    format: input.format,
    items: optional(input.items),
    version: optional(input.version),
    date: optional(input.date),
    link: optional(input.link),
    userAgent: optional(input.userAgent),
  };
}

/**
 * Checks a web source with its version pattern: a 400 problem with the errors keyed like the request body
 * (`webSource.url` …, `versionPattern`), or null when it can be used.
 */
export function checkWebSource(config: WebSourceConfig, versionPattern: string | null): Response | null {
  const errors = validateWebSource(config, versionPattern);
  if (!errors) {
    return null;
  }
  const keyed = Object.fromEntries(
    Object.entries(errors).map(([field, messages]) => [field === 'pattern' ? 'versionPattern' : `webSource.${field}`, messages]),
  );
  return problem(400, 'One or more validation errors occurred.', { errors: keyed });
}

/** The problem response for an error of reading a web source, or null when it is not one of those. */
export function webSourceErrorProblem(error: unknown): Response | null {
  if (error instanceof PatternError) {
    return problem(400, 'One or more validation errors occurred.', { errors: { versionPattern: [error.message] } });
  }
  if (error instanceof WebSourceError) {
    return problem(400, 'One or more validation errors occurred.', { errors: { 'webSource.format': [error.message] } });
  }
  if (error instanceof ReleaseSourceError) {
    return problem(502, 'Bad Gateway', { detail: error.message });
  }
  return null;
}

export interface WebSourceRoutesDeps {
  /** Fetch used to read the pages (faked in tests). */
  fetch?: typeof fetch;
}

/** `POST /api/web-sources/preview`: reads a web source once with the given settings, without saving anything. */
export function webSourceRoutes(deps: WebSourceRoutesDeps = {}) {
  const fetcher = deps.fetch ?? globalThis.fetch;
  return {
    '/api/web-sources/preview': {
      POST: async (req: Request) => {
        const input = await readBody(req, previewSchema);
        const config = normalizeWebSource(input.webSource);
        const versionPattern = normalizePattern(input.versionPattern);
        const invalid = checkWebSource(config, versionPattern);
        if (invalid) {
          return invalid;
        }
        try {
          const fetched = await fetchWebDocument(fetcher, config.url, { userAgent: config.userAgent });
          if (fetched.notModified) {
            throw new ReleaseSourceError(`${config.url} answered 304 to an unconditional request.`, 304);
          }
          const releases = await readWebReleases(fetched.body, config, versionPattern);
          const order = webReleaseOrder(config);
          // The newest version as a check would pick it (no baseline yet = only the newest is chosen).
          const filter = { includePrereleases: input.includePrereleases ?? false, lastCheckedAt: null, lastSeenPublishedAt: null, lastSeenTag: null };
          const { newest } =
            order === 'version'
              ? selectNewVersions(filter, releases, new Date())
              : selectNewReleases(filter, releases.filter((r) => r.publishedAt !== ''));
          return Response.json({
            contentType: fetched.contentType,
            detectedFormat: detectFormat(fetched.contentType, fetched.body),
            bytes: fetched.bytes,
            order,
            releases: releases.slice(0, PREVIEW_MAX_RELEASES).map((r) => ({
              version: r.tag,
              title: r.name,
              publishedAt: r.publishedAt || null,
              url: r.htmlUrl === config.url ? null : r.htmlUrl,
              isPrerelease: r.isPrerelease,
            })),
            newest: newest?.tag ?? null,
          });
        } catch (error) {
          return webSourceErrorProblem(error) ?? problem(500, 'Reading the web source failed.', { detail: errorMessage(error) });
        }
      },
    },
  };
}
