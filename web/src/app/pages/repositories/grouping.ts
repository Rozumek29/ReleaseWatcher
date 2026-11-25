import { RepositoryGroup, WatchedRepository } from '../../core/models';
import type { RepositoryGrouping } from '../../core/preferences.service';

/** A collapsible group of the repositories list: the repositories of one owner or of one custom group. */
export interface ListGroup {
  /**
   * Stable key, remembered when the group is collapsed: `owner:<owner>` (lower case; `owner:<host>/<owner>` outside
   * GitHub) or `group:<id>`.
   */
  key: string;
  /** Owner or group name as shown. */
  label: string;
  /** Owner avatar; null for a custom group. */
  avatarUrl: string | null;
  /** Custom icon of a custom group, best first; empty = the owner avatar or a folder. */
  iconUrls: string[];
  /** The custom group (it has options: name, icon); null for an owner. */
  customGroup: RepositoryGroup | null;
  repositories: WatchedRepository[];
  /** Repositories in the group with a newer release than the installed one. */
  updates: number;
}

/** One entry of the grouped list: a group card or a repository that is in no group. */
export type ListEntry =
  | { kind: 'group'; key: string; group: ListGroup }
  | { kind: 'repository'; key: string; repository: WatchedRepository };

/** Key of the group a repository belongs to in a grouping, or null when it stays on its own. */
function groupKey(repository: WatchedRepository, grouping: RepositoryGrouping): string | null {
  if (grouping === 'owner') {
    const owner = repository.owner.trim().toLowerCase();
    // The same owner name on another host is another owner.
    return owner ? `owner:${repository.host ? `${repository.host.toLowerCase()}/` : ''}${owner}` : null;
  }
  if (grouping === 'custom') {
    return repository.groupId === null ? null : `group:${repository.groupId}`;
  }
  return null;
}

/**
 * Groups the visible repositories. Grouping by owner only groups owners with at least two watched repositories (of
 * all, not only the visible ones), so a single repository of an owner stays as it is; custom groups always group.
 * Groups come first, sorted by name, then the repositories in no group; repositories keep the order of `visible`.
 * Groups without a visible repository (search, filters) are left out.
 */
export function groupRepositories(
  all: readonly WatchedRepository[],
  visible: readonly WatchedRepository[],
  grouping: RepositoryGrouping,
  customGroups: readonly RepositoryGroup[] = [],
): ListEntry[] {
  const custom = new Map(customGroups.map((g) => [g.id, g]));
  if (grouping === 'none') {
    return visible.map((repository) => ({ kind: 'repository', key: `repo:${repository.id}`, repository }));
  }
  const sizes = new Map<string, number>();
  for (const repository of all) {
    const key = groupKey(repository, grouping);
    if (key) sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  const minSize = grouping === 'owner' ? 2 : 1;

  const groups = new Map<string, ListGroup>();
  const single: ListEntry[] = [];
  for (const repository of visible) {
    const key = groupKey(repository, grouping);
    const customGroup = grouping === 'custom' ? (custom.get(repository.groupId!) ?? null) : null;
    // A custom group not loaded (yet) has no name to show: the repository stays on its own.
    if (!key || (sizes.get(key) ?? 0) < minSize || (grouping === 'custom' && !customGroup)) {
      single.push({ kind: 'repository', key: `repo:${repository.id}`, repository });
      continue;
    }
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        label: customGroup ? customGroup.name : ownerLabel(repository),
        avatarUrl: customGroup ? null : repository.avatarUrl,
        iconUrls: customGroup?.iconUrls ?? [],
        customGroup,
        repositories: [],
        updates: 0,
      };
      groups.set(key, group);
    }
    group.repositories.push(repository);
    if (repository.updateAvailable === true) {
      group.updates++;
    }
  }
  const sorted = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
  return [...sorted.map((group): ListEntry => ({ kind: 'group', key: group.key, group })), ...single];
}

/** Keys of every group the repositories form in a grouping (for "Collapse all"). */
export function groupKeys(
  all: readonly WatchedRepository[],
  grouping: RepositoryGrouping,
  customGroups: readonly RepositoryGroup[] = [],
): string[] {
  return groupRepositories(all, all, grouping, customGroups).flatMap((entry) => (entry.kind === 'group' ? [entry.key] : []));
}

/** Owner as shown on a group card: with the host outside GitHub; web sources are grouped by the host of their page. */
function ownerLabel(repository: WatchedRepository): string {
  if (repository.provider === 'web') {
    return repository.host ?? repository.owner.trim();
  }
  return `${repository.host ? `${repository.host}/` : ''}${repository.owner.trim()}`;
}
