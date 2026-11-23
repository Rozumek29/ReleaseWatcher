import { ChangeDetectionStrategy, Component, DestroyRef, OnInit, computed, effect, inject, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import { DockerEndpoint, Host, HostType, SshKey } from '../../core/models';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { HostDialog, HostDialogData } from '../../shared/host.dialog';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { DockerEndpointDialog, DockerEndpointDialogData } from './docker-endpoint.dialog';
import { SshKeyDialog, SshKeyDialogMode } from './ssh-key.dialog';

/** While a Docker endpoint is being checked, the list reloads this often. */
const POLL_MS = 2000;

/**
 * Settings → Connections: the hosts ReleaseWatcher reaches over SSH, the named keys they log in with and the Docker
 * endpoints it reads without SSH (socket, socket proxy, TCP).
 */
@Component({
  selector: 'app-connections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DockerEndpointDialog, HostDialog, Icon, RelativeTimePipe, SshKeyDialog],
  templateUrl: './connections.html',
  styleUrl: './connections.scss',
})
export class ConnectionsPanel implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);

  /** Hosts or keys were added, changed or removed. */
  readonly changed = output<void>();

  protected readonly hosts = signal<Host[] | null>(null);
  protected readonly keys = signal<SshKey[] | null>(null);
  /** Host, key or endpoint IDs with an action in progress (`host-1`, `key-2`, `endpoint-3`). */
  protected readonly busy = signal<ReadonlySet<string>>(new Set());
  /** Inline confirmation shown in place of the actions (`delete-host-1`, `forget-host-1`, `delete-key-2`, `delete-endpoint-3`). */
  protected readonly confirming = signal<string | null>(null);
  /** Result of "Test connection" per host. */
  protected readonly testResults = signal<ReadonlyMap<number, { ok: boolean; text: string }>>(new Map());
  protected readonly editingHost = signal<HostDialogData | null>(null);
  protected readonly keyDialog = signal<SshKeyDialogMode | null>(null);
  protected readonly endpoints = signal<DockerEndpoint[] | null>(null);
  protected readonly editingEndpoint = signal<DockerEndpointDialogData | null>(null);
  protected readonly now = signal(Date.now());

  /** Some endpoint is being checked: reload until it finished. */
  private readonly checking = computed(() => !!this.endpoints()?.some((e) => e.isChecking));

  constructor() {
    effect((onCleanup) => {
      if (!this.checking()) return;
      const timer = setTimeout(() => void this.reloadEndpoints(), POLL_MS);
      onCleanup(() => clearTimeout(timer));
    });
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }

  async ngOnInit(): Promise<void> {
    await Promise.all([this.reload(), this.reloadEndpoints()]);
  }

  protected async reload(): Promise<void> {
    try {
      const [hosts, keys] = await Promise.all([firstValueFrom(this.api.getHosts()), firstValueFrom(this.api.getSshKeys())]);
      this.hosts.set(hosts);
      this.keys.set(keys);
    } catch (error) {
      this.toast.error(error);
      this.hosts.update((h) => h ?? []);
      this.keys.update((k) => k ?? []);
    }
  }

  protected typeLabel(type: HostType): string {
    return type === 'proxmox' ? 'Proxmox node' : 'Server';
  }

  protected destination(host: Host): string {
    return `${host.user}@${host.address}${host.port === 22 ? '' : `:${host.port}`}`;
  }

  protected isBusy(key: string): boolean {
    return this.busy().has(key);
  }

  /** One dialog for every host: the type is picked inside. */
  protected addHost(): void {
    this.editingHost.set({ type: 'server', host: null, chooseType: true });
  }

  protected editHost(host: Host): void {
    this.editingHost.set({ type: host.type, host });
  }

  protected async hostSaved(): Promise<void> {
    this.editingHost.set(null);
    await this.reload();
    this.changed.emit();
  }

  protected async testHost(host: Host): Promise<void> {
    await this.run(`host-${host.id}`, async () => {
      let result: { ok: boolean; text: string };
      try {
        const { output } = await firstValueFrom(this.api.testHost(host.id));
        result = { ok: true, text: output || 'Connected.' };
      } catch (error) {
        result = { ok: false, text: describeError(error) };
      }
      this.testResults.update((m) => new Map(m).set(host.id, result));
    });
  }

  protected async forgetHostKey(host: Host): Promise<void> {
    this.confirming.set(null);
    await this.run(`host-${host.id}`, async () => {
      await firstValueFrom(this.api.forgetHostKey(host.id));
      this.toast.success(`Host key of ${host.name} forgotten – the next connection trusts the new one.`);
    });
  }

  protected async deleteHost(host: Host): Promise<void> {
    this.confirming.set(null);
    await this.run(`host-${host.id}`, async () => {
      await firstValueFrom(this.api.deleteHost(host.id));
      this.toast.success(`${host.name} removed.`);
      await this.reload();
      this.changed.emit();
    });
  }

  /** A generated key stays in its dialog, which shows the public key to copy; other dialogs close. */
  protected async keySaved(): Promise<void> {
    if (this.keyDialog()?.kind !== 'generate') {
      this.keyDialog.set(null);
    }
    await this.reload();
    this.changed.emit();
  }

  protected async copyPublicKey(key: SshKey): Promise<void> {
    if (!key.publicKey) return;
    try {
      await navigator.clipboard.writeText(key.publicKey);
      this.toast.success('Public key copied.');
    } catch {
      this.toast.error('Copying failed – select the key and copy it by hand.');
    }
  }

  protected async deleteKey(key: SshKey): Promise<void> {
    this.confirming.set(null);
    await this.run(`key-${key.id}`, async () => {
      await firstValueFrom(this.api.deleteSshKey(key.id));
      this.toast.success(`Key ${key.name} removed.`);
      await this.reload();
      this.changed.emit();
    });
  }

  protected async reloadEndpoints(): Promise<void> {
    try {
      this.endpoints.set(await firstValueFrom(this.api.getDockerEndpoints()));
    } catch (error) {
      this.toast.error(error);
      this.endpoints.update((e) => e ?? []);
    }
  }

  protected endpointSaved(endpoint: DockerEndpoint): void {
    const isNew = this.editingEndpoint()?.endpoint === null;
    this.editingEndpoint.set(null);
    this.toast.success(isNew ? `${endpoint.name} added – checking it now.` : 'Endpoint saved.');
    void this.reloadEndpoints();
  }

  protected async checkEndpoint(endpoint: DockerEndpoint): Promise<void> {
    await this.run(`endpoint-${endpoint.id}`, async () => {
      const checking = await firstValueFrom(this.api.checkDockerEndpoint(endpoint.id));
      this.endpoints.update((list) => list?.map((e) => (e.id === checking.id ? checking : e)) ?? null);
    });
  }

  protected async deleteEndpoint(endpoint: DockerEndpoint): Promise<void> {
    this.confirming.set(null);
    await this.run(`endpoint-${endpoint.id}`, async () => {
      await firstValueFrom(this.api.deleteDockerEndpoint(endpoint.id));
      this.toast.success(`${endpoint.name} removed.`);
      await this.reloadEndpoints();
    });
  }

  /** Runs an action with its row marked busy; errors become a toast. */
  private async run(id: string, action: () => Promise<void>): Promise<void> {
    this.busy.update((s) => new Set(s).add(id));
    try {
      await action();
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.busy.update((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }
}
