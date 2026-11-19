# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read `README.md` first for what the
app does, the API, configuration and project layout – this file covers only what is not obvious from it.
Architecture, API conventions and the UI design system (tokens, components, layout, interaction patterns) are
described in `DESIGN.md` – follow it for every UI or API change so new code looks and behaves like the rest.

## Workflow (mandatory)

- **Never commit to `main`.** Start every task on a new branch (`feat/…`, `fix/…`, `docs/…`, `chore/…`).
- Push the branch right away and open a **draft PR** with the GitHub CLI:

  ```bash
  git switch -c feat/short-description
  # …changes, commit…
  git push -u origin HEAD
  gh pr create --draft --fill   # or --title/--body
  ```

- **No AI attribution:** never add `Co-Authored-By:` / session trailers or "Generated with …" lines for AI tools
  to commit messages or PR descriptions.
- Keep pushing follow-up commits to the same branch; the PR updates itself.
- Wait for CI with `gh pr checks <pr> --watch` – AI agents run it through the **Monitor** tool (not a
  blocking shell call with `sleep`/`timeout`) and react when it finishes.
- Merge only after CI passes, and **always squash-merge**:

  ```bash
  gh pr ready && gh pr merge --squash --delete-branch
  ```
- Before marking work done, run the full check (same as CI):

  ```bash
  bun run typecheck && bun run test && bun run build
  ```

## Commands

| Command              | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `bun install`        | installs server + `web/` workspace                         |
| `bun run dev`        | API on :8080 (watch) + Angular dev server on :4200         |
| `bun run typecheck`  | type-checks `src/`, `test/`, `scripts/` (TypeScript 7)     |
| `bun run test:api`   | server tests (`bun test`, limited to `test/` by `bunfig.toml`) |
| `bun run test:web`   | UI tests (Vitest via `ng test`)                            |
| `bun run build`      | production UI build into `public/`                         |
| `bun run compile`    | single-file server executable into `dist/` (`scripts/compile.ts`) |
| `bun run deploy`     | build + install/update in a Proxmox LXC (`scripts/deploy-lxc.ts`, `deploy/install.sh`) |

A single server test file: `bun test test/checker.test.ts`. Use `bun run test` (not `bun test`) for
the full suite. The Angular CLI runs on Node.js; Bun is only its package manager.

## Server (`src/`) – Bun, TypeScript without a build step

Bun runs the `.ts` files directly. Conventions (`tsconfig.json`, type-checked with TypeScript 7):

- Relative imports include the `.ts` extension: `import { x } from './domain.ts'`.
- Type-only imports must use `import type` / `type` specifiers (`verbatimModuleSyntax`).
- Prefer union types / `as const` objects over `enum`/`namespace`.
- `noUncheckedIndexedAccess` is on – indexed access returns `T | undefined`.
- The server's only runtime dependency is `@simplewebauthn/server` (passkeys). Prefer Bun built-ins (`Bun.serve`, `bun:sqlite`, `Bun.file`,
  `bun:test`, `fetch`) and `node:` modules Bun implements. Ask before adding a dependency.
- `web/` stays on TypeScript 6 – the Angular compiler requires `>=6.0 <6.1`.
- The release executable and the Docker image run the server as a `bun build --compile` binary (ESM +
  bytecode, `scripts/compile.ts`) with the UI embedded: a generated entry point imports every `public/` file
  `with { type: 'file' }`, fills `embeddedUi` (`src/embedded-ui.ts`) and then imports `main.ts`. Code must work
  there too: `import.meta.dir` points into Bun's virtual FS (`/$bunfs/…`), so don't read files relative to
  the sources at runtime, and avoid `import()` of paths the bundler cannot see.
- The UI (`public/` or the embedded files) is read into memory once at startup (`src/static-ui.ts`), so a
  server started with `bun src/main.ts` needs a restart after `bun run build` to serve the new UI.

### Architecture notes

- Dependencies are injected: `buildApp(deps)` in `src/app.ts` receives the store, settings, release source,
  notifiers, logger and optional fakes (`fetchInstalledVersion`, clock). Keep new I/O behind such seams so it
  can be faked in tests. `app.listen()` starts `Bun.serve`; `app.close()` stops the server and the poller.
- Pure logic lives in `domain.ts` / `version.ts`; `checker.ts` orchestrates; `app.ts` only handles HTTP
  (routes via `Bun.serve({ routes })`, body validation via the small schemas in `validation.ts`, errors via
  the `problem()` helper). A thrown `RequestValidationError` becomes a 400 problem response.
