/**
 * Reads running containers from a Docker (or Podman) Engine API: a mounted socket, a socket proxy or a remote engine
 * over TCP. Read-only: only `GET /version`, `GET /containers/json` and `GET /images/{id}/json` are used, so a socket
 * proxy needs nothing but `CONTAINERS=1` and `IMAGES=1`.
 */
import { errorMessage } from '../errors.ts';
import { type EngineContainer, type EngineListing, keptLabels, parseEndpointUrl } from './domain.ts';

/** Lists running containers; faked in tests. */
export interface DockerEngine {
  list(signal?: AbortSignal): Promise<EngineListing>;
}

/** `fetch` with Bun's `unix` option (requests over a Unix socket). */
export type EngineFetch = (input: string, init: RequestInit & { unix?: string }) => Promise<Response>;

export class DockerEngineError extends Error {
  override name = 'DockerEngineError';
}

const REQUEST_TIMEOUT_MS = 15_000;
/** Images inspected in parallel. */
const IMAGE_CONCURRENCY = 8;

export class HttpDockerEngine implements DockerEngine {
  private readonly url: string;
  private readonly fetch: EngineFetch;

  constructor(url: string, fetchImpl?: EngineFetch) {
    this.url = url;
    this.fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async list(signal?: AbortSignal): Promise<EngineListing> {
    const version = await this.get<{ Version?: string; Components?: { Name?: string }[] }>('/version', signal);
    const isPodman = (version.Components ?? []).some((c) => /podman/i.test(c.Name ?? ''));
    const listed = await this.get<RawListedContainer[]>('/containers/json', signal);
    const imageIds = [...new Set(listed.map((c) => c.ImageID).filter((id): id is string => !!id))];
    const digests = new Map<string, string[]>();
    for (let i = 0; i < imageIds.length; i += IMAGE_CONCURRENCY) {
      await Promise.all(
        imageIds.slice(i, i + IMAGE_CONCURRENCY).map(async (id) => {
          try {
            const image = await this.get<{ RepoDigests?: unknown }>(`/images/${encodeURIComponent(id)}/json`, signal);
            digests.set(id, Array.isArray(image.RepoDigests) ? image.RepoDigests.filter((d): d is string => typeof d === 'string') : []);
          } catch (error) {
            // A socket proxy without IMAGES=1 answers 403: versions from tags and labels still work.
            if (!(error instanceof DockerEngineError)) throw error;
            digests.set(id, []);
          }
        }),
      );
    }
    const containers: EngineContainer[] = listed.map((c) => ({
      id: c.Id ?? '',
      name: (c.Names?.[0] ?? c.Id?.slice(0, 12) ?? '').replace(/^\//, ''),
      image: c.Image ?? '',
      imageId: c.ImageID ?? '',
      state: c.State ?? 'running',
      labels: keptLabels(c.Labels),
      repoDigests: c.ImageID ? (digests.get(c.ImageID) ?? []) : [],
    }));
    return { runtime: isPodman ? 'podman' : 'docker', version: version.Version ?? null, containers };
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const target = parseEndpointUrl(this.url);
    if ('error' in target) {
      throw new DockerEngineError(target.error);
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetch(`${target.baseUrl}${path}`, {
        headers: { Accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        ...(target.unixSocket ? { unix: target.unixSocket } : {}),
      });
    } catch (error) {
      throw new Error(describeConnectionError(error, target.unixSocket ?? target.baseUrl), { cause: error });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const message = body.match(/"message"\s*:\s*"([^"]*)"/)?.[1] ?? body.slice(0, 200);
      throw new DockerEngineError(
        response.status === 403
          ? `The Docker endpoint refused ${path} (HTTP 403) – allow CONTAINERS and IMAGES in the socket proxy.`
          : `The Docker endpoint answered HTTP ${response.status} for ${path}${message ? `: ${message.trim()}` : ''}.`,
      );
    }
    return (await response.json()) as T;
  }
}

interface RawListedContainer {
  Id?: string;
  Names?: string[];
  Image?: string;
  ImageID?: string;
  State?: string;
  Labels?: Record<string, unknown> | null;
}

function describeConnectionError(error: unknown, where: string): string {
  const code = (error as { code?: string } | null)?.code;
  const message = errorMessage(error);
  if (code === 'EACCES' || /permission denied/i.test(message)) {
    return `No permission to use ${where} – add the user ReleaseWatcher runs as to the socket's group (e.g. group_add in compose) or use a socket proxy.`;
  }
  if (code === 'ENOENT' || code === 'FailedToOpenSocket' || /no such file|failed to open socket/i.test(message)) {
    return `${where} was not found – mount the Docker socket or check the path.`;
  }
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${where} did not answer in time.`;
  }
  return `Could not reach ${where}: ${message}`;
}
