/**
 * Serves the built Angular UI from memory: every file is read once at startup, compressed with zstd (when that
 * helps) and gets an ETag, so requests are answered with `304 Not Modified` when the browser already has the file.
 *
 * Caching: files with a content hash in their name (`main-QT5IUOY2.js`, `chunk-B-Wp3YLy.js`, `styles-….css`)
 * never change and are cached for a year (`immutable`); everything else – `index.html`, icons – is revalidated on
 * every use (`no-cache` + ETag). Unknown paths without a file extension are client-side routes and get
 * `index.html`; unknown paths *with* one (e.g. a chunk of an older build) are a 404, so the browser never caches
 * HTML under a script URL.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { problem } from './http.ts';

/** One file in two representations; `zstd` is null when compression does not pay off. */
interface UiFile {
  type: string;
  cacheControl: string;
  identity: { body: Uint8Array; etag: string };
  zstd: { body: Uint8Array; etag: string } | null;
}

/** A year – the longest `max-age` worth sending. */
export const IMMUTABLE = 'public, max-age=31536000, immutable';
export const REVALIDATE = 'no-cache';

const ZSTD_LEVEL = 19;
/** Below this size compression saves less than the request overhead. */
const MIN_COMPRESS_BYTES = 512;
const COMPRESSIBLE = /^(?:text\/|application\/(?:javascript|json|manifest\+json|xml)|image\/(?:svg\+xml|x-icon|vnd\.microsoft\.icon))/;

/**
 * True for file names carrying a build hash: `-` + 8 URL-safe characters (at least one upper-case letter or digit,
 * so ordinary words like `apple-touch-icon.png` don't count) right before the extension.
 */
export function isHashedAsset(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return /-(?=[\w-]{0,7}[A-Z0-9])[\w-]{8}\.[a-z0-9]+$/.test(name);
}

/** Whether the `Accept-Encoding` header allows zstd (`q=0` refuses it). */
export function acceptsZstd(header: string | null): boolean {
  if (!header) {
    return false;
  }
  return header.split(',').some((part) => {
    const [name, ...params] = part.split(';').map((s) => s.trim().toLowerCase());
    if (name !== 'zstd') {
      return false;
    }
    const q = params.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** Whether `If-None-Match` lists `etag` (weak comparison, as RFC 9110 requires for GET/HEAD) or `*`. */
export function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) {
    return false;
  }
  return header.split(',').some((tag) => {
    const value = tag.trim();
    return value === '*' || value.replace(/^W\//, '') === etag;
  });
}

async function loadFile(path: string, urlPath: string): Promise<UiFile> {
  const file = Bun.file(path);
  const body = await file.bytes();
  const hash = Bun.hash(body).toString(36);
  let zstd: UiFile['zstd'] = null;
  if (body.length >= MIN_COMPRESS_BYTES && COMPRESSIBLE.test(file.type)) {
    const compressed = await Bun.zstdCompress(body, { level: ZSTD_LEVEL });
    if (compressed.length < body.length * 0.9) {
      zstd = { body: compressed, etag: `"${hash}-zstd"` };
    }
  }
  return {
    type: file.type,
    cacheControl: isHashedAsset(urlPath) ? IMMUTABLE : REVALIDATE,
    identity: { body, etag: `"${hash}"` },
    zstd,
  };
}

/** Lists the files of a directory as URL path (`/main.js`) → file path; empty when the directory is missing. */
export async function scanDirectory(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (!existsSync(dir)) {
    return files;
  }
  for await (const relative of new Bun.Glob('**/*').scan({ cwd: dir, onlyFiles: true })) {
    files.set(`/${relative.replaceAll('\\', '/')}`, join(dir, relative));
  }
  return files;
}

export class StaticUi {
  private constructor(
    private readonly files: ReadonlyMap<string, UiFile>,
    private readonly index: UiFile,
  ) {}

  /** Loads the UI from `files` (URL path → file path); null when there is no `/index.html`. */
  static async load(files: ReadonlyMap<string, string>): Promise<StaticUi | null> {
    if (!files.has('/index.html')) {
      return null;
    }
    const loaded = new Map(
      await Promise.all([...files].map(async ([urlPath, path]) => [urlPath, await loadFile(path, urlPath)] as const)),
    );
    // The SPA fallback is served under many URLs, so it must always be revalidated.
    return new StaticUi(loaded, { ...loaded.get('/index.html')!, cacheControl: REVALIDATE });
  }

  /** Answers a GET/HEAD for a UI path: the file, `index.html` for client-side routes, or a 404. */
  respond(req: Request, pathname: string): Response {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return problem(404, 'Not found.');
    }
    const name = decoded.slice(decoded.lastIndexOf('/') + 1);
    const file = this.files.get(decoded) ?? (name.includes('.') ? null : this.index);
    if (!file) {
      return problem(404, 'Not found.', {}, { 'cache-control': 'no-store' });
    }
    const variant = file.zstd && acceptsZstd(req.headers.get('accept-encoding')) ? file.zstd : file.identity;
    const headers: Record<string, string> = { etag: variant.etag, 'cache-control': file.cacheControl };
    if (file.zstd) {
      headers['vary'] = 'Accept-Encoding';
    }
    if (matchesEtag(req.headers.get('if-none-match'), variant.etag)) {
      return new Response(null, { status: 304, headers });
    }
    headers['content-type'] = file.type;
    if (variant === file.zstd) {
      headers['content-encoding'] = 'zstd';
    }
    return new Response(variant.body, { headers });
  }
}
