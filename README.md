# ReleaseWatcher

Watches selected GitHub repositories for new releases and sends a notification (Discord today, more channels later).
It also keeps the LXC containers of a Proxmox node up to date: it checks pending `apt` packages and application
versions on a cron schedule and runs updates (apt, community-scripts `update`, your own scripts) at the push of a button.

- **Server:** [Bun](https://bun.sh) 1.4+ running TypeScript natively (no build step), `Bun.serve` HTTP server,
  built-in `bun:sqlite`
- **UI:** Angular 22 (standalone, signals, zoneless), served by the server from `public/`
- **Notifications:** Discord webhook; new channels plug in through the `Notifier` interface
- No runtime dependencies – everything the server needs is built into Bun; releases and the Docker image ship
  it as a single self-contained executable (`bun build --compile`)

## How it works

1. You add a repository (`owner/repo` or a GitHub URL) in the UI or via the API.
2. The first check only stores a **baseline** (the newest existing release), so you are not spammed with history.
3. Every `POLL_INTERVAL_MINUTES` (default 15) the poller fetches recent releases using conditional requests
   (`If-None-Match`/ETag; a `304` does not count against GitHub's rate limit).
4. Releases newer than the baseline are sent to every enabled notifier (oldest first, max 5 per check),
   then the baseline moves forward. Drafts are ignored; pre-releases are opt-in per repository.

## Proxmox LXC containers

1. In **Settings → Proxmox node** enter the host, SSH user (`root`, or a user allowed to run `pct` through
   passwordless `sudo`) and the **private key**. Only public-key authentication is used (no passwords, no agent,
   keys with a passphrase are not supported). The node's host key is trusted on the first connection and pinned in
   `known_hosts` next to the database. Use **Test connection** to verify.
2. On the **Containers** page add containers found on the node (`pct list`). Commands run inside a container with
   `pct exec <vmid> -- sh -lc '…'`, so containers need no SSH server of their own.
3. Per container you can enable the **apt** check (`apt-get update` + `apt list --upgradable`; upgrade =
   `apt-get -y upgrade`, keeping existing config files), take a **snapshot before every update** (`pct snapshot`;
   snapshots are not removed automatically) and override the global check schedule with a cron expression.
4. Each container can have **applications**:
   - *version command* – prints the installed version, e.g. `cat /opt/vaultwarden_version.txt`,
   - *latest version* – the newest release of a watched GitHub repository, a command, or none,
   - *update command* – e.g. `update` (community-scripts) or `cd /opt/app && ./pull.sh`.
     Enable **TTY** for scripts that need a terminal; every update has a timeout (default 30 min).
5. Checks run on the cron schedule (`CONTAINER_CHECK_CRON`, default every 6 hours, server time zone – set `TZ`) and
   notify Discord when something new is pending (each pending item is reported once). A check is a single SSH
   connection: `pct status` plus one `pct exec` running the apt check and all version commands, each with its own
   timeout; up to `CONTAINER_CHECK_CONCURRENCY` containers are checked in parallel. **Updates never run
   automatically** – start them from the UI; the console output is shown live and kept in the run history
   (last 50 runs per container). Only one task runs in a container at a time; a stopped container is reported, not
   started.

> Interactive scripts (whiptail dialogs) cannot be answered from the UI – a script that waits for input ends with a
> timeout. Prefer non-interactive update commands.

## Quick start (Docker)

```bash
cp .env.example .env        # paste your Discord webhook URL (and optionally a GitHub token)
docker compose up -d --build
```

Open http://localhost:8080. The SQLite database lives in the `releasewatcher-data` volume.

## Local development

Requirements: Bun 1.4.4+ and Node.js 26 (the Angular CLI still runs on Node; Bun is only its package
manager). The server and the Angular UI are one Bun workspace, so a single `bun install` in the repository
root installs both.

Bun loads `.env` from the working directory automatically.

```bash
cp .env.example .env        # fill in DISCORD_WEBHOOK_URL (or set it later in the UI)
bun install
bun start                   # builds the UI if needed, then serves app + API on http://localhost:8080
```

`bun start` rebuilds the UI only when `web/` changed since the last build, so later starts are instant.

For development with live reload:

```bash
bun run dev                 # API on :8080 (restarts on change) + Angular dev server on http://localhost:4200
```

Open http://localhost:4200; the Angular dev server proxies `/api` to the API on :8080 (`web/proxy.conf.json`,
adjust it if you change `PORT`).

| Script              | What it does                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `bun start`         | build the UI if it is missing or outdated, start the app             |
| `bun run dev`       | API in watch mode + Angular dev server, side by side (`--parallel`)  |
| `bun run build`     | force a production build of the UI into `public/`                    |
| `bun run serve`     | start the app without touching the UI build                          |
| `bun run test`      | server tests (`bun test`) + UI tests (Vitest)                        |
| `bun run typecheck` | type-check the server (TypeScript 7)                                 |
| `bun run compile`   | single-file executable (server + UI) into `dist/` for this platform  |
| `bun run package`   | release artifacts in `release/` (see Releases)                       |

Use `bun run test`, not plain `bun test` – the latter runs only the server tests (`bunfig.toml` limits
it to `test/`).

## Releases

`bun run package` builds both release artifacts in `release/`:

- `releasewatcher-<version>/` – server sources + production UI for Bun (no `bun install` needed, the server
  has no runtime dependencies):

  ```bash
  cp .env.example .env   # optional, settings can also be changed in the UI
  bun start              # http://localhost:8080
  ```

- `releasewatcher-<version>-linux-x64` – one self-contained executable (`bun build --compile --bytecode`,
  Bun runtime and UI embedded); the target machine needs nothing installed:

  ```bash
  chmod +x releasewatcher-1.2.3-linux-x64
  ./releasewatcher-1.2.3-linux-x64   # reads .env from the working directory
  ```

Compile flags live in `scripts/compile.ts`; the target is `TARGET` in `scripts/package.ts`.
The Docker image runs the same kind of executable on a distroless base (no Bun, Node or shell inside).

Pushing a tag runs `.github/workflows/release.yml`:

| Tag          | GitHub Release                                                    | Docker image (`ghcr.io/<owner>/releasewatcher`) |
| ------------ | ----------------------------------------------------------------- | ----------------------------------------------- |
| `v1.2.3`     | `releasewatcher-1.2.3.zip` + `releasewatcher-1.2.3-linux-x64`     | `1.2.3`, `1.2`, `latest`                        |
| `beta-1.2.3` | pre-release with the same two files                               | `beta-1.2.3`                                    |

```bash
git tag v1.0.0 && git push origin v1.0.0
```

To run the published image instead of building locally, replace `build: .` in `docker-compose.yml` with
`image: ghcr.io/<owner>/releasewatcher:latest` (log in with `docker login ghcr.io` if the package is private).

## UI

- **Repositories** – add/remove repositories, filter (active, paused, errors), search, toggle pre-releases
  and pausing per repository, check a single repository on demand.
- **List or grid** layout for repositories (toggle in the Repositories toolbar; remembered per browser).
- Each repository shows its owner's GitHub avatar (also used as the author icon in Discord messages).
- **Repository settings** (sliders icon) – optional **installed version URL** of your self-hosted instance,
  e.g. Vaultwarden's `https://vault.lan/api/version`. The version is read on every check (plain text, a JSON
  string, common keys like `version`, or an explicit JSON dot path such as `data.version`). You then see
  *Update available 1.31.0 → 1.32.0* / *Up to date*, Discord messages include the installed version, and
  releases you already run (installed ≥ release) are not announced. A **Test URL** button previews the result.
  Optional **request headers** (e.g. `Authorization: Bearer …`, `X-Api-Key`) are sent with the request; their
  values are stored in SQLite and never returned by the API (the UI only sees header names).
