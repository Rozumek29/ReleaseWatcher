import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import {
  BackupAppearance,
  BackupFile,
  ImportMode,
  ImportPreview,
  ImportSectionPreview,
} from '../../core/models';
import {
  ACCENTS,
  AccentColor,
  ContainerSort,
  PreferencesService,
  RepositoryLayout,
  THEME_MODES,
  ThemeMode,
} from '../../core/preferences.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { Switch } from '../../shared/switch';

/** Never part of a backup, whatever is configured. */
const ALWAYS_EXCLUDED = [
  'Passwords, tokens, webhook URLs, header values and SSH private keys',
  'Your account: password, passkeys, single sign-on and API tokens',
  'History and state: releases seen, check results, run logs, vulnerabilities, Docker listings',
  'Values set by environment variables (only values saved in the UI are exported)',
];

const MODES: { mode: ImportMode; label: string; hint: string }[] = [
  {
    mode: 'merge',
    label: 'Merge',
    hint: 'Adds what is new and updates matching items (same repository, host address, VMID, endpoint URL). Nothing is removed.',
  },
  {
    mode: 'replace',
    label: 'Replace',
    hint: 'Makes the configuration match the file: also removes repositories, machines and endpoints the file does not have.',
  },
];

/** Names shown per change list before "+N more". */
const MAX_NAMES = 8;

/**
 * Settings → Backup: downloads the configuration as a JSON file (without secrets) and imports such a file after a
 * preview of what changes.
 */
