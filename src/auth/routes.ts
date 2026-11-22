import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { problem, validationProblem } from '../http.ts';
import { type ObjectSchema, parseId, readBody } from '../validation.ts';
import { AuthError, type AuthService, type RequestContext, sessionCookie, sessionTokenFrom } from './service.ts';
import type { ApiTokenScope, Session } from './store.ts';

/** Routes reachable without a session (everything else under /api requires one). */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  '/health',
  '/api/version',
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/passkey/options',
  '/api/auth/passkey/login',
]);

const credentialsSchema: ObjectSchema = {
  type: 'object',
  properties: { username: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 1000 } },
  required: ['username', 'password'],
};

const setupSchema: ObjectSchema = {
  type: 'object',
  properties: { ...credentialsSchema.properties, code: { type: 'string', maxLength: 50 } },
  required: ['code', 'username', 'password'],
};

const accountSchema: ObjectSchema = {
  type: 'object',
  properties: {
    currentPassword: { type: 'string', maxLength: 1000 },
    username: { type: 'string', nullable: true, maxLength: 200 },
    newPassword: { type: 'string', nullable: true, maxLength: 1000 },
    passwordLogin: { type: 'boolean', nullable: true },
  },
  required: ['currentPassword'],
};

const passkeyLoginSchema: ObjectSchema = {
  type: 'object',
  properties: { challengeId: { type: 'string', maxLength: 100 }, response: { type: 'json' } },
  required: ['challengeId', 'response'],
};

const passkeyRegisterSchema: ObjectSchema = {
  type: 'object',
  properties: { name: { type: 'string', nullable: true, maxLength: 100 }, response: { type: 'json' } },
  required: ['response'],
};

const renameSchema: ObjectSchema = {
  type: 'object',
  properties: { name: { type: 'string', maxLength: 100 } },
  required: ['name'],
};

const apiTokenSchema: ObjectSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: 100 },
    scope: { type: 'string', maxLength: 10 },
    expiresInDays: { type: 'integer', nullable: true, minimum: 1 },
  },
  required: ['name', 'scope'],
};

export interface AuthRoutesDeps {
  auth: AuthService;
  /** Request context (client IP, origin, RP ID) for a request. */
  context: (req: Request, server: Bun.Server<undefined>) => RequestContext;
}

/** Turns an {@link AuthError} into a problem response; rethrows anything else. */
function authProblem(error: unknown): Response {
  if (!(error instanceof AuthError)) {
    throw error;
  }
  if (error.field) {
    return validationProblem(error.field, error.message);
  }
  return problem(error.status, error.message, {}, error.retryAfterSeconds ? { 'retry-after': String(error.retryAfterSeconds) } : {});
}

