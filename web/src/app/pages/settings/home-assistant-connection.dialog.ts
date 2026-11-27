import { ChangeDetectionStrategy, Component, ElementRef, effect, inject, input, output, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError, fieldErrors } from '../../core/api.service';
import { HomeAssistantConnection } from '../../core/models';
import { BackdropClose } from '../../shared/backdrop-close';
import { Icon } from '../../shared/icon';
import { Switch } from '../../shared/switch';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';

/** What the dialog edits: a new connection (`connection` null) or an existing one. */
export interface HomeAssistantConnectionDialogData {
  connection: HomeAssistantConnection | null;
}

/** Adds or edits a Home Assistant connection: its address and a long-lived access token. */
@Component({
  selector: 'app-home-assistant-connection-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, FormsModule, Icon, Switch, UnsavedChanges],
  templateUrl: './home-assistant-connection.dialog.html',
  styleUrl: './home-assistant-connection.dialog.scss',
})
export class HomeAssistantConnectionDialog {
  private readonly api = inject(ApiService);

  /** Connection to add or edit; null closes the dialog. */
  readonly data = input<HomeAssistantConnectionDialogData | null>(null);
  readonly saved = output<HomeAssistantConnection>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected name = '';
  protected url = '';
  protected token = '';
  protected readonly showToken = signal(false);
  protected readonly isEnabled = signal(true);
  protected readonly saving = signal(false);
  protected readonly testing = signal(false);
  /** Result of "Test": what was found, or why it failed. */
  protected readonly testResult = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  protected readonly saveError = signal<string | null>(null);
  private savedValues: unknown = null;

  constructor() {
    effect(() => {
      const data = this.data();
      const dialog = this.dialog().nativeElement;
      if (data) {
        this.name = data.connection?.name ?? '';
        this.url = data.connection?.url ?? '';
        this.token = '';
        this.isEnabled.set(data.connection?.isEnabled ?? true);
        // Untracked: reading the switch here would make the effect run again – and reset the form – when it is toggled.
        this.savedValues = untracked(() => this.values());
        this.showToken.set(false);
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
    return [this.name, this.url, this.token, this.isEnabled()];
  }

  protected changed(): boolean {
    return !sameValues(this.values(), this.savedValues);
  }

  /** Editing with another address: the saved token is not sent there, so a new one is needed. */
  protected needsToken(): boolean {
    const connection = this.data()?.connection;
    return !connection || this.url.trim().replace(/\/+$/, '') !== connection.url;
  }

  protected async test(): Promise<void> {
    this.testing.set(true);
    this.testResult.set(null);
    this.errors.set({});
    try {
      const result = await firstValueFrom(
        this.api.testHomeAssistantConnection({
          url: this.url.trim(),
          token: this.token.trim() || null,
          id: this.data()?.connection?.id ?? null,
        }),
      );
      this.testResult.set({
        ok: true,
        text: `Connected – ${result.components} update ${result.components === 1 ? 'entity names' : 'entities name'} a repository.`,
      });
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
    const request = { name: this.name.trim() || hostOf(url), url, token: this.token.trim() || null, isEnabled: this.isEnabled() };
    this.saving.set(true);
    this.errors.set({});
    this.saveError.set(null);
    try {
      const connection = await firstValueFrom(
        data.connection
          ? this.api.updateHomeAssistantConnection(data.connection.id, request)
          : this.api.addHomeAssistantConnection(request),
      );
      this.saved.emit(connection);
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

/** Default name: the host of the address. */
function hostOf(url: string): string {
  return url.match(/^https?:\/\/([^/:]+)/i)?.[1] ?? 'Home Assistant';
}
