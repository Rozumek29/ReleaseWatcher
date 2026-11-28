import type { RepositoryLink } from '../docker/store.ts';
import { fullName, iconUrls, type MachineAppRef, repositoryUrl } from '../domain.ts';
import { errorMessage } from '../errors.ts';
import type { Logger } from '../log.ts';
import { appUpdateAvailable } from '../proxmox/domain.ts';
import { type FetchLike, HomeAssistantApi, HomeAssistantApiError } from '../proxmox/home-assistant-api.ts';
import {
  componentsFromStates,
  CORE_ENTITY_ID,
  type HomeAssistantComponent,
  type HomeAssistantConnection,
  installBlocker,
  isComparableVersion,
  type ReadComponent,
} from './domain.ts';
import type { HomeAssistantStore } from './store.ts';

export interface HomeAssistantServiceDeps {
  store: HomeAssistantStore;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** `fetch` for the Home Assistant API (tests pass a fake). */
  fetch?: FetchLike;
  /** Watched repositories with what components are compared with (latest release, icon). */
  repositories?: () => readonly RepositoryLink[];
  /** A component names a watched repository and reports a version it can be compared by (`MachineApps.adopt`). */
  onLinked?: (app: MachineAppRef, repositoryId: number) => void;
  /** Pause between two looks at a running installation (tests shorten it). */
  pollMs?: number;
  now?: () => Date;
}

/** Shown while Home Assistant is starting; the components read before are kept. */
export const STARTING_MESSAGE = 'Home Assistant is still starting – the components read before are kept until it is running.';

/** An installation may take this long (Home Assistant Core downloads an image and restarts). */
const INSTALL_TIMEOUT_MS = 30 * 60_000;

export class ConnectionBusyError extends Error {
  override name = 'ConnectionBusyError';
  constructor() {
    super('This Home Assistant is busy – wait for the check or installation to finish.');
  }
}

/** Shown when Home Assistant refuses `update.install`: only administrators may install updates there. */
export const ADMIN_NEEDED_MESSAGE =
  'Home Assistant refused to install the update – installing needs the access token of a user with administrator rights.';
export const ADMIN_NEEDED_RESTART_MESSAGE =
  'Home Assistant refused to restart – that needs the access token of a user with administrator rights.';

/** Home Assistant may take this long to answer again after a restart. */
const RESTART_TIMEOUT_MS = 10 * 60_000;
/** Looks at a restarting Home Assistant that still answers before it is taken as "already back". */
const RESTART_GRACE_POLLS = 6;

/** The update cannot be installed from ReleaseWatcher (see `installBlocker`). */
export class InstallBlockedError extends Error {
  override name = 'InstallBlockedError';
}

/** What the API shows of a component. */
export interface HomeAssistantComponentView extends Omit<HomeAssistantComponent, 'repository' | 'repositoryId'> {
  /** Repository the entity names, lower-case (`owner/name`, or `host/owner/name` outside GitHub). */
  repositoryName: string;
  /** False for a commit hash (a repository without releases): shown, but not compared with releases. */
  versionComparable: boolean;
  /** Home Assistant reports an update for the entity (its state is `on`). */
  homeAssistantUpdate: boolean;
  /** Why that update cannot be installed from ReleaseWatcher; null = it can (or there is none to install). */
  installBlocker: string | null;
  /** The update is being installed right now. */
  isInstalling: boolean;
  /** The watched repository the component names; null = not watched. */
  repository: { id: number; fullName: string; url: string; latestVersion: string | null; iconUrls: string[] } | null;
  /** Repository the component names that is not watched yet (offered as "Watch"); null = already watched. */
  suggestedRepository: string | null;
  /** Release-based: the repository has a newer release than the installed version; null = not watched or not comparable. */
  updateAvailable: boolean | null;
}

/**
 * Home Assistant connections: reads their update entities and stores those that name a repository. Read-only – it
 * never installs anything.
 */
export class HomeAssistantService {
  private readonly deps: HomeAssistantServiceDeps;
  private readonly now: () => Date;
  private readonly busy = new Map<number, Promise<void>>();
  /** Component being installed, by connection (a connection installs one update at a time). */
  private readonly installing = new Map<number, number>();
  /** Connections whose Home Assistant is restarting right now (asked for, or while Core updates). */
  private readonly restarting = new Set<number>();
  private readonly pollMs: number;

  constructor(deps: HomeAssistantServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.pollMs = deps.pollMs ?? 5000;
  }

  isRestarting(connectionId: number): boolean {
    return this.restarting.has(connectionId);
  }

  isChecking(connectionId: number): boolean {
    return this.busy.has(connectionId);
  }