export function authRoutes({ auth, context }: AuthRoutesDeps) {
  const sessionOf = (req: Request): Session | null => auth.sessionFromToken(sessionTokenFrom(req));
  const signedIn = (req: Request, token: string) =>
    Response.json(auth.state(auth.sessionFromToken(token)), { headers: { 'set-cookie': sessionCookie(req, token) } });
  /** Runs `action` for a signed-in request (the global guard already rejected anonymous ones). */
  const withSession = async (req: Request, action: (session: Session) => Response | Promise<Response>) => {
    const session = sessionOf(req);
    if (!session) {
      return problem(401, 'Sign in first.');
    }
    try {
      return await action(session);
    } catch (error) {
      return authProblem(error);
    }
  };

  return {
    '/api/auth/state': {
      GET: (req: Request) => Response.json(auth.state(sessionOf(req))),
    },
    '/api/auth/setup': {
      POST: async (req: Request, server: Bun.Server<undefined>) => {
        const body = await readBody<{ code: string; username: string; password: string }>(req, setupSchema);
        try {
          return signedIn(req, await auth.setup(body.code, body.username, body.password, context(req, server)));
        } catch (error) {
          return authProblem(error);
        }
      },
    },
    '/api/auth/login': {
      POST: async (req: Request, server: Bun.Server<undefined>) => {
        const body = await readBody<{ username: string; password: string }>(req, credentialsSchema);
        try {
          return signedIn(req, await auth.loginWithPassword(body.username, body.password, context(req, server)));
        } catch (error) {
          return authProblem(error);
        }
      },
    },
    '/api/auth/passkey/options': {
      POST: async (req: Request, server: Bun.Server<undefined>) => {
        try {
          return Response.json(await auth.passkeyLoginOptions(context(req, server)));
        } catch (error) {
          return authProblem(error);
        }
      },
    },
    '/api/auth/passkey/login': {
      POST: async (req: Request, server: Bun.Server<undefined>) => {
        const body = await readBody<{ challengeId: string; response: AuthenticationResponseJSON }>(req, passkeyLoginSchema);
        try {
          return signedIn(req, await auth.loginWithPasskey(body.challengeId, body.response, context(req, server)));
        } catch (error) {
          return authProblem(error);
        }
      },
    },
    '/api/auth/logout': {
      POST: (req: Request) => {
        const session = sessionOf(req);
        if (session) {
          auth.logout(session);
        }
        return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(req, null) } });
      },
    },
    '/api/auth/account': {
      PUT: async (req: Request) => {
        const body = await readBody<{
          currentPassword: string;
          username?: string | null;
          newPassword?: string | null;
          passwordLogin?: boolean | null;
        }>(
          req,
          accountSchema,
        );
        return withSession(req, async (session) => {
          await auth.updateAccount(session, body);
          return Response.json(auth.state(session));
        });
      },
    },
    '/api/auth/passkeys': {
      GET: (req: Request) => withSession(req, () => Response.json(auth.listPasskeys())),
      POST: async (req: Request, server: Bun.Server<undefined>) => {
        const body = await readBody<{ name?: string | null; response: RegistrationResponseJSON }>(req, passkeyRegisterSchema);
        return withSession(req, async (session) => {
          await auth.registerPasskey(session, body.response, body.name ?? '', context(req, server));
          return Response.json(auth.listPasskeys(), { status: 201 });
        });
      },
    },
    '/api/auth/passkeys/options': {
      POST: (req: Request, server: Bun.Server<undefined>) =>
        withSession(req, async (session) => Response.json(await auth.passkeyRegistrationOptions(session, context(req, server)))),
    },
    '/api/auth/passkeys/:id': {
      PATCH: async (req: Bun.BunRequest<'/api/auth/passkeys/:id'>) => {
        const body = await readBody<{ name: string }>(req, renameSchema);
        return withSession(req, () =>
          auth.renamePasskey(decodeURIComponent(req.params.id), body.name)
            ? Response.json(auth.listPasskeys())
            : problem(404, 'Passkey not found.'),
        );
      },
      DELETE: (req: Bun.BunRequest<'/api/auth/passkeys/:id'>) =>
        withSession(req, () =>
          auth.deletePasskey(decodeURIComponent(req.params.id))
            ? new Response(null, { status: 204 })
            : problem(404, 'Passkey not found.'),
        ),
    },
    '/api/auth/sessions': {
      GET: (req: Request) => withSession(req, (session) => Response.json(auth.listSessions(session))),
      // Signs out every other session.
      DELETE: (req: Request) =>
        withSession(req, (session) => Response.json({ ended: auth.endSessions(session, null) })),
    },
    '/api/auth/sessions/:id': {
      DELETE: (req: Bun.BunRequest<'/api/auth/sessions/:id'>) =>
        withSession(req, (session) =>
          auth.endSessions(session, req.params.id) > 0 ? new Response(null, { status: 204 }) : problem(404, 'Session not found.'),
        ),
    },
    '/api/auth/api-tokens': {
      GET: (req: Request) => withSession(req, () => Response.json(auth.listApiTokens())),
      // The response carries the token value – the only time it leaves the server.
      POST: async (req: Request) => {
        const body = await readBody<{ name: string; scope: string; expiresInDays?: number | null }>(req, apiTokenSchema);
        return withSession(req, () => {
          const { token, value } = auth.createApiToken({
            name: body.name,
            scope: body.scope as ApiTokenScope,
            expiresInDays: body.expiresInDays ?? null,
          });
          return Response.json({ ...token, expired: false, token: value }, { status: 201 });
        });
      },
    },
    '/api/auth/api-tokens/:id': {
      DELETE: (req: Bun.BunRequest<'/api/auth/api-tokens/:id'>) => {
        const id = parseId(req.params.id);
        return withSession(req, () =>
          auth.deleteApiToken(id) ? new Response(null, { status: 204 }) : problem(404, 'API token not found.'),
        );
      },
    },
  };
}
