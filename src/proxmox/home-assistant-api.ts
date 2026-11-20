import { type UpdateEntity, updateEntitiesFromStates } from './home-assistant.ts';

/** `fetch` as used by the client (tests pass a fake – they must never reach a real Home Assistant). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Base URL and long-lived access token of a Home Assistant instance. */
export interface HomeAssistantConnection {
  url: string;
  token: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Thrown for failed API requests; the message is meant for the user (it never contains the token). */
export class HomeAssistantApiError extends Error {
  override name = 'HomeAssistantApiError';
}

/**
 * Minimal client of the Home Assistant REST API (`/api/states`, `update.install`). Calls go from ReleaseWatcher to
 * Home Assistant directly – the token never reaches the Proxmox node or the guest's command line.
 */
export class HomeAssistantApi {
  private readonly connection: HomeAssistantConnection;
  private readonly fetch: FetchLike;

  constructor(connection: HomeAssistantConnection, fetchImpl: FetchLike = fetch) {
    this.connection = connection;
    this.fetch = fetchImpl;
  }

  /** Pending update entities, read live. */
  async pendingEntities(): Promise<UpdateEntity[]> {
    return updateEntitiesFromStates(await this.request('GET', '/api/states'));
  }

  /** State of one update entity: whether it is still pending or being installed, and the installed version. */
  async updateState(entityId: string): Promise<{ pending: boolean; inProgress: boolean; installed: string | null }> {
    const state = (await this.request('GET', `/api/states/${encodeURIComponent(entityId)}`)) as {
      state?: unknown;
      attributes?: Record<string, unknown>;
    };
    const installed = state.attributes?.['installed_version'];
    const progress = state.attributes?.['in_progress'];
    return {
      pending: state.state === 'on',
      // `in_progress` is a boolean, or a percentage in older versions.
      inProgress: progress === true || typeof progress === 'number',
      installed: typeof installed === 'string' ? installed : null,
    };
  }

  /** Calls `update.install` for an entity (Home Assistant may answer before the installation has finished). */
  async install(entityId: string, timeoutMs: number): Promise<void> {
    await this.request('POST', '/api/services/update/install', { entity_id: entityId }, timeoutMs);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(`${this.connection.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.connection.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'it did not answer in time' : describe(error);
      throw new HomeAssistantApiError(`Could not reach Home Assistant at ${this.connection.url} – ${reason}.`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new HomeAssistantApiError('Home Assistant rejected the access token – create a new long-lived access token in your profile.');
    }
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim().slice(0, 200);
      throw new HomeAssistantApiError(`Home Assistant answered ${response.status}${text ? `: ${text}` : ''}.`);
    }
    try {
      return await response.json();
    } catch {
      throw new HomeAssistantApiError('Home Assistant answered with something other than JSON – check the URL.');
    }
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\.$/, '');
