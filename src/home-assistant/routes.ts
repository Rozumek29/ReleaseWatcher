import type { CronJob } from '../cron-job.ts';
import { errorMessage } from '../errors.ts';
import { problem, validationProblem } from '../http.ts';
import { normalizeHomeAssistantUrl } from '../proxmox/home-assistant.ts';
import { maskSecret } from '../settings.ts';
import { body, parseId, readBody, z } from '../validation.ts';
import { type HomeAssistantConnection, MAX_NAME_LENGTH, MAX_TOKEN_LENGTH } from './domain.ts';
import { ConnectionBusyError, type HomeAssistantService } from './service.ts';
import type { HomeAssistantStore } from './store.ts';

export interface HomeAssistantRoutesDeps {
  store: HomeAssistantStore;
  service: HomeAssistantService;
  /** Scheduled run (`homeAssistantCheckCron`). */
  job: CronJob;
}

const MAX_URL_LENGTH = 500;

const connectionSchema = body({
  name: z.string().max(MAX_NAME_LENGTH),
  url: z.string().max(MAX_URL_LENGTH),
  /** Omitted or empty when editing = keep the saved token. */
  token: z.string().max(MAX_TOKEN_LENGTH).nullish(),
  isEnabled: z.boolean().optional(),
});

const testSchema = body({
  url: z.string().max(MAX_URL_LENGTH),
  token: z.string().max(MAX_TOKEN_LENGTH).nullish(),
  /** Connection whose saved token is used when none is given. */
  id: z.int().min(1).nullish(),
});

/** Validates name and URL of a connection; returns the normalized values or a problem response. */
function readConnection(body: { name: string; url: string }): { name: string; url: string } | Response {
  const name = body.name.trim();
  if (!name) {
    return validationProblem('name', 'Enter a name for the Home Assistant connection.');
  }
  const parsed = normalizeHomeAssistantUrl(body.url);
  if ('error' in parsed) {
    return validationProblem('url', parsed.error);
  }
  return { name, url: parsed.url };
}

const TOKEN_HINT = 'Enter a long-lived access token (Home Assistant: your profile → Security).';

/** HTTP routes of Home Assistant connections and their components (registered by `buildApp`). */
export function homeAssistantRoutes(deps: HomeAssistantRoutesDeps) {
  const { store, service, job } = deps;

  /** A connection as returned by the API: never the token itself. */
  const connectionDto = (c: HomeAssistantConnection) => ({
    id: c.id,
    name: c.name,
    url: c.url,
    tokenMasked: maskSecret(c.token, 4),
    isEnabled: c.isEnabled,
    lastCheckedAt: c.lastCheckedAt,
    lastError: c.lastError,
    createdAt: c.createdAt,
    isChecking: service.isChecking(c.id),
  });

  const overview = () => ({
    connections: store.listConnections().map(connectionDto),
    components: service.describe(store.listComponents()),
    check: job.status,
  });

  const findConnection = (rawId: string) => store.getConnection(parseId(rawId));

  return {
    '/api/home-assistant': {
      GET: () => Response.json(overview()),
    },
    // Reads every enabled connection right away.
    '/api/home-assistant/check': {
      POST: () => {
        if (!job.status.isRunning) {
          void job.runNow();
        }
        return Response.json(overview(), { status: 202 });
      },
    },
    '/api/home-assistant/connections': {
      GET: () => Response.json(store.listConnections().map(connectionDto)),
      POST: async (req: Request) => {
        const body = await readBody(req, connectionSchema);
        const input = readConnection(body);
        if (input instanceof Response) return input;
        const token = body.token?.trim();
        if (!token) return validationProblem('token', TOKEN_HINT);
        const connection = store.addConnection(input.name, input.url, token);
        service.startCheck(connection);
        return Response.json(connectionDto(connection), {
          status: 201,
          headers: { Location: `/api/home-assistant/connections/${connection.id}` },
        });
      },
    },
    '/api/home-assistant/connections/test': {
      POST: async (req: Request) => {
        const body = await readBody(req, testSchema);
        const parsed = normalizeHomeAssistantUrl(body.url);
        if ('error' in parsed) {
          return validationProblem('url', parsed.error);
        }
        const saved = body.id ? store.getConnection(body.id) : null;
        // The saved token is only ever sent to the address it was saved for.
        const token = body.token?.trim() || (saved?.url === parsed.url ? saved.token : null);
        if (!token) return validationProblem('token', TOKEN_HINT);
        try {
          const components = await service.read({ url: parsed.url, token });
          return Response.json({ components: components.length });
        } catch (error) {
          return problem(502, 'Home Assistant could not be read.', { detail: errorMessage(error) });
        }
      },
    },
    '/api/home-assistant/connections/:id': {
      PUT: async (req: Bun.BunRequest<'/api/home-assistant/connections/:id'>) => {
        const connection = findConnection(req.params.id);
        const body = await readBody(req, connectionSchema);
        if (!connection) return problem(404, 'Home Assistant connection not found.');
        const input = readConnection(body);
        if (input instanceof Response) return input;
        const token = body.token?.trim() || null;
        const changedUrl = input.url !== connection.url;
        if (changedUrl && !token) {
          // The saved token is only ever sent to the address it was saved for.
          return validationProblem('token', 'Enter the access token again for the new address.');
        }
        const changed = changedUrl || (token !== null && token !== connection.token);
        Object.assign(connection, { ...input, token: token ?? connection.token, isEnabled: body.isEnabled ?? connection.isEnabled });
        if (changedUrl) {
          // Another instance: what was read before is not there.
          Object.assign(connection, { lastError: null, lastCheckedAt: null });
          store.clearComponents(connection.id);
        }
        store.saveConnection(connection);
        if (changed && connection.isEnabled && !service.isChecking(connection.id)) {
          service.startCheck(connection);
        }
        return Response.json(connectionDto(connection));
      },
      DELETE: (req: Bun.BunRequest<'/api/home-assistant/connections/:id'>) => {
        const connection = findConnection(req.params.id);
        if (!connection) return problem(404, 'Home Assistant connection not found.');
        store.deleteConnection(connection.id);
        return new Response(null, { status: 204 });
      },
    },
    '/api/home-assistant/connections/:id/check': {
      POST: (req: Bun.BunRequest<'/api/home-assistant/connections/:id/check'>) => {
        const connection = findConnection(req.params.id);
        if (!connection) return problem(404, 'Home Assistant connection not found.');
        try {
          service.startCheck(connection);
        } catch (error) {
          if (error instanceof ConnectionBusyError) return problem(409, error.message);
          throw error;
        }
        return Response.json(connectionDto(connection), {
          status: 202,
          headers: { Location: `/api/home-assistant/connections/${connection.id}` },
        });
      },
    },
  };
}