- **Settings** – Discord webhook, mention and bot name (with a test message), GitHub token with live API quota,
  polling interval. Changes apply immediately; values saved in the UI are stored in SQLite and override
  the environment variables below (clearing a value falls back to the environment).
- The sidebar shows when the next check runs and has a **Check all now** button.

## Configuration (environment variables / `.env`)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | – | Discord channel webhook. Empty = Discord disabled. |
| `DISCORD_MENTION` | – | Text above the embed, e.g. `@here` or `<@&ROLE_ID>`. |
| `DISCORD_USERNAME` | `ReleaseWatcher` | Display name of the webhook. |
| `DISCORD_AVATAR_URL` | – | Avatar of the webhook. |
| `DISCORD_MAX_BODY_LENGTH` | `1500` | Release notes are truncated to this length. |
| `GITHUB_TOKEN` | – | Optional PAT. Raises the limit from 60 to 5000 requests/hour; needed for private repos. |
| `POLL_INTERVAL_MINUTES` | `15` | Time between checks. |
| `POLL_INITIAL_DELAY_SECONDS` | `10` | Delay before the first check after start. |
| `DATABASE_PATH` | `releasewatcher.db` | SQLite file. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP binding. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`; logs are JSON lines. |
| `PROXMOX_HOST` | – | Proxmox node for container checks. Empty = containers disabled. |
| `PROXMOX_SSH_PORT` | `22` | SSH port of the node. |
| `PROXMOX_SSH_USER` | `root` | SSH user; non-root users need passwordless `sudo` for `pct`. |
| `PROXMOX_SSH_KEY_FILE` | – | Path to the private key (read at start; the key can also be pasted in the UI). |
| `SSH_KNOWN_HOSTS_FILE` | `<database dir>/known_hosts` | Pinned host keys (trust on first use). |
| `CONTAINER_CHECK_CRON` | `0 */6 * * *` | Default container check schedule (5-field cron, `@daily`, …). |
| `CONTAINER_CHECK_CONCURRENCY` | `3` | How many containers are checked at the same time (1–10). |
| `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` | – | When both are set, the UI and API (except `/health`) require HTTP Basic auth. |

> Without a token GitHub allows 60 requests/hour per IP. Each repository costs one request per check
> (fewer with ETag hits), so for more than ~10 repositories at a 15 min interval add a token.

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/repositories` | List watched repositories |
| `POST` | `/api/repositories` | `{ "repository": "owner/repo", "includePrereleases": false }` |
| `PUT` | `/api/repositories/:id` | `{ "includePrereleases": true, "isEnabled": true, "installedVersionUrl"?: "https://…", "installedVersionField"?: "data.version", "installedVersionHeaders"?: [{ "name": "Authorization", "value": "Bearer …" }] }` – a header with `value: null` keeps the saved value |
| `POST` | `/api/installed-version/test` | `{ "url": "https://…", "field": null, "headers": [], "repositoryId"?: 1 }` → detected version and response preview |
| `DELETE` | `/api/repositories/:id` | Stop watching |
| `POST` | `/api/repositories/:id/check` | Check immediately |
| `GET` | `/api/notifiers` | Registered notifiers and whether they are configured |
| `POST` | `/api/notifiers/test` | Send a fake release to all enabled notifiers |
| `GET` | `/api/settings` | Effective settings (secrets masked) and where each value comes from |
| `PUT` | `/api/settings` | Partial update; `null` resets a value to the environment default |
| `GET` | `/api/status` | Poller state (next/last run), repository and container counts |
| `POST` | `/api/check-all` | Check all active repositories now |
| `GET` | `/api/github/rate-limit` | Remaining GitHub API quota |
| `POST` | `/api/proxmox/test` | Connect to the node, returns `pveversion` output |
| `GET` | `/api/proxmox/containers` | Containers on the node (`pct list`) with an `added` flag |
| `GET` | `/api/containers` | Added containers with their applications and pending updates |
| `POST` | `/api/containers` | `{ "vmid": 101, "name"?: "…" }` – adds a container and starts a check |
| `PUT` | `/api/containers/:id` | `{ "name", "isEnabled", "aptEnabled", "snapshotBeforeUpdate", "checkCron"?: "0 3 * * *" \| null }` |
| `DELETE` | `/api/containers/:id` | Remove a container (409 while a task runs) |
| `POST` | `/api/containers/check-all` | Queue a check of all enabled containers (202) |
| `POST` | `/api/containers/:id/check` | Start a check → `202` with the run |
| `POST` | `/api/containers/:id/apt-upgrade` | Start `apt-get upgrade` → `202` with the run |
| `POST` | `/api/containers/:id/apps` | `{ "name", "versionCommand", "latestSource": "none" \| "github" \| "command", "repositoryId", "latestCommand", "updateCommand", "useTty", "timeoutSeconds" }` |
| `PUT` / `DELETE` | `/api/containers/:id/apps/:appId` | Edit / remove an application |
| `POST` | `/api/containers/:id/apps/:appId/update` | Run the update command → `202` with the run |
| `GET` | `/api/containers/:id/runs` | Recent runs (without output) |
| `GET` | `/api/runs/:id` | One run with its console output (poll while `status` is `running`) |
| `GET` | `/health` | Liveness |

