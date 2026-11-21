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
import { Icon } from './icon';

/** What the dialog edits: a new host of `type` (host null) or an existing host. */
export interface HostDialogData {
  type: HostType;
  host: Host | null;
}

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
  /** Proxmox node: its backup storage ('' = the global setting). */
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

  protected title(data: HostDialogData): string {
    const what = data.type === 'proxmox' ? 'Proxmox node' : 'server';
    return data.host ? `Edit ${data.host.name}` : `Add ${what}`;
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
      ...(data.type === 'proxmox' && data.host ? { backupStorage: this.backupStorage.trim() || null } : {}),
    };
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const host = await firstValueFrom(
        data.host ? this.api.updateHost(data.host.id, input) : this.api.addHost({ ...input, type: data.type }),
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
