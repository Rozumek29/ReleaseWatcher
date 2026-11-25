import { APP_VERSION } from '../app-version.ts';
import { ReleaseSourceError, truncate } from '../release-source.ts';

/** Largest response read from a web source; bigger pages are refused instead of filling the memory. */
export const MAX_WEB_SOURCE_BYTES = 5 * 1024 * 1024;

/** Time a web source may take to answer completely. */
const TIMEOUT_MS = 20_000;

/**
 * Honest User-Agent with a link to the project, so site owners can see who reads their page (and how often) instead of
 * a scraper disguised as a browser.
 */
export const WEB_SOURCE_USER_AGENT = `ReleaseWatcher/${APP_VERSION} (+https://github.com/Rozumek29/ReleaseWatcher)`;

/** Prefix of a stored `Last-Modified` value: the repository's single validator column holds an ETag or this. */
const LAST_MODIFIED_PREFIX = 'last-modified:';

export interface WebDocument {
  body: string;
  /** `Content-Type` of the response (empty when the server sent none). */
  contentType: string;
  /** Size of the body in bytes. */
  bytes: number;
  /** Validator for the next conditional request (an ETag or the `Last-Modified` date); null when the server sent none. */
  validator: string | null;
}

export type WebFetchResult = ({ notModified: false } & WebDocument) | { notModified: true; validator: string | null };

/**
 * GET of a web page, feed or JSON document. `validator` (from an earlier result) makes the request conditional, so an
 * unchanged page costs the site a `304` only. Error statuses, timeouts and oversized bodies throw a
 * {@link ReleaseSourceError} with a message meant for the user.
 */
export async function fetchWebDocument(
  fetcher: typeof fetch,
  url: string,
  options: { validator?: string | null; userAgent?: string | null } = {},
): Promise<WebFetchResult> {
  const validator = options.validator ?? null;
  const headers: Record<string, string> = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    'User-Agent': options.userAgent?.trim() || WEB_SOURCE_USER_AGENT,
  };
  if (validator?.startsWith(LAST_MODIFIED_PREFIX)) {
    headers['If-Modified-Since'] = validator.slice(LAST_MODIFIED_PREFIX.length);
  } else if (validator) {
    headers['If-None-Match'] = validator;
  }

  let response: Response;
  try {
    response = await fetcher(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new ReleaseSourceError(
      timedOut ? `${url} did not answer within ${TIMEOUT_MS / 1000} seconds.` : `${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }
  if (response.status === 304) {
    return { notModified: true, validator };
  }
  if (!response.ok) {
    const hint = response.status === 403 || response.status === 429 ? ' The site may block automated requests.' : '';
    // Error pages are mostly HTML (Cloudflare, nginx): only a plain-text body says something worth showing.
    const isText = /^text\/plain/i.test(response.headers.get('content-type') ?? '');
    const detail = isText ? ` ${truncate((await readLimited(response)).text.trim(), 200)}` : '';
    if (!isText) await response.body?.cancel().catch(() => undefined);
    throw new ReleaseSourceError(`${url} answered ${response.status}.${hint}${detail}`.trim(), response.status);
  }
  const { text, bytes } = await readLimited(response);
  const etag = response.headers.get('etag');
  const lastModified = response.headers.get('last-modified');
  return {
    notModified: false,
    body: text,
    contentType: response.headers.get('content-type') ?? '',
    bytes,
    validator: etag ?? (lastModified ? `${LAST_MODIFIED_PREFIX}${lastModified}` : null),
  };
}

/** Reads the body as UTF-8, failing once it exceeds {@link MAX_WEB_SOURCE_BYTES}. */
async function readLimited(response: Response): Promise<{ text: string; bytes: number }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_WEB_SOURCE_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (!response.body) {
    return { text: '', bytes: 0 };
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_WEB_SOURCE_BYTES) {
      // Leaving the loop by throwing cancels the stream.
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  return { text: decoder(response.headers.get('content-type')).decode(Buffer.concat(chunks)), bytes };
}

/** Decoder for the `charset` of a `Content-Type` (e.g. windows-1250); UTF-8 when none is given or it is unknown. */
function decoder(contentType: string | null): TextDecoder {
  const charset = contentType?.match(/;\s*charset="?([\w.:-]+)"?/i)?.[1];
  try {
    return new TextDecoder((charset ?? 'utf-8') as ConstructorParameters<typeof TextDecoder>[0]);
  } catch {
    return new TextDecoder('utf-8');
  }
}

const tooLarge = () => new ReleaseSourceError(`The page is larger than ${MAX_WEB_SOURCE_BYTES / 1024 / 1024} MB.`, 413);
