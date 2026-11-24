import { WatchedRepository } from '../../core/models';
import { RepositoryGroup } from '../../core/models';
import { groupKeys, groupRepositories, ListEntry } from './grouping';

const repo = (id: number, owner: string, name: string, extra: Partial<WatchedRepository> = {}) =>
  ({
    id,
    owner,
    name,
    fullName: `${owner}/${name}`,
    avatarUrl: `https://avatars.githubusercontent.com/${owner}`,
    host: null,
    groupId: null,
    updateAvailable: null,
    ...extra,
  }) as WatchedRepository;

/** Entries as short strings: `[label: ids]` for groups, the id for repositories in no group. */
const shape = (entries: ListEntry[]) =>
  entries.map((e) => (e.kind === 'group' ? `${e.group.label}: ${e.group.repositories.map((r) => r.id).join(',')}` : e.repository.id));

const group = (id: number, name: string, extra: Partial<RepositoryGroup> = {}): RepositoryGroup => ({
  id,
  name,
  icon: null,
  iconUrls: [],
  repositoryCount: 1,
  ...extra,
});

describe('groupRepositories', () => {
  const groups = [group(10, 'Media', { iconUrls: ['https://example.com/media.svg'] }), group(11, 'home lab')];
  const all = [
    repo(1, 'immich-app', 'immich', { groupId: 10 }),
    repo(2, 'home-assistant', 'supervisor', { updateAvailable: true }),
    repo(3, 'angular', 'angular'),
    repo(4, 'Home-Assistant', 'core', { groupId: 11, updateAvailable: true }),
    repo(5, 'jellyfin', 'jellyfin', { groupId: 10 }),
  ];

  it('keeps the list as it is without grouping', () => {
    expect(shape(groupRepositories(all, all, 'none'))).toEqual([1, 2, 3, 4, 5]);
  });

  it('groups owners with several repositories (case-insensitive) and leaves single ones as they are', () => {
    const entries = groupRepositories(all, all, 'owner');
    expect(shape(entries)).toEqual(['home-assistant: 2,4', 1, 3, 5]);
    const group = entries[0]!.kind === 'group' ? entries[0].group : null;
    expect(group).toMatchObject({ key: 'owner:home-assistant', updates: 2, avatarUrl: 'https://avatars.githubusercontent.com/home-assistant' });
  });

  it('tells owners on other hosts apart', () => {
    const repos = [repo(1, 'acme', 'a'), repo(2, 'acme', 'b'), repo(3, 'acme', 'c', { host: 'codeberg.org' }), repo(4, 'acme', 'd', { host: 'codeberg.org' })];
    expect(shape(groupRepositories(repos, repos, 'owner'))).toEqual(['acme: 1,2', 'codeberg.org/acme: 3,4']);
  });

  it('keeps an owner group when a filter leaves only one of its repositories', () => {
    expect(shape(groupRepositories(all, [all[1]!, all[2]!], 'owner'))).toEqual(['home-assistant: 2', 3]);
  });

  it('groups by custom groups, sorted by name, even a group of one', () => {
    const entries = groupRepositories(all, all, 'custom', groups);
    expect(shape(entries)).toEqual(['home lab: 4', 'Media: 1,5', 2, 3]);
    expect(entries.map((e) => e.key).slice(0, 2)).toEqual(['group:11', 'group:10']);
    const media = entries[1]!.kind === 'group' ? entries[1].group : null;
    expect(media).toMatchObject({ avatarUrl: null, iconUrls: ['https://example.com/media.svg'], customGroup: groups[0] });
  });

  it('leaves repositories of unknown groups and groups without a visible repository out', () => {
    expect(shape(groupRepositories(all, [all[2]!], 'custom', groups))).toEqual([3]);
    expect(shape(groupRepositories(all, all, 'custom', [groups[0]!]))).toEqual(['Media: 1,5', 2, 3, 4]);
  });

  it('lists the keys of every group', () => {
    expect(groupKeys(all, 'owner')).toEqual(['owner:home-assistant']);
    expect(groupKeys(all, 'custom', groups)).toEqual(['group:11', 'group:10']);
    expect(groupKeys(all, 'none')).toEqual([]);
  });
});
