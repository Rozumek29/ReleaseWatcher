/**
 * Minimal client of the OCI distribution API (registry v2): the digest a tag points to and the tags of a repository.
 * Works with Docker Hub, GHCR, lscr.io, Quay and self-hosted registries using anonymous bearer tokens
 * (`WWW-Authenticate: Bearer realm=…`). Only reads – nothing is pulled.
 */
import { APP_VERSION } from '../app-version.ts';
import { DOCKER_HUB, type ImageRef } from './domain.ts';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads image data from registries; faked in tests. */
export interface RegistryClient {
  /** Digest the tag points to right now (for multi-platform images the digest of the index). */
  digest(ref: ImageRef, signal?: AbortSignal): Promise<string>;
  /** All tags of the repository (bounded, see {@link MAX_TAG_PAGES}). */
  tags(ref: Pick<ImageRef, 'registry' | 'repository'>, signal?: AbortSignal): Promise<string[]>;
}

export class RegistryError extends Error {
  override name = 'RegistryError';
}

/** Manifest types a tag may point to; listing the index types first returns the digest `docker pull` stores. */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

const PAGE_SIZE = 1000;
/** Pages of tags read at most (repositories like `library/nginx` have thousands of tags). */
export const MAX_TAG_PAGES = 10;
const REQUEST_TIMEOUT_MS = 20_000;

/** API host of a registry (Docker Hub's API does not live at docker.io). */
export const registryHost = (registry: string): string => (registry === DOCKER_HUB ? 'registry-1.docker.io' : registry);

/** Parses `Bearer realm="…",service="…",scope="…"`. */
export function parseChallenge(header: string | null): { scheme: string; params: Record<string, string> } | null {
  const match = header?.match(/^\s*(\w+)\s*(.*)$/s);
  if (!match) return null;
  const params: Record<string, string> = {};
  for (const m of match[2]!.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]*))/g)) {
    params[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  }
  return { scheme: match[1]!.toLowerCase(), params };
}

export class OciRegistryClient implements RegistryClient {
  private readonly fetch: FetchLike;
  /** Bearer tokens per registry and repository (they last a few minutes; renewed on the next 401). */
  private readonly tokens = new Map<string, string>();

  constructor(options: { fetch?: FetchLike } = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async digest(ref: ImageRef, signal?: AbortSignal): Promise<string> {
    const reference = ref.digest ?? ref.tag ?? 'latest';
    const url = `https://${registryHost(ref.registry)}/v2/${ref.repository}/manifests/${reference}`;
    let response = await this.request(ref, url, 'HEAD', MANIFEST_ACCEPT, signal);
    let digest = response.headers.get('docker-content-digest');
    if (response.ok && !digest) {
      // Some registries leave the header out of HEAD responses: hash the manifest itself.
      response = await this.request(ref, url, 'GET', MANIFEST_ACCEPT, signal);
      if (response.ok) {
        const body = new Uint8Array(await response.arrayBuffer());
        digest = response.headers.get('docker-content-digest') ?? `sha256:${new Bun.CryptoHasher('sha256').update(body).digest('hex')}`;
      }
    }
    if (!response.ok) {
      throw new RegistryError(describeStatus(response.status, `${ref.registry}/${ref.repository}:${reference}`));
    }
    return digest!;
  }

  async tags(ref: Pick<ImageRef, 'registry' | 'repository'>, signal?: AbortSignal): Promise<string[]> {
    const host = registryHost(ref.registry);
    const tags: string[] = [];
    let url: string | null = `https://${host}/v2/${ref.repository}/tags/list?n=${PAGE_SIZE}`;
    for (let page = 0; url && page < MAX_TAG_PAGES; page++) {
      const response = await this.request(ref, url, 'GET', 'application/json', signal);
      if (!response.ok) {
        throw new RegistryError(describeStatus(response.status, `${ref.registry}/${ref.repository}`));
      }
      const body = (await response.json()) as { tags?: unknown };
      if (Array.isArray(body.tags)) {
        tags.push(...body.tags.filter((t): t is string => typeof t === 'string'));
      }
      url = nextPage(response.headers.get('link'), `https://${host}`);
    }
    return tags;
  }

  /** Sends a request; on 401 fetches an anonymous token as the challenge describes and tries once more. */
  private async request(
    ref: Pick<ImageRef, 'registry' | 'repository'>,
    url: string,
    method: 'GET' | 'HEAD',
    accept: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const tokenKey = `${ref.registry}/${ref.repository}`;
    const send = (token: string | undefined) =>
      this.fetch(url, {
        method,
        headers: {
          Accept: accept,
          'User-Agent': `ReleaseWatcher/${APP_VERSION}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: 'follow',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    let response = await send(this.tokens.get(tokenKey));
    if (response.status !== 401) {
      return response;
    }
    const challenge = parseChallenge(response.headers.get('www-authenticate'));
    if (challenge?.scheme !== 'bearer' || !challenge.params['realm']) {
      throw new RegistryError(`${ref.registry} requires a login – only public images are supported.`);
    }
    const token = await this.token(challenge.params, ref.repository, signal);
    this.tokens.set(tokenKey, token);
    response = await send(token);
    if (response.status === 401) {
      throw new RegistryError(`${ref.registry}/${ref.repository} is private or does not exist – only public images are supported.`);
    }
    return response;
  }

  private async token(params: Record<string, string>, repository: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(params['realm']!);
    if (params['service']) url.searchParams.set('service', params['service']);
    url.searchParams.set('scope', params['scope'] || `repository:${repository}:pull`);
    const response = await this.fetch(url.href, {
      headers: { 'User-Agent': `ReleaseWatcher/${APP_VERSION}` },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new RegistryError(`The registry refused an anonymous token (HTTP ${response.status}) – only public images are supported.`);
    }
    const body = (await response.json()) as { token?: unknown; access_token?: unknown };
    const token = typeof body.token === 'string' ? body.token : typeof body.access_token === 'string' ? body.access_token : null;
    if (!token) {
      throw new RegistryError('The registry returned no token.');
    }
    return token;
  }
}

/** `Link: </v2/…/tags/list?last=x&n=1000>; rel="next"` → absolute URL of the next page. */
function nextPage(link: string | null, origin: string): string | null {
  const target = link?.match(/<([^>]+)>\s*;\s*rel="?next"?/i)?.[1];
  if (!target) return null;
  try {
    const url = new URL(target, origin);
    // Never follow a link to another host (the token belongs to this registry).
    return url.origin === origin ? url.href : null;
  } catch {
    return null;
  }
}

function describeStatus(status: number, what: string): string {
  if (status === 404) return `${what} was not found in the registry.`;
  if (status === 429) return 'The registry rate limit was reached – the next check tries again.';
  return `The registry answered HTTP ${status} for ${what}.`;
}