  /**
   * Reads the components of a Home Assistant without saving anything ("Test connection"). Refuses while Home Assistant
   * is still starting: its update entities are not all loaded then, and storing that list would drop the others.
   */
  async read(connection: Pick<HomeAssistantConnection, 'url' | 'token'>): Promise<ReadComponent[]> {
    const api = new HomeAssistantApi(connection, this.deps.fetch);
    if (!(await api.isRunning())) {
      throw new HomeAssistantApiError(STARTING_MESSAGE);
    }
    return componentsFromStates(await api.states());
  }

  /** Starts a check of the connection in the background (see {@link check}). */
  startCheck(connection: HomeAssistantConnection): void {
    if (this.busy.has(connection.id)) {
      throw new ConnectionBusyError();
    }
    const run = this.check(connection)
      .catch((err: unknown) => this.deps.log.error({ err, connection: connection.name }, 'Home Assistant check failed'))
      .finally(() => this.busy.delete(connection.id));
    this.busy.set(connection.id, run);
  }

  /** Waits for running checks (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.busy.values());
  }

  /** Reads the connection's update entities and stores them; a failure keeps what was read before. */
  async check(connection: HomeAssistantConnection): Promise<void> {
    const { store, log } = this.deps;
    let lastError: string | null = null;
    try {
      const components = await this.read(connection);
      // The connection may have been removed (or pointed elsewhere) while Home Assistant answered.
      if (store.getConnection(connection.id)?.url !== connection.url) return;
      store.replaceComponents(connection.id, components, this.now());
      this.adopt(store.listComponents(connection.id));
      log.info({ connection: connection.name, components: components.length }, 'Read Home Assistant update entities');
    } catch (error) {
      lastError = errorMessage(error).slice(0, 1000);
      log.warn({ connection: connection.name, error: lastError }, 'Reading Home Assistant update entities failed');
    }
    // Saved by id: the connection may have been edited meanwhile.
    const current = store.getConnection(connection.id);
    if (current) {
      store.saveConnection({ ...current, lastError, lastCheckedAt: this.now().toISOString() });
    }
  }

  // --- Installing ---

  /**
   * Starts installing a component's update in the background: `update.install` for its entity (with a backup when
   * asked for and supported), then waits until Home Assistant no longer reports the update and reads the connection
   * again. Only what Home Assistant offers is installed – ReleaseWatcher never picks a version.
   */
  startInstall(connection: HomeAssistantConnection, component: HomeAssistantComponent, backup: boolean): void {
    const blocker = installBlocker(component, connection);
    if (blocker) {
      throw new InstallBlockedError(blocker);
    }
    if (this.busy.has(connection.id)) {
      throw new ConnectionBusyError();
    }
    const run = this.install(connection, component, backup)
      .catch((err: unknown) => this.deps.log.error({ err, connection: connection.name, component: component.name }, 'Home Assistant installation failed'))
      .finally(() => {
        this.busy.delete(connection.id);
        this.installing.delete(connection.id);
        this.restarting.delete(connection.id);
      });
    this.busy.set(connection.id, run);
    this.installing.set(connection.id, component.id);
  }

  private async install(connection: HomeAssistantConnection, component: HomeAssistantComponent, backup: boolean): Promise<void> {
    const { store, log } = this.deps;
    const api = new HomeAssistantApi(connection, this.deps.fetch);
    // Home Assistant Core restarts while it updates: the request may be cut off and the API is away for a while.
    const restarts = component.entityId === CORE_ENTITY_ID;
    const deadline = Date.now() + INSTALL_TIMEOUT_MS;
    let error: string | null = null;
    try {
      await api.install(component.entityId, INSTALL_TIMEOUT_MS, backup && component.supportsBackup);
    } catch (err) {
      if (err instanceof HomeAssistantApiError && err.unauthorized) {
        // Reading works with any user; `update.install` is an admin-only service in Home Assistant.
        error = ADMIN_NEEDED_MESSAGE;
      } else {
        error = restarts ? null : `Installing ${component.name} failed: ${errorMessage(err)}`;
      }
    }
    while (error === null) {
      let state: Awaited<ReturnType<HomeAssistantApi['updateState']>> | null = null;
      try {
        state = await api.updateState(component.entityId);
      } catch (err) {
        if (!restarts) {
          error = `Installing ${component.name} failed: ${errorMessage(err)}`;
          break;
        }
        this.restarting.add(connection.id); // Core is restarting – shown as such
      }
      if (state) {
        this.restarting.delete(connection.id);
      }
      if (state && !state.pending && !state.inProgress) {
        break; // installed
      }
      if (state && !state.inProgress && !restarts) {
        error = `Home Assistant still reports an update of ${component.name} (installed ${state.installed ?? '?'}) – see its log.`;
      } else if (Date.now() >= deadline) {
        error = `The update of ${component.name} did not finish in time.`;
      } else {
        await Bun.sleep(this.pollMs);
      }
    }
    store.setInstallError(component.id, error?.slice(0, 1000) ?? null);
    if (error) {
      log.warn({ connection: connection.name, component: component.name, error }, 'Installing a Home Assistant update failed');
    } else {
      log.info({ connection: connection.name, component: component.name, version: component.latestVersion }, 'Installed a Home Assistant update');
    }
    const current = store.getConnection(connection.id);
    if (current) {
      await this.check(current);
    }
  }

