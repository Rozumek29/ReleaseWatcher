import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { AptPackage } from '../../core/models';

/** A version split into the part shared with the installed version and the part that changes. */
export interface VersionDiff {
  same: string;
  changed: string;
}

/**
 * Splits `next` at the last separator (`.`, `-`, `+`, `~`, `:`) of the prefix it shares with `current`, so that
 * whole version components are highlighted: 3.0.3 → 3.0.4 gives "3.0." + "4", 1.2.9 → 1.2.10 gives "1.2." + "10".
 */
export function versionDiff(current: string | null, next: string): VersionDiff {
  if (!current) {
    return { same: '', changed: next };
  }
  let common = 0;
  while (common < current.length && common < next.length && current[common] === next[common]) {
    common++;
  }
  if (common === next.length && common === current.length) {
    return { same: next, changed: '' };
  }
  let cut = common;
  while (cut > 0 && !/[.\-+~:]/.test(next[cut - 1]!)) {
    cut--;
  }
  return { same: next.slice(0, cut), changed: next.slice(cut) };
}

/** Lists above this size get a filter field. */
const FILTER_FROM = 10;

/** Upgradable apt packages of a container: name, installed and available version side by side. */
@Component({
  selector: 'app-apt-packages',
  templateUrl: './apt-packages.html',
  styleUrl: './apt-packages.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AptPackages {
  readonly packages = input.required<readonly AptPackage[]>();
  /** Used for unique element ids when several lists are open. */
  readonly listId = input.required<string | number>();

  protected readonly query = signal('');
  protected readonly showFilter = computed(() => this.packages().length > FILTER_FROM);
  protected readonly rows = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.packages()
      .filter((p) => !query || p.name.toLowerCase().includes(query))
      .map((p) => ({ ...p, diff: versionDiff(p.currentVersion, p.newVersion) }));
  });
}
