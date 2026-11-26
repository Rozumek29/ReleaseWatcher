# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. Read `README.md` first for what the
app does; the full user documentation (installation, configuration, API, features) is the
[GitHub Wiki](https://github.com/Rozumek29/ReleaseWatcher/wiki), a separate git repository (`ReleaseWatcher.wiki.git`, see *Docs* below) – this file covers
only what is not obvious from them.
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
- **The PR stays a draft until the user explicitly says to merge.** Green CI is not a reason to mark it
  ready or merge it – report the result and wait.
- When told to merge: only after CI passes, and **always squash-merge**:

  ```bash
  gh pr ready && gh pr merge --squash --delete-branch
  ```
- Before marking work done, run the full check (same as CI):

  ```bash
  bun run typecheck && bun run test && bun run build
  ```

### Large tasks: stacked PRs

A small task stays one PR (above). A large one – several layers or several parts worth reviewing on their own, e.g.
API contract → server → UI – becomes a chain of small PRs with
[stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs) and the `gh stack` extension
(`gh extension install github/gh-stack`, needs gh 2.90+):

- Each PR is based on the branch of the PR below it; the bottom one targets `main`. A branch depends only on its own
  layer or the ones below it, never on a higher one.
- Every PR in the stack follows the rules above: its own commits, a draft, green CI, no AI attribution.

```bash
gh stack init feat/x-contract       # new stack on main (or: gh stack init --base main <existing branches…>)
# …commit…
gh stack add feat/x-server          # next layer on top of the current one
# …commit…
gh stack submit --auto              # push all branches, create/update the PRs (drafts) and link them as a stack
gh stack rebase                     # after changing a lower branch: cascade-rebase the ones above
gh stack sync                       # fetch, rebase onto the current main, push and refresh the PRs
gh stack view --short
```

- **Merging:** still only when the user says so, after CI passes, and **always squash into `main`** – every PR of the
  stack becomes its own squashed commit. Merge from the bottom: `gh stack merge --squash` merges atomically everything up
  to the chosen PR (`gh stack merge --squash <pr>`), the PRs above it are rebased and retargeted. Mark the merged PRs
  ready first (`gh pr ready <pr>`; drafts cannot be merged) and run `gh stack sync` afterwards. Never merge a stack PR
  into the branch below it.
- **Parallel sessions:** each agent works in its own `git worktree` on its own branch; one coordinating session
  assembles the stack (`gh stack init --base main <branches…>` adopts branches from other worktrees) and does the
  rebases and submits.

## Releasing a version

1. Pick the version from the changes since the last tag (`git log $(git describe --tags --abbrev=0)..main`):
   new features → minor, fixes only → patch.
2. On a branch `chore/release-X.Y.Z` from the current `main`, bump `"version"` in `package.json` and the version badge
   (`version-X.Y.Z-5865f2`) in `README.md` – nothing else carries the version.
3. Commit and open the PR as “Release X.Y.Z”, wait for CI, squash-merge (as for any PR).
4. Tag the merged commit on `main` and push only the tag:

   ```bash
   git switch main && git pull
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

   `.github/workflows/release.yml` then creates the GitHub Release (zip + Linux executables, generated notes) and the
   Docker images (`:X.Y.Z`, `:X.Y`, `:latest`). Don't create the release on github.com by hand. A `beta-X.Y.Z` tag
   makes a pre-release.
5. Watch the *Release* workflow (`gh run watch`) until it finishes.

## Commands

| Command              | Purpose                                                    |
| -------------------- | ---------------------------------------------------------- |
| `bun install`        | installs server + `web/` workspace                         |
| `bun run dev`        | API on :8080 (watch) + Angular dev server on :4200         |
| `bun run typecheck`  | type-checks `src/`, `test/`, `scripts/` (TypeScript 7)     |
| `bun run test:api`   | server tests (`bun test`, limited to `test/` by `bunfig.toml`) |
| `bun run test:web`   | UI tests (Vitest via `ng test`)                            |
| `bun run build`      | production UI build into `public/`                         |
| `bun run build:executable` | single-file server executable into `dist/` (`scripts/build-executable.ts`) |
| `bun run deploy`     | build + install/update in a Proxmox LXC (`scripts/deploy-lxc.ts`, `deploy/install.sh`) |

A single server test file: `bun test test/checker.test.ts`. Use `bun run test` (not `bun test`) for
the full suite. The Angular CLI runs on Node.js; Bun is only its package manager.

## Server (`src/`) – Bun, TypeScript without a build step

Bun runs the `.ts` files directly. Conventions (`tsconfig.json`, type-checked with TypeScript 7):

- Relative imports include the `.ts` extension: `import { x } from './domain.ts'`.
- Type-only imports must use `import type` / `type` specifiers (`verbatimModuleSyntax`).
- Prefer union types / `as const` objects over `enum`/`namespace`.
- `noUncheckedIndexedAccess` is on – indexed access returns `T | undefined`.
- The server's only runtime dependencies are `@simplewebauthn/server` (passkeys), `jose` (OIDC ID tokens),
  `nodemailer` (SMTP and MIME messages, behind `sendMail()` in `src/notifiers/smtp.ts`) and `zod` (request bodies,
  behind `src/validation.ts`). Prefer Bun built-ins (`Bun.serve`, `bun:sqlite`, `Bun.file`,
  `bun:test`, `fetch`) and `node:` modules Bun implements. Ask before adding a dependency.
- `web/` stays on TypeScript 6 – the Angular compiler requires `>=6.0 <6.1`.
- The release executable and the Docker image run the server as a `Bun.build({ compile })` binary (ESM +
  bytecode, `scripts/build-executable.ts`) with the UI embedded: a generated entry point imports every `public/` file
  `with { type: 'file' }`, fills `embeddedUi` (`src/embedded-ui.ts`) and then imports `main.ts`. Code must work
  there too: `import.meta.dir` points into Bun's virtual FS (`/$bunfs/…`), so don't read files relative to
  the sources at runtime, and avoid `import()` of paths the bundler cannot see.
- The UI (`public/` or the embedded files) is read into memory once at startup (`src/static-ui.ts`), so a
  server started with `bun src/main.ts` needs a restart after `bun run build` to serve the new UI.

### Architecture notes

- Dependencies are injected: `buildApp(deps)` in `src/app.ts` receives the store, settings, release source,
  notifiers, logger and optional fakes (`fetchInstalledVersion`, clock). Keep new I/O behind such seams so it
  can be faked in tests. `app.listen()` starts `Bun.serve`; `app.close()` stops the server and the scheduled jobs.
- Pure logic lives in `domain.ts` / `version.ts`; `checker.ts` orchestrates; `app.ts` only handles HTTP
  (routes via `Bun.serve({ routes })`, body validation via Zod schemas compiled with `body()` from `validation.ts`, errors via
  the `problem()` helper). A thrown `RequestValidationError` becomes a 400 problem response.
- Logging goes through the `Logger` from `log.ts` (`log.info({ fields }, 'message')`, JSON lines).
- `checker.ts` advances the baseline (`lastSeenTag`/`lastSeenPublishedAt`) after **each** dispatched release
  so a crash cannot cause duplicate notifications. Preserve this when changing it.
- Proxmox containers live in `src/proxmox/`: all node access goes through the `NodeShell` interface
  (`SshShell` spawns the system `ssh` client – key-only, `BatchMode`; tests use `FakeShell` from
  `test/helpers.ts`, never a real node). Commands inside guests are built with `guestExec()` (`pctExec()` for
  containers, `qmGuestExec()` for virtual machines – the QEMU guest agent returns JSON, decoded by
  `parseGuestExecResult()`) and `shQuote()` – never interpolate user input into shell strings without them. `pct` and
  `qm` are Perl tools that need about a second to start, so the batched container check (`buildCheckScript()`) calls
  `lxc-info` / `lxc-attach` directly and falls back to `pct` only when they fail; keep frequent work in as few `pct`/`qm`
  calls as possible. Node
  commands that differ per guest kind take a `GuestTarget` (`{ kind, vmid }`) and use `guestCli()` (`pct`/`qm`). `ContainerService` allows one task per container
  and runs checks/updates in the background, writing output to `target_runs`; updates are manual only
  (the scheduler runs checks, never updates). The runtime Docker image therefore needs `openssh-client`.
- What a target kind supports (backups, start/stop, resources, applications, Home Assistant, "update all", how it
  restarts) is described once in `TARGET_CAPABILITIES` (`src/proxmox/domain.ts`) and sent to the UI as
  `capabilities` in the container DTO. Branch on `capabilities(kind)` / `c.capabilities` – not on `kind` – except
  for labels and transport details (`pct` vs `qm guest exec`). The SSH connection of a target comes from
  `ContainerService.shellFor(container)`, never from `deps.shell` directly.
- SSH connections live in `src/hosts/`: named keys (`ssh_keys`) and hosts (`hosts`, `type` `proxmox` | `server`);
  every target has a `host_id`. `ShellPool` keeps one `SshShell` per host and reads address, user and key from the
  store for every command (edits apply without a restart). `ssh-keygen` (inspect, generate, forget host keys) is
  behind `KeyTool` – tests use `FakeKeyTool` and `addProxmoxHost()` from `test/helpers.ts`; `deps.shell` in tests
  answers for every host. The former Proxmox settings (`PROXMOX_*`, saved `proxmox*` settings) are only read once by
  `seedProxmoxHost()` to create the first host.
- Login lives in `src/auth/`: one account (password via `Bun.password`, passkeys via `@simplewebauthn/server`, single sign-on via OIDC in `oidc.ts`),
  sessions in the `sessions` table (only a SHA-256 of the cookie token). `buildApp` guards every route except
  `PUBLIC_ROUTES` (`src/auth/routes.ts`) and refuses cross-site writes (Origin check). New routes are protected
  automatically; add a path to `PUBLIC_ROUTES` only if it must work signed out. Instead of a session, a request may
  carry an API token (`api_tokens`, SHA-256 only; `Authorization: Bearer` or `X-API-Key`, checked by `denied()` in
  `app.ts`): `read` tokens only `GET`/`HEAD`, `full` tokens everything – but never `/api/auth/*`. Tests of other features pass
  `auth: { requireAuth: false }`; `test/auth.test.ts` has a software passkey for real WebAuthn round trips.
- Settings: values saved from the UI live in the `settings` table and override env vars; `null` in
  `PUT /api/settings` resets to the env value. Components read `settings.current` lazily (callbacks), so
  changes apply without a restart.

### Database (`src/db.ts`)

- Migrations are an append-only array versioned by `PRAGMA user_version`. **Never edit or reorder existing
  migrations** – add a new entry at the end.
- When adding a column, update `Row`, `toEntity`, `save()` and `WatchedRepository` in `domain.ts`.

### Secrets

- Installed-version header values, the Discord webhook URL, the SMTP password, the GitHub token (global and per repository), the Gitea/Forgejo/GitLab tokens (per repository and per host, `git_host_tokens`), the
  SSH private keys (`ssh_keys`), the Home Assistant access token of a VM, the OIDC client secret, password hashes, session tokens, API tokens and the setup code are secrets
  (a key is exposed only as its public key and fingerprint, a repository token as `hasAccessToken` + `accessTokenMasked`, the Home Assistant token as
  `homeAssistant.hasToken` + `tokenMasked`; it is sent only to Home Assistant, never to the node). The API never
  returns them in full: headers expose only names (`hasValue`), other secrets are masked (`maskSecret`).
  Keep it that way in any new endpoint or DTO.
- Secrets are also **encrypted at rest** (AES-256-GCM, `SecretBox` in `src/secret-box.ts`; key from `ENCRYPTION_KEY`
  or `encryption.key` next to the database). Stores encrypt on write and decrypt on read, so the rest of the code
  sees plain values. A new secret setting goes into `SECRET_SETTING_KEYS` (`src/db.ts`); a new secret column is
  encrypted in its store and added to `RepositoryStore.encryptSecrets()` so plain-text values of older databases
  get migrated. Password hashes, session hashes and API token hashes are hashed, not encrypted (an API token value is returned only once, by `POST /api/auth/api-tokens`).
- Never log secret values.

## API contract (server ↔ UI)

The API shape is defined twice and must be kept in sync by hand:

- server: DTO mappers in `src/app.ts` (`toDto`, `settingsDto`, `statusDto`) and route schemas,
- UI: `web/src/app/core/models.ts` and `web/src/app/core/api.service.ts`.

When changing an endpoint, also update the wiki page *REST API*.

## Docs

- `README.md` is a short overview (features, quick start, installation methods, links). Keep it short – details
  belong in the wiki.
- The wiki ([https://github.com/Rozumek29/ReleaseWatcher/wiki](https://github.com/Rozumek29/ReleaseWatcher/wiki)) is its own repository: `git clone https://github.com/Rozumek29/ReleaseWatcher.wiki.git`
  next to this one. Page files use dashes for spaces (`REST-API.md` → `[[REST API]]`), `_Sidebar.md` is the
  navigation. Update the affected pages whenever a change is visible to users (new setting/env var →
  *Configuration*, endpoint → *REST API*, feature → its page, new page → `_Sidebar.md` and `Home.md`).
  Wiki changes are pushed to its default branch directly, so push them only after the PR is merged.

## UI (`web/`)

- Angular 22: standalone components, signals, zoneless; dependencies via `inject()`.
- Shared state in `core/*.service.ts` (`StatusService`, `ToastService`, `PreferencesService`, `ClockService`); HTTP only
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

- **New notifier:** implement `Notifier` (`src/notifiers/notifier.ts`: `notify`, `notifyVulnerability`,
  `notifyContainerUpdates`, `notifyUpdateResult`, `notifyDockerUpdates` and `notifyDigest`) – or, for a service that
  takes a title and a text, extend `SimpleNotifier` (`src/notifiers/simple.ts`, see `ntfy.ts`) – register it in
  `src/notifiers/index.ts`; if configurable from the UI, see “New setting”.
- **New setting:** `Settings` + `current` + `validate()` in `src/settings.ts`, env default in `src/config.ts`
  (and `.env.example`), DTO + `PUT /api/settings` schema in `src/app.ts`, `models.ts` + Settings page in
  `web/`, wiki page *Configuration*.
- **New repository field:** migration + mapping in `db.ts`, `domain.ts`, `toDto`, `models.ts`, UI.
