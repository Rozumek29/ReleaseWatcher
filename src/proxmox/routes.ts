import type { RepositoryStore } from '../db.ts';
import { fullName, iconUrls, type MachineAppRef } from '../domain.ts';
import { errorMessage } from '../errors.ts';
import { problem, validationProblem } from '../http.ts';
import { maskSecret } from '../settings.ts';
import { validateCron } from '../cron.ts';
import { body, parseId, readBody, readOptionalBody, RequestValidationError, z } from '../validation.ts';
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
  targetTitle,
  capabilities,
  osLabel,
  APP_STORES,
  APP_STORE_LABELS,
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
  /**
   * Backup settings for a target of the node `hostId`: its storage (the node's own, else the global one) and whether
   * to back up before updates by default.
   */
  backupDefaults: (hostId: number | null) => { storage: string | null; enabled: boolean };
  /** True when `hostId` is a Proxmox node (guests can be listed and added from it). */
  isProxmoxHost: (hostId: number) => boolean;
  /** Name of a host (shown next to its targets); null when unknown. */
  hostName: (hostId: number) => string | null;
  /** Called after a target was removed (a server's host goes with it). */
  onTargetDeleted?: (container: Container) => void;
  /** Called when Docker listing was switched off for a target (forgets its Docker containers). */
  onDockerDisabled?: (container: Container) => void;
  /** Called after an application was linked to a repository (added with one, or its repository changed). */
  onAppLinked?: (app: MachineAppRef, repositoryId: number) => void;
}

const COMMAND_MAX_LENGTH = 4000;

const addContainerSchema = body({
  vmid: z.int().min(1),
  name: z.string().max(100).nullish(),
  /** Proxmox node to add the guest from; omitted = the default (first) node. */
  hostId: z.int().min(1).nullish(),
});

const updateContainerSchema = body({
  name: z.string().max(100),
  isEnabled: z.boolean(),
  packagesEnabled: z.boolean(),
  backupBeforeUpdate: z.boolean().nullish(),
  startWhenStopped: z.boolean().optional(),
  checkCron: z.string().max(200).nullish(),
  updateCores: z.int().nullish(),
  updateMemoryMb: z.int().nullish(),
  homeAssistantUrl: z.string().max(500).nullish(),
  homeAssistantToken: z.string().max(1000).nullish(),
  homeAssistantInstall: z.boolean().optional(),
  dockerEnabled: z.boolean().optional(),
});

/** Body of `POST /api/containers/:id/home-assistant-update`: `ids` selects updates (omitted = all installable). */
const homeAssistantUpdateSchema = body({
  backup: z.boolean().nullish(),
  ids: z.array(z.string().max(300)).max(100).nullish(),
});

/** Body of `POST /api/containers/update-all`: `ids` selects containers (omitted = every container with updates). */
const updateAllSchema = body({
  backup: z.boolean().nullish(),
  ids: z.array(z.int().min(1)).max(1000).nullish(),
});

/** Optional body of the update endpoints: `backup` overrides the container/global default for this update. */
const updateOptionsSchema = body({ backup: z.boolean().nullish() });

/** Longest installed version that can be entered by hand. */
const MANUAL_VERSION_MAX_LENGTH = 100;

const appSchema = body({
  name: z.string().max(100),
  versionCommand: z.string().max(COMMAND_MAX_LENGTH).nullish(),
  latestSource: z.string(),
  repositoryId: z.int().nullish(),
  latestCommand: z.string().max(COMMAND_MAX_LENGTH).nullish(),
  updateCommand: z.string().max(COMMAND_MAX_LENGTH).nullish(),
  useTty: z.boolean().optional(),
  timeoutSeconds: z.int().nullish(),
  /** Installed version entered by hand (only without a version command); omit = keep, null/"" = none. */
  installedVersion: z.string().max(MANUAL_VERSION_MAX_LENGTH).nullish(),
});

type AppBody = z.output<typeof appSchema>;

const blankToNull = (value: string | null | undefined): string | null => value?.trim() || null;

export const runDto = (run: Run | Omit<Run, 'output'>) => ({ ...run });

