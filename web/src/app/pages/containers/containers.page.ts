import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import { AppSettings, Container, ContainerApp, DiscoveredContainer, Run } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { ContainerSettingsDialog } from './container-settings.dialog';
import { RunLogDialog, RunLogTarget } from './run-log.dialog';
import { targetLabel } from './target';

/** How often the list is refreshed while a container reports a running task. */
const BUSY_REFRESH_MS = 3000;

/** Proxmox LXC containers: pending apt/app updates and manual update actions. */
@Component({
  selector: 'app-containers-page',
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    Icon,
    RelativeTimePipe,
    ContainerSettingsDialog,
    RunLogDialog,
  ],
  templateUrl: './containers.page.html',
  styleUrl: './containers.page.scss',
})
export class ContainersPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly statusService = inject(StatusService);

  protected readonly containers = signal<Container[]>([]);
  protected readonly settings = signal<AppSettings | null>(null);
  protected readonly loading = signal(true);
  /** False when the node is not configured (from settings or a 409 answer). */
  protected readonly configured = signal(true);
  protected readonly busyIds = signal<ReadonlySet<number>>(new Set());
  /** Key of the action waiting for confirmation, e.g. `apt-3`, `app-3-7`, `delete-3`. */
  protected readonly confirming = signal<string | null>(null);
  /** Containers whose apt package list is expanded. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());

  protected readonly editing = signal<Container | null>(null);
  protected readonly runTarget = signal<RunLogTarget | null>(null);

  // "Add container" panel
  protected readonly addOpen = signal(false);
  protected readonly discovering = signal(false);
  protected readonly discovered = signal<DiscoveredContainer[]>([]);
  protected readonly discoverError = signal<string | null>(null);
  protected readonly adding = signal(false);
  protected selectedVmid: number | null = null;

  protected readonly checkingAll = signal(false);
  /** Ticks so relative times stay current. */
  protected readonly now = signal(Date.now());

  protected readonly available = computed(() => this.discovered().filter((c) => !c.added));
  protected readonly globalCron = computed(() => this.settings()?.proxmox.checkCron ?? '');
  protected readonly backupStorage = computed(() => this.settings()?.proxmox.backupStorage ?? null);
  /** "Backup first" checkbox of the open update confirmation. */
  protected readonly backupFirst = signal(false);
  protected readonly anyBusy = computed(() => this.containers().some((c) => c.isBusy));
  protected readonly hasNode = computed(() => this.containers().some((c) => c.kind === 'node'));
  protected readonly label = targetLabel;

  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.statusService.revision();
      untracked(() => void this.load());
    });
    const ticker = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(ticker);
      this.clearRefresh();
    });
  }

  protected async load(): Promise<void> {
    try {
      const [containers, settings] = await Promise.all([
        firstValueFrom(this.api.getContainers()),
        firstValueFrom(this.api.getSettings()),
      ]);
      this.containers.set(containers);
      this.settings.set(settings);
      this.configured.set(settings.proxmox.configured);
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.loading.set(false);
      this.scheduleRefresh();
    }
  }

  /**
   * Polls while something runs in the background (new container, scheduled checks, "check all"). Re-armed after
   * every load – an effect on `anyBusy` would fire only when it changes, so a check longer than one interval
   * would stop the polling.
   */
  private scheduleRefresh(): void {
    this.clearRefresh();
    if (this.anyBusy()) {
      this.refreshTimer = setTimeout(() => void this.load(), BUSY_REFRESH_MS);
    }
  }

  protected async openAdd(): Promise<void> {
    this.addOpen.set(true);
    this.discovering.set(true);
    this.discoverError.set(null);
    try {
      const found = await firstValueFrom(this.api.discoverContainers());
      this.discovered.set(found);
      this.selectedVmid = found.find((c) => !c.added)?.vmid ?? null;
    } catch (error) {
      this.handleNotConfigured(error);
      this.discoverError.set(describeError(error));
    } finally {
      this.discovering.set(false);
    }
  }

  protected async add(): Promise<void> {
    const vmid = this.selectedVmid === null ? null : Number(this.selectedVmid);
    if (vmid === null || this.adding()) {
      return;
    }
    this.adding.set(true);
    try {
      const created = await firstValueFrom(this.api.addContainer(vmid));
      this.containers.update((list) => [...list, created].sort((a, b) => a.vmid - b.vmid));
      this.scheduleRefresh(); // the first check of the new container runs in the background
      this.discovered.update((list) =>
        list.map((c) => (c.vmid === vmid ? { ...c, added: true } : c)),
      );
      this.addOpen.set(false);
      this.toast.success(`Added CT ${created.vmid} (${created.name}) – checking it now.`);
      void this.statusService.refresh();
    } catch (error) {
      this.handleNotConfigured(error);
      this.toast.error(error);
    } finally {
      this.adding.set(false);
    }
  }

  protected async addAll(): Promise<void> {
    if (this.adding()) {
      return;
    }
    this.adding.set(true);
    try {
      const created = await firstValueFrom(this.api.addAllContainers());
      const vmids = new Set(created.map((c) => c.vmid));
      this.discovered.update((list) => list.map((c) => (vmids.has(c.vmid) ? { ...c, added: true } : c)));
      this.addOpen.set(false);
      this.toast.success(
        created.length > 0
          ? `Added ${created.length} container(s) – checking them now.`
          : 'All containers of the node have been added already.',
      );
      // Checks are queued on the server; reload to pick up their progress.
      await this.load();
      void this.statusService.refresh();
    } catch (error) {
      this.handleNotConfigured(error);
      this.toast.error(error);
    } finally {
      this.adding.set(false);
    }
  }

  protected async addNode(): Promise<void> {
    if (this.adding()) {
      return;
    }
    this.adding.set(true);
    try {
      const created = await firstValueFrom(this.api.addNode());
      this.containers.update((list) => [created, ...list]);
      this.scheduleRefresh();
      this.addOpen.set(false);
      this.toast.success(`Added the Proxmox host (${created.name}) – checking it now.`);
      void this.statusService.refresh();
    } catch (error) {
      this.handleNotConfigured(error);
      this.toast.error(error);
    } finally {
      this.adding.set(false);
    }
  }

  protected async checkAll(): Promise<void> {
    this.checkingAll.set(true);
    try {
      const { queued } = await firstValueFrom(this.api.checkAllContainers());
      this.toast.info(`Checking ${queued} container(s) in the background.`);
      // The list shows progress (isBusy) and refreshes itself while checks run.
      setTimeout(() => void this.load(), 500);
    } catch (error) {
      this.handleNotConfigured(error);
      this.toast.error(error);
    } finally {
      this.checkingAll.set(false);
    }
  }

  protected check(container: Container): Promise<void> {
    return this.startRun(container, () => this.api.checkContainer(container.id));
  }

  /** Opens an update confirmation; "Backup first" starts with the container's default. */
  protected ask(key: string, container: Container): void {
    // The host cannot be backed up with vzdump.
    this.backupFirst.set(
      container.kind !== 'node' && container.effectiveBackupBeforeUpdate && this.backupStorage() !== null,
    );
    this.confirming.set(key);
  }

  protected upgradeApt(container: Container): Promise<void> {
    this.confirming.set(null);
    const backup = this.backupFirst();
    return this.startRun(container, () => this.api.upgradeApt(container.id, backup));
  }

  protected updateApp(container: Container, app: ContainerApp): Promise<void> {
    this.confirming.set(null);
    const backup = this.backupFirst();
    return this.startRun(container, () => this.api.updateApp(container.id, app.id, backup));
  }

  protected async remove(container: Container): Promise<void> {
    this.confirming.set(null);
    await this.withBusy(container.id, async () => {
      await firstValueFrom(this.api.deleteContainer(container.id));
      this.containers.update((list) => list.filter((c) => c.id !== container.id));
      this.toast.success(`Removed ${targetLabel(container)}.`);
      void this.statusService.refresh();
    });
  }

  protected showHistory(container: Container): void {
    this.runTarget.set({ container, runId: null });
  }

  protected toggleExpanded(id: number): void {
    this.expanded.update((ids) => {
      const next = new Set(ids);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });
  }

  protected onSettingsSaved(updated: Container): void {
    this.replace(updated);
    this.editing.set(null);
    this.toast.success(`Settings of ${targetLabel(updated)} saved.`);
  }

  protected onSettingsClosed(): void {
    this.editing.set(null);
    // Applications may have been added/changed in the dialog.
    void this.load();
  }

  protected onRunFinished(run: Run): void {
    void this.load();
    void this.statusService.refresh();
    if (run.status === 'failed') {
      this.toast.error(`${kindLabel(run.kind)} failed – see the log for details.`);
    } else {
      this.toast.success(`${kindLabel(run.kind)} finished.`);
    }
  }

  protected isBusy(container: Container): boolean {
    return container.isBusy || this.busyIds().has(container.id);
  }

  protected statusClass(container: Container): string {
    // Stopped is a normal state (skipped, not an error) – a neutral badge.
    return container.status === 'running' ? 'badge-success' : '';
  }

  /** Stopped and not allowed to be started temporarily – commands cannot run in it. */
  protected blockedWhileStopped(container: Container): boolean {
    return container.status === 'stopped' && !container.startWhenStopped;
  }

  protected cronOf(container: Container): string {
    return container.checkCron ?? this.globalCron();
  }

  private async startRun(container: Container, start: () => ReturnType<ApiService['checkContainer']>): Promise<void> {
    await this.withBusy(container.id, async () => {
      const run = await firstValueFrom(start());
      this.replace({ ...container, isBusy: true });
      this.runTarget.set({ container, runId: run.id });
    });
  }

  private async withBusy(id: number, action: () => Promise<void>): Promise<void> {
    this.busyIds.update((ids) => new Set(ids).add(id));
    try {
      await action();
    } catch (error) {
      this.handleNotConfigured(error);
      this.toast.error(error);
    } finally {
      this.busyIds.update((ids) => {
        const next = new Set(ids);
        next.delete(id);
        return next;
      });
    }
  }

  /** A 409 "not configured" answer means the settings changed meanwhile – show the hint. */
  private handleNotConfigured(error: unknown): void {
    if (error instanceof HttpErrorResponse && error.status === 409 && /not configured/i.test(describeError(error))) {
      this.configured.set(false);
    }
  }

  private replace(updated: Container): void {
    this.containers.update((list) => list.map((c) => (c.id === updated.id ? updated : c)));
  }

  private clearRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }
}

export function kindLabel(kind: Run['kind']): string {
  return kind === 'check' ? 'Check' : kind === 'apt-upgrade' ? 'apt upgrade' : 'Application update';
}