  /**
   * Restarts Home Assistant in the background (`homeassistant.restart`, e.g. to load an updated custom integration),
   * waits until it answers again and reads the connection. Only with installing switched on for the connection.
   */
  startRestart(connection: HomeAssistantConnection): void {
    if (!connection.installEnabled) {
      throw new InstallBlockedError('Installing from ReleaseWatcher is switched off for this connection – restart Home Assistant itself.');
    }
    if (this.busy.has(connection.id)) {
      throw new ConnectionBusyError();
    }
    const run = this.restart(connection)
      .catch((err: unknown) => this.deps.log.error({ err, connection: connection.name }, 'Restarting Home Assistant failed'))
      .finally(() => {
        this.busy.delete(connection.id);
        this.restarting.delete(connection.id);
      });
    this.busy.set(connection.id, run);
    this.restarting.add(connection.id);
  }

  private async restart(connection: HomeAssistantConnection): Promise<void> {
    const { store, log } = this.deps;
    const api = new HomeAssistantApi(connection, this.deps.fetch);
    let error: string | null = null;
    try {
      await api.restart(60_000);
      log.info({ connection: connection.name }, 'Restarting Home Assistant');
      // It still answers for a moment: wait until it was away once (or a few looks passed), then until it is back.
      const deadline = Date.now() + RESTART_TIMEOUT_MS;
      let wasAway = false;
      for (let polls = 1; ; polls++) {
        await Bun.sleep(this.pollMs);
        // Running again, not just answering: while it starts, the API answers before the integrations are loaded.
        const answers = await api.isRunning().catch(() => false);
        wasAway ||= !answers;
        if (answers && (wasAway || polls >= RESTART_GRACE_POLLS)) break;
        if (Date.now() >= deadline) {
          error = 'Home Assistant did not answer again in time after the restart.';
          break;
        }
      }
    } catch (err) {
      error = err instanceof HomeAssistantApiError && err.unauthorized ? ADMIN_NEEDED_RESTART_MESSAGE : `Restarting Home Assistant failed: ${errorMessage(err)}`;
    }
    this.restarting.delete(connection.id);
    const current = store.getConnection(connection.id);
    if (!current) return;
    if (error) {
      log.warn({ connection: connection.name, error }, 'Restarting Home Assistant failed');
      store.saveConnection({ ...current, lastError: error, lastCheckedAt: this.now().toISOString() });
    } else {
      await this.check(current);
    }
  }

  /** Scheduled run: every enabled connection. */
  async checkAll(signal?: AbortSignal): Promise<void> {
    for (const connection of this.deps.store.listConnections()) {
      if (signal?.aborted) return;
      if (connection.isEnabled && !this.busy.has(connection.id)) {
        await this.check(connection);
      }
    }
  }

  /**
   * Tells `onLinked` about the components that name a watched repository and report a comparable version, so a
   * repository without another source reads its installed version from Home Assistant.
   */
  adopt(components: readonly HomeAssistantComponent[]): void {
    for (const c of components) {
      if (c.repositoryId !== null && isComparableVersion(c.installedVersion)) {
        this.deps.onLinked?.({ kind: 'home-assistant', id: c.id }, c.repositoryId);
      }
    }
  }

  /** A repository was added: the components that name it become its installed version (see {@link adopt}). */
  adoptRepository(repositoryId: number): void {
    this.adopt(this.deps.store.listLinked(repositoryId));
  }

  describe(components: readonly HomeAssistantComponent[]): HomeAssistantComponentView[] {
    const byId = new Map((this.deps.repositories?.() ?? []).map((r) => [r.id, r]));
    const connections = new Map(this.deps.store.listConnections().map((c) => [c.id, c]));
    return components.map((c) => {
      const connection = connections.get(c.connectionId);
      const pending = c.hasUpdate;
      const repo = c.repositoryId === null ? undefined : byId.get(c.repositoryId);
      const comparable = isComparableVersion(c.installedVersion);
      const { repository: repositoryName, repositoryId: _linked, ...rest } = c;
      return {
        ...rest,
        repositoryName,
        versionComparable: comparable,
        homeAssistantUpdate: pending,
        installBlocker: pending && connection ? installBlocker(c, connection) : null,
        isInstalling: this.installing.get(c.connectionId) === c.id,
        repository: repo
          ? { id: repo.id, fullName: fullName(repo), url: repositoryUrl(repo), latestVersion: repo.lastSeenTag, iconUrls: iconUrls(repo.icon) }
          : null,
        suggestedRepository: c.repositoryId === null ? c.repository : null,
        updateAvailable: repo && comparable ? appUpdateAvailable({ installedVersion: c.installedVersion, latestVersion: repo.lastSeenTag }) : null,
      };
    });
  }
}