/** A request named a host that is not a Proxmox node. */
class UnknownNodeError extends Error {
  override name = 'UnknownNodeError';
  constructor() {
    super('Proxmox node not found.');
  }
}

/** Maps service errors to problem responses; everything else propagates to the global handler. */
const RUN_PAGE_SIZE = 20;
const MAX_RUN_PAGE_SIZE = 100;

function runPageLimit(value: string | null): number {
  if (value === null) {
    return RUN_PAGE_SIZE;
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RUN_PAGE_SIZE) {
    throw new RequestValidationError(`limit must be a whole number from 1 to ${MAX_RUN_PAGE_SIZE}.`);
  }
  return limit;
}

/** Cursor of the run history: the id of the last run of the previous page. */
function runCursor(value: string | null): number | null {
  if (value === null || value === '') {
    return null;
  }
  if (!/^[1-9]\d{0,15}$/.test(value)) {
    throw new RequestValidationError('cursor is not valid – load the history from the first page again.');
  }
  return Number(value);
}

/**
 * Runs a request to the Proxmox node: a failure becomes a 502 with `title` (the node was reached for this request), a
 * missing connection is left to {@link guard} (409).
 */
async function nodeRequest(title: string, action: () => Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ShellNotConfiguredError) throw error;
    return problem(502, title, { detail: errorMessage(error) });
  }
}

