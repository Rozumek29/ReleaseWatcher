import type { CronJob } from '../cron-job.ts';
import type { RepositoryStore } from '../db.ts';
import { errorMessage } from '../errors.ts';
import { problem, validationProblem } from '../http.ts';
import { body, parseId, readBody, z } from '../validation.ts';
import { type DockerEndpoint, engineLabel, parseEndpointUrl } from './domain.ts';
import { type DockerService, EndpointBusyError } from './service.ts';
import type { DockerStore } from './store.ts';

export interface DockerRoutesDeps {
  store: DockerStore;
  repositories: RepositoryStore;
  service: DockerService;
  /** Scheduled run (`dockerCheckCron`): endpoints and registry checks. */
  job: CronJob;
}

const MAX_NAME_LENGTH = 100;
const MAX_URL_LENGTH = 500;

const endpointSchema = body({
  name: z.string().max(MAX_NAME_LENGTH),
  url: z.string().max(MAX_URL_LENGTH),
  isEnabled: z.boolean().optional(),
});

const testSchema = body({ url: z.string().max(MAX_URL_LENGTH) });

const containerSchema = body({
  ignored: z.boolean().optional(),
  /** true = link through the labels; false = `repositoryId` (null = no repository). */
  linkAuto: z.boolean().optional(),
  repositoryId: z.int().min(1).nullish(),
});

/** Validates name and URL of an endpoint; returns the normalized values or a problem response. */
function readEndpoint(body: { name: string; url: string }): { name: string; url: string } | Response {
  const name = body.name.trim();
  if (!name) {
    return validationProblem('name', 'Enter a name for the Docker endpoint.');
  }
  const parsed = parseEndpointUrl(body.url);
  if ('error' in parsed) {
    return validationProblem('url', parsed.error);
  }
  return { name, url: parsed.url };
}

/** HTTP routes of Docker endpoints and containers (registered by `buildApp`). */
export function dockerRoutes(deps: DockerRoutesDeps) {
  const { store, service, job } = deps;

  const endpointDto = (e: DockerEndpoint) => ({
    id: e.id,
    name: e.name,
    url: e.url,
    isEnabled: e.isEnabled,
    engine: e.engine,
    lastCheckedAt: e.lastCheckedAt,
    lastError: e.lastError,
    createdAt: e.createdAt,
    isChecking: service.isChecking(e.id),
  });

  const overview = () => ({
    endpoints: store.listEndpoints().map(endpointDto),
    containers: service.describe(store.listContainers()),
    check: job.status,
  });

  const findEndpoint = (rawId: string) => store.getEndpoint(parseId(rawId));

  return {
    '/api/docker': {
      GET: () => Response.json(overview()),
    },
    // Lists the endpoints right away and asks the registries again for every image (also of targets' containers).
    '/api/docker/check': {
      POST: () => {
        if (!job.status.isRunning) {
          void job.runNow();
        }
        return Response.json(overview(), { status: 202 });
      },
    },
    '/api/docker/endpoints': {
      GET: () => Response.json(store.listEndpoints().map(endpointDto)),
      POST: async (req: Request) => {
        const body = await readBody(req, endpointSchema);
        const input = readEndpoint(body);
        if (input instanceof Response) return input;
        const endpoint = store.addEndpoint(input.name, input.url);
        service.startEndpointCheck(endpoint);
        return Response.json(endpointDto(endpoint), { status: 201, headers: { Location: `/api/docker/endpoints/${endpoint.id}` } });
      },
    },
    '/api/docker/endpoints/test': {
      POST: async (req: Request) => {
        const body = await readBody(req, testSchema);
        const parsed = parseEndpointUrl(body.url);
        if ('error' in parsed) {
          return validationProblem('url', parsed.error);
        }
        try {
          const listing = await service.test(parsed.url);
          return Response.json({ engine: engineLabel(listing), containers: listing.containers.length });
        } catch (error) {
          return problem(502, 'The Docker endpoint could not be read.', { detail: errorMessage(error) });
        }
      },
    },
    '/api/docker/endpoints/:id': {
      PUT: async (req: Bun.BunRequest<'/api/docker/endpoints/:id'>) => {
        const endpoint = findEndpoint(req.params.id);
        const body = await readBody(req, endpointSchema);
        if (!endpoint) return problem(404, 'Docker endpoint not found.');
        const input = readEndpoint(body);
        if (input instanceof Response) return input;
        const changedUrl = input.url !== endpoint.url;
        Object.assign(endpoint, { ...input, isEnabled: body.isEnabled ?? endpoint.isEnabled });
        if (changedUrl) {
          // Another engine: what was listed before is not there.
          Object.assign(endpoint, { engine: null, lastError: null, lastCheckedAt: null });
          store.clearSource({ kind: 'endpoint', id: endpoint.id });
        }
        store.saveEndpoint(endpoint);
        if (changedUrl && endpoint.isEnabled && !service.isChecking(endpoint.id)) {
          service.startEndpointCheck(endpoint);
        }
        return Response.json(endpointDto(endpoint));
      },
      DELETE: (req: Bun.BunRequest<'/api/docker/endpoints/:id'>) => {
        const endpoint = findEndpoint(req.params.id);
        if (!endpoint) return problem(404, 'Docker endpoint not found.');
        store.deleteEndpoint(endpoint.id);
        return new Response(null, { status: 204 });
      },
    },
    '/api/docker/endpoints/:id/check': {
      POST: (req: Bun.BunRequest<'/api/docker/endpoints/:id/check'>) => {
        const endpoint = findEndpoint(req.params.id);
        if (!endpoint) return problem(404, 'Docker endpoint not found.');
        try {
          service.startEndpointCheck(endpoint);
        } catch (error) {
          if (error instanceof EndpointBusyError) return problem(409, error.message);
          throw error;
        }
        return Response.json(endpointDto(endpoint), { status: 202, headers: { Location: `/api/docker/endpoints/${endpoint.id}` } });
      },
    },
    '/api/docker/containers/:id': {
      PUT: async (req: Bun.BunRequest<'/api/docker/containers/:id'>) => {
        const container = store.getContainer(parseId(req.params.id));
        const body = await readBody(req, containerSchema);
        if (!container) return problem(404, 'Docker container not found.');
        const linkAuto = body.linkAuto ?? (body.repositoryId !== undefined ? false : container.linkAuto);
        const repositoryId = linkAuto ? null : body.repositoryId === undefined ? container.repositoryId : body.repositoryId;
        if (repositoryId !== null && !deps.repositories.get(repositoryId)) {
          return validationProblem('repositoryId', 'The repository is not watched (any more).');
        }
        const updated = { ...container, ignored: body.ignored ?? container.ignored, linkAuto, repositoryId };
        store.saveChoices(updated);
        const [view] = service.describe([store.getContainer(container.id)!]);
        return Response.json(view);
      },
    },
  };
}
