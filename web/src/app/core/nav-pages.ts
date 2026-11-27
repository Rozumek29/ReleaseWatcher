import type { IconName } from '../shared/icon';

/** Pages of the sidebar navigation in their default order (the first one is the start page). */
export const NAV_PAGES = [
  { id: 'repositories', label: 'Repositories', icon: 'repo' },
  { id: 'machines', label: 'Machines', icon: 'box' },
  { id: 'docker', label: 'Docker', icon: 'container' },
  { id: 'home-assistant', label: 'Home Assistant', icon: 'home' },
  { id: 'vulnerabilities', label: 'Vulnerabilities', icon: 'shield' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
] as const satisfies readonly { id: string; label: string; icon: IconName }[];

export type NavPageId = (typeof NAV_PAGES)[number]['id'];
export type NavPage = (typeof NAV_PAGES)[number];

export const DEFAULT_NAV_ORDER: readonly NavPageId[] = NAV_PAGES.map((p) => p.id);

/**
 * A saved order cleaned up: unknown and repeated pages are dropped, pages it does not mention yet (added in a newer
 * version) keep their default place relative to the others by being appended in default order.
 */
export function normalizeNavOrder(value: unknown): NavPageId[] {
  const known = Array.isArray(value)
    ? value.filter(
        (id, i): id is NavPageId => DEFAULT_NAV_ORDER.includes(id) && value.indexOf(id) === i,
      )
    : [];
  return [...known, ...DEFAULT_NAV_ORDER.filter((id) => !known.includes(id))];
}