## Adding a new notifier (e.g. Slack, Teams, e-mail)

1. Implement `Notifier` from `src/notifiers/notifier.ts` (`name`, `isEnabled`, `notify()` for releases,
   `notifyContainerUpdates()` for pending container updates).
2. Register it in `src/notifiers/index.ts`. Notifiers receive their options through a callback, so values
   changed in the UI (`settings.current`) apply without a restart:

```ts
export function createNotifiers(config: Config, settings: SettingsService): Notifier[] {
  return [
    new DiscordNotifier(() => ({ ...config.discord, webhookUrl: settings.current.discordWebhookUrl /* … */ })),
    new SlackNotifier(() => ({ ...config.slack, webhookUrl: settings.current.slackWebhookUrl })),
  ];
}
```

3. If the channel should be configurable from the UI, add its fields to `Settings` in `src/settings.ts`
   (with validation), to the settings DTO and `PUT /api/settings` schema in `src/app.ts`, and to the
   Settings page in `web/`.

`NotificationDispatcher` sends every release to all enabled notifiers; a failure in one channel
does not block the others. The UI picks up the new channel automatically.

## Project layout

```
src/
  main.ts            entry point: config, DB, HTTP server, poller, graceful shutdown
  app.ts             HTTP routes (Bun.serve) + static UI with SPA fallback
  log.ts             minimal JSON-lines logger
  embedded-ui.ts     UI files embedded into the compiled executable (filled by scripts/compile.ts)
  validation.ts      request body/param validation
  domain.ts          types, repository-name parsing, new-release selection
  db.ts              bun:sqlite store with simple versioned migrations
  github.ts          GitHub REST client (ETag aware)
  checker.ts         checks one/all repositories, dispatches notifications
  poller.ts          interval scheduler (interval can change at runtime)
  settings.ts        UI-editable settings stored in SQLite, falling back to env vars
  version.ts         version parsing/comparison, reading the installed version of a self-hosted app
  cron.ts            5-field cron parser (container check schedule)
  http.ts            problem-details response helpers
  notifiers/         Notifier interface, dispatcher, Discord
  proxmox/           LXC containers: SSH client (system OpenSSH), pct/apt parsing, store, service
                     (checks + updates + run log), cron scheduler, HTTP routes
test/                bun:test tests
scripts/
  ensure-web.ts      builds the UI for `bun start` when needed
  compile.ts         `bun build --compile` flags, used by `bun run compile`, packaging and the Dockerfile
  package.ts         builds the release folder for `bun run package`
web/                 Angular UI (builds into public/)
  src/app/app.*              shell: sidebar, poller status, toasts
  src/app/pages/repositories watched repositories
  src/app/pages/containers   Proxmox LXC containers, applications, run log
  src/app/pages/settings     Discord, GitHub, polling, Proxmox node settings
```

## Security note

The server fetches the installed-version URLs you configure (usually LAN addresses) – keep the UI private.
Header values (API keys, tokens) are stored in plain text in the SQLite file – protect the data volume.
**The UI can run commands as root on your Proxmox node.** Set `BASIC_AUTH_USERNAME`/`BASIC_AUTH_PASSWORD`
(the server logs a warning without them), keep it on a private network and put it behind HTTPS (reverse proxy) –
Basic auth over plain HTTP sends the password in clear text. The SSH private key is stored in the SQLite file
when pasted in the UI (or read from `PROXMOX_SSH_KEY_FILE`); it is never returned by the API. Consider a dedicated
key used only by ReleaseWatcher.
