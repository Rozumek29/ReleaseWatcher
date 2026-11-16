import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { ReleaseChecker } from './checker.ts';
import type { RepositoryStore } from './db.ts';
import { fullName, ownerAvatarUrl, parseRepositoryName, type WatchedRepository } from './domain.ts';
import type { ReleaseSource } from './github.ts';
import { createLogger, type Logger } from './log.ts';
import { NotificationDispatcher } from './notifiers/dispatcher.ts';
import type { Notifier } from './notifiers/notifier.ts';
import { Poller } from './poller.ts';
import {
  MAX_POLL_INTERVAL_MINUTES,
  MIN_POLL_INTERVAL_MINUTES,
  maskSecret,
  SettingsValidationError,
  type SettingsPatch,
  type SettingsService,
} from './settings.ts';
import { parseId, readBody, RequestValidationError, type ObjectSchema, type Schema } from './validation.ts';
import {
  compareVersions,
  fetchInstalledVersion,
  type HttpHeader,
  InstalledVersionError,
  MAX_CUSTOM_HEADERS,
  validateHeaders,
  validateVersionUrl,
} from './version.ts';

/** Header as sent by the UI. A missing/null value means "keep the value already saved for this name". */
interface HeaderInput {
  name: string;
  value?: string | null;
}

const headersSchema: Schema = {
  type: 'array',
  nullable: true,
  maxItems: MAX_CUSTOM_HEADERS,
  items: {
    type: 'object',
    properties: { name: { type: 'string', maxLength: 100 }, value: { type: 'string', nullable: true, maxLength: 4000 } },
    required: ['name'],
  },
};

/** Merges submitted headers with saved ones so secrets don't have to be sent back to the UI. */
function resolveHeaders(input: readonly HeaderInput[], saved: readonly HttpHeader[]): HttpHeader[] | { error: string } {
  const result: HttpHeader[] = [];
  for (const header of input) {
    const name = header.name.trim();
    if (!name) {
      continue;
    }
    const value = header.value ?? saved.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
    if (value === undefined) {
      return { error: `Enter a value for header "${name}".` };
    }
    result.push({ name, value: value.trim() });
  }
  return result;
}

export interface AppDeps {
  store: RepositoryStore;
  source: ReleaseSource;
  notifiers: readonly Notifier[];
  settings: SettingsService;
  /** Override for tests; defaults to a real HTTP fetch. */
  fetchInstalledVersion?: (
    url: string,
    field: string | null,
    headers: readonly HttpHeader[],
  ) => Promise<{ version: string; preview: string }>;
  /** Directory with the built Angular UI; skipped when missing. */
  publicDir?: string;
  /** UI files embedded in a compiled executable (URL path → embedded file); takes precedence over `publicDir`. */
  embeddedUi?: ReadonlyMap<string, string>;
  /** Defaults to an `info` level logger. */
  log?: Logger;
}

export interface App {
  checker: ReleaseChecker;
  /** Created but not started – call `poller.start()`. */
  poller: Poller;
  log: Logger;
  /** Starts the HTTP server (`port: 0` picks a free port). */
  listen(options: { port: number; hostname: string }): Bun.Server<undefined>;
  /** Stops the poller and the HTTP server (if started). */
  close(): Promise<void>;
}

/** Public shape of a watched repository (internal fields like the ETag are not exposed). */
export const toDto = (r: WatchedRepository) => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  fullName: fullName(r),
  url: `https://github.com/${fullName(r)}`,
  avatarUrl: ownerAvatarUrl(r.owner),
  includePrereleases: r.includePrereleases,
  isEnabled: r.isEnabled,
  lastSeenTag: r.lastSeenTag,
  lastSeenPublishedAt: r.lastSeenPublishedAt,
  lastCheckedAt: r.lastCheckedAt,
  lastError: r.lastError,
  createdAt: r.createdAt,
  installedVersionUrl: r.installedVersionUrl,
  installedVersionField: r.installedVersionField,
  // Only names are exposed; values may contain credentials.
  installedVersionHeaders: r.installedVersionHeaders.map((h) => ({ name: h.name, hasValue: h.value.length > 0 })),
  installedVersion: r.installedVersion,
  installedVersionCheckedAt: r.installedVersionCheckedAt,
  installedVersionError: r.installedVersionError,
  /** True/false when both versions are known and comparable, otherwise null. */
  updateAvailable: (() => {
    const diff = compareVersions(r.lastSeenTag, r.installedVersion);
    return diff === null ? null : diff > 0;
  })(),
});