- Logging goes through the `Logger` from `log.ts` (`log.info({ fields }, 'message')`, JSON lines).
- `checker.ts` advances the baseline (`lastSeenTag`/`lastSeenPublishedAt`) after **each** dispatched release
  so a crash cannot cause duplicate notifications. Preserve this when changing it.
- Proxmox containers live in `src/proxmox/`: all node access goes through the `NodeShell` interface
  (`SshShell` spawns the system `ssh` client – key-only, `BatchMode`; tests use `FakeShell` from
  `test/helpers.ts`, never a real node). Commands inside guests are built with `guestExec()` (`pctExec()` for
  containers, `qmGuestExec()` for virtual machines – the QEMU guest agent returns JSON, decoded by
  `parseGuestExecResult()`) and `shQuote()` – never interpolate user input into shell strings without them. Node
  commands that differ per guest kind take a `GuestTarget` (`{ kind, vmid }`) and use `guestCli()` (`pct`/`qm`). `ContainerService` allows one task per container
  and runs checks/updates in the background, writing output to `container_runs`; updates are manual only
  (the scheduler runs checks, never updates). The runtime Docker image therefore needs `openssh-client`.
- Login lives in `src/auth/`: one account (password via `Bun.password`, passkeys via `@simplewebauthn/server`),
  sessions in the `sessions` table (only a SHA-256 of the cookie token). `buildApp` guards every route except
  `PUBLIC_ROUTES` (`src/auth/routes.ts`) and refuses cross-site writes (Origin check). New routes are protected
  automatically; add a path to `PUBLIC_ROUTES` only if it must work signed out. Tests of other features pass
  `auth: { requireAuth: false }`; `test/auth.test.ts` has a software passkey for real WebAuthn round trips.
- Settings: values saved from the UI live in the `settings` table and override env vars; `null` in
  `PUT /api/settings` resets to the env value. Components read `settings.current` lazily (callbacks), so
  changes apply without a restart.

### Database (`src/db.ts`)

- Migrations are an append-only array versioned by `PRAGMA user_version`. **Never edit or reorder existing
  migrations** – add a new entry at the end.
- When adding a column, update `Row`, `toEntity`, `save()` and `WatchedRepository` in `domain.ts`.

### Secrets

- Installed-version header values, the Discord webhook URL, the SMTP password, the GitHub token (global and per repository), the
  Proxmox SSH private key, password hashes, session tokens and the setup code are secrets (the key is exposed only as `sshKeyConfigured`, a repository token as
  `hasOwnToken` + masked value). The API never
  returns them in full: headers expose only names (`hasValue`), other secrets are masked (`maskSecret`).
  Keep it that way in any new endpoint or DTO.
- Secrets are also **encrypted at rest** (AES-256-GCM, `SecretBox` in `src/secret-box.ts`; key from `ENCRYPTION_KEY`
  or `encryption.key` next to the database). Stores encrypt on write and decrypt on read, so the rest of the code
  sees plain values. A new secret setting goes into `SECRET_SETTING_KEYS` (`src/db.ts`); a new secret column is
  encrypted in its store and added to `RepositoryStore.encryptSecrets()` so plain-text values of older databases
  get migrated. Password hashes and session hashes are hashed, not encrypted.
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

- Server tests use `bun:test` + `node:assert/strict`, an in-memory DB (`new RepositoryStore(':memory:')`)
  and the fakes in `test/helpers.ts` (`FakeSource`, `RecordingNotifier`, `release()`, `silentLog`).
  API tests start the app on `127.0.0.1` with `port: 0` and use `fetch`.
- Tests must never call the real GitHub API, Discord or other network services.
- Add or update tests with every behavior change (logic → `domain`/`version`/`checker` tests,
  endpoints → `test/api.test.ts`, containers → `test/containers.test.ts`).

## Common changes – checklist

- **New notifier:** implement `Notifier` (`src/notifiers/notifier.ts`: `notify`, `notifyContainerUpdates`,
  `notifyUpdateResult` and `notifyDigest`), register it in
  `src/notifiers/index.ts`; if configurable from the UI, see “New setting”.
- **New setting:** `Settings` + `current` + `validate()` in `src/settings.ts`, env default in `src/config.ts`
  (and `.env.example`), DTO + `PUT /api/settings` schema in `src/app.ts`, `models.ts` + Settings page in
  `web/`, README configuration table.
- **New repository field:** migration + mapping in `db.ts`, `domain.ts`, `toDto`, `models.ts`, UI.
