import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError, fieldErrors } from '../../core/api.service';
import { DockerEndpoint } from '../../core/models';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { Switch } from '../../shared/switch';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** What the dialog edits: a new endpoint (`endpoint` null) or an existing one. */
export interface DockerEndpointDialogData {
  endpoint: DockerEndpoint | null;
}

/** Adds or edits a Docker endpoint: a mounted socket, a socket proxy or a remote engine over TCP. */
@Component({
  selector: 'app-docker-endpoint-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon, Switch, UnsavedChanges],
  templateUrl: './docker-endpoint.dialog.html',
  styleUrl: './docker-endpoint.dialog.scss',
})
export class DockerEndpointDialog {
  private readonly api = inject(ApiService);

  /** Endpoint to add or edit; null closes the dialog. */
  readonly data = input<DockerEndpointDialogData | null>(null);
  readonly saved = output<DockerEndpoint>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected name = '';
  protected url = '';
  protected readonly isEnabled = signal(true);
  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  /** Result of "Test connection": what was found, or why it failed. */
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly saveError = signal<string | null>(null);
  private savedValues: unknown = null;

  constructor() {
    effect(() => {
      const data = this.data();
      const dialog = this.dialog().nativeElement;
      if (data) {
        this.name = data.endpoint?.name ?? '';
        this.url = data.endpoint?.url ?? '';
        this.isEnabled.set(data.endpoint?.isEnabled ?? true);
        // Untracked: reading the switch here would run this effect again – and reset the form – when it is toggled.
        this.savedValues = untracked(() => this.values());
        this.testResult.set(null);
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

  private values(): unknown {
    return [this.name, this.url, this.isEnabled()];
  }

  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  /** Fills in a common address (the user still adjusts host or path). */
  protected useExample(url: string): void {
    this.url = url;
    this.testResult.set(null);
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    this.errors.set({});
    try {
      const result = await firstValueFrom(this.api.testDockerEndpoint(this.url.trim()));
      this.testResult.set({ ok: true, text: `Connected to ${result.engine} – ${result.containers} running container(s).` });
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) {
        this.errors.set(fields);
      } else {
        this.testResult.set({ ok: false, text: describeError(error) });
      }
    } finally {
      this.testing.set(false);
    }
  }

  protected async save(): Promise<void> {
    const data = this.data();
    if (!data) return;
    const url = this.url.trim();
    const request = { name: this.name.trim() || hostOf(url), url, isEnabled: this.isEnabled() };
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const endpoint = await firstValueFrom(
        data.endpoint ? this.api.updateDockerEndpoint(data.endpoint.id, request) : this.api.addDockerEndpoint(request),
      );
      this.saved.emit(endpoint);
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

  protected close(): void {
    this.closed.emit();
  }
}

/** Default name: the host of a TCP endpoint, "Docker" for a socket. */
function hostOf(url: string): string {
  const host = url.match(/^[a-z]+:\/\/([^/:]+)/i)?.[1];
  return host && !url.startsWith('unix:') ? host : 'Docker';
}
