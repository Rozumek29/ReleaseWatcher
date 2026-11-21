import type { RepositoryStore } from '../db.ts';
import { fullName } from '../domain.ts';
import { errorMessage, problem, validationProblem } from '../http.ts';
import { maskSecret } from '../settings.ts';
import { validateCron } from '../cron.ts';
import { type ObjectSchema, parseId, readBody, RequestValidationError, validate } from '../validation.ts';
import {
  appUpdateAvailable,
  type Container,
  type ContainerApp,
  DEFAULT_APP_TIMEOUT_SECONDS,
  type DiscoveredContainer,
  homeAssistantInstallContext,
  LATEST_SOURCES,
  type LatestSource,
  MAX_APP_TIMEOUT_SECONDS,
  MAX_UPDATE_CORES,
  MAX_UPDATE_MEMORY_MB,
  MIN_APP_TIMEOUT_SECONDS,
  MIN_UPDATE_CORES,
  MIN_UPDATE_MEMORY_MB,
  type PendingUpdate,
  type Run,
  targetLabel,
} from './domain.ts';
import { installBlocker, normalizeHomeAssistantUrl } from './home-assistant.ts';
import type { ContainerScheduler } from './scheduler.ts';
import {
  ContainerBusyError,
  type ContainerService,
  DetectionUnavailableError,
  HomeAssistantUpdateError,
} from './service.ts';
import { ShellNotConfiguredError } from './ssh.ts';
import type { AppInput, ContainerStore } from './store.ts';
import { type ContainerUpdater, UpdateAllRunningError, type UpdateRequest } from './updater.ts';

export interface ContainerRoutesDeps {
  containers: ContainerStore;
  repositories: RepositoryStore;
  service: ContainerService;
  scheduler: ContainerScheduler;
  updater: ContainerUpdater;
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
    updateCores: { type: 'integer', nullable: true },
    updateMemoryMb: { type: 'integer', nullable: true },
    homeAssistantUrl: { type: 'string', nullable: true, maxLength: 500 },
    homeAssistantToken: { type: 'string', nullable: true, maxLength: 1000 },
    homeAssistantInstall: { type: 'boolean' },
  },
  required: ['name', 'isEnabled', 'aptEnabled'],
};

/** Body of `POST /api/containers/:id/home-assistant-update`: `ids` selects updates (omitted = all installable). */
const homeAssistantUpdateSchema: ObjectSchema = {
  type: 'object',
  properties: {
    backup: { type: 'boolean', nullable: true },
    ids: { type: 'array', nullable: true, maxItems: 100, items: { type: 'string', maxLength: 300 } },
  },
};

/** Optional body of the update endpoints: `backup` overrides the container/global default for this update. */
const updateOptionsSchema: ObjectSchema = {
  type: 'object',
  properties: { backup: { type: 'boolean', nullable: true } },
};

async function readUpdateOptions<T = { backup?: boolean | null }>(req: Request, schema = updateOptionsSchema): Promise<Partial<T>> {
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
  return validate(json, schema, 'body') as Partial<T>;
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
    if (
      error instanceof ContainerBusyError ||
      error instanceof UpdateAllRunningError ||
      error instanceof HomeAssistantUpdateError
    ) {
      return problem(409, error.message);
    }
    throw error;
  }
}

