import type { RepositoryStore } from './db.ts';
import type { DockerStore } from './docker/store.ts';
import type { MachineAppRef, WatchedRepository } from './domain.ts';
import type { ContainerStore } from './proxmox/store.ts';

/** An app on a machine a repository can read its installed version from. */
export interface MachineAppOption extends MachineAppRef {
  name: string;
  installedVersion: string | null;
  /** When the machine last reported the version. */
  checkedAt: string | null;
  /** Repository the app is linked to (by hand or, for Docker, through its labels); null = none. */
  repositoryId: number | null;
  /** `owner/name` of that repository. */
  repository: string | null;
}

/** A machine (target) or Docker connection with its apps. */
export interface MachineAppGroup {
  machine: { kind: 'target' | 'endpoint'; id: number; name: string };
  apps: MachineAppOption[];
}

/**
 * True when an app linked to `repo` from the machine side should become the source of its installed version: the
 * repository has none or one entered by hand (never replaces a version URL or another app), and the app reports a
 * version.
 */
export const shouldAdoptMachineApp = (
  repo: Pick<WatchedRepository, 'installedVersionUrl' | 'installedVersionApp'>,
  reportsVersion: boolean,
): boolean => reportsVersion && !repo.installedVersionUrl && repo.installedVersionApp === null;

/**
 * Apps on machines as sources of a repository's installed version: applications of targets and Docker containers. The
 * link between an app and a repository is the one set on the machine side (an app's "latest version from" repository,
 * a Docker container's repository); reading the version from an app links it.
 */
export class MachineApps {
  constructor(
    private readonly deps: { repositories: RepositoryStore; containers: ContainerStore; docker: DockerStore },
  ) {}

  /** Every machine with apps, by name; hidden and vanished Docker containers are left out. */
  list(): MachineAppGroup[] {
    const { containers, docker } = this.deps;
    const groups = new Map<string, MachineAppGroup>();
    const group = (kind: 'target' | 'endpoint', id: number, name: string): MachineAppGroup => {
      const key = `${kind}:${id}`;
      let found = groups.get(key);
      if (!found) {
        found = { machine: { kind, id, name }, apps: [] };
        groups.set(key, found);
      }
      return found;
    };

    const repositories = docker.listRepositoryLinks();
    const fullNames = new Map(repositories.map((r) => [r.id, `${r.owner}/${r.name}`]));
    const byFullName = new Map(repositories.map((r) => [`${r.owner}/${r.name}`.toLowerCase(), r.id]));
    const linkTo = (repositoryId: number | null) => ({ repositoryId, repository: repositoryId === null ? null : (fullNames.get(repositoryId) ?? null) });

    const targetNames = containers.names();
    for (const a of containers.listApps()) {
      group('target', a.containerId, targetNames.get(a.containerId) ?? `#${a.containerId}`).apps.push({
        kind: 'app',
        id: a.id,
        name: a.name,
        installedVersion: a.installedVersion,
        checkedAt: a.checkedAt,
        ...linkTo(a.repositoryId),
      });
    }

    const endpointNames = new Map(docker.listEndpoints().map((e) => [e.id, e.name]));
    for (const d of docker.listContainers()) {
      if (!d.present || d.ignored) continue;
      const name =
        d.source.kind === 'target'
          ? (targetNames.get(d.source.id) ?? `#${d.source.id}`)
          : (endpointNames.get(d.source.id) ?? `#${d.source.id}`);
      group(d.source.kind, d.source.id, name).apps.push({
        kind: 'docker',
        id: d.id,
        name: d.name,
        installedVersion: d.installedVersion,
        checkedAt: d.lastSeenAt,
        ...linkTo(d.linkAuto ? (d.labelRepository ? (byFullName.get(d.labelRepository) ?? null) : null) : d.repositoryId),
      });
    }

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return [...groups.values()]
      .map((g) => ({ ...g, apps: g.apps.sort((a, b) => byName(a, b) || (a.kind === b.kind ? 0 : a.kind === 'app' ? -1 : 1)) }))
      .sort((a, b) => byName(a.machine, b.machine) || a.machine.id - b.machine.id);
  }

  /** The app with its link, or null when it does not exist (any more). */
  find(ref: MachineAppRef): MachineAppOption | null {
    return this.list().flatMap((g) => g.apps).find((a) => a.kind === ref.kind && a.id === ref.id) ?? null;
  }

  /**
   * Links an app to a repository, as if done on the machine side: an application takes its latest version from the
   * repository, a Docker container is linked to it by hand. A repository whose installed version came from the app before
   * falls back to the version entered by hand (database triggers).
   */
  link(ref: MachineAppRef, repositoryId: number): void {
    if (ref.kind === 'app') {
      const app = this.deps.containers.findApp(ref.id);
      if (app && (app.latestSource !== 'github' || app.repositoryId !== repositoryId)) {
        app.latestSource = 'github';
        app.repositoryId = repositoryId;
        // The latest version came from elsewhere: the next check reads it from the repository.
        app.latestVersion = null;
        this.deps.containers.saveApp(app);
      }
      return;
    }
    const container = this.deps.docker.getContainer(ref.id);
    const linked = this.find(ref)?.repositoryId ?? null;
    if (container && (container.ignored || linked !== repositoryId)) {
      this.deps.docker.saveChoices({ id: container.id, ignored: false, linkAuto: false, repositoryId });
    }
  }

  /**
   * Called after an app was linked to a repository on the machine side: when the app reports a version, the repository
   * reads its installed version from it – unless it already has a version URL or another app (see {@link shouldAdoptMachineApp}).
   */
  adopt(ref: MachineAppRef, repositoryId: number): void {
    const repo = this.deps.repositories.get(repositoryId);
    if (!repo) return;
    const reportsVersion =
      ref.kind === 'app'
        ? (() => {
            const app = this.deps.containers.findApp(ref.id);
            return app !== null && (app.versionCommand !== null || app.installedVersion !== null);
          })()
        : this.deps.docker.getContainer(ref.id)?.installedVersion != null;
    if (shouldAdoptMachineApp(repo, reportsVersion)) {
      this.deps.repositories.setInstalledVersionApp(repositoryId, ref);
    }
  }
}