/** RFC 7807-style error response, consumed by the UI. */
function problem(status: number, title: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ status, title, ...extra }, { status, headers: { 'content-type': 'application/problem+json' } });
}

const validationProblem = (field: string, message: string) =>
  problem(400, 'One or more validation errors occurred.', { errors: { [field]: [message] } });

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const addRepositorySchema: ObjectSchema = {
  type: 'object',
  properties: { repository: { type: 'string' }, includePrereleases: { type: 'boolean' } },
  required: ['repository'],
};

const updateRepositorySchema: ObjectSchema = {
  type: 'object',
  properties: {
    includePrereleases: { type: 'boolean' },
    isEnabled: { type: 'boolean' },
    installedVersionUrl: { type: 'string', nullable: true, maxLength: 2000 },
    installedVersionField: { type: 'string', nullable: true, maxLength: 200 },
    installedVersionHeaders: headersSchema,
  },
  required: ['includePrereleases', 'isEnabled'],
};

const testInstalledVersionSchema: ObjectSchema = {
  type: 'object',
  properties: {
    url: { type: 'string', maxLength: 2000 },
    field: { type: 'string', nullable: true, maxLength: 200 },
    headers: headersSchema,
    repositoryId: { type: 'integer', nullable: true },
  },
  required: ['url'],
};

const settingsSchema: ObjectSchema = {
  type: 'object',
  properties: {
    discordWebhookUrl: { type: 'string', nullable: true },
    discordMention: { type: 'string', nullable: true },
    discordUsername: { type: 'string', nullable: true },
    githubToken: { type: 'string', nullable: true },
    pollIntervalMinutes: { type: 'number', nullable: true },
  },
};

/** Resolves a URL path to a regular file inside `root`, or null (missing file, directory or path traversal). */
async function findStaticFile(root: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = resolve(root, `.${decoded}`);
  if (!path.startsWith(root + sep)) {
    return null;
  }
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}

/** Where the UI comes from: `find` maps a URL path to a file path (or null), `index` is the SPA fallback. */
interface UiResolver {
  find(pathname: string): Promise<string | null>;
  index: string;
}

