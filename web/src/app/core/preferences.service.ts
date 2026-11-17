import { Injectable, effect, signal } from '@angular/core';

export type RepositoryLayout = 'list' | 'grid';
/** Order of the containers list: what needs attention first, by VMID or by name. */
export type ContainerSort = 'attention' | 'vmid' | 'name';

const STORAGE_KEY = 'releasewatcher.preferences';

interface Preferences {
  repositoryLayout: RepositoryLayout;
  containerSort: ContainerSort;
}

const DEFAULTS: Preferences = { repositoryLayout: 'list', containerSort: 'attention' };
const CONTAINER_SORTS: readonly ContainerSort[] = ['attention', 'vmid', 'name'];

/** Per-browser UI preferences (kept in localStorage; the app works the same without it). */
@Injectable({ providedIn: 'root' })
export class PreferencesService {
  private readonly initial = load();
  readonly repositoryLayout = signal<RepositoryLayout>(this.initial.repositoryLayout);
  readonly containerSort = signal<ContainerSort>(this.initial.containerSort);

  constructor() {
    effect(() =>
      save({ repositoryLayout: this.repositoryLayout(), containerSort: this.containerSort() }),
    );
  }
}

function load(): Preferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Preferences>;
    return {
      repositoryLayout: stored.repositoryLayout === 'grid' ? 'grid' : DEFAULTS.repositoryLayout,
      containerSort: CONTAINER_SORTS.includes(stored.containerSort as ContainerSort)
        ? (stored.containerSort as ContainerSort)
        : DEFAULTS.containerSort,
    };
  } catch {
    return DEFAULTS;
  }
}

function save(preferences: Preferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Storage unavailable (private mode, blocked cookies) – preference lasts for this session only.
  }
}
