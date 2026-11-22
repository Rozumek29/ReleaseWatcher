import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  ACCENTS,
  AccentColor,
  PreferencesService,
  ThemeMode,
} from '../../core/preferences.service';
import { Icon, IconName } from '../../shared/icon';

const THEME_OPTIONS: { mode: ThemeMode; label: string; hint: string; icon: IconName }[] = [
  { mode: 'system', label: 'System', hint: 'Follows your device', icon: 'monitor' },
  { mode: 'light', label: 'Light', hint: 'Always light', icon: 'sun' },
  { mode: 'dark', label: 'Dark', hint: 'Always dark', icon: 'moon' },
];

const ACCENT_LABELS: Record<AccentColor, string> = {
  indigo: 'Indigo',
  blue: 'Blue',
  teal: 'Teal',
  green: 'Green',
  orange: 'Orange',
  rose: 'Rose',
  violet: 'Violet',
};

/** Settings → Appearance: colour scheme and accent colour, saved in this browser (PreferencesService). */
@Component({
  selector: 'app-appearance',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Icon],
  templateUrl: './appearance.html',
  styleUrl: './appearance.scss',
})
export class AppearancePanel {
  protected readonly preferences = inject(PreferencesService);
  protected readonly themes = THEME_OPTIONS;
  /** The System preview shows both schemes side by side. */
  protected readonly schemesBoth = ['light', 'dark'] as const;
  protected readonly accents = ACCENTS.map((name) => ({ name, label: ACCENT_LABELS[name] }));

  protected setTheme(mode: ThemeMode): void {
    this.preferences.theme.set(mode);
  }

  protected setAccent(accent: AccentColor): void {
    this.preferences.accent.set(accent);
  }
}
