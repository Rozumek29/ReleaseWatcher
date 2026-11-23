import { fullName, iconUrls } from '../domain.ts';
import { errorMessage } from '../http.ts';
import type { Logger } from '../log.ts';
import { appUpdateAvailable, type Container, type StepResult } from '../proxmox/domain.ts';
import {
  composeProject,
  displayImage,
  type DockerContainer,
  type DockerEndpoint,
  type DockerSource,
  type EngineListing,
  engineLabel,
  imageState,
  type ImageRef,
  type ImageState,
  installedVersion,
  isIgnoredByLabel,
  LABELS,
  labelRepository,
  localDigests,
  needsResolving,
  parseDockerListOutput,
  parseImageRef,
  repositoryKey,
  resolveCandidates,
  tagKey,
  type VersionSource,
} from './domain.ts';
import { type DockerEngine, HttpDockerEngine } from './engine.ts';
import type { RegistryClient } from './registry.ts';
import type { DockerStore, RepositoryLink } from './store.ts';

export interface DockerServiceDeps {
  store: DockerStore;
  registry: RegistryClient;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Engine client of an endpoint URL (tests pass a fake); defaults to {@link HttpDockerEngine}. */
  engine?: (url: string) => DockerEngine;
  /** Target names for DTOs (the machine a container runs on). */
  targetName?: (targetId: number) => string | null;
  now?: () => Date;
}

/** Writes a line to the log of a run (container checks) – or nowhere. */
export type NoteFn = (line: string) => void;

/** A tag's digest is not asked again within this time (a container check and the Docker job in the same minute). */
const REGISTRY_RECHECK_MS = 10 * 60_000;
/** A digest no version tag was found for is searched again after this time (new tags may have been pushed). */
const RESOLVE_RETRY_MS = 24 * 60 * 60_000;
/** Registry requests at the same time. */
const REGISTRY_CONCURRENCY = 4;

export class EndpointBusyError extends Error {
  override name = 'EndpointBusyError';
  constructor() {
    super('This Docker endpoint is being checked – wait for the check to finish.');
  }
}

/** What the API shows of a container (built by {@link DockerService.describe}). */
export interface DockerContainerView {
  id: number;
  source: DockerSource & { name: string | null };
  name: string;
  image: string;
  /** Short image name for display (`nginx:1.27`). */
  imageDisplay: string;
  tag: string | null;
  state: string | null;
  present: boolean;
  ignored: boolean;
  composeProject: string | null;
  composeService: string | null;
  installedVersion: string | null;
  installedVersionSource: VersionSource | null;
  /** Linked through the labels (true) or chosen by the user (false). */
  linkAuto: boolean;
  repository: { id: number; fullName: string; latestVersion: string | null; iconUrls: string[] } | null;
  /** Repository the labels name that is not watched yet (offered as "Watch"); null = none or already watched. */
  suggestedRepository: string | null;
  /** Release-based: the linked repository has a newer release than the installed version; null = unknown. */
  updateAvailable: boolean | null;
  registry: {
    state: ImageState;
    /** Version tag the registry's current image of this tag has (when it could be resolved). */
    latestVersion: string | null;
    checkedAt: string | null;
    error: string | null;
    /** Why the state is unknown (pinned digest, local image, …); null otherwise. */
    note: string | null;
  };
}

/**
 * Docker and Podman containers: stores what engines list (endpoints directly, targets through their checks), asks
 * registries for the current digest of every tag and resolves digests to version tags. Read-only – it never changes
 * a container.
 */
export class DockerService {
  private readonly deps: DockerServiceDeps;
  private readonly now: () => Date;
  private readonly engineFor: (url: string) => DockerEngine;
  private readonly busy = new Map<number, Promise<void>>();
  /** Registry work running right now (so overlapping checks do not ask twice). */
  private registryRun: Promise<void> | null = null;

  constructor(deps: DockerServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.engineFor = deps.engine ?? ((url) => new HttpDockerEngine(url));
  }

  // --- Endpoints ---

  isChecking(endpointId: number): boolean {
    return this.busy.has(endpointId);
  }

  /** Lists an endpoint's engine without saving anything ("Test connection"). */
  async test(url: string): Promise<EngineListing> {
    return this.engineFor(url).list();
  }

  /** Starts a check of the endpoint in the background (see {@link checkEndpoint}). */
  startEndpointCheck(endpoint: DockerEndpoint): void {
    if (this.busy.has(endpoint.id)) {
      throw new EndpointBusyError();
    }
    const run = this.checkEndpoint(endpoint)
      .catch((err: unknown) => this.deps.log.error({ err, endpoint: endpoint.name }, 'Docker endpoint check failed'))
      .finally(() => this.busy.delete(endpoint.id));
    this.busy.set(endpoint.id, run);
  }

