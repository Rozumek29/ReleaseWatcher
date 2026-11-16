# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read `README.md` first for what the
app does, the API, configuration and project layout – this file covers only what is not obvious from it.

## Workflow (mandatory)

- **Never commit to `main`.** Start every task on a new branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
- Push the branch right away and open a **draft PR** with the GitHub CLI:

  ```bash
  git switch -c feat/short-description
  # …changes, commit…
  git push -u origin HEAD
  gh pr create --draft --fill   # or --title/--body
  ```

- Keep pushing follow-up commits to the same branch; the PR updates itself.
- Merge only after CI passes, and **always squash-merge**:

  ```bash
  gh pr ready && gh pr merge --squash --delete-branch
  ```
- Before marking work done, run the full check (same as CI):

  ```bash
  npm run typecheck && npm test && npm run build
  ```

## Commands

| Command              | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `npm install`        | installs server + `web/` workspace                         |
| `npm run dev`        | API on :8080 (watch) + Angular dev server on :4200         |
| `npm run typecheck`  | type-checks `src/`, `test/`, `scripts/`                    |
| `npm run test:api`   | server tests (`node:test`)                                 |
| `npm run test:web`   | UI tests (Vitest via `ng test`)                            |
| `npm run build`      | production UI build into `public/`                         |

A single server test file: `node --test test/checker.test.ts`.

## Server (`src/`) – TypeScript without a build step

Node runs the `.ts` files directly (type stripping), which constrains the syntax (`tsconfig.json`):

- Relative imports **must include the `.ts` extension**: `import { x } from './domain.ts'`.
- Type-only imports must use `import type` / `type` specifiers (`verbatimModuleSyntax`).
- No non-erasable syntax (`erasableSyntaxOnly`): no `enum`, `namespace`, constructor parameter properties
  (`constructor(private x)`), or decorators. Use union types / `as const` objects and explicit fields.
- `noUncheckedIndexedAccess` is on – indexed access returns `T | undefined`.
- Keep runtime dependencies minimal (currently only `fastify` and `@fastify/static`). Prefer Node built-ins
  (`node:sqlite`, `fetch`, `node:test`). Ask before adding a dependency.

### Architecture notes

- Dependencies are injected: `buildApp(deps)` in `src/app.ts` receives the store, settings, release source,
  notifiers and optional fakes (`fetchInstalledVersion`, clock). Keep new I/O behind such seams so it can be
  faked in tests.
- Pure logic lives in `domain.ts` / `version.ts`; `checker.ts` orchestrates; `app.ts` only handles HTTP
  (validation via Fastify JSON schemas, errors via the `problem()` helper).
- `checker.ts` advances the baseline (`lastSeenTag`/`lastSeenPublishedAt`) after **each** dispatched release
  so a crash cannot cause duplicate notifications. Preserve this when changing it.
- Settings: values saved from the UI live in the `settings` table and override env vars; `null` in
  `PUT /api/settings` resets to the env value. Components read `settings.current` lazily (callbacks), so
  changes apply without a restart.

### Database (`src/db.ts`)

- Migrations are an append-only array versioned by `PRAGMA user_version`. **Never edit or reorder existing
  migrations** – add a new entry at the end.
- When adding a column, update `Row`, `toEntity`, `save()` and `WatchedRepository` in `domain.ts`.

### Secrets

- Installed-version header values, the Discord webhook URL and the GitHub token are secrets. The API never
  returns them in full: headers expose only names (`hasValue`), other secrets are masked (`maskSecret`).
  Keep it that way in any new endpoint or DTO.
- Never log secret values.

## API contract (server ↔ UI)

The API shape is defined twice and must be kept in sync by hand:

- server: DTO mappers in `src/app.ts` (`toDto`, `settingsDto`, `statusDto`) and route schemas,
- UI: `web/src/app/core/models.ts` and `web/src/app/core/api.service.ts`.

When changing an endpoint, also update the API table in `README.md`.

## UI (`web/`)

- Angular 22: standalone components, signals, zoneless; dependencies via `inject()`.
- Shared state in `core/*.service.ts` (`StatusService`, `ToastService`, `PreferencesService`); HTTP only
  through `ApiService`.
- Formatting: Prettier (`web/.prettierrc`: `printWidth: 100`, single quotes).
- Component tests sit next to the component (`*.spec.ts`); `web/src/app/testing.ts` has helpers.

## Tests

- Server tests use `node:test` + `node:assert/strict`, an in-memory DB (`new RepositoryStore(':memory:')`)
  and the fakes in `test/helpers.ts` (`FakeSource`, `RecordingNotifier`, `release()`, `silentLog`).
- Tests must never call the real GitHub API, Discord or other network services.
- Add or update tests with every behavior change (logic → `domain`/`version`/`checker` tests,
  endpoints → `test/api.test.ts`).

## Common changes – checklist

- **New notifier:** implement `Notifier` (`src/notifiers/notifier.ts`), register it in
  `src/notifiers/index.ts`; if configurable from the UI, see “New setting”.
- **New setting:** `Settings` + `current` + `validate()` in `src/settings.ts`, env default in `src/config.ts`
  (and `.env.example`), DTO + `PUT /api/settings` schema in `src/app.ts`, `models.ts` + Settings page in
  `web/`, README configuration table.
- **New repository field:** migration + mapping in `db.ts`, `domain.ts`, `toDto`, `models.ts`, UI.
