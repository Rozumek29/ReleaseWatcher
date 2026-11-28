import type { RepositoryLink } from '../docker/store.ts';
import { fullName, iconUrls, type MachineAppRef, repositoryUrl } from '../domain.ts';
import { errorMessage } from '../errors.ts';
import type { Logger } from '../log.ts';
import { type FetchLike, HomeAssistantApi, HomeAssistantApiError } from '../proxmox/home-assistant-api.ts';
import { appUpdateAvailable } from '../proxmox/domain.ts';
import { componentsFromStates, type HomeAssistantComponent, type HomeAssistantConnection, isComparableVersion, type ReadComponent } from './domain.ts';
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
  now?: () => Date;
}

/** Shown while Home Assistant is starting; the components read before are kept. */
export const STARTING_MESSAGE = 'Home Assistant is still starting – the components read before are kept until it is running.';

export class ConnectionBusyError extends Error {
  override name = 'ConnectionBusyError';
  constructor() {
    super('This Home Assistant is being read – wait for the check to finish.');
  }
}

/** What the API shows of a component. */
export interface HomeAssistantComponentView extends Omit<HomeAssistantComponent, 'repository' | 'repositoryId'> {
  /** Repository the entity names, lower-case (`owner/name`, or `host/owner/name` outside GitHub). */
  repositoryName: string;
  /** False for a commit hash (a repository without releases): shown, but not compared with releases. */
  versionComparable: boolean;
  /** Home Assistant reports an update for the entity (its state is `on`). */
  homeAssistantUpdate: boolean;
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

  constructor(deps: HomeAssistantServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
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
    return components.map((c) => {
      const repo = c.repositoryId === null ? undefined : byId.get(c.repositoryId);
      const comparable = isComparableVersion(c.installedVersion);
      const { repository: repositoryName, repositoryId: _linked, ...rest } = c;
      return {
        ...rest,
        repositoryName,
        versionComparable: comparable,
        homeAssistantUpdate: c.hasUpdate,
        repository: repo
          ? { id: repo.id, fullName: fullName(repo), url: repositoryUrl(repo), latestVersion: repo.lastSeenTag, iconUrls: iconUrls(repo.icon) }
          : null,
        suggestedRepository: c.repositoryId === null ? c.repository : null,
        updateAvailable: repo && comparable ? appUpdateAvailable({ installedVersion: c.installedVersion, latestVersion: repo.lastSeenTag }) : null,
      };
    });
  }
}