  /** Waits for a running endpoint check (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.busy.values(), this.registryRun]);
  }

  /** Lists the endpoint's containers, stores them and checks their images in the registries. */
  async checkEndpoint(endpoint: DockerEndpoint, signal?: AbortSignal): Promise<void> {
    const { store, log } = this.deps;
    const source: DockerSource = { kind: 'endpoint', id: endpoint.id };
    try {
      const listing = await this.engineFor(endpoint.url).list(signal);
      this.applyListing(source, listing);
      endpoint.engine = engineLabel(listing);
      endpoint.lastError = null;
      log.info({ endpoint: endpoint.name, containers: listing.containers.length }, 'Listed Docker containers');
    } catch (error) {
      endpoint.lastError = errorMessage(error).slice(0, 1000);
      log.warn({ endpoint: endpoint.name, error: endpoint.lastError }, 'Listing Docker containers failed');
    }
    endpoint.lastCheckedAt = this.now().toISOString();
    // Saved by id: the endpoint may have been edited (or removed) meanwhile.
    const current = store.getEndpoint(endpoint.id);
    if (current) {
      store.saveEndpoint({ ...current, engine: endpoint.engine, lastError: endpoint.lastError, lastCheckedAt: endpoint.lastCheckedAt });
    }
    if (!endpoint.lastError) {
      await this.refreshRegistries(store.listContainers(source), { signal });
    }
  }

  /** Scheduled run: every enabled endpoint, then the registries of the containers found on targets. */
  async checkAll(signal?: AbortSignal): Promise<void> {
    for (const endpoint of this.deps.store.listEndpoints()) {
      if (signal?.aborted) return;
      if (endpoint.isEnabled && !this.busy.has(endpoint.id)) {
        await this.checkEndpoint(endpoint, signal);
      }
    }
    await this.refreshRegistries(
      this.deps.store.listContainers().filter((c) => c.source.kind === 'target'),
      { signal },
    );
  }

  // --- Targets (machines reached over SSH) ---

