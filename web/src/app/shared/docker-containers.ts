import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../core/api.service';
import { DockerContainer, DockerContainerRequest, WatchedRepository } from '../core/models';
import { ToastService } from '../core/toast.service';
import { Avatar } from './avatar';
import { Icon } from './icon';

interface ComposeGroup {
  /** Compose project; null = containers started on their own. */
  project: string | null;
  containers: DockerContainer[];
}

const VERSION_SOURCE: Record<NonNullable<DockerContainer['installedVersionSource']>, string> = {
  tag: 'From the image tag',
  label: 'From the image label (org.opencontainers.image.version)',
  digest: 'The registry tag with the same digest as the running image',
};

/**
 * Docker / Podman containers of one source (a machine or a Docker endpoint), grouped by compose project: installed
 * version, newer image of the same tag, the linked repository's latest release. Containers can be linked to a
 * watched repository and ignored. Read-only towards the containers themselves.
 */
@Component({
  selector: 'app-docker-containers',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon, Avatar],
  templateUrl: './docker-containers.html',
  styleUrl: './docker-containers.scss',
})
export class DockerContainers {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  readonly containers = input.required<DockerContainer[]>();
  /** A container changed (ignored, linked, its repository watched). */
  readonly changed = output<DockerContainer>();

  protected readonly showIgnored = signal(false);
  protected readonly busy = signal<ReadonlySet<number>>(new Set());
  /** Container whose repository link is being edited. */
  protected readonly linking = signal<number | null>(null);
  protected readonly repositories = signal<WatchedRepository[] | null>(null);

  protected readonly ignoredCount = computed(() => this.containers().filter((c) => c.ignored).length);

  protected readonly groups = computed<ComposeGroup[]>(() => {
    const shown = this.containers().filter((c) => this.showIgnored() || !c.ignored);
    const byProject = new Map<string | null, DockerContainer[]>();
    for (const c of shown) {
      byProject.set(c.composeProject, [...(byProject.get(c.composeProject) ?? []), c]);
    }
    return [...byProject]
      .map(([project, containers]) => ({ project, containers }))
      .sort((a, b) => (a.project === null ? 1 : b.project === null ? -1 : a.project.localeCompare(b.project)));
  });

  protected versionTitle(c: DockerContainer): string {
    return c.installedVersionSource
      ? VERSION_SOURCE[c.installedVersionSource]
      : 'No version tag, no version label and no registry tag with the same digest';
  }

  protected registryTitle(c: DockerContainer): string {
    return c.registry.error ?? c.registry.note ?? 'Not checked in the registry yet';
  }

  protected isBusy(c: DockerContainer): boolean {
    return this.busy().has(c.id);
  }

  protected toggleIgnored(c: DockerContainer): Promise<void> {
    return this.save(c, { ignored: !c.ignored }, c.ignored ? `${c.name} is shown again.` : `${c.name} is ignored.`);
  }

  protected async startLinking(c: DockerContainer): Promise<void> {
    this.linking.set(c.id);
    if (this.repositories() === null) {
      try {
        const repositories = await firstValueFrom(this.api.getRepositories());
        this.repositories.set([...repositories].sort((a, b) => a.fullName.localeCompare(b.fullName)));
      } catch (error) {
        this.toast.error(error);
        this.linking.set(null);
      }
    }
  }

  /** `auto` = through the labels, `none` = no repository, otherwise a repository id. */
  protected async link(c: DockerContainer, value: string): Promise<void> {
    const request: DockerContainerRequest =
      value === 'auto' ? { linkAuto: true } : { linkAuto: false, repositoryId: value === 'none' ? null : Number(value) };
    this.linking.set(null);
    await this.save(c, request, 'Link saved.');
  }

  protected linkValue(c: DockerContainer): string {
    return c.linkAuto ? 'auto' : c.repository ? String(c.repository.id) : 'none';
  }

  /** Watches the repository the labels name; the container is linked to it through its labels. */
  protected async watch(c: DockerContainer): Promise<void> {
    const repository = c.suggestedRepository;
    if (!repository) return;
    this.setBusy(c.id, true);
    try {
      await firstValueFrom(this.api.addRepository({ repository, includePrereleases: false }));
      this.repositories.set(null);
      this.toast.success(`Watching ${repository}.`);
      // Saved without changes: returns the container linked to the new repository.
      this.changed.emit(await firstValueFrom(this.api.updateDockerContainer(c.id, {})));
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.setBusy(c.id, false);
    }
  }

  private async save(c: DockerContainer, request: DockerContainerRequest, message: string): Promise<void> {
    this.setBusy(c.id, true);
    try {
      this.changed.emit(await firstValueFrom(this.api.updateDockerContainer(c.id, request)));
      this.toast.success(message);
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.setBusy(c.id, false);
    }
  }

  private setBusy(id: number, busy: boolean): void {
    const next = new Set(this.busy());
    if (busy) next.add(id);
    else next.delete(id);
    this.busy.set(next);
  }
}
