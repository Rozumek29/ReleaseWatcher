import type { RepositoryStore } from './db.ts';
import { GROUP_NAME_MAX_LENGTH, ICON_MAX_LENGTH, iconUrls, normalizeGroupName, type RepositoryGroup, validateIcon } from './domain.ts';
import { problem, validationProblem } from './http.ts';
import { body, parseId, readBody, z } from './validation.ts';

export interface RepositoryGroupRoutesDeps {
  store: RepositoryStore;
}

const updateGroupSchema = body({
  /** New name; omit = keep. */
  name: z.string().max(GROUP_NAME_MAX_LENGTH).optional(),
  /** Image URL or `sh:<slug>`; omit = keep, null/"" = the default folder icon. */
  icon: z.string().max(ICON_MAX_LENGTH).nullish(),
});

export const groupDto = (g: RepositoryGroup) => ({
  id: g.id,
  name: g.name,
  /** Custom icon as entered (URL or `sh:<slug>`); null = a folder. */
  icon: g.icon,
  /** Image URLs of the custom icon, best first; empty without one. */
  iconUrls: iconUrls(g.icon),
  repositoryCount: g.repositoryCount,
});

/**
 * Custom groups of repositories (Repositories page → Group: Custom). Groups are created by putting a repository into
 * one (`groupName` of `PUT /api/repositories/:id`) and disappear with their last repository.
 */
export function repositoryGroupRoutes({ store }: RepositoryGroupRoutesDeps) {
  return {
    '/api/repository-groups': {
      GET: () => Response.json(store.listGroups().map(groupDto)),
    },
    '/api/repository-groups/:id': {
      PUT: async (req: Bun.BunRequest<'/api/repository-groups/:id'>) => {
        const id = parseId(req.params.id);
        const input = await readBody(req, updateGroupSchema);
        if (!store.getGroup(id)) {
          return problem(404, 'Group not found.');
        }
        const name = input.name === undefined ? undefined : normalizeGroupName(input.name);
        if (name === null) {
          return validationProblem('name', 'Enter a name for the group.');
        }
        const icon = input.icon === undefined ? undefined : input.icon?.trim() || null;
        const iconError = icon ? validateIcon(icon) : null;
        if (iconError) {
          return validationProblem('icon', iconError);
        }
        if (!store.updateGroup(id, { name, icon })) {
          return problem(409, `A group named "${name}" already exists.`);
        }
        return Response.json(groupDto(store.getGroup(id)!));
      },
      DELETE: (req: Bun.BunRequest<'/api/repository-groups/:id'>) =>
        store.deleteGroup(parseId(req.params.id)) ? new Response(null, { status: 204 }) : problem(404, 'Group not found.'),
    },
  };
}
