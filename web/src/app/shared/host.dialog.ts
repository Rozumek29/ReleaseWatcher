import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError, fieldErrors } from '../core/api.service';
import { BackupStorage, Host, HostInput, HostType, SshKey } from '../core/models';
import { BackdropClose } from './backdrop-close';
import { Icon, IconName } from './icon';

/** What the dialog edits: a new host of `type` (host null) or an existing host. */
export interface HostDialogData {
  type: HostType;
  host: Host | null;
  /** New host: the user picks the type in the dialog (`type` is preselected). */
  chooseType?: boolean;
}

/** Choices of the type picker. */
export const HOST_TYPE_CHOICES: readonly { type: HostType; label: string; icon: IconName; hint: string }[] = [
  { type: 'server', label: 'Server', icon: 'server', hint: 'A VPS or any Linux machine – apt and your update commands.' },
  { type: 'proxmox', label: 'Proxmox node', icon: 'box', hint: 'Its containers and VMs – pct and qm on the node.' },
];

/**
 * Adds or edits a host: address, login user and the SSH key it accepts. Used by Settings → Connections and by the
 * Machines page ("Add server"); it loads the saved keys itself when it opens.
 */
@Component({
  selector: 'app-host-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon],
  templateUrl: './host.dialog.html',
  styleUrl: './host.dialog.scss',
})
export class HostDialog {
  private readonly api = inject(ApiService);

  /** Host to add or edit; null closes the dialog. */
  readonly data = input<HostDialogData | null>(null);
  readonly saved = output<Host>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected name = '';
  protected address = '';
  protected port: number | null = 22;
  protected user = 'root';
  protected sshKeyId: number | null = null;
  /** Type of the host being added or edited (can change only while adding with `chooseType`). */
  protected readonly type = signal<HostType>('server');
  protected readonly typeChoices = HOST_TYPE_CHOICES;
  /** Proxmox node: its backup storage ('' = none, no backups). */
  protected backupStorage = '';

  /** Saved keys to choose from (null while loading). */
  protected readonly keys = signal<SshKey[] | null>(null);
  /** Storages of an existing Proxmox node that accept backups (null = not loaded / not available). */
  protected readonly storages = signal<BackupStorage[] | null>(null);
  protected readonly storagesError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly saveError = signal<string | null>(null);

  constructor() {
    effect(() => {
      const data = this.data();
      const dialog = this.dialog().nativeElement;
      if (data) {
        const host = data.host;
        this.type.set(host?.type ?? data.type);
        this.name = host?.name ?? '';
        this.address = host?.address ?? '';
        this.port = host?.port ?? 22;
        this.user = host?.user ?? 'root';
        this.sshKeyId = host?.sshKeyId ?? null;
        this.backupStorage = host?.backupStorage ?? '';
        void this.loadKeys(host === null);
        this.storages.set(null);
        this.storagesError.set(null);
        if (host?.type === 'proxmox' && host.configured) {
          void this.loadStorages(host.id);
        }
        this.errors.set({});
        this.saveError.set(null);
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  /** Loads the keys; a new host starts with the only key, if there is exactly one. */
  private async loadKeys(preselect: boolean): Promise<void> {
    this.keys.set(null);
    try {
      const keys = await firstValueFrom(this.api.getSshKeys());
      if (preselect && keys.length === 1 && this.sshKeyId === null) {
        this.sshKeyId = keys[0]!.id;
      }
      this.keys.set(keys);
    } catch (error) {
      this.keys.set([]);
      this.saveError.set(describeError(error));
    }
  }

  private async loadStorages(hostId: number): Promise<void> {
    try {
      this.storages.set(await firstValueFrom(this.api.getBackupStorages(hostId)));
    } catch (error) {
      this.storagesError.set(describeError(error));
    }
  }

  /** "local (dir, 50 GB free)"; inactive storages say so. */
  protected storageLabel(st: BackupStorage): string {
    const details = [st.type];
    if (st.availableBytes !== null && st.status === 'active') {
      details.push(`${formatBytes(st.availableBytes)} free`);
    }
    if (st.status !== 'active') {
      details.push(st.status);
    }
    return `${st.name} (${details.join(', ')})`;
  }

  protected title(data: HostDialogData): string {
    if (data.host) return `Edit ${data.host.name}`;
    if (data.chooseType) return 'Add host';
    return this.type() === 'proxmox' ? 'Add Proxmox node' : 'Add server';
  }

  /** Whether the type picker is shown (adding from Settings → Connections). */
  protected canChooseType(data: HostDialogData): boolean {
    return data.host === null && data.chooseType === true;
  }

  protected async save(): Promise<void> {
    const data = this.data();
    if (!data) return;
    const port = this.port === null || `${this.port}` === '' ? null : Number(this.port);
    const input: HostInput = {
      name: this.name.trim() || this.address.trim(),
      address: this.address.trim(),
      port,
      user: this.user.trim() || null,
      sshKeyId: this.sshKeyId,
      ...(this.type() === 'proxmox' && data.host ? { backupStorage: this.backupStorage.trim() || null } : {}),
    };
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const host = await firstValueFrom(
        data.host ? this.api.updateHost(data.host.id, input) : this.api.addHost({ ...input, type: this.type() }),
      );
      this.saved.emit(host);
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) {
        this.errors.set(fields);
      } else {
        this.saveError.set(describeError(error));
      }
    } finally {
      this.saving.set(false);
    }
  }

  protected hasStorage(name: string): boolean {
    return (this.storages() ?? []).some((st) => st.name === name);
  }

  protected close(): void {
    this.closed.emit();
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
