import { parseGitHost } from '../domain.ts';
import { problem, validationProblem } from '../http.ts';
import type { Logger } from '../log.ts';
import { maskSecret } from '../settings.ts';
import { body, parseId, readBody, z } from '../validation.ts';
import { GIT_HOST_PROVIDERS, type GitHostToken, MAX_TOKEN_LENGTH, providerMismatch } from './domain.ts';
import type { GitHostTokenStore } from './store.ts';

export interface GitHostTokenRoutesDeps {
  tokens: GitHostTokenStore;
  log: Pick<Logger, 'info'>;
}

const tokenSchema = body({
  provider: z.enum(GIT_HOST_PROVIDERS).optional(),
  host: z.string().max(300).optional(),
  token: z.string().max(MAX_TOKEN_LENGTH).nullish(),
});

/** A host token as returned by the API: never the token itself. */
const tokenDto = (t: GitHostToken) => ({
  id: t.id,
  provider: t.provider,
  host: t.host,
  tokenMasked: maskSecret(t.token, 4),
  repositoryCount: t.repositoryCount,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

const HOST_HINT = 'Enter the host of the instance, e.g. git.example.com or git.example.com:3000.';

/** HTTP routes for the access tokens of Gitea/Forgejo and GitLab instances (registered by `buildApp`). */
export function gitHostTokenRoutes(deps: GitHostTokenRoutesDeps) {
  const { tokens } = deps;

  /** Validates provider + host; returns the normalized host or a 400/409 response. */
  const checkHost = (provider: GitHostToken['provider'], rawHost: string, exceptId: number | null): string | Response => {
    const host = parseGitHost(rawHost);
    if (!host) return validationProblem('host', HOST_HINT);
    const mismatch = providerMismatch(provider, host);
    if (mismatch) return validationProblem('provider', mismatch);
    const existing = tokens.idOf(provider, host);
    if (existing !== null && existing !== exceptId) return problem(409, `A token for ${host} is already saved.`);
    return host;
  };

  return {
    '/api/git-host-tokens': {
      GET: () => Response.json(tokens.list().map(tokenDto)),
      POST: async (req: Request) => {
        const body = await readBody(req, tokenSchema);
        if (!body.provider) return validationProblem('provider', 'Choose Gitea/Forgejo or GitLab.');
        const token = body.token?.trim();
        if (!token) return validationProblem('token', 'Enter the access token.');
        const host = checkHost(body.provider, body.host ?? '', null);
        if (host instanceof Response) return host;
        const saved = tokens.add(body.provider, host, token);
        deps.log.info({ host, provider: body.provider }, 'Host token added');
        return Response.json(tokenDto(saved), { status: 201, headers: { location: `/api/git-host-tokens/${saved.id}` } });
      },
    },
    '/api/git-host-tokens/:id': {
      // Omitted = keep; the token can't be removed (delete the entry instead).
      PUT: async (req: Bun.BunRequest<'/api/git-host-tokens/:id'>) => {
        const id = parseId(req.params.id);
        const body = await readBody(req, tokenSchema);
        const current = tokens.get(id);
        if (!current) return problem(404, 'Host token not found.');
        const provider = body.provider ?? current.provider;
        const host = checkHost(provider, body.host ?? current.host, id);
        if (host instanceof Response) return host;
        const token = body.token?.trim() || null;
        const saved = tokens.update(id, provider, host, token)!;
        deps.log.info({ host, provider, tokenChanged: token !== null }, 'Host token updated');
        return Response.json(tokenDto(saved));
      },
      DELETE: (req: Bun.BunRequest<'/api/git-host-tokens/:id'>) => {
        const id = parseId(req.params.id);
        const current = tokens.get(id);
        if (!current) return problem(404, 'Host token not found.');
        tokens.delete(id);
        deps.log.info({ host: current.host, provider: current.provider }, 'Host token removed');
        return new Response(null, { status: 204 });
      },
    },
  };
}