/** HTTP routes for Proxmox containers (registered by `buildApp`). */
export function containerRoutes(deps: ContainerRoutesDeps) {
  const { containers, repositories, service, scheduler, updater } = deps;

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

  /** Home Assistant OS of a virtual machine (null for containers); the token only as `hasToken` + a masked hint. */
  const homeAssistantDto = (c: Container) => {
    if (c.kind !== 'vm') {
      return null;
    }
    const context = homeAssistantInstallContext(c);
    return {
      /** Found by the last check (false = not Home Assistant OS, or not checked yet). */
      detected: c.homeAssistant !== null,
      coreVersion: c.homeAssistant?.coreVersion ?? null,
      osVersion: c.homeAssistant?.osVersion ?? null,
      /** When Home Assistant saved the states the integration updates were read from; null = read live (or unknown). */
      entitiesSavedAt: c.homeAssistant?.entitiesSavedAt ?? null,
      updates: (c.homeAssistant?.updates ?? []).map((u) => ({ ...u, installBlocker: installBlocker(u, context) })),
      /** Updates may be installed from ReleaseWatcher (false = only checked and reported). */
      installEnabled: c.homeAssistantInstall,
      url: c.homeAssistantUrl,
      hasToken: c.homeAssistantToken !== null,
      tokenMasked: maskSecret(c.homeAssistantToken, 4),
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
      updateCores: c.updateCores,
      updateMemoryMb: c.updateMemoryMb,
      /** Resources are raised for an update right now (or could not be restored yet). */
      resourcesRaised: c.resourcesToRestore !== null,
      nextCheckAt: scheduler.nextRunOf(c)?.toISOString() ?? null,
      status: c.status,
      aptUpgradable: c.aptUpgradable,
      /** Why a restart is needed (last check); empty = none. */
      restartReasons: c.restartReasons,
      homeAssistant: homeAssistantDto(c),
      lastCheckedAt: c.lastCheckedAt,
      lastError: c.lastError,
      createdAt: c.createdAt,
      /** A task runs or the container waits for its turn in "update all". */
      isBusy: service.isBusy(c.id) || updater.isQueued(c.id),
      /** The check/update running right now (its live log: `GET /api/runs/:id`); null while waiting in "update all". */
      activeRunId: service.activeRunId(c.id),
      apps: appDtos,
      /** apt counts as one pending update, every Home Assistant update as one. */
      updatesAvailable:
        (c.aptUpgradable.length > 0 ? 1 : 0) +
        appDtos.filter((a) => a.updateAvailable).length +
        (c.homeAssistant?.updates.length ?? 0),
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

  /**
   * Queues the planned containers for "update all" with their backup storage; answers 202 with the counts
   * (200 with zeros when nothing is pending) or the first backup problem.
   */
  const startUpdates = (
    plan: { container: Container; updates: PendingUpdate[] }[],
    backupOf: (container: Container) => string | null | Response,
  ): Response => {
    if (plan.length === 0) {
      return Response.json({ containers: 0, updates: 0 });
    }
    const requests: UpdateRequest[] = [];
    for (const { container } of plan) {
      const backup = backupOf(container);
      if (backup instanceof Response) {
        return backup;
      }
      requests.push({ containerId: container.id, backupStorage: backup });
    }
    updater.enqueue(requests);
    return Response.json(
      { containers: plan.length, updates: plan.reduce((sum, p) => sum + p.updates.length, 0) },
      { status: 202 },
    );
  };

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
            return problem(409, `Guest ${body.vmid} has already been added.`);
          }
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          let found: DiscoveredContainer | undefined;
          try {
            found = (await service.discover()).find((c) => c.vmid === body.vmid);
          } catch (error) {
            return problem(502, 'Listing containers failed.', { detail: errorMessage(error) });
          }
          if (!found) {
            return validationProblem('vmid', `No container or virtual machine ${body.vmid} exists on the node.`);
          }
          const container = containers.add(body.vmid, blankToNull(body.name) ?? found.name, found.kind);
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
    // Adds every container of the node that has not been added yet and queues a check of each. Virtual machines
    // are added one by one: they need the QEMU guest agent, and appliances like Home Assistant OS have no apt.
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
          const added = found
            .filter((c) => c.kind === 'lxc' && !containers.existsVmid(c.vmid))
            .map((c) => containers.add(c.vmid, c.name, c.kind));
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
    // Updates every container with pending updates (apt, then applications), one after another. The host is left out.
    '/api/containers/update-all': {
      POST: (req: Request) =>
        guard(async () => {
          const options = await readUpdateOptions(req);
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          const plan = updater.plan().filter(({ container }) => !updater.isQueued(container.id));
          if (plan.length === 0 && updater.isRunning) {
            throw new UpdateAllRunningError();
          }
          // false = no backups; true/omitted = each container's own default (backupBeforeUpdate or the global one).
          return startUpdates(plan, (container) => resolveBackup(container, options.backup === false ? false : undefined));
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
          updateCores?: number | null;
          updateMemoryMb?: number | null;
          homeAssistantUrl?: string | null;
          homeAssistantToken?: string | null;
          homeAssistantInstall?: boolean;
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
        const updateCores = body.updateCores === undefined ? container.updateCores : body.updateCores;
        if (updateCores !== null && (updateCores < MIN_UPDATE_CORES || updateCores > MAX_UPDATE_CORES)) {
          return validationProblem('updateCores', `CPU cores must be between ${MIN_UPDATE_CORES} and ${MAX_UPDATE_CORES}.`);
        }
        const updateMemoryMb = body.updateMemoryMb === undefined ? container.updateMemoryMb : body.updateMemoryMb;
        if (updateMemoryMb !== null && (updateMemoryMb < MIN_UPDATE_MEMORY_MB || updateMemoryMb > MAX_UPDATE_MEMORY_MB)) {
          return validationProblem(
            'updateMemoryMb',
            `Memory must be between ${MIN_UPDATE_MEMORY_MB} and ${MAX_UPDATE_MEMORY_MB} MiB.`,
          );
        }
        // Omitted = keep, null/empty = remove, value = set (the UI never sends the saved token back).
        let homeAssistantUrl = body.homeAssistantUrl === undefined ? container.homeAssistantUrl : blankToNull(body.homeAssistantUrl);
        if (homeAssistantUrl !== null) {
          const normalized = normalizeHomeAssistantUrl(homeAssistantUrl);
          if ('error' in normalized) {
            return validationProblem('homeAssistantUrl', normalized.error);
          }
          homeAssistantUrl = normalized.url;
        }
        const homeAssistantToken =
          body.homeAssistantToken === undefined ? container.homeAssistantToken : blankToNull(body.homeAssistantToken);
        const isVm = container.kind === 'vm';
        if (isVm && homeAssistantToken !== null && homeAssistantUrl === null) {
          return validationProblem('homeAssistantUrl', 'Enter the Home Assistant URL the token is used with.');
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
          // Only containers are resized for updates.
          updateCores: container.kind === 'lxc' ? updateCores : null,
          updateMemoryMb: container.kind === 'lxc' ? updateMemoryMb : null,
          // Home Assistant OS runs in virtual machines only.
          homeAssistantUrl: isVm ? homeAssistantUrl : null,
          homeAssistantToken: isVm ? homeAssistantToken : null,
          homeAssistantInstall: isVm && (body.homeAssistantInstall ?? container.homeAssistantInstall),
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
    // Installs Home Assistant updates in a Home Assistant OS virtual machine (every installable one, or `ids`).
    '/api/containers/:id/home-assistant-update': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/home-assistant-update'>) =>
        guard(async () => {
          const options = await readUpdateOptions<{ backup: boolean | null; ids: string[] | null }>(
            req,
            homeAssistantUpdateSchema,
          );
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          if (updater.isQueued(container.id)) {
            throw new UpdateAllRunningError(`Updates of ${targetLabel(container)} are already running – wait for them to finish.`);
          }
          const backup = resolveBackup(container, options.backup);
          return backup instanceof Response
            ? backup
            : accepted(service.startHomeAssistantUpdate(container, options.ids ?? null, backup));
        }),
    },
    // Restarts a running container (`pct reboot`) or schedules a restart of the Proxmox host.
    '/api/containers/:id/restart': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/restart'>) =>
        guard(() => {
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          if (updater.isQueued(container.id)) {
            return problem(409, `Updates of ${targetLabel(container)} are running – restart it when they have finished.`);
          }
          if (container.kind === 'node') {
            if (service.hasActiveTasks() || containers.list().some((c) => updater.isQueued(c.id))) {
              return problem(409, 'Checks or updates are running – restart the Proxmox host when they have finished.');
            }
          } else if (container.status === 'stopped') {
            return problem(409, `${targetLabel(container)} is stopped – it does not need a restart.`);
          }
          return accepted(service.startRestart(container));
        }),
    },
    // Runs every pending update of one container (apt, then applications) one after another.
    '/api/containers/:id/update-all': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/update-all'>) =>
        guard(async () => {
          const options = await readUpdateOptions(req);
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          if (updater.isQueued(container.id)) {
            throw new UpdateAllRunningError(`Updates of ${targetLabel(container)} are already running – wait for them to finish.`);
          }
          return startUpdates(updater.plan([container]), (c) => resolveBackup(c, options.backup));
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
    // Suggests applications found in the container with their GitHub repository (nothing is saved).
    '/api/containers/:id/detect-apps': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/detect-apps'>) =>
        guard(async () => {
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shell.isConfigured) {
            throw new ShellNotConfiguredError();
          }
          let detected;
          try {
            detected = await service.detectApps(container);
          } catch (error) {
            if (error instanceof DetectionUnavailableError) {
              return problem(409, error.message);
            }
            return problem(502, 'Detecting applications failed.', { detail: errorMessage(error) });
          }
          const apps = containers.listApps(container.id);
          const watched = repositories.list();
          return Response.json(
            detected.map((d) => {
              const repo = d.repository
                ? watched.find((r) => fullName(r).toLowerCase() === d.repository!.toLowerCase())
                : undefined;
              return {
                ...d,
                repositoryId: repo?.id ?? null,
                // Already set up: the same repository or the same name in this container.
                alreadyAdded: apps.some(
                  (a) =>
                    (repo !== undefined && a.repositoryId === repo.id) || a.name.toLowerCase() === d.name.toLowerCase(),
                ),
              };
            }),
          );
        }),
    },
    '/api/containers/:id/apps': {
      POST: async (req: Bun.BunRequest<'/api/containers/:id/apps'>) => {
        const container = findContainer(req.params.id);
        const body = await readBody<AppBody>(req, appSchema);
        if (!container) {
          return problem(404, 'Container not found.');
        }
        if (container.kind === 'node') {
          return problem(409, 'Applications can be added to guests only, not to the Proxmox host.');
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
      // `?after=<outputCursor>` returns only the output written since that read while the run is in progress.
      GET: (req: Bun.BunRequest<'/api/runs/:id'>) => {
        const id = parseId(req.params.id);
        const live = service.liveRun(id, new URL(req.url).searchParams.get('after'));
        if (live) {
          const { output, append, cursor } = live.output;
          return Response.json({ ...runDto(live.run), output, outputAppend: append, outputCursor: cursor });
        }
        const run = containers.getRun(id);
        return run
          ? Response.json({ ...runDto(run), outputAppend: false, outputCursor: null })
          : problem(404, 'Run not found.');
      },
    },
  };
}

/** Summary for `/api/status`. */
export function containerStatus(containers: ContainerStore) {
  const counts = containers.statusCounts();
  return {
    total: counts.total,
    enabled: counts.enabled,
    withErrors: counts.withErrors,
    aptPending: counts.aptPending,
    appUpdatesAvailable: containers.listAppVersions().filter((a) => appUpdateAvailable(a)).length,
    homeAssistantUpdatesAvailable: counts.homeAssistantUpdates,
  };
}