async function guard(action: () => Response | Promise<Response>): Promise<Response> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof ShellNotConfiguredError) {
      return problem(409, error.message);
    }
    if (error instanceof UnknownNodeError) {
      return problem(404, error.message);
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
      /** Custom icon of the linked repository (best first); empty = none, the UI shows its generic icon. */
      iconUrls: repo ? iconUrls(repo.icon) : [],
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
    if (!capabilities(c.kind).homeAssistant) {
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
      hostId: c.hostId,
      hostName: c.hostId === null ? null : deps.hostName(c.hostId),
      /** Its host has an SSH key, so checks and updates can run. */
      configured: service.shellFor(c).isConfigured,
      kind: c.kind,
      /** What can be done with this target (the UI shows only the matching settings and actions). */
      capabilities: capabilities(c.kind),
      vmid: c.vmid,
      name: c.name,
      isEnabled: c.isEnabled,
      packagesEnabled: c.packagesEnabled,
      backupBeforeUpdate: c.backupBeforeUpdate,
      /** Whether updates back up first unless changed for a single update. */
      effectiveBackupBeforeUpdate:
        capabilities(c.kind).backup !== null && (c.backupBeforeUpdate ?? deps.backupDefaults(c.hostId).enabled),
      /** Storage its backups go to (its node's, else the global one); null = it cannot be backed up or none is chosen. */
      backupStorage: capabilities(c.kind).backup === null ? null : deps.backupDefaults(c.hostId).storage,
      startWhenStopped: c.startWhenStopped,
      checkCron: c.checkCron,
      updateCores: c.updateCores,
      updateMemoryMb: c.updateMemoryMb,
      /** Resources are raised for an update right now (or could not be restored yet). */
      resourcesRaised: c.resourcesToRestore !== null,
      nextCheckAt: scheduler.nextRunOf(c)?.toISOString() ?? null,
      status: c.status,
      packageUpdates: c.packageUpdates,
      packageManager: c.packageManager,
      /** Flatpak / Snap found by the last check (only installed ones), with their pending updates. */
      appStores: APP_STORES.flatMap((store) => {
        const packages = c.appStores[store];
        return packages ? [{ store, label: APP_STORE_LABELS[store], packages }] : [];
      }),
      /** Why a restart is needed (last check); empty = none. */
      restartReasons: c.restartReasons,
      /** Operating system read by the last check (`label` for display); null = not read yet. */
      os: c.osRelease ? { ...c.osRelease, label: osLabel(c.osRelease) } : null,
      homeAssistant: homeAssistantDto(c),
      /** Docker / Podman containers are listed during checks (`engine` = runtime found by the last check). */
      docker: { enabled: c.dockerEnabled, engine: c.dockerEngine, error: c.dockerError },
      lastCheckedAt: c.lastCheckedAt,
      lastError: c.lastError,
      createdAt: c.createdAt,
      /** A task runs or the container waits for its turn in "update all". */
      isBusy: service.isBusy(c.id) || updater.isQueued(c.id),
      /** The check/update running right now (its live log: `GET /api/runs/:id`); null while waiting in "update all". */
      activeRunId: service.activeRunId(c.id),
      apps: appDtos,
      /** System packages count as one pending update, so do Flatpak and Snap; every Home Assistant update as one. */
      updatesAvailable:
        (c.packageUpdates.length > 0 ? 1 : 0) +
        APP_STORES.filter((store) => (c.appStores[store]?.length ?? 0) > 0).length +
        appDtos.filter((a) => a.updateAvailable).length +
        (c.homeAssistant?.updates.length ?? 0),
    };
  };

  const listDtos = () => {
    const appsOf = Map.groupBy(containers.listApps(), (a) => a.containerId);
    return containers.list().map((c) => containerDto(c, appsOf.get(c.id) ?? []));
  };

  const findContainer = (rawId: string) => containers.get(parseId(rawId));

  /** Validates an application body; returns the input or a problem response. */
  /** The installed version entered by hand: undefined = keep, null = none; only apps without a version command take one. */
  const manualAppVersion = (body: AppBody, input: AppInput): string | null | undefined | Response => {
    if (body.installedVersion === undefined) {
      return undefined;
    }
    const version = blankToNull(body.installedVersion);
    if (version && input.versionCommand) {
      return validationProblem('installedVersion', 'Remove the version command to enter the installed version by hand.');
    }
    return input.versionCommand ? undefined : version;
  };

  const toAppInput = (body: AppBody, current: ContainerApp | null): AppInput | Response => {
    const name = body.name.trim();
    if (!name) {
      return validationProblem('name', 'Enter a name.');
    }
    if (!(LATEST_SOURCES as readonly string[]).includes(body.latestSource)) {
      return validationProblem('latestSource', `Use one of: ${LATEST_SOURCES.join(', ')}.`);
    }
    const latestSource = body.latestSource as LatestSource;
    const repositoryId = latestSource === 'repository' ? (body.repositoryId ?? null) : null;
    if (latestSource === 'repository' && (repositoryId === null || !repositories.get(repositoryId))) {
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
    if (capabilities(container.kind).backup === null) {
      return requested === true
        ? problem(409, `${targetTitle(container)} cannot be backed up with vzdump – update it without a backup.`)
        : null;
    }
    const defaults = deps.backupDefaults(container.hostId);
    const enabled = requested ?? container.backupBeforeUpdate ?? defaults.enabled;
    if (!enabled) {
      return null;
    }
    return (
      defaults.storage ??
      problem(409, 'Choose a backup storage (Settings → Containers, or the node under Connections), or update without a backup.')
    );
  };

  /**
   * The Proxmox node a request names (`hostId`, from the query or the body) or the default one. Throws
   * {@link UnknownNodeError} (→ 404) for an unknown node and ShellNotConfiguredError (→ 409) when it has no key.
   */
  const requireNode = (requested: number | null | undefined = null): number => {
    if (requested != null && !deps.isProxmoxHost(requested)) {
      throw new UnknownNodeError();
    }
    const hostId = requested ?? service.nodeHostId();
    if (hostId === null || !service.shellForHost(hostId).isConfigured) {
      throw new ShellNotConfiguredError();
    }
    return hostId;
  };

  /** `?hostId=` of a request (null = not given). */
  const queryHostId = (req: Request): number | null => {
    const raw = new URL(req.url).searchParams.get('hostId');
    return raw === null || raw === '' ? null : parseId(raw, 'query/hostId');
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
      POST: (req: Request) =>
        guard(async () => {
          const hostId = requireNode(queryHostId(req));
          return nodeRequest('Could not connect to the Proxmox node.', async () =>
            Response.json({ output: await service.testConnection(hostId) }),
          );
        }),
    },
    // Containers present on the node (`pct list`), marked when already added.
    '/api/proxmox/containers': {
      GET: (req: Request) =>
        guard(async () => {
          const hostId = requireNode(queryHostId(req));
          return nodeRequest('Listing containers failed.', async () => {
            const found = await service.discover(hostId);
            const added = containers.addedVmids(hostId);
            return Response.json(found.map((c) => ({ ...c, added: added.has(c.vmid) })));
          });
        }),
    },

    // Storages on the node that accept backups (`pvesm status --content backup`).
    '/api/proxmox/storages': {
      GET: (req: Request) =>
        guard(async () => {
          const hostId = requireNode(queryHostId(req));
          return nodeRequest('Listing storages failed.', async () => Response.json(await service.backupStorages(hostId)));
        }),
    },

    '/api/containers': {
      GET: () => Response.json(listDtos()),
      POST: (req: Request) =>
        guard(async () => {
          const body = await readBody(req, addContainerSchema);
          const hostId = requireNode(body.hostId);
          if (containers.existsVmid(hostId, body.vmid)) {
            return problem(409, `Guest ${body.vmid} has already been added.`);
          }
          let found: DiscoveredContainer | undefined;
          try {
            found = (await service.discover(hostId)).find((c) => c.vmid === body.vmid);
          } catch (error) {
            return problem(502, 'Listing containers failed.', { detail: errorMessage(error) });
          }
          if (!found) {
            return validationProblem('vmid', `No container or virtual machine ${body.vmid} exists on the node.`);
          }
          const container = containers.add(hostId, body.vmid, blankToNull(body.name) ?? found.name, found.kind);
          service.startCheck(container, 'manual');
          return Response.json(containerDto(container), {
            status: 201,
            headers: { location: `/api/containers/${container.id}` },
          });
        }),
    },
    // The Proxmox host itself as a target: apt check and dist-upgrade on the node (no applications, no backup).
    '/api/containers/node': {
      POST: (req: Request) =>
        guard(async () => {
          const hostId = requireNode(queryHostId(req));
          if (containers.getNode(hostId)) {
            return problem(409, 'The Proxmox host has already been added.');
          }
          let name: string;
          try {
            name = await service.nodeHostname(hostId);
          } catch (error) {
            return problem(502, 'Could not connect to the Proxmox node.', { detail: errorMessage(error) });
          }
          const node = containers.addNode(hostId, name);
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
      POST: (req: Request) =>
        guard(async () => {
          const hostId = requireNode(queryHostId(req));
          let found: DiscoveredContainer[];
          try {
            found = await service.discover(hostId);
          } catch (error) {
            return problem(502, 'Listing containers failed.', { detail: errorMessage(error) });
          }
          const known = containers.addedVmids(hostId);
          const added = found
            .filter((c) => c.kind === 'lxc' && !known.has(c.vmid))
            .map((c) => containers.add(hostId, c.vmid, c.name, c.kind));
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
          const enabled = containers.listEnabledSchedules();
          const queued = enabled.filter((c) => service.shellFor(c).isConfigured).length;
          if (queued === 0 && enabled.length > 0) {
            throw new ShellNotConfiguredError();
          }
          void scheduler.checkAll();
          return Response.json({ queued }, { status: 202 });
        }),
    },
    // Updates every container with pending updates (or those in `ids`: apt, then applications), one after another.
    // The host is left out.
    '/api/containers/update-all': {
      POST: (req: Request) =>
        guard(async () => {
          const options = await readOptionalBody(req, updateAllSchema);
          const ids = options.ids ? new Set(options.ids) : null;
          const plan = updater
            .plan()
            .filter(
              ({ container }) =>
                (ids === null || ids.has(container.id)) &&
                !updater.isQueued(container.id) &&
                service.shellFor(container).isConfigured,
            );
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
        const body = await readBody(req, updateContainerSchema);
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
        const can = capabilities(container.kind);
        if (can.homeAssistant && homeAssistantToken !== null && homeAssistantUrl === null) {
          return validationProblem('homeAssistantUrl', 'Enter the Home Assistant URL the token is used with.');
        }
        // Settings a kind does not support are cleared (see TargetCapabilities).
        Object.assign(container, {
          name,
          isEnabled: body.isEnabled,
          packagesEnabled: !can.packagesOptional || body.packagesEnabled,
          backupBeforeUpdate:
            can.backup === null ? null : body.backupBeforeUpdate === undefined ? container.backupBeforeUpdate : body.backupBeforeUpdate,
          startWhenStopped: can.power && (body.startWhenStopped ?? container.startWhenStopped),
          checkCron,
          updateCores: can.updateResources ? updateCores : null,
          updateMemoryMb: can.updateResources ? updateMemoryMb : null,
          homeAssistantUrl: can.homeAssistant ? homeAssistantUrl : null,
          homeAssistantToken: can.homeAssistant ? homeAssistantToken : null,
          homeAssistantInstall: can.homeAssistant && (body.homeAssistantInstall ?? container.homeAssistantInstall),
        });
        if (!container.packagesEnabled) {
          container.packageUpdates = [];
        }
        if (body.dockerEnabled !== undefined && body.dockerEnabled !== container.dockerEnabled) {
          container.dockerEnabled = body.dockerEnabled;
          if (!container.dockerEnabled) deps.onDockerDisabled?.(container);
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
        deps.onTargetDeleted?.(container);
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
    '/api/containers/:id/packages-upgrade': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/packages-upgrade'>) =>
        guard(async () => {
          const options = await readOptionalBody(req, updateOptionsSchema);
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!container.packagesEnabled) {
            return problem(409, 'System packages are disabled for this container.');
          }
          const backup = resolveBackup(container, options.backup);
          return backup instanceof Response ? backup : accepted(service.startPackagesUpgrade(container, backup));
        }),
    },
    // Updates every Flatpak / Snap application of a machine (`flatpak update` / `snap refresh`).
    ...Object.fromEntries(
      APP_STORES.map((store) => [
        `/api/containers/:id/${store}-update`,
        {
          POST: (req: Bun.BunRequest<'/api/containers/:id'>) =>
            guard(async () => {
              const options = await readOptionalBody(req, updateOptionsSchema);
              const container = findContainer(req.params.id);
              if (!container) {
                return problem(404, 'Container not found.');
              }
              if (!container.appStores[store]) {
                return problem(409, `${APP_STORE_LABELS[store]} was not found on ${targetLabel(container)} by its last check.`);
              }
              const backup = resolveBackup(container, options.backup);
              return backup instanceof Response ? backup : accepted(service.startAppStoreUpdate(container, store, backup));
            }),
        },
      ]),
    ),
    // Installs Home Assistant updates in a Home Assistant OS virtual machine (every installable one, or `ids`).
    '/api/containers/:id/home-assistant-update': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/home-assistant-update'>) =>
        guard(async () => {
          const options = await readOptionalBody(req, homeAssistantUpdateSchema);
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shellFor(container).isConfigured) {
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
    // Restarts a running container (`pct reboot`) or schedules a restart of a machine (the Proxmox host, a server).
    '/api/containers/:id/restart': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/restart'>) =>
        guard(() => {
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shellFor(container).isConfigured) {
            throw new ShellNotConfiguredError();
          }
          if (updater.isQueued(container.id)) {
            return problem(409, `Updates of ${targetLabel(container)} are running – restart it when they have finished.`);
          }
          if (capabilities(container.kind).restart === 'machine') {
            // Everything reached through this machine stops with it (a node's guests too).
            const onHost = containers.idsOnHost(container.hostId);
            if (service.hasActiveTasksOn(container.hostId) || onHost.some((id) => updater.isQueued(id))) {
              return problem(409, `Checks or updates are running – restart ${targetLabel(container)} when they have finished.`);
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
          const options = await readOptionalBody(req, updateOptionsSchema);
          const container = findContainer(req.params.id);
          if (!container) {
            return problem(404, 'Container not found.');
          }
          if (!service.shellFor(container).isConfigured) {
            throw new ShellNotConfiguredError();
          }
          if (updater.isQueued(container.id)) {
            throw new UpdateAllRunningError(`Updates of ${targetLabel(container)} are already running – wait for them to finish.`);
          }
          return startUpdates(updater.plan([container]), (c) => resolveBackup(c, options.backup));
        }),
    },
    '/api/containers/:id/runs': {
      // Paged newest first (keyset): `cursor` = `nextCursor` of the previous page.
      GET: (req: Bun.BunRequest<'/api/containers/:id/runs'>) => {
        const container = findContainer(req.params.id);
        if (!container) {
          return problem(404, 'Container not found.');
        }
        const params = new URL(req.url).searchParams;
        const limit = runPageLimit(params.get('limit'));
        const runs = containers.listRuns(container.id, limit + 1, runCursor(params.get('cursor')));
        const items = runs.slice(0, limit);
        return Response.json({
          items: items.map(runDto),
          nextCursor: runs.length > limit ? String(items.at(-1)!.id) : null,
        });
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
          if (!service.shellFor(container).isConfigured) {
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
        const body = await readBody(req, appSchema);
        if (!container) {
          return problem(404, 'Container not found.');
        }
        if (!capabilities(container.kind).apps) {
          return problem(409, `Applications cannot be added to ${targetLabel(container)}.`);
        }
        const input = toAppInput(body, null);
        if (input instanceof Response) {
          return input;
        }
        const manual = manualAppVersion(body, input);
        if (manual instanceof Response) {
          return manual;
        }
        const app = containers.addApp(container.id, input);
        if (manual) {
          app.installedVersion = manual;
          containers.saveApp(app);
        }
        if (app.repositoryId !== null) {
          deps.onAppLinked?.({ kind: 'app', id: app.id }, app.repositoryId);
        }
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
        const body = await readBody(req, appSchema);
        if (!app) {
          return problem(404, 'Application not found.');
        }
        const input = toAppInput(body, app);
        if (input instanceof Response) {
          return input;
        }
        const manual = manualAppVersion(body, input);
        if (manual instanceof Response) {
          return manual;
        }
        const sourceChanged =
          input.latestSource !== app.latestSource ||
          input.repositoryId !== app.repositoryId ||
          input.latestCommand !== app.latestCommand;
        const versionChanged = input.versionCommand !== app.versionCommand;
        const linked = input.repositoryId !== null && input.repositoryId !== app.repositoryId;
        Object.assign(app, input);
        // Values read with the old configuration would be misleading.
        if (sourceChanged) app.latestVersion = null;
        if (versionChanged) app.installedVersion = null;
        if (manual !== undefined) app.installedVersion = manual;
        containers.saveApp(app);
        if (linked && app.repositoryId !== null) {
          deps.onAppLinked?.({ kind: 'app', id: app.id }, app.repositoryId);
        }
        return Response.json(appDto(app));
      },
      DELETE: (req: Bun.BunRequest<'/api/containers/:id/apps/:appId'>) =>
        containers.deleteApp(parseId(req.params.id), parseId(req.params.appId, 'params/appId'))
          ? new Response(null, { status: 204 })
          : problem(404, 'Application not found.'),
    },
    // Sets the installed version of an app without a version command to its latest version ("Mark as installed").
    '/api/containers/:id/apps/:appId/mark-installed': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/apps/:appId/mark-installed'>) => {
        const app = containers.getApp(parseId(req.params.id), parseId(req.params.appId, 'params/appId'));
        if (!app) {
          return problem(404, 'Application not found.');
        }
        if (app.versionCommand) {
          return problem(409, `The installed version of ${app.name} is read by its version command.`);
        }
        if (!app.latestVersion) {
          return problem(409, `The latest version of ${app.name} is not known yet – check the container first.`);
        }
        app.installedVersion = app.latestVersion;
        containers.saveApp(app);
        return Response.json(appDto(app));
      },
    },
    '/api/containers/:id/apps/:appId/update': {
      POST: (req: Bun.BunRequest<'/api/containers/:id/apps/:appId/update'>) =>
        guard(async () => {
          const options = await readOptionalBody(req, updateOptionsSchema);
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
    packagesPending: counts.packagesPending,
    /** Pending Flatpak / Snap updates, one per store and machine. */
    appStorePending: counts.appStorePending,
    appUpdatesAvailable: containers.listAppVersions().filter((a) => appUpdateAvailable(a)).length,
    homeAssistantUpdatesAvailable: counts.homeAssistantUpdates,
  };
}
