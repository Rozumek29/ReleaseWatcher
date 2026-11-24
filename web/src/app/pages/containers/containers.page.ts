import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ClockService } from '../../core/clock.service';
import { ApiService, describeError } from '../../core/api.service';
import { AppSettings, AppStore, Container, ContainerApp, DiscoveredContainer, DockerContainer, HomeAssistantUpdate, Host, Run } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ContainerSort, PreferencesService } from '../../core/preferences.service';
import { ToastService } from '../../core/toast.service';
import { HostDialog, HostDialogData } from '../../shared/host.dialog';
import { DockerContainers } from '../../shared/docker-containers';
import { Avatar } from '../../shared/avatar';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { SystemPackages } from './system-packages';
import { ContainerSettingsDialog } from './container-settings.dialog';
import { RunLogDialog, RunLogTarget } from './run-log.dialog';
import { kindLabel, packagesLabel, targetLabel, upgradeCommand } from './target';

/** How often the list is refreshed while a container reports a running task. */
const BUSY_REFRESH_MS = 3000;
/** Width at which the list and the detail pane stop sitting side by side (same as in the stylesheet). */
const NARROW_QUERY = '(max-width: 1100px)';

/** Proxmox guests and servers: pending apt/app updates and manual update actions. */
@Component({
  selector: 'app-containers-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DatePipe,
    RouterLink,
    Avatar,
    Icon,
    RelativeTimePipe,
    ContainerSettingsDialog,
    RunLogDialog,
    SystemPackages,
    HostDialog,
    DockerContainers,
  ],
  templateUrl: './containers.page.html',
  styleUrl: './containers.page.scss',
})
export class ContainersPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly statusService = inject(StatusService);

  protected readonly containers = signal<Container[]>([]);
  /** Docker / Podman containers found on the machines, by target id. */
  protected readonly dockerByTarget = signal<ReadonlyMap<number, DockerContainer[]>>(new Map());
  protected readonly noDockerContainers: DockerContainer[] = [];
  protected readonly settings = signal<AppSettings | null>(null);
  protected readonly loading = signal(true);
  /** False when the node is not configured (from settings or a 409 answer). */
  protected readonly configured = signal(true);
  protected readonly busyIds = signal<ReadonlySet<number>>(new Set());
  /** Key of the action waiting for confirmation, e.g. `apt-3`, `app-3-7`, `delete-3`. */
  protected readonly confirming = signal<string | null>(null);
  /** Containers whose apt package list is expanded. */
  protected readonly expanded = signal<ReadonlySet<number>>(new Set());
  /** Flatpak / Snap lists that are expanded (`<container id>-<store>`). */
  protected readonly expandedStores = signal<ReadonlySet<string>>(new Set());

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
  protected readonly updatingAll = signal(false);
  /** Ticks so relative times stay current. */
  protected readonly now = inject(ClockService).now;

  protected readonly available = computed(() => this.discovered().filter((c) => !c.added));
  /** "Add all" adds containers only: virtual machines need the guest agent and may have no apt. */
  protected readonly availableContainers = computed(() => this.available().filter((c) => c.kind === 'lxc'));
  protected readonly globalCron = computed(() => this.settings()?.proxmox.checkCron ?? '');
  /** Proxmox nodes guests can be added from (the first one is the default). */
  protected readonly nodes = computed(() => this.settings()?.proxmox.nodes ?? []);
  /** Node the add form lists guests of (null = the default node). */
  protected readonly addHostId = signal<number | null>(null);
  /**
   * Backup storage shown with "Update all": the storage of the selected targets' node(s); several nodes with
   * different storages are summarised.
   */
  protected readonly headerStorage = computed(() => {
    const storages = new Set(this.updatable().map((c) => c.backupStorage).filter((s): s is string => s !== null));
    return storages.size === 0 ? null : storages.size === 1 ? [...storages][0]! : 'each node’s storage';
  });
  /** "Backup first" checkbox of the open update confirmation. */
  protected readonly backupFirst = signal(false);
  protected readonly anyBusy = computed(() => this.containers().some((c) => c.isBusy));
  /** The node picked in the add form has its own entry already ("Add host" is hidden). */
  protected readonly hasNode = computed(() =>
    this.containers().some((c) => c.kind === 'node' && (this.addHostId() === null || c.hostId === this.addHostId())),
  );
  /** At least one target can be reached (its host has a key) – "Check all" and "Update" need one. */
  protected readonly anyConfigured = computed(() => this.containers().some((c) => c.configured));
  /** The missing-node hint matters when there is nothing yet or Proxmox targets are listed (not for servers only). */
  protected readonly needsNode = computed(
    () => this.containers().length === 0 || this.containers().some((c) => c.kind !== 'server'),
  );
  /** "Add server" dialog (a new server host gets its target right away). */
  protected readonly addingServer = signal<HostDialogData | null>(null);
  protected readonly label = targetLabel;
  protected readonly packagesLabel = packagesLabel;
  protected readonly upgradeCommand = upgradeCommand;
  /** Containers "Update all" would update (same rules as the server: no host, no disabled or blocked ones). */
  protected readonly updatable = computed(() =>
    this.containers().filter((c) => this.pendingCount(c) > 0),
  );
  /** Containers ticked for "Update" (null = not choosing; the first click on "Update" ticks every updatable one). */
  protected readonly picked = signal<ReadonlySet<number> | null>(null);
  /** Ticked containers that still have pending updates – what the second click on "Update" updates. */
  protected readonly pickedUpdatable = computed(() => {
    const picked = this.picked();
    return picked ? this.updatable().filter((c) => picked.has(c.id)) : [];
  });

  // Browsing many containers: filter tabs, search, sort and the selected container shown in the detail pane.
  protected readonly preferences = inject(PreferencesService);
  protected readonly filters = FILTERS;
  protected readonly sorts = SORTS;
  protected readonly filter = signal<ContainerFilter>('all');
  protected readonly query = signal('');
  protected readonly selectedId = signal<number | null>(null);
  /** Narrow screens show either the list or the detail pane; true = the detail pane. */
  protected readonly showDetail = signal(false);

  protected readonly counts = computed(() => {
    const counts: Record<ContainerFilter, number> = { all: 0, updates: 0, errors: 0, working: 0, inactive: 0 };
    for (const c of this.containers()) {
      for (const f of FILTERS) {
        if (matchesFilter(c, f.value)) {
          counts[f.value]++;
        }
      }
    }
    return counts;
  });

  /** Targets of more than one host (several nodes, or a node and servers) are listed in groups. */
  protected readonly grouped = computed(() => new Set(this.containers().map((c) => groupOf(c).key)).size > 1);

  protected readonly visible = computed(() => {
    const filter = this.filter();
    const query = this.query().trim().toLowerCase();
    const sort = this.preferences.containerSort();
    const grouped = this.grouped();
    return this.containers()
      .filter((c) => matchesFilter(c, filter) && (!query || searchText(c).includes(query)))
      .sort((a, b) => (grouped ? groupOf(a).order.localeCompare(groupOf(b).order) : 0) || compareContainers(a, b, sort));
  });

  /** Group headings of the list by the index of the group's first visible target (only when grouped). */
  protected readonly groupHeadings = computed(() => {
    const headings = new Map<number, { label: string; kind: 'proxmox' | 'servers' | 'none'; count: number }>();
    if (!this.grouped()) return headings;
    let current: { key: string; heading: { label: string; kind: 'proxmox' | 'servers' | 'none'; count: number } } | null = null;
    this.visible().forEach((c, i) => {
      const group = groupOf(c);
      if (group.key !== current?.key) {
        current = { key: group.key, heading: { label: group.label, kind: group.kind, count: 0 } };
        headings.set(i, current.heading);
      }
      current.heading.count++;
    });
    return headings;
  });

  /** The selected container, or the first one in the list when nothing (still visible) is selected. */
  protected readonly selected = computed(() => {
    const visible = this.visible();
    return visible.find((c) => c.id === this.selectedId()) ?? visible[0] ?? null;
  });
  /** The selection as a one-item list, so switching containers re-creates (and re-animates) the detail pane. */
  protected readonly selectedList = computed(() => {
    const selected = this.selected();
    return selected ? [selected] : [];
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    effect(() => {
      this.statusService.revision();
      untracked(() => void this.load());
    });
    inject(DestroyRef).onDestroy(() => this.clearRefresh());
  }

  protected async serverAdded(host: Host): Promise<void> {
    this.addingServer.set(null);
    this.toast.success(
      host.configured ? `Added ${host.name} – checking it now.` : `Added ${host.name} – choose an SSH key for it in Settings → Connections.`,
    );
    await this.load();
    void this.statusService.refresh();
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
      // Only machines where a check found Docker or Podman have containers to show.
      if (containers.some((c) => c.docker.enabled && (c.docker.engine || c.docker.error))) {
        void this.loadDocker();
      } else {
        this.dockerByTarget.set(new Map());
      }
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.loading.set(false);
      this.scheduleRefresh();
    }
  }

  /** Docker containers of the machines (shown in the detail pane); a failure only leaves the section out. */
  private async loadDocker(): Promise<void> {
    try {
      const { containers } = await firstValueFrom(this.api.getDocker());
      const byTarget = new Map<number, DockerContainer[]>();
      for (const c of containers) {
        if (c.source.kind === 'target') byTarget.set(c.source.id, [...(byTarget.get(c.source.id) ?? []), c]);
      }
      this.dockerByTarget.set(byTarget);
    } catch {
      this.dockerByTarget.set(new Map());
    }
  }

  protected onDockerChanged(container: DockerContainer): void {
    const next = new Map(this.dockerByTarget());
    const list = next.get(container.source.id);
    if (list) next.set(container.source.id, list.map((c) => (c.id === container.id ? container : c)));
    this.dockerByTarget.set(next);
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
    if (this.addHostId() === null || !this.nodes().some((n) => n.id === this.addHostId())) {
      this.addHostId.set(this.nodes()[0]?.id ?? null);
    }
    await this.discover();
  }

  /** Another node picked in the add form: lists its guests. */
  protected async pickNode(hostId: number): Promise<void> {
    this.addHostId.set(Number(hostId));
    await this.discover();
  }

  private async discover(): Promise<void> {
    this.discovering.set(true);
    this.discoverError.set(null);
    try {
      const found = await firstValueFrom(this.api.discoverContainers(this.nodeParam()));
      this.discovered.set(found);
      this.selectedVmid = found.find((c) => !c.added)?.vmid ?? null;
    } catch (error) {
      this.handleNotConfigured(error);
      this.discoverError.set(describeError(error));
    } finally {
      this.discovering.set(false);
    }
  }

  /** `hostId` for requests about the picked node – null (the default node) while there is only one. */
  private nodeParam(): number | null {
    return this.nodes().length > 1 ? this.addHostId() : null;
  }

  /** Kind of the guest picked in the add form. */
  protected selectedKind(): 'lxc' | 'vm' | null {
    const vmid = this.selectedVmid === null ? null : Number(this.selectedVmid);
    return this.discovered().find((c) => c.vmid === vmid)?.kind ?? null;
  }

  protected async add(): Promise<void> {
    const vmid = this.selectedVmid === null ? null : Number(this.selectedVmid);
    if (vmid === null || this.adding()) {
      return;
    }
    this.adding.set(true);
    try {
      const created = await firstValueFrom(this.api.addContainer(vmid, null, this.nodeParam()));
      this.containers.update((list) => [...list, created].sort((a, b) => a.vmid - b.vmid));
      this.selectedId.set(created.id);
      this.scheduleRefresh(); // the first check of the new container runs in the background
      this.discovered.update((list) =>
        list.map((c) => (c.vmid === vmid ? { ...c, added: true } : c)),
      );
      this.addOpen.set(false);
      this.toast.success(`Added ${targetLabel(created)} (${created.name}) – checking it now.`);
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
      const created = await firstValueFrom(this.api.addAllContainers(this.nodeParam()));
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
      const created = await firstValueFrom(this.api.addNode(this.nodeParam()));
      this.containers.update((list) => [created, ...list]);
      this.selectedId.set(created.id);
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

  /**
   * First click on "Update": shows checkboxes in the list with every container that has updates ticked;
   * "Backup first" is on when a container backs up by default.
   */
  protected startPicking(): void {
    this.confirming.set(null);
    this.backupFirst.set(
      this.updatable().some((c) => c.effectiveBackupBeforeUpdate && c.backupStorage !== null),
    );
    this.picked.set(new Set(this.updatable().map((c) => c.id)));
  }

  protected togglePicked(container: Container, checked: boolean): void {
    this.picked.update((picked) => {
      const next = new Set(picked);
      if (checked) {
        next.add(container.id);
      } else {
        next.delete(container.id);
      }
      return next;
    });
  }

  /** Ticks every container with updates, or none when all of them are ticked. */
  protected togglePickAll(): void {
    const all = this.updatable();
    this.picked.set(new Set(this.pickedUpdatable().length === all.length ? [] : all.map((c) => c.id)));
  }

  /** Second click on "Update": updates the ticked containers one after another. */
  protected async updateAll(): Promise<void> {
    const ids = this.pickedUpdatable().map((c) => c.id);
    this.picked.set(null);
    if (ids.length === 0) {
      return;
    }
    this.updatingAll.set(true);
    try {
      const { targets, updates } = await firstValueFrom(
        this.api.updateAllContainers(this.backupFirst() && this.headerStorage() !== null, ids),
      );
      this.toast.info(
        targets > 0
          ? `Updating ${targets} container(s) one after another – ${updates} update(s).`
          : 'No container has pending updates.',
      );
      // Queued containers report isBusy, so the list keeps refreshing until all updates finished.
      await this.load();
      void this.statusService.refresh();
    } catch (error) {
      this.handleNotConfigured(error);
      this.toast.error(error);
    } finally {
      this.updatingAll.set(false);
    }
  }

  protected check(container: Container): Promise<void> {
    return this.startRun(container, () => this.api.checkContainer(container.id));
  }

  /** Opens an update confirmation; "Backup first" starts with the container's default. */
  protected ask(key: string, container: Container): void {
    this.backupFirst.set(
      container.capabilities.backup !== null && container.effectiveBackupBeforeUpdate && container.backupStorage !== null,
    );
    this.confirming.set(key);
  }

  protected upgradePackages(container: Container): Promise<void> {
    this.confirming.set(null);
    const backup = this.backupFirst();
    return this.startRun(container, () => this.api.upgradePackages(container.id, backup));
  }

  protected updateAppStore(container: Container, store: AppStore): Promise<void> {
    this.confirming.set(null);
    const backup = this.backupFirst();
    return this.startRun(container, () => this.api.updateAppStore(container.id, store, backup));
  }

  protected toggleStore(key: string): void {
    this.expandedStores.update((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  protected restart(container: Container): Promise<void> {
    this.confirming.set(null);
    return this.startRun(container, () => this.api.restartContainer(container.id));
  }

  /** Installs one Home Assistant update, or every installable one (`update` null). */
  protected updateHomeAssistant(container: Container, update: HomeAssistantUpdate | null): Promise<void> {
    this.confirming.set(null);
    const backup = this.backupFirst();
    return this.startRun(container, () =>
      this.api.updateHomeAssistant(container.id, backup, update ? [update.id] : undefined),
    );
  }

  /** Home Assistant updates that can be installed from here. */
  protected installableHa(container: Container): HomeAssistantUpdate[] {
    return container.homeAssistant?.updates.filter((u) => !u.installBlocker) ?? [];
  }

  /** The update could be installed with an access token (the hint above the list explains it once). */
  protected waitsForToken(container: Container, update: HomeAssistantUpdate): boolean {
    return update.source === 'entity' && update.installable && !container.homeAssistant?.hasToken;
  }

  /** An integration update waits for an access token. */
  protected hasBlockedEntity(container: Container): boolean {
    return container.homeAssistant?.updates.some((u) => this.waitsForToken(container, u)) ?? false;
  }

  protected haSourceLabel(update: HomeAssistantUpdate): string {
    switch (update.source) {
      case 'core':
      case 'os':
      case 'supervisor':
        return 'System';
      case 'app':
        return 'App';
      case 'entity':
        return update.platform === 'marketplace' || update.platform === 'hacs'
          ? 'Integration (marketplace)'
          : `Integration${update.platform ? ` (${update.platform})` : ''}`;
    }
  }

  /** A restart is suggested and possible right now (a stopped container starts fresh anyway). */
  protected needsRestart(container: Container): boolean {
    return restartPending(container);
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

  /** Opens the live log of the check/update running in the container. */
  protected showActiveRun(container: Container): void {
    if (container.activeRunId !== null) {
      this.runTarget.set({ container, runId: container.activeRunId });
    }
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

  protected async onRunFinished(run: Run): Promise<void> {
    void this.statusService.refresh();
    const reloaded = this.load().then(() => this.followNextRun(run));
    if (run.status === 'failed') {
      this.toast.error(`${kindLabel(run.kind)} failed – see the log for details.`);
    } else {
      this.toast.success(`${kindLabel(run.kind)} finished.`);
    }
    await reloaded;
  }

  /**
   * "Update all" runs the updates of a container one after another: when the log of one of them is open and it
   * finishes, the log switches to the next one.
   */
  private followNextRun(finished: Run): void {
    const target = this.runTarget();
    const container = this.containers().find((c) => c.id === finished.targetId);
    const next = container?.activeRunId ?? null;
    if (container && target?.runId === finished.id && next !== null && next !== finished.id) {
      this.runTarget.set({ container, runId: next });
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

  /**
   * Updates "Update all" runs in the container (same rules as the server: system packages, Flatpak and Snap count once each, then every application
   * with a newer version and an update command; nothing for the host, paused or blocked containers).
   */
  protected pendingCount(container: Container): number {
    if (!container.capabilities.updateAll || !container.isEnabled || this.blockedWhileStopped(container)) {
      return 0;
    }
    const apt = container.packagesEnabled && container.packageUpdates.length > 0 ? 1 : 0;
    // Flatpak and Snap update all their applications at once.
    const stores = container.appStores.filter((s) => s.packages.length > 0).length;
    // Home Assistant updates run as one task.
    const ha = this.installableHa(container).length > 0 ? 1 : 0;
    return apt + stores + ha + container.apps.filter((a) => a.updateAvailable === true && !!a.updateCommand).length;
  }

  /** Runs every pending update of one container, one after another (a single backup before the first one). */
  protected async updateContainer(container: Container): Promise<void> {
    this.confirming.set(null);
    const backup = this.backupFirst() && container.backupStorage !== null;
    await this.withBusy(container.id, async () => {
      const { updates } = await firstValueFrom(this.api.runContainerUpdates(container.id, backup));
      this.toast.info(
        updates > 0
          ? `Updating ${targetLabel(container)} – ${updates} update(s) one after another.`
          : `${targetLabel(container)} has no pending updates.`,
      );
      // The container reports isBusy while its updates run, so the list keeps refreshing.
      await this.load();
      void this.statusService.refresh();
      // Like a single update: show the live log (it moves on to the next update by itself).
      const updated = this.containers().find((c) => c.id === container.id);
      if (updated) {
        this.showActiveRun(updated);
      }
    });
  }

  protected select(container: Container): void {
    this.selectedId.set(container.id);
    this.confirming.set(null);
    this.showDetail.set(true);
    // Narrow screens swap the list for the detail pane – start reading it at its top.
    this.scrollIntoView('.detail', 'start');
  }

  /** Narrow screens: back from the detail pane to the list, at the container that was open. */
  protected backToList(): void {
    this.showDetail.set(false);
    const id = this.selected()?.id;
    this.scrollIntoView(`[data-id="${id}"]`, 'center', true);
  }

  private scrollIntoView(selector: string, block: ScrollLogicalPosition, focus = false): void {
    if (typeof matchMedia !== 'function' || !matchMedia(NARROW_QUERY).matches) {
      return;
    }
    setTimeout(() => {
      const element = this.host.nativeElement.querySelector<HTMLElement>(selector);
      element?.scrollIntoView({ block });
      if (focus) {
        element?.focus({ preventScroll: true });
      }
    });
  }

  /** Arrow keys, Home and End move the selection through the list. */
  protected onListKeydown(event: KeyboardEvent): void {
    const list = this.visible();
    const index = list.findIndex((c) => c.id === this.selected()?.id);
    const next =
      event.key === 'ArrowDown' ? index + 1
      : event.key === 'ArrowUp' ? index - 1
      : event.key === 'Home' ? 0
      : event.key === 'End' ? list.length - 1
      : null;
    const target = next === null ? undefined : list[Math.max(0, Math.min(list.length - 1, next))];
    if (!target) {
      return;
    }
    event.preventDefault();
    this.selectedId.set(target.id);
    this.confirming.set(null);
    const listEl = event.currentTarget as HTMLElement;
    queueMicrotask(() =>
      listEl.querySelector<HTMLButtonElement>(`[data-id="${target.id}"]`)?.focus(),
    );
  }

  /** Short state shown in the list: what needs attention, or that all is well. */
  protected stateOf(container: Container): ContainerState {
    if (container.activeRunId !== null || this.isBusy(container)) {
      return container.activeRunId === null && container.isBusy && !this.busyIds().has(container.id)
        ? 'queued'
        : 'working';
    }
    if (!container.isEnabled) {
      return 'paused';
    }
    if (hasError(container)) {
      return 'error';
    }
    if (container.updatesAvailable > 0) {
      return 'updates';
    }
    if (this.needsRestart(container)) {
      return 'restart';
    }
    if (container.status === 'stopped') {
      return 'stopped';
    }
    return container.lastCheckedAt ? 'ok' : 'unchecked';
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

  /** An app without a version command whose version (entered by hand) is not the latest one. */
  protected canMarkInstalled(app: ContainerApp): boolean {
    return (
      !app.versionCommand &&
      app.latestVersion !== null &&
      app.installedVersion !== app.latestVersion &&
      app.updateAvailable !== false
    );
  }

  /** Sets the installed version of the app to its latest version and reloads the container (its counters change). */
  protected async markAppInstalled(container: Container, app: ContainerApp): Promise<void> {
    await this.withBusy(container.id, async () => {
      const updated = await firstValueFrom(this.api.markAppInstalled(container.id, app.id));
      this.replace(await firstValueFrom(this.api.getContainer(container.id)));
      this.toast.success(`${app.name}: ${updated.installedVersion} marked as installed.`);
      void this.statusService.refresh();
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

export type ContainerFilter = 'all' | 'updates' | 'errors' | 'working' | 'inactive';
/** State shown for a container in the list (one, by priority). */
export type ContainerState =
  | 'working'
  | 'queued'
  | 'error'
  | 'updates'
  | 'restart'
  | 'paused'
  | 'stopped'
  | 'ok'
  | 'unchecked';

const FILTERS: readonly { value: ContainerFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'updates', label: 'Updates' },
  { value: 'errors', label: 'Errors' },
  { value: 'working', label: 'Working' },
  { value: 'inactive', label: 'Stopped or paused' },
];

const SORTS: readonly { value: ContainerSort; label: string }[] = [
  { value: 'attention', label: 'Needs attention first' },
  { value: 'vmid', label: 'VMID' },
  { value: 'name', label: 'Name' },
];

/** List group of a target: its Proxmox node, all servers together, or targets without a host. */
function groupOf(c: Container): { key: string; label: string; kind: 'proxmox' | 'servers' | 'none'; order: string } {
  if (c.kind === 'server') return { key: 'servers', label: 'Servers', kind: 'servers', order: '2' };
  if (c.hostId === null) return { key: 'none', label: 'Without a host', kind: 'none', order: '3' };
  const name = c.hostName ?? 'Proxmox node';
  return { key: `node-${c.hostId}`, label: name, kind: 'proxmox', order: `1 ${name.toLowerCase()} ${c.hostId}` };
}

function hasError(c: Container): boolean {
  return !!c.lastError || c.apps.some((a) => !!a.error);
}

function restartPending(c: Container): boolean {
  return c.restartReasons.length > 0 && c.status !== 'stopped';
}

function matchesFilter(c: Container, filter: ContainerFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'updates':
      // A restart is the last step of applying updates.
      return c.updatesAvailable > 0 || restartPending(c);
    case 'errors':
      return hasError(c);
    case 'working':
      return c.isBusy;
    case 'inactive':
      return !c.isEnabled || c.status === 'stopped';
  }
}

/** Lower = shown higher with "Needs attention first". */
function attentionRank(c: Container): number {
  if (c.isBusy) return 0;
  if (!c.isEnabled) return 5; // paused: not checked or updated, so nothing to act on
  if (hasError(c)) return 1;
  if (c.updatesAvailable > 0 || restartPending(c)) return 2;
  if (c.status === 'stopped') return 4;
  return 3;
}

function compareContainers(a: Container, b: Container, sort: ContainerSort): number {
  // The host stays on top, like the node in Proxmox's own tree; servers follow the node's guests.
  const host = Number(b.kind === 'node') - Number(a.kind === 'node');
  if (host !== 0) return host;
  const server = Number(a.kind === 'server') - Number(b.kind === 'server');
  if (server !== 0) return server;
  if (sort === 'attention') {
    const rank = attentionRank(a) - attentionRank(b);
    if (rank !== 0) return rank;
  } else if (sort === 'name') {
    const name = a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
    if (name !== 0) return name;
  }
  return a.vmid - b.vmid;
}

/** What the search box matches: name, VMID, application names and their repositories. */
function searchText(c: Container): string {
  return [
    c.name,
    c.kind === 'node' ? 'host proxmox' : c.kind === 'vm' ? `vm ${c.vmid}` : c.kind === 'server' ? 'server' : String(c.vmid),
    c.hostName ?? '',
    ...c.apps.flatMap((a) => [a.name, a.repositoryFullName ?? '']),
  ]
    .join(' ')
    .toLowerCase();
}
