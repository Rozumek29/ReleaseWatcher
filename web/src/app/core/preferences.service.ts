import { DOCUMENT } from '@angular/common';
import { Injectable, effect, inject, signal } from '@angular/core';
import { DEFAULT_NAV_ORDER, NavPageId, normalizeNavOrder } from './nav-pages';

export type RepositoryLayout = 'list' | 'grid';
/** Grouping of the repositories list. */
export type RepositoryGrouping = 'none' | 'owner' | 'custom';
/** Order of the containers list: what needs attention first, by VMID or by name. */
export type ContainerSort = 'attention' | 'vmid' | 'name';
/** Colour scheme: follow the operating system or force one. */
export type ThemeMode = 'system' | 'light' | 'dark';
/** Accent colour preset (the colours themselves are in `$accent-presets` in styles.scss). */
export type AccentColor = (typeof ACCENTS)[number];

/** Accent presets in display order; keep in sync with `$accent-presets` in styles.scss and the script in index.html. */
export const ACCENTS = ['indigo', 'blue', 'teal', 'green', 'orange', 'rose', 'violet'] as const;
export const THEME_MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

const STORAGE_KEY = 'releasewatcher.preferences';

interface Preferences {
  repositoryLayout: RepositoryLayout;
  repositoryGrouping: RepositoryGrouping;
  /** Groups collapsed on the Repositories page (keys from `groupRepositories()`). */
  collapsedGroups: string[];
  containerSort: ContainerSort;
  theme: ThemeMode;
  accent: AccentColor;
  /** Order of the sidebar pages; the first one is the start page. */
  navOrder: NavPageId[];
}

const DEFAULTS: Preferences = {
  repositoryLayout: 'list',
  repositoryGrouping: 'none',
  collapsedGroups: [],
  containerSort: 'attention',
  theme: 'system',
  accent: 'indigo',
  navOrder: [...DEFAULT_NAV_ORDER],
};
const CONTAINER_SORTS: readonly ContainerSort[] = ['attention', 'vmid', 'name'];
const REPOSITORY_GROUPINGS: readonly RepositoryGrouping[] = ['none', 'owner', 'custom'];

/** Per-browser UI preferences (kept in localStorage; the app works the same without it). */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly document = inject(DOCUMENT);
  private readonly initial = load();
  readonly repositoryLayout = signal<RepositoryLayout>(this.initial.repositoryLayout);
  readonly repositoryGrouping = signal<RepositoryGrouping>(this.initial.repositoryGrouping);
  readonly collapsedGroups = signal<readonly string[]>(this.initial.collapsedGroups);
  readonly containerSort = signal<ContainerSort>(this.initial.containerSort);
  readonly theme = signal<ThemeMode>(this.initial.theme);
  readonly accent = signal<AccentColor>(this.initial.accent);
  readonly navOrder = signal<NavPageId[]>(this.initial.navOrder);

  constructor() {
    effect(() =>
      save({
        repositoryLayout: this.repositoryLayout(),
        repositoryGrouping: this.repositoryGrouping(),
        collapsedGroups: [...this.collapsedGroups()],
        containerSort: this.containerSort(),
        theme: this.theme(),
        accent: this.accent(),
        navOrder: this.navOrder(),
      }),
    );
    effect(() => applyAppearance(this.document, this.theme(), this.accent()));
  }
}

/** Sets the attributes styles.scss themes by (the same as the startup script in index.html does). */
function applyAppearance(document: Document, theme: ThemeMode, accent: AccentColor): void {
  const root = document.documentElement;
  root.dataset['theme'] = theme;
  root.dataset['accent'] = accent;
  // The browser's toolbar colour follows the accent of the active theme.
  const accentValue = getComputedStyle(root).getPropertyValue('--accent').trim();
  if (accentValue) {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', accentValue);
  }
}

function load(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Preferences>;
    return {
      repositoryLayout: stored.repositoryLayout === 'grid' ? 'grid' : DEFAULTS.repositoryLayout,
      repositoryGrouping: oneOf(REPOSITORY_GROUPINGS, stored.repositoryGrouping, DEFAULTS.repositoryGrouping),
      collapsedGroups: Array.isArray(stored.collapsedGroups)
        ? stored.collapsedGroups.filter((key): key is string => typeof key === 'string')
        : DEFAULTS.collapsedGroups,
      containerSort: oneOf(CONTAINER_SORTS, stored.containerSort, DEFAULTS.containerSort),
      theme: oneOf(THEME_MODES, stored.theme, DEFAULTS.theme),
      accent: oneOf(ACCENTS, stored.accent, DEFAULTS.accent),
      navOrder: normalizeNavOrder(stored.navOrder),
    };
  } catch {
    return DEFAULTS;
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function save(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable (private mode, blocked cookies) – preference lasts for this session only.
  }
}
