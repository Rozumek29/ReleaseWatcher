import type { RepositoryStore } from '../db.ts';
import { fullName } from '../domain.ts';
import { errorMessage, problem, validationProblem } from '../http.ts';
import { validateCron } from '../cron.ts';
import { type ObjectSchema, parseId, readBody, RequestValidationError, validate } from '../validation.ts';
import {
  appUpdateAvailable,
  type Container,
  type ContainerApp,
  DEFAULT_APP_TIMEOUT_SECONDS,
  type DiscoveredContainer,
  LATEST_SOURCES,
  type LatestSource,
  MAX_APP_TIMEOUT_SECONDS,
  MIN_APP_TIMEOUT_SECONDS,
  type Run,
} from './domain.ts';
import type { ContainerScheduler } from './scheduler.ts';
import { ContainerBusyError, type ContainerService } from './service.ts';
import { ShellNotConfiguredError } from './ssh.ts';
import type { AppInput, ContainerStore } from './store.ts';

export interface ContainerRoutesDeps {
  containers: ContainerStore;
  repositories: RepositoryStore;
  service: ContainerService;
  scheduler: ContainerScheduler;
  /** Global backup settings: storage for backups and whether to back up before updates by default. */
  backupDefaults: () => { storage: string | null; enabled: boolean };
}

const COMMAND_MAX_LENGTH = 4000;

const addContainerSchema: ObjectSchema = {
  type: 'object',
  properties: { vmid: { type: 'integer', minimum: 1 }, name: { type: 'string', nullable: true, maxLength: 100 } },
  required: ['vmid'],
};

const updateContainerSchema: ObjectSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    isEnabled: { type: 'boolean' },
    aptEnabled: { type: 'boolean' },
    backupBeforeUpdate: { type: 'boolean', nullable: true },
    startWhenStopped: { type: 'boolean' },
    checkCron: { type: 'string', nullable: true, maxLength: 200 },
  },
  required: ['name', 'isEnabled', 'aptEnabled'],
};

/** Optional body of the update endpoints: `backup` overrides the container/global default for this update. */
const updateOptionsSchema: ObjectSchema = {
  type: 'object',
  properties: { backup: { type: 'boolean', nullable: true } },
};

async function readUpdateOptions(req: Request): Promise<{ backup?: boolean | null }> {
  const text = await req.text();
  if (!text.trim()) {
    return {};
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new RequestValidationError('body must be valid JSON');
  }
  return validate(json, updateOptionsSchema, 'body') as { backup?: boolean | null };
}

const appSchema: ObjectSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    versionCommand: { type: 'string', nullable: true, maxLength: COMMAND_MAX_LENGTH },
    latestSource: { type: 'string' },
    repositoryId: { type: 'integer', nullable: true },
    latestCommand: { type: 'string', nullable: true, maxLength: COMMAND_MAX_LENGTH },
    updateCommand: { type: 'string', nullable: true, maxLength: COMMAND_MAX_LENGTH },
    useTty: { type: 'boolean' },
    timeoutSeconds: { type: 'integer', nullable: true },
  },
  required: ['name', 'latestSource'],
};

interface AppBody {
  name: string;
  versionCommand?: string | null;
  latestSource: string;
  repositoryId?: number | null;
  latestCommand?: string | null;
  updateCommand?: string | null;
  useTty?: boolean;
  timeoutSeconds?: number | null;
}

const blankToNull = (value: string | null | undefined): string | null => value?.trim() || null;

export const runDto = (run: Run | Omit<Run, 'output'>) => ({ ...run });

/** Maps service errors to problem responses; everything else propagates to the global handler. */
async function guard(action: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ShellNotConfiguredError) {
      return problem(409, error.message);
    }
    if (error instanceof ContainerBusyError) {
      return problem(409, error.message);
    }
    throw error;
  }
}