async function createUiResolver(deps: Pick<AppDeps, 'publicDir' | 'embeddedUi'>): Promise<UiResolver | null> {
  const embedded = deps.embeddedUi;
  if (embedded?.has('/index.html')) {
    return {
      find: async (pathname) => {
        try {
          return embedded.get(decodeURIComponent(pathname)) ?? null;
        } catch {
          return null;
        }
      },
      index: embedded.get('/index.html')!,
    };
  }
  if (deps.publicDir === undefined) {
    return null;
  }
  const dir = resolve(deps.publicDir);
  const index = join(dir, 'index.html');
  return (await Bun.file(index).exists()) ? { find: (pathname) => findStaticFile(dir, pathname), index } : null;
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const log = deps.log ?? createLogger('info');
  const dispatcher = new NotificationDispatcher(deps.notifiers, log);
  const checker = new ReleaseChecker({
    store: deps.store,
    source: deps.source,
    dispatcher,
    log,
    ...(deps.fetchInstalledVersion ? { fetchInstalledVersion: deps.fetchInstalledVersion } : {}),
  });
  const { store, source, settings } = deps;
  const poller = new Poller(checker, () => settings.current.pollIntervalMinutes * 60_000, log);
  settings.onChange(() => poller.reschedule());

  const settingsDto = () => {
    const current = settings.current;
    return {
      discord: {
        webhookConfigured: !!current.discordWebhookUrl,
        webhookUrlMasked: maskSecret(current.discordWebhookUrl, 36),
        webhookSource: settings.sourceOf('discordWebhookUrl'),
        mention: current.discordMention,
        username: current.discordUsername,
      },
      github: {
        tokenConfigured: !!current.githubToken,
        tokenMasked: maskSecret(current.githubToken, 4),
        tokenSource: settings.sourceOf('githubToken'),
      },
      polling: {
        intervalMinutes: current.pollIntervalMinutes,
        intervalSource: settings.sourceOf('pollIntervalMinutes'),
        minIntervalMinutes: MIN_POLL_INTERVAL_MINUTES,
        maxIntervalMinutes: MAX_POLL_INTERVAL_MINUTES,
      },
    };
  };

  const statusDto = () => {
    const repositories = store.list();
    return {
      poller: poller.status,
      repositories: {
        total: repositories.length,
        enabled: repositories.filter((r) => r.isEnabled).length,
        withErrors: repositories.filter((r) => r.lastError).length,
        updatesAvailable: repositories.filter((r) => toDto(r).updateAvailable).length,
      },
    };
  };

  const findRepository = (rawId: string) => store.get(parseId(rawId));

  const addRepository = async (req: Request) => {
    const body = await readBody<{ repository: string; includePrereleases?: boolean }>(req, addRepositorySchema);
    const parsed = parseRepositoryName(body.repository);
    if (!parsed) {
      return validationProblem('repository', "Use the 'owner/repo' format or a https://github.com/owner/repo URL.");
    }

    const { owner, name } = parsed;
    if (store.exists(owner, name)) {
      return problem(409, `${owner}/${name} is already being watched.`);
    }

    try {
      if (!(await source.repositoryExists(owner, name))) {
        return validationProblem('repository', `Repository ${owner}/${name} was not found on GitHub.`);
      }
    } catch (error) {
      return problem(502, 'Bad Gateway', { detail: errorMessage(error) });
    }

    const repo = store.add(owner, name, body.includePrereleases ?? false);
    // Establish the baseline right away so the UI shows the current latest release.
    await checker.check(repo);

    return Response.json(toDto(repo), { status: 201, headers: { location: `/api/repositories/${repo.id}` } });
  };

  const updateRepository = async (req: Request, rawId: string) => {
    const repo = findRepository(rawId);
    const body = await readBody<{
      includePrereleases: boolean;
      isEnabled: boolean;
      installedVersionUrl?: string | null;
      installedVersionField?: string | null;
      installedVersionHeaders?: HeaderInput[] | null;
    }>(req, updateRepositorySchema);
    if (!repo) {
      return problem(404, 'Repository not found.');
    }
    if (repo.includePrereleases !== body.includePrereleases) {
      // Filter changed: force a full fetch on the next check.
      repo.etag = null;
    }
    repo.includePrereleases = body.includePrereleases;
    repo.isEnabled = body.isEnabled;

    // Installed-version settings are optional in the body: undefined = keep, null/"" = clear.
    const { installedVersionUrl, installedVersionField, installedVersionHeaders } = body;
    if (installedVersionUrl !== undefined || installedVersionField !== undefined || installedVersionHeaders !== undefined) {
      const url = installedVersionUrl === undefined ? repo.installedVersionUrl : installedVersionUrl?.trim() || null;
      const field = installedVersionField === undefined ? repo.installedVersionField : installedVersionField?.trim() || null;
      const urlError = url ? validateVersionUrl(url) : null;
      if (urlError) {
        return validationProblem('installedVersionUrl', urlError);
      }
      let headers = repo.installedVersionHeaders;
      if (installedVersionHeaders !== undefined) {
        const resolved = resolveHeaders(installedVersionHeaders ?? [], repo.installedVersionHeaders);
        const headerError = 'error' in resolved ? resolved.error : validateHeaders(resolved);
        if (headerError) {
          return validationProblem('installedVersionHeaders', headerError);
        }
        headers = resolved as HttpHeader[];
      }
      const changed =
        url !== repo.installedVersionUrl ||
        field !== repo.installedVersionField ||
        JSON.stringify(headers) !== JSON.stringify(repo.installedVersionHeaders);
      repo.installedVersionUrl = url;
      repo.installedVersionField = field;
      repo.installedVersionHeaders = headers;
      if (changed) {
        await checker.refreshInstalledVersion(repo);
      }
    }

    store.save(repo);
    return Response.json(toDto(repo));
  };

  // Tries an installed-version URL without saving it (used by the "Test" button in the UI).
  // `repositoryId` lets headers without a value reuse the secret saved for that repository.
  const testInstalledVersion = async (req: Request) => {
    const body = await readBody<{ url: string; field?: string | null; headers?: HeaderInput[] | null; repositoryId?: number | null }>(
      req,
      testInstalledVersionSchema,
    );
    const urlError = validateVersionUrl(body.url.trim());
    if (urlError) {
      return validationProblem('installedVersionUrl', urlError);
    }
    const saved = body.repositoryId ? (store.get(body.repositoryId)?.installedVersionHeaders ?? []) : [];
    const resolved = resolveHeaders(body.headers ?? [], saved);
    const headerError = 'error' in resolved ? resolved.error : validateHeaders(resolved);
    if (headerError) {
      return validationProblem('installedVersionHeaders', headerError);
    }
    try {
      return Response.json(
        await (deps.fetchInstalledVersion ?? fetchInstalledVersion)(body.url.trim(), body.field?.trim() || null, resolved as HttpHeader[]),
      );
    } catch (error) {
      if (error instanceof InstalledVersionError) {
        return problem(422, error.message);
      }
      throw error;
    }
  };

  const updateSettings = async (req: Request) => {
    const body = await readBody<SettingsPatch>(req, settingsSchema);
    try {
      settings.update(body);
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        return validationProblem(error.field, error.message);
      }
      throw error;
    }
    return Response.json(settingsDto());
  };

  // Angular UI + SPA fallback; everything else (incl. unknown /api routes) is a 404 problem.
  const ui = await createUiResolver(deps);
  const fallback = async (req: Request) => {
    const { pathname } = new URL(req.url);
    if (ui && (req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
      return new Response(Bun.file((await ui.find(pathname)) ?? ui.index));
    }
    return problem(404, 'Not found.');
  };

  let server: Bun.Server<undefined> | null = null;

  const listen = (options: { port: number; hostname: string }) => {
    server = Bun.serve({
      port: options.port,
      hostname: options.hostname,
      routes: {
        '/health': { GET: () => Response.json({ status: 'ok' }) },

        '/api/repositories': {
          GET: () => Response.json(store.list().map(toDto)),
          POST: addRepository,
        },
        '/api/repositories/:id': {
          GET: (req) => {
            const repo = findRepository(req.params.id);
            return repo ? Response.json(toDto(repo)) : problem(404, 'Repository not found.');
          },
          PUT: (req) => updateRepository(req, req.params.id),
          DELETE: (req) =>
            store.delete(parseId(req.params.id)) ? new Response(null, { status: 204 }) : problem(404, 'Repository not found.'),
        },
        '/api/repositories/:id/check': {
          POST: async (req) => {
            const repo = findRepository(req.params.id);
            if (!repo) {
              return problem(404, 'Repository not found.');
            }
            const result = await checker.check(repo);
            return Response.json({ repository: toDto(repo), notifiedCount: result.notifiedCount });
          },
        },

        '/api/installed-version/test': { POST: testInstalledVersion },

        '/api/notifiers': {
          GET: () => Response.json(deps.notifiers.map((n) => ({ name: n.name, isEnabled: n.isEnabled }))),
        },
        // Sends a fake release to every enabled notifier to verify the configuration.
        '/api/notifiers/test': {
          POST: async () =>
            Response.json(
              await dispatcher.dispatch({
                owner: 'releasewatcher',
                repository: 'test',
                release: {
                  tag: 'v0.0.0-test',
                  name: 'Test notification',
                  htmlUrl: 'https://github.com',
                  body: 'If you can read this, ReleaseWatcher can reach this channel. 🎉',
                  isPrerelease: false,
                  publishedAt: new Date().toISOString(),
                  authorLogin: null,
                  authorAvatarUrl: null,
                },
              }),
            ),
        },

        '/api/settings': {
          GET: () => Response.json(settingsDto()),
          PUT: updateSettings,
        },

        '/api/status': { GET: () => Response.json(statusDto()) },
        // Checks all enabled repositories right away.
        '/api/check-all': {
          POST: async () => {
            await poller.runNow();
            return Response.json(statusDto());
          },
        },

        '/api/github/rate-limit': {
          GET: async () => {
            try {
              return Response.json((await source.getRateLimit?.()) ?? null);
            } catch (error) {
              return problem(502, 'Bad Gateway', { detail: errorMessage(error) });
            }
          },
        },
      },
      fetch: fallback,
      error: (error) => {
        if (error instanceof RequestValidationError) {
          return validationProblem('request', error.message);
        }
        log.error({ err: error }, 'Request failed');
        return problem(500, 'An unexpected error occurred.');
      },
    });
    return server;
  };

  const close = async () => {
    poller.stop();
    await server?.stop();
    server = null;
  };

  return { checker, poller, log, listen, close };
}
