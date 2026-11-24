import { Injectable, computed, inject, signal } from '@angular/core';
import { DEFAULT_NAV_ORDER, NAV_PAGES, NavPage, NavPageId } from './nav-pages';
import { PreferencesService } from './preferences.service';

/** Order of the sidebar pages (saved per browser) and the sidebar's rearrange mode. */
@Injectable({ providedIn: 'root' })
export class NavigationService {
  private readonly preferences = inject(PreferencesService);

  /** The sidebar is in rearrange mode: items wiggle, can be dragged and do not navigate. */
  readonly editing = signal(false);
  readonly pages = computed(() =>
    this.preferences.navOrder().map((id) => NAV_PAGES.find((p) => p.id === id) as NavPage),
  );
  /** Where `/` (and signing in without a return URL) leads: the first page of the sidebar. */
  readonly home = computed(() => this.preferences.navOrder()[0] ?? DEFAULT_NAV_ORDER[0]);
  readonly isDefault = computed(() =>
    this.preferences.navOrder().every((id, i) => id === DEFAULT_NAV_ORDER[i]),
  );

  /** Moves the page at `from` to `to` (indexes are clamped). */
  move(from: number, to: number): void {
    const order = [...this.preferences.navOrder()];
    const target = Math.max(0, Math.min(order.length - 1, to));
    if (from === target || from < 0 || from >= order.length) return;
    const [id] = order.splice(from, 1);
    order.splice(target, 0, id as NavPageId);
    this.preferences.navOrder.set(order);
  }

  reset(): void {
    this.preferences.navOrder.set([...DEFAULT_NAV_ORDER]);
  }
}