/** HTTP routes for Proxmox containers (registered by `buildApp`). */
export function containerRoutes(deps: ContainerRoutesDeps) {
  const { containers, repositories, service, scheduler } = deps;

  const appDto = (a: ContainerApp) => {
    const repo = a.repositoryId === null ? null : repositories.get(a.repositoryId);
    return {
      id: a.id,
      name: a.name,
      versionCommand: a.versionCommand,
      latestSource: a.latestSource,
      repositoryId: a.repositoryId,
      repositoryFullName: repo ? fullName(repo) : null,
      latestCommand: a.latestCommand,
      updateCommand: a.updateCommand,
      useTty: a.useTty,
      timeoutSeconds: a.timeoutSeconds,
      installedVersion: a.installedVersion,
      latestVersion: a.latestVersion,
      checkedAt: a.checkedAt,
      error: a.error,
      updateAvailable: appUpdateAvailable(a),
    };
  };

  const containerDto = (c: Container, apps = containers.listApps(c.id)) => {
    const appDtos = apps.map(appDto);
    return {
      id: c.id,
      kind: c.kind,
      vmid: c.vmid,
      name: c.name,
      isEnabled: c.isEnabled,
      aptEnabled: c.aptEnabled,
      backupBeforeUpdate: c.backupBeforeUpdate,
      /** Whether updates back up first unless changed for a single update. */
      effectiveBackupBeforeUpdate: c.kind !== 'node' && (c.backupBeforeUpdate ?? deps.backupDefaults().enabled),
      startWhenStopped: c.startWhenStopped,
      checkCron: c.checkCron,
      nextCheckAt: scheduler.nextRunOf(c)?.toISOString() ?? null,
      status: c.status,
      aptUpgradable: c.aptUpgradable,
      lastCheckedAt: c.lastCheckedAt,
      lastError: c.lastError,
      createdAt: c.createdAt,
      isBusy: service.isBusy(c.id),
      apps: appDtos,
      /** apt counts as one pending update. */
      updatesAvailable: (c.aptUpgradable.length > 0 ? 1 : 0) + appDtos.filter((a) => a.updateAvailable).length,
    };
  };

  const listDtos = () => {
    const allApps = containers.listApps();
    return containers.list().map((c) => containerDto(c, allApps.filter((a) => a.containerId === c.id)));
  };

  const findContainer = (rawId: string) => containers.get(parseId(rawId));

  /** Validates an application body; returns the input or a problem response. */
  const toAppInput = (body: AppBody, current: ContainerApp | null): AppInput | Response => {
    const name = body.name.trim();
    if (!name) {
      return validationProblem('name', 'Enter a name.');
    }
    if (!(LATEST_SOURCES as readonly string[]).includes(body.latestSource)) {
      return validationProblem('latestSource', `Use one of: ${LATEST_SOURCES.join(', ')}.`);
    }
    const latestSource = body.latestSource as LatestSource;
    const repositoryId = latestSource === 'github' ? (body.repositoryId ?? null) : null;
    if (latestSource === 'github' && (repositoryId === null || !repositories.get(repositoryId))) {
      return validationProblem('repositoryId', 'Choose a watched GitHub repository.');
    }
    const latestCommand = latestSource === 'command' ? blankToNull(body.latestCommand) : null;
    if (latestSource === 'command' && !latestCommand) {
      return validationProblem('latestCommand', 'Enter a command that prints the latest version.');
    }
    const timeoutSeconds = body.timeoutSeconds ?? current?.timeoutSeconds ?? DEFAULT_APP_TIMEOUT_SECONDS;
    if (timeoutSeconds < MIN_APP_TIMEOUT_SECONDS || timeoutSeconds > MAX_APP_TIMEOUT_SECONDS) {
      return validationProblem(
        'timeoutSeconds',
        `Timeout must be between ${MIN_APP_TIMEOUT_SECONDS} and ${MAX_APP_TIMEOUT_SECONDS} seconds.`,
      );
    }
    return {
      name,
      versionCommand: blankToNull(body.versionCommand),
      latestSource,
      repositoryId,
      latestCommand,
      updateCommand: blankToNull(body.updateCommand),
      useTty: body.useTty ?? false,
      timeoutSeconds,
    };
  };

  /** Storage to back up to before an update (null = no backup), or a problem response. */
  const resolveBackup = (container: Container, requested: boolean | null | undefined): string | null | Response => {
    const defaults = deps.backupDefaults();
    const enabled = requested ?? container.backupBeforeUpdate ?? defaults.enabled;
    if (!enabled) {
      return null;
    }
    return defaults.storage ?? problem(409, 'Choose a backup storage in Settings → Proxmox node, or update without a backup.');
  };

  const accepted = (run: Run) => Response.json(runDto(run), { status: 202, headers: { location: `/api/runs/${run.id}` } });

  return {
    '/api/proxmox/test': {
      POST: () =>
        guard(async () => {
          try {
            return Response.json({ output: await service.testConnection() });
          } catch (error) {
            if (error instanceof ShellNotConfiguredError) throw error;
            return problem(502, 'Could not connect to the Proxmox node.', { detail: errorMessage(error) });
          }
        }),
    },
    // Containers present on the node (`pct list`), marked when already added.
    '/api/proxmox/containers': {
      GET: () =>
        guard(async () => {
          try {
            const found = await service.discover();
            return Response.json(found.map((c) => ({ ...c, added: containers.existsVmid(c.vmid) })));
          } catch (error) {
            if (error instanceof ShellNotConfiguredError) throw error;
            return problem(502, 'Listing containers failed.', { detail: errorMessage(error) });
          }
        }),
    },

    // Storages on the node that accept backups (`pvesm status --content backup`).
    '/api/proxmox/storages': {
      GET: () =>
        guard(async () => {
          try {
            return Response.json(await service.backupStorages());
          } catch (error) {
            if (error instanceof ShellNotConfiguredError) throw error;
            return problem(502, 'Listing storages failed.', { detail: errorMessage(error) });
          }
        }),
    },

    '/api/containers': {
      GET: () => Response.json(listDtos()),
      POST: (req: Request) =>
        guard(async () => {
          const body = await readBody<{ vmid: number; name?: string | null }>(req, addContainerSchema);
          if (containers.existsVmid(body.vmid)) {
            return problem(409, `Container ${body.vmid} has already been added.`);
          }
          let name = blankToNull(body.name);
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          try {
            const found = (await service.discover()).find((c) => c.vmid === body.vmid);
            if (!found) {
              return validationProblem('vmid', `Container ${body.vmid} does not exist on the node.`);
            }
            name ??= found.name;
          } catch (error) {
            return problem(502, 'Listing containers failed.', { detail: errorMessage(error) });
          }
          const container = containers.add(body.vmid, name);
          service.startCheck(container, 'manual');
          return Response.json(containerDto(container), {
            status: 201,
            headers: { location: `/api/containers/${container.id}` },
          });
        }),
    },
    // The Proxmox host itself as a target: apt check and dist-upgrade on the node (no applications, no backup).
    '/api/containers/node': {
      POST: () =>
        guard(async () => {
          if (containers.getNode()) {
            return problem(409, 'The Proxmox host has already been added.');
          }
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          let name: string;
          try {
            name = await service.nodeHostname();
          } catch (error) {
            return problem(502, 'Could not connect to the Proxmox node.', { detail: errorMessage(error) });
          }
          const node = containers.addNode(name);
          service.startCheck(node, 'manual');
          return Response.json(containerDto(node), {
            status: 201,
            headers: { location: `/api/containers/${node.id}` },
          });
        }),
    },
    // Adds every container of the node that has not been added yet and queues a check of each.
    '/api/containers/add-all': {
      POST: () =>
        guard(async () => {
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          let found: DiscoveredContainer[];
          try {
            found = await service.discover();
          } catch (error) {
            return problem(502, 'Listing containers failed.', { detail: errorMessage(error) });
          }
          const added = found.filter((c) => !containers.existsVmid(c.vmid)).map((c) => containers.add(c.vmid, c.name));
          // Checks run through the scheduler queue, so the concurrency limit applies.
          void scheduler.checkMany(added.map((c) => c.id));
          return Response.json(
            added.map((c) => containerDto(c)),
            { status: added.length > 0 ? 201 : 200 },
          );
        }),
    },
    '/api/containers/check-all': {
      POST: () =>
        guard(() => {
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          void scheduler.checkAll();
          return Response.json({ queued: containers.listEnabled().length }, { status: 202 });
        }),
    },
    '/api/containers/:id': {
      GET: (req: Bun.BunRequest<'/api/containers/:id'>) => {
        const container = findContainer(req.params.id);
        return container ? Response.json(containerDto(container)) : problem(404, 'Container not found.');
      },
      PUT: async (req: Bun.BunRequest<'/api/containers/:id'>) => {
        const container = findContainer(req.params.id);
        const body = await readBody<{
          name: string;
          isEnabled: boolean;
          aptEnabled: boolean;
          backupBeforeUpdate?: boolean | null;
          startWhenStopped?: boolean;
          checkCron?: string | null;
        }>(req, updateContainerSchema);
        if (!container) {
          return problem(404, 'Container not found.');
        }
        const name = body.name.trim();
        if (!name) {
          return validationProblem('name', 'Enter a name.');
        }
        const checkCron = body.checkCron === undefined ? container.checkCron : blankToNull(body.checkCron);
        const cronError = checkCron ? validateCron(checkCron) : null;
        if (cronError) {
          return validationProblem('checkCron', cronError);
        }
        const isNode = container.kind === 'node';
        Object.assign(container, {
          name,
          isEnabled: body.isEnabled,
          // The host entry exists only for apt; backups and temporary starts apply to containers only.
          aptEnabled: isNode || body.aptEnabled,
          backupBeforeUpdate: isNode ? null : body.backupBeforeUpdate === undefined ? container.backupBeforeUpdate : body.backupBeforeUpdate,
          startWhenStopped: !isNode && (body.startWhenStopped ?? container.startWhenStopped),
          checkCron,
        });
        if (!container.aptEnabled) {
          container.aptUpgradable = [];
        }
        containers.save(container);
        return Response.json(containerDto(container));
      },
      DELETE: (req: Bun.BunRequest<'/api/containers/:id'>) => {
        const container = findContainer(req.params.id);
        if (!container) {
          return problem(404, 'Container not found.');
        }
        if (service.isBusy(container.id)) {
          return problem(409, 'A task is running in this container – wait for it to finish.');
        }
        containers.delete(container.id);
        return new Response(null, { status: 204 });
      },
    },
    '/api/containers/:id/check': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/check'>) =>
        guard(() => {
          const container = findContainer(req.params.id);
          return container ? accepted(service.startCheck(container, 'manual')) : problem(404, 'Container not found.');
        }),
    },
    '/api/containers/:id/apt-upgrade': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/apt-upgrade'>) =>
        guard(async () => {
          const options = await readUpdateOptions(req);
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!container.aptEnabled) {
            return problem(409, 'apt is disabled for this container.');
          }
          if (container.kind === 'node') {
            if (options.backup === true) {
              return problem(409, 'The Proxmox host cannot be backed up with vzdump – update it without a backup.');
            }
            return accepted(service.startAptUpgrade(container, null));
          }
          const backup = resolveBackup(container, options.backup);
          return backup instanceof Response ? backup : accepted(service.startAptUpgrade(container, backup));
        }),
    },
    '/api/containers/:id/runs': {
      GET: (req: Bun.BunRequest<'/api/containers/:id/runs'>) => {
        const container = findContainer(req.params.id);
        return container
          ? Response.json(containers.listRuns(container.id).map(runDto))
          : problem(404, 'Container not found.');
      },
    },
    '/api/containers/:id/apps': {
      POST: async (req: Bun.BunRequest<'/api/containers/:id/apps'>) => {
        const container = findContainer(req.params.id);
        const body = await readBody<AppBody>(req, appSchema);
        if (!container) {
          return problem(404, 'Container not found.');
        }
        if (container.kind === 'node') {
          return problem(409, 'Applications can be added to containers only, not to the Proxmox host.');
        }
        const input = toAppInput(body, null);
        if (input instanceof Response) {
          return input;
        }
        const app = containers.addApp(container.id, input);
        return Response.json(appDto(app), {
          status: 201,
          headers: { location: `/api/containers/${container.id}/apps/${app.id}` },
        });
      },
    },
    '/api/containers/:id/apps/:appId': {
      PUT: async (req: Bun.BunRequest<'/api/containers/:id/apps/:appId'>) => {
        const containerId = parseId(req.params.id);
        const app = containers.getApp(containerId, parseId(req.params.appId, 'params/appId'));
        const body = await readBody<AppBody>(req, appSchema);
        if (!app) {
          return problem(404, 'Application not found.');
        }
        const input = toAppInput(body, app);
        if (input instanceof Response) {
          return input;
        }
        const sourceChanged =
          input.latestSource !== app.latestSource ||
          input.repositoryId !== app.repositoryId ||
          input.latestCommand !== app.latestCommand;
        const versionChanged = input.versionCommand !== app.versionCommand;
        Object.assign(app, input);
        // Values read with the old configuration would be misleading.
        if (sourceChanged) app.latestVersion = null;
        if (versionChanged) app.installedVersion = null;
        containers.saveApp(app);
        return Response.json(appDto(app));
      },
      DELETE: (req: Bun.BunRequest<'/api/containers/:id/apps/:appId'>) =>
        containers.deleteApp(parseId(req.params.id), parseId(req.params.appId, 'params/appId'))
          ? new Response(null, { status: 204 })
          : problem(404, 'Application not found.'),
    },
    '/api/containers/:id/apps/:appId/update': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/apps/:appId/update'>) =>
        guard(async () => {
          const options = await readUpdateOptions(req);
          const container = findContainer(req.params.id);
          const app = container ? containers.getApp(container.id, parseId(req.params.appId, 'params/appId')) : null;
          if (!container || !app) {
            return problem(404, 'Application not found.');
          }
          if (!app.updateCommand) {
            return problem(409, `No update command is configured for ${app.name}.`);
          }
          const backup = resolveBackup(container, options.backup);
          return backup instanceof Response ? backup : accepted(service.startAppUpdate(container, app, backup));
        }),
    },
    '/api/runs/:id': {
      GET: (req: Bun.BunRequest<'/api/runs/:id'>) => {
        const run = containers.getRun(parseId(req.params.id));
        return run ? Response.json(runDto(run)) : problem(404, 'Run not found.');
      },
    },
  };
}

/** Summary for `/api/status`. */
export function containerStatus(containers: ContainerStore) {
  const list = containers.list();
  const apps = containers.listApps();
  return {
    total: list.length,
    enabled: list.filter((c) => c.isEnabled).length,
    withErrors: list.filter((c) => c.lastError).length,
    aptPending: list.filter((c) => c.aptUpgradable.length > 0).length,
    appUpdatesAvailable: apps.filter((a) => appUpdateAvailable(a)).length,
  };
}