@Component({
  selector: 'app-backup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, Icon, Switch],
  templateUrl: './backup.html',
  styleUrl: './backup.scss',
})
export class BackupPanel implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly preferences = inject(PreferencesService);

  /** Emitted after an import was applied (the page reloads its settings). */
  readonly imported = output<void>();

  protected readonly alwaysExcluded = ALWAYS_EXCLUDED;
  protected readonly modes = MODES;
  protected readonly maxNames = MAX_NAMES;

  // --- Export ---
  protected readonly current = signal<BackupFile | null>(null);
  protected readonly exportError = signal<string | null>(null);
  protected readonly includeAppearance = signal(true);
  protected readonly downloading = signal(false);
  protected readonly counts = computed(() => {
    const file = this.current();
    if (!file) return null;
    const targets = file.hosts.flatMap((h) => h.targets);
    return {
      settings: Object.keys(file.settings).length,
      repositories: file.repositories.length,
      hosts: file.hosts.length,
      targets: targets.length,
      apps: targets.reduce((sum, t) => sum + t.apps.length, 0),
      endpoints: file.dockerEndpoints.length,
    };
  });

  // --- Import ---
  protected readonly fileName = signal<string | null>(null);
  private readonly fileData = signal<Record<string, unknown> | null>(null);
  protected readonly mode = signal<ImportMode>('merge');
  protected readonly preview = signal<ImportPreview | null>(null);
  protected readonly previewError = signal<string | null>(null);
  protected readonly previewing = signal(false);
  protected readonly importing = signal(false);
  /** Preview of the import that was applied (shows the secrets to enter again). */
  protected readonly result = signal<ImportPreview | null>(null);
  protected readonly applyAppearance = signal(true);
  protected readonly fileAppearance = computed(() =>
    readAppearance(this.fileData()?.['appearance']),
  );
  protected readonly hasChanges = computed(() => {
    const preview = this.preview();
    return (
      !!preview &&
      preview.sections.some((s) => s.added.length + s.updated.length + s.removed.length > 0)
    );
  });
  protected readonly removals = computed(
    () => this.preview()?.sections.reduce((sum, s) => sum + s.removed.length, 0) ?? 0,
  );

  async ngOnInit(): Promise<void> {
    await this.loadCurrent();
  }

  private async loadCurrent(): Promise<void> {
    try {
      this.current.set(await firstValueFrom(this.api.exportBackup()));
      this.exportError.set(null);
    } catch (error) {
      this.exportError.set(describeError(error));
    }
  }

  protected async download(): Promise<void> {
    this.downloading.set(true);
    try {
      const file = await firstValueFrom(this.api.exportBackup());
      this.current.set(file);
      if (this.includeAppearance()) {
        file.appearance = {
          theme: this.preferences.theme(),
          accent: this.preferences.accent(),
          repositoryLayout: this.preferences.repositoryLayout(),
          containerSort: this.preferences.containerSort(),
        };
      }
      saveFile(
        `releasewatcher-backup-${file.exportedAt.slice(0, 10)}.json`,
        JSON.stringify(file, null, 2),
      );
      this.toast.success('Backup downloaded.');
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.downloading.set(false);
    }
  }

  protected async fileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.reset();
    this.fileName.set(file.name);
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      this.previewError.set(
        'This file is not valid JSON – choose a backup downloaded from ReleaseWatcher.',
      );
      return;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      this.previewError.set('This file is not a ReleaseWatcher backup.');
      return;
    }
    this.fileData.set(data as Record<string, unknown>);
    await this.runPreview();
  }

  protected async setMode(mode: ImportMode): Promise<void> {
    if (mode === this.mode()) return;
    this.mode.set(mode);
    if (this.fileData()) {
      await this.runPreview();
    }
  }

  private async runPreview(): Promise<void> {
    const data = this.fileData();
    if (!data) return;
    this.previewing.set(true);
    this.previewError.set(null);
    this.preview.set(null);
    try {
      const response = await firstValueFrom(this.api.importBackup(data, this.mode(), true));
      this.preview.set(response.preview);
    } catch (error) {
      this.previewError.set(describeError(error));
    } finally {
      this.previewing.set(false);
    }
  }

  protected async import(): Promise<void> {
    const data = this.fileData();
    if (!data) return;
    this.importing.set(true);
    try {
      const response = await firstValueFrom(this.api.importBackup(data, this.mode(), false));
      const appearance = this.fileAppearance();
      if (appearance && this.applyAppearance()) {
        this.preferences.theme.set(appearance.theme);
        this.preferences.accent.set(appearance.accent);
        this.preferences.repositoryLayout.set(appearance.repositoryLayout);
        this.preferences.containerSort.set(appearance.containerSort);
      }
      this.result.set(response.preview);
      this.fileData.set(null);
      this.preview.set(null);
      this.toast.success('Configuration imported.');
      this.imported.emit();
      await this.loadCurrent();
    } catch (error) {
      this.previewError.set(describeError(error));
    } finally {
      this.importing.set(false);
    }
  }

  protected reset(): void {
    this.fileName.set(null);
    this.fileData.set(null);
    this.preview.set(null);
    this.previewError.set(null);
    this.result.set(null);
  }

  protected changeCount(s: ImportSectionPreview): number {
    return s.added.length + s.updated.length + s.removed.length;
  }

  /** The non-empty change lists of a section, in display order. */
  protected groups(s: ImportSectionPreview): { kind: string; label: string; names: string[] }[] {
    return [
      { kind: 'added', label: 'New', names: s.added },
      { kind: 'updated', label: 'Updated', names: s.updated },
      { kind: 'removed', label: 'Removed', names: s.removed },
    ].filter((g) => g.names.length > 0);
  }

  protected more(names: string[]): number {
    return Math.max(0, names.length - MAX_NAMES);
  }
}

/** The appearance saved in a file, with unknown values dropped; null when there is none. */
function readAppearance(value: unknown): {
  theme: ThemeMode;
  accent: AccentColor;
  repositoryLayout: RepositoryLayout;
  containerSort: ContainerSort;
} | null {
  if (!value || typeof value !== 'object') return null;
  const a = value as Partial<BackupAppearance>;
  const theme = THEME_MODES.find((t) => t === a.theme);
  const accent = ACCENTS.find((c) => c === a.accent);
  if (!theme || !accent) return null;
  return {
    theme,
    accent,
    repositoryLayout: a.repositoryLayout === 'grid' ? 'grid' : 'list',
    containerSort:
      (['attention', 'vmid', 'name'] as const).find((s) => s === a.containerSort) ?? 'attention',
  };
}

/** Lets the browser save `text` as a file. */
function saveFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url));
}