  /**
   * Applies the `docker` step of a target check: stores the listed containers (or clears them when Docker/Podman is
   * gone) and checks their images. Never throws – problems end up in `container.dockerError` and the run log.
   */
  async applyTargetCheck(container: Container, step: StepResult | undefined, note: NoteFn): Promise<void> {
    const source: DockerSource = { kind: 'target', id: container.id };
    try {
      if (!step) {
        throw new Error('the container listing did not run');
      }
      const listing = step.exitCode === 0 ? parseDockerListOutput(step.output) : null;
      if (step.exitCode !== 0) {
        throw new Error(step.output.trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit code ${step.exitCode}`);
      }
      if (!listing) {
        if (container.dockerEngine) note('Docker: no container runtime found any more');
        container.dockerEngine = null;
        container.dockerError = null;
        this.deps.store.clearSource(source);
        return;
      }
      container.dockerEngine = engineLabel(listing);
      container.dockerError = null;
      this.applyListing(source, listing);
      note(`Docker: ${container.dockerEngine}, ${listing.containers.length} running container(s)`);
    } catch (error) {
      container.dockerError = `Docker: ${errorMessage(error)}`.slice(0, 1000);
      note(`Could not list the Docker containers: ${errorMessage(error)}`);
      return;
    }
    await this.refreshRegistries(this.deps.store.listContainers(source), { note });
  }

  /** Docker was switched off for a target: forget its containers. */
  clearTarget(container: Container): void {
    container.dockerEngine = null;
    container.dockerError = null;
    this.deps.store.clearSource({ kind: 'target', id: container.id });
  }

  private applyListing(source: DockerSource, listing: EngineListing): void {
    this.deps.store.replaceListing(
      source,
      listing.containers.map((c) => ({ ...c, labelRepository: labelRepository(c.labels), ignoredByLabel: isIgnoredByLabel(c.labels) })),
      this.now(),
    );
    this.updateInstalledVersions();
  }

  // --- Registries ---

  /**
   * Asks the registries for the current digest of every tag the containers run (skipping tags checked a few minutes
   * ago unless `force`) and resolves local and new digests of floating tags (`latest`) to version tags.
   */
  async refreshRegistries(
    containers: readonly DockerContainer[],
    options: { force?: boolean; signal?: AbortSignal; note?: NoteFn } = {},
  ): Promise<void> {
    // One registry pass at a time: a second caller waits and then only does what is still due.
    while (this.registryRun) {
      await this.registryRun;
    }
    const run = this.runRegistries(containers, options);
    this.registryRun = run.finally(() => {
      this.registryRun = null;
    });
    await this.registryRun;
  }

  private async runRegistries(
    containers: readonly DockerContainer[],
    options: { force?: boolean; signal?: AbortSignal; note?: NoteFn },
  ): Promise<void> {
    const { store, registry, log } = this.deps;
    const now = this.now();
    const refs = new Map<string, ImageRef>();
    for (const c of containers) {
      const ref = c.present && !c.ignored ? parseImageRef(c.image) : null;
      const key = ref ? tagKey(ref) : null;
      if (ref && key) refs.set(key, ref);
    }
    const states = store.listTagStates();
    const due = [...refs].filter(([key]) => {
      const checkedAt = states.get(key)?.checkedAt;
      return options.force || !checkedAt || now.getTime() - Date.parse(checkedAt) >= REGISTRY_RECHECK_MS;
    });
    let failed = 0;
    await inBatches(due, REGISTRY_CONCURRENCY, async ([key, ref]) => {
      if (options.signal?.aborted) return;
      try {
        store.saveTagState(key, { remoteDigest: await registry.digest(ref, options.signal) }, this.now());
      } catch (error) {
        failed++;
        store.saveTagState(key, { error: errorMessage(error) }, this.now());
      }
    });
    if (due.length > 0) {
      options.note?.(`Docker: checked ${due.length} image tag(s) in the registries${failed > 0 ? `, ${failed} failed` : ''}`);
    }

    // Digests to resolve, per image repository and tag flavour.
    const fresh = store.listTagStates();
    const wanted = new Map<string, { ref: ImageRef; digests: Set<string> }>();
    for (const c of containers) {
      const ref = c.present && !c.ignored ? parseImageRef(c.image) : null;
      const key = ref ? tagKey(ref) : null;
      if (!ref || !key || !needsResolving(ref.tag)) continue;
      const repo = repositoryKey(ref);
      const known = store.digestVersions(repo);
      const isDue = (digest: string) => {
        const entry = known.get(digest);
        return !entry || (entry.version === null && now.getTime() - Date.parse(entry.checkedAt) >= RESOLVE_RETRY_MS);
      };
      const local = localDigests(ref, c.repoDigests);
      const remote = fresh.get(key)?.remoteDigest ?? null;
      const digests = [...local.slice(0, 1), ...(remote && !local.includes(remote) ? [remote] : [])].filter(isDue);
      if (digests.length === 0) continue;
      const group = `${repo}|${ref.tag}`;
      const entry = wanted.get(group) ?? { ref, digests: new Set<string>() };
      digests.forEach((d) => entry.digests.add(d));
      wanted.set(group, entry);
    }
    for (const { ref, digests } of wanted.values()) {
      if (options.signal?.aborted) break;
      try {
        const found = await this.resolveDigests(ref, [...digests], options.signal);
        for (const digest of digests) {
          store.saveDigestVersion(repositoryKey(ref), digest, found.get(digest) ?? null, this.now());
        }
        const resolved = [...found.values()];
        if (resolved.length > 0) options.note?.(`Docker: ${displayImage(ref)} is ${resolved.join(' / ')}`);
      } catch (error) {
        // Not stored: tried again with the next check.
        log.warn({ image: displayImage(ref), error: errorMessage(error) }, 'Resolving image digests to versions failed');
      }
    }
    this.updateInstalledVersions();
    this.prune();
  }

  /**
   * Finds the version tag of each digest among the newest tags of the same flavour (one HEAD per tag). Candidates come
   * newest and most specific first, so the first tag found for a digest is the one to show (`1.2.3` before `1.2`).
   */
  private async resolveDigests(ref: ImageRef, digests: readonly string[], signal?: AbortSignal): Promise<Map<string, string>> {
    const { registry } = this.deps;
    const candidates = resolveCandidates(await registry.tags(ref, signal), ref.tag);
    const result = new Map<string, string>();
    for (let i = 0; i < candidates.length && result.size < digests.length; i += REGISTRY_CONCURRENCY) {
      if (signal?.aborted) break;
      const batch = candidates.slice(i, i + REGISTRY_CONCURRENCY);
      const found = await Promise.all(batch.map((tag) => registry.digest({ ...ref, tag, digest: null }, signal).catch(() => null)));
      found.forEach((digest, index) => {
        if (digest && digests.includes(digest) && !result.has(digest)) {
          result.set(digest, batch[index]!);
        }
      });
    }
    return result;
  }

  /** Recomputes the stored installed version of every container (used by vulnerability impacts and repositories). */
  private updateInstalledVersions(): void {
    const { store } = this.deps;
    const resolved = store.allDigestVersions();
    const versions = new Map<number, string | null>();
    for (const c of store.listContainers()) {
      versions.set(c.id, this.installed(c, resolved)?.version ?? null);
    }
    store.saveInstalledVersions(versions);
  }

  private installed(c: DockerContainer, resolved: ReadonlyMap<string, string | null>) {
    const ref = parseImageRef(c.image);
    const local = ref ? localDigests(ref, c.repoDigests)[0] : undefined;
    const resolvedVersion = ref && local ? (resolved.get(`${repositoryKey(ref)}@${local}`) ?? null) : null;
    return installedVersion({ tag: ref?.tag ?? null, labels: c.labels, resolvedVersion });
  }

  /** Drops registry data of images no container runs any more. */
  private prune(): void {
    const { store } = this.deps;
    const keys = new Set<string>();
    const digests: string[] = [];
    const states = store.listTagStates();
    for (const c of store.listContainers()) {
      const ref = parseImageRef(c.image);
      const key = ref ? tagKey(ref) : null;
      if (!ref || !key) continue;
      keys.add(key);
      const repo = repositoryKey(ref);
      for (const d of localDigests(ref, c.repoDigests)) digests.push(`${repo}@${d}`);
      const remote = states.get(key)?.remoteDigest;
      if (remote) digests.push(`${repo}@${remote}`);
    }
    store.pruneTagStates([...keys]);
    store.pruneDigestVersions(digests);
  }

  // --- Views ---

  /** API view of containers (all, or those of one source). */
  describe(containers: readonly DockerContainer[]): DockerContainerView[] {
    const { store } = this.deps;
    const states = store.listTagStates();
    const resolved = store.allDigestVersions();
    const repos = store.listRepositoryLinks();
    const byId = new Map(repos.map((r) => [r.id, r]));
    const byName = new Map(repos.map((r) => [fullName(r).toLowerCase(), r]));
    const endpointNames = new Map(store.listEndpoints().map((e) => [e.id, e.name]));
    return containers.map((c) => {
      const ref = parseImageRef(c.image);
      const key = ref ? tagKey(ref) : null;
      const tagState = key ? states.get(key) : undefined;
      const local = ref ? localDigests(ref, c.repoDigests) : [];
      const installed = this.installed(c, resolved);
      const repo: RepositoryLink | undefined = c.linkAuto
        ? c.labelRepository
          ? byName.get(c.labelRepository)
          : undefined
        : c.repositoryId !== null
          ? byId.get(c.repositoryId)
          : undefined;
      const remote = tagState?.remoteDigest ?? null;
      const state = imageState(local, remote);
      // The exact version of the newer image; null when not known or not different (a rebuilt `1.2.3`).
      const remoteVersion = ref && remote ? (resolved.get(`${repositoryKey(ref)}@${remote}`) ?? null) : null;
      const latestVersion = remoteVersion !== installed?.version ? remoteVersion : null;
      return {
        id: c.id,
        source: {
          ...c.source,
          name: c.source.kind === 'endpoint' ? (endpointNames.get(c.source.id) ?? null) : (this.deps.targetName?.(c.source.id) ?? null),
        },
        name: c.name,
        image: c.image,
        imageDisplay: ref ? displayImage(ref) : c.image,
        tag: ref?.tag ?? null,
        state: c.state,
        present: c.present,
        ignored: c.ignored,
        composeProject: composeProject(c.labels),
        composeService: c.labels[LABELS.composeService] ?? null,
        installedVersion: installed?.version ?? null,
        installedVersionSource: installed?.source ?? null,
        linkAuto: c.linkAuto,
        repository: repo
          ? { id: repo.id, fullName: fullName(repo), latestVersion: repo.lastSeenTag, iconUrls: iconUrls(repo.icon) }
          : null,
        suggestedRepository: c.labelRepository && !byName.has(c.labelRepository) ? c.labelRepository : null,
        updateAvailable: repo ? appUpdateAvailable({ installedVersion: installed?.version ?? null, latestVersion: repo.lastSeenTag }) : null,
        registry: {
          state,
          latestVersion: state === 'update-available' ? latestVersion : null,
          checkedAt: tagState?.checkedAt ?? null,
          error: tagState?.error ?? null,
          note: !ref
            ? 'The image reference could not be read (the image was re-tagged or removed).'
            : ref.digest
              ? 'The image is pinned to a digest.'
              : local.length === 0
                ? 'The image was built locally or loaded without a registry digest.'
                : null,
        },
      };
    });
  }
}

async function inBatches<T>(items: readonly T[], size: number, task: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(task));
  }
}
