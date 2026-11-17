# ReleaseWatcher

Watches selected GitHub repositories for new releases and sends a notification (Discord today, more channels later).
It also keeps the LXC containers of a Proxmox node up to date: it checks pending `apt` packages and application
versions on a cron schedule and runs updates (apt, community-scripts `update`, your own scripts) at the push of a button.

- **Server:** [Bun](https://bun.sh) 1.4+ running TypeScript natively (no build step), `Bun.serve` HTTP server,
  built-in `bun:sqlite`
- **UI:** Angular 22 (standalone, signals, zoneless), served by the server from `public/`
- **Notifications:** Discord webhook; new channels plug in through the `Notifier` interface
- One runtime dependency (`@simplewebauthn/server` for passkeys) – everything else is built into Bun; releases and
  the Docker image ship the app as a single self-contained executable (`bun build --compile`)

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
2. On the **Containers** page add containers found on the node (`pct list`) – one by one or all at once with
   **Add all**. Commands run inside a container with
   `pct exec <vmid> -- sh -lc '…'`, so containers need no SSH server of their own.
   **Add host** adds the Proxmox node itself (apt only, no applications): it is checked like a container
   (`apt list --upgradable`, on its own schedule, with notifications) and upgraded with `apt-get dist-upgrade` – the
   upgrade Proxmox VE requires. There is no backup before host upgrades and the host is never rebooted; reboot it
   yourself after a kernel update.
3. Per container you can enable the **apt** check (`apt-get update` + `apt list --upgradable`; upgrade =
   `apt-get -y upgrade`, keeping existing config files) and override the global check schedule with a cron
   expression.
   **Backups before updates:** choose a backup storage in Settings (listed from the node – e.g. a Proxmox Backup
   Server or `local`) and whether to back up by default; a container can override the default, and every update
   confirmation has a **Backup first** checkbox. The backup is a `vzdump` in snapshot mode (zstd, except on PBS),
   retention follows the storage's prune settings, and a failed backup stops the update.
   **Update all** (Containers page) updates every enabled container with pending updates, one container after
   another: apt first, then applications with a newer version and an update command. The Proxmox host and
   stopped containers that may not be started are left out. With **Backup first** each container is backed up
   once, before its first update, if it is set to back up; a failed update skips the rest of that container.
   While a container is busy, its **Working…** badge opens the live log of the update in progress (the log moves on
   to the next update by itself); containers still waiting for their turn show **Queued**.
   A container with more than one pending update also has its own **Update all (n)** button that runs just its
   updates the same way (it waits in the queue when another "update all" is running). Applications are listed
   alphabetically.
4. Each container can have **applications**:
   - *version command* – prints the installed version, e.g. `cat /opt/vaultwarden_version.txt`,
   - *latest version* – the newest release of a watched GitHub repository, a command, or none,
   - *update command* – e.g. `update` (community-scripts) or `cd /opt/app && ./pull.sh`.
     Enable **TTY** for scripts that need a terminal (it runs in a pseudo-terminal via `script`); every update has a
     timeout (default 30 min). Update commands run with `PHS_SILENT=1` and `DEBIAN_FRONTEND=noninteractive`, so a
     plain `update` of community-scripts skips its *Silent / Verbose / Cancel* menu and updates silently.

   **Detect applications** (container settings) looks inside a running container and suggests what it finds:
   a community-scripts container (`/usr/bin/update` → `ct/<app>.sh`) with its version file (`~/.<app>` or
   `/opt/<App>_version.txt`) and `update` as update command, or – without community-scripts – `/opt/*_version.txt`
   files and version files of well-known applications. The GitHub repository comes from a built-in list of popular
   applications or from the `# Source:` line of the app's community-scripts script (downloaded from
   `raw.githubusercontent.com`). Nothing is saved until you click **Add**: that watches the repository (or reuses it
   when it is already watched) and links it as the latest version; applications already in the container are marked
   **Added**.
5. Checks run on the cron schedule (`CONTAINER_CHECK_CRON`, default every 6 hours, server time zone – set `TZ`) and
   notify Discord when something new is pending (each pending item is reported once). A check is a single SSH
   connection: `pct status` plus one `pct exec` running the apt check and all version commands, each with its own
   timeout; up to `CONTAINER_CHECK_CONCURRENCY` containers are checked in parallel. **Updates never run
   automatically** – start them from the UI; the console output is shown live and kept in the run history
   (last 50 runs per container). Only one task runs in a container at a time.
   **Stopped containers** are not started by default: a check only reads their status (not an error, no
   notification) and keeps the results of the last check made while it was running; updates are refused until the
   container runs again (the live status is read before the backup and the update). Enable **Start temporarily when
   stopped** in the container settings to have checks (scheduled ones too) and updates start it with `pct start`, wait
   up to a minute for its network and shut it down again afterwards (`pct shutdown`, forced after 2 minutes).
6. **Updates survive a dropped connection.** Backups, apt upgrades and application updates run on the node as
   transient systemd units (`systemd-run`, unit `releasewatcher-run-<run>-<step>`, output in
   `/var/tmp/releasewatcher/`), not inside the SSH session. When the connection drops, ReleaseWatcher reconnects and
   reads the output again; when ReleaseWatcher itself restarts, it re-attaches to the running update and finishes the
   run. systemd stops an update at its timeout.
7. **Resources during updates:** a container can get more **CPU cores** and **memory** for its updates (e.g. an
   update that compiles Rust). They are raised with `pct set` right before the apt upgrade or application update
   (never lowered) and set back to the previous values afterwards – also when the update fails. The previous values
   are saved first, so they are restored on the next start if ReleaseWatcher stopped in between.

> Interactive scripts (whiptail dialogs) cannot be answered from the UI. When an update shows a prompt – a
> whiptail/dialog menu, a `[y/N]` question, a dpkg config-file question, “Press Enter” – and prints nothing more for
> 45 seconds, it is stopped and the run fails with a message instead of waiting for its timeout. Prefer
> non-interactive update commands.

## Quick start (Docker)

```bash
cp .env.example .env        # paste your Discord webhook URL (and optionally a GitHub token)
docker compose up -d --build
```

Open http://localhost:8080. The SQLite database lives in the `releasewatcher-data` volume.

## Native install (systemd, e.g. in its own LXC)

**One command from your computer** (needs SSH access to the Proxmox node and a running Debian/Ubuntu LXC with
*Nesting* enabled – Proxmox's default):

```bash
bun run deploy -- --ct 251            # first install and every later update
```

It builds the executable, uploads it through the node (`pct push`) and runs `deploy/install.sh` inside the container:
system user, directories, systemd service and `/etc/releasewatcher/releasewatcher.env`. On the first install it
prints the **setup code** to create your account in the UI (see Login). Running it again updates the app (the
previous executable stays as `releasewatcher.previous`) and keeps the configuration, the account and the data.

- The node host, SSH user, port and key default to what your local instance has in **Settings → Proxmox node**;
  override with `--node <host>`, `--user`, `--port`, `--identity <key file>`.
- `--db` also copies your local database (repositories, containers, tokens, settings) when the container has none
  yet; `--force-db` replaces an existing one.
- `deploy/install.sh` can also be run by hand inside the container: `sh install.sh <dir with the files>`.

### Manual install

The release executable `releasewatcher-<version>-linux-x64` contains everything (Bun runtime + UI) – no Bun, Node or
Docker needed. A Debian/Ubuntu LXC with 1 CPU, 512 MB RAM and 2 GB disk is plenty. As root in the container:

```bash
# 1. Dependencies: the OpenSSH client reaches the Proxmox node
apt-get update && apt-get install -y openssh-client ca-certificates

# 2. System user and directories
useradd --system --home-dir /var/lib/releasewatcher --shell /usr/sbin/nologin releasewatcher
install -d -o releasewatcher -g releasewatcher -m 750 /var/lib/releasewatcher   # database + known_hosts
install -d -m 755 /opt/releasewatcher                                           # executable
install -d -o root -g releasewatcher -m 750 /etc/releasewatcher                 # configuration

# 3. Executable – from the GitHub release (private repository: `gh release download v1.2.3 -R <owner>/ReleaseWatcher
#    -p 'releasewatcher-*-linux-x64'` or the release page) or built with `bun scripts/compile.ts --target=bun-linux-x64`
install -m 755 releasewatcher-1.2.3-linux-x64 /opt/releasewatcher/releasewatcher

# 4. Configuration (optional – everything can be set in the UI; behind a reverse proxy set PUBLIC_URL)
install -m 640 -g releasewatcher .env.example /etc/releasewatcher/releasewatcher.env
nano /etc/releasewatcher/releasewatcher.env
# SSH key as a file instead of pasting it in the UI:
#   install -m 640 -g releasewatcher id_ed25519 /etc/releasewatcher/proxmox_key
#   PROXMOX_SSH_KEY_FILE=/etc/releasewatcher/proxmox_key   (in releasewatcher.env)

# 5. Service (deploy/releasewatcher.service from this repository)
install -m 644 releasewatcher.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now releasewatcher
journalctl -u releasewatcher -f                      # logs (JSON lines)
cat /var/lib/releasewatcher/setup-code               # one-time code to create the account in the UI
```

Open `http://<container-ip>:8080`. `DATABASE_PATH` is set by the unit (`/var/lib/releasewatcher/releasewatcher.db`);
the pinned host key of the node is stored next to it.

- **Update:** replace `/opt/releasewatcher/releasewatcher` with the new executable and `systemctl restart releasewatcher`
  (database migrations run on start). Keep the old file to roll back.
- **Backup:** `/var/lib/releasewatcher` (SQLite in WAL mode – stop the service or copy all three `releasewatcher.db*`
  files, plus `encryption.key` that decrypts the secrets in it) and `/etc/releasewatcher`.
- **Hardening:** the unit runs as an unprivileged user with a read-only system (`ProtectSystem=strict`, writes only
  to `/var/lib/releasewatcher`). In an unprivileged LXC this needs *nesting* (Proxmox enables it by default); if the
  service fails with `status=226/NAMESPACE`, enable *Options → Features → Nesting* or remove the hardening lines.
- **SSH key on the node:** restrict it to the container's IP (`from="<container-ip>"` in `authorized_keys`).

## Login

The UI and the API require a login – **one account** that can sign in with its **password** and/or **passkeys**.

- **First start:** without an account the app logs a one-time **setup code** (also in `setup-code` next to the
  database, and printed by `bun run deploy`). The UI shows the setup screen: enter the code, a user name and a
  password (10+ characters). Without the code nobody else can claim a fresh installation.
- **Upgrading from Basic auth** (installs made with an earlier `bun run deploy` have a generated password in
  `/etc/releasewatcher/releasewatcher.env` – `grep BASIC_AUTH` it): if `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` are
  set and no account exists, the
  account is created with them on the first start – just sign in with the same credentials.
- **Passkeys** (Account page → *Add passkey*) need a secure context: **HTTPS with a host name** (or `localhost`).
  Put the app behind a reverse proxy (Caddy, Nginx Proxy Manager, Traefik …) and set
  `PUBLIC_URL=https://watcher.example.com` (pins the WebAuthn relying party) and `TRUST_PROXY=true`. A passkey is bound
  to that host name. The password keeps working everywhere.
- **Sessions:** HttpOnly, `SameSite=Strict` cookie (`Secure` over HTTPS), 30 days, extended while you use the app;
  the Account page lists them and signs them out. Changing the password signs out all other sessions. Repeated
  failed logins lock the client out with growing delays; state-changing requests from other sites are refused.
- **Reset the login** (forgot the password, no passkey at hand) – removes the account, its passkeys and sessions,
  nothing else:

  ```bash
  # in the container (on the node: prefix each command with `pct exec <vmid> --`)
  sed -i '/^BASIC_AUTH_/d' /etc/releasewatcher/releasewatcher.env   # else the old credentials come back on restart
  runuser -u releasewatcher -- env DATABASE_PATH=/var/lib/releasewatcher/releasewatcher.db \
    /opt/releasewatcher/releasewatcher --reset-login
  systemctl restart releasewatcher
  cat /var/lib/releasewatcher/setup-code
  ```

  Then open the UI and create the account again with the new setup code.

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
| `bun run deploy`    | build and install/update the app in a Proxmox LXC (see Native install) |

Use `bun run test`, not plain `bun test` – the latter runs only the server tests (`bunfig.toml` limits
it to `test/`).

## Releases

`bun run package` builds both release artifacts in `release/`:

- `releasewatcher-<version>/` – server sources + production UI + runtime dependencies for Bun (no `bun install`
  needed):

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
  values are stored encrypted in SQLite and never returned by the API (the UI only sees header names).
- **Settings** – Discord webhook, mention and bot name (with a test message), GitHub token with live API quota,
  polling interval. Changes apply immediately; values saved in the UI are stored in SQLite and override
  the environment variables below (clearing a value falls back to the environment).
- The sidebar shows when the next check runs and has a **Check all now** button; its footer shows the running
  version and links to the GitHub repository.

## Configuration (environment variables / `.env`)

| Variable | Default | Description |
|---|---|---|
| `DISCORD_WEBHOOK_URL` | – | Discord channel webhook. Empty = Discord disabled. |
| `DISCORD_MENTION` | – | Text above the embed, e.g. `@here` or `<@&ROLE_ID>`. |
| `DISCORD_USERNAME` | `ReleaseWatcher` | Display name of the webhook. |
| `DISCORD_AVATAR_URL` | – | Avatar of the webhook. |
| `DISCORD_MAX_BODY_LENGTH` | `1500` | Release notes are truncated to this length. |
| `GITHUB_TOKEN` | – | Optional PAT. Raises the limit from 60 to 5000 requests/hour; needed for private repos – fine-grained token with access to those repositories and **Contents: Read-only** (Metadata: Read-only is added automatically); a classic token needs `repo`. Fine-grained tokens cannot read repositories of another user you only collaborate on – give such a repository its own token (of the owner) in its settings; per-repository tokens override this one and are never returned by the API. |
| `POLL_INTERVAL_MINUTES` | `15` | Time between checks. |
| `POLL_INITIAL_DELAY_SECONDS` | `10` | Delay before the first check after start. |
| `DATABASE_PATH` | `releasewatcher.db` | SQLite file. |
| `ENCRYPTION_KEY` | – | Key for secrets in the database: 32 bytes, base64 or hex (`openssl rand -base64 32`). Empty = `encryption.key` next to the database, generated on the first start. See *Security note*. |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | HTTP binding. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` or `silent`; logs are JSON lines. |
| `PROXMOX_HOST` | – | Proxmox node for container checks. Empty = containers disabled. |
| `PROXMOX_SSH_PORT` | `22` | SSH port of the node. |
| `PROXMOX_SSH_USER` | `root` | SSH user; non-root users need passwordless `sudo` for `pct`. |
| `PROXMOX_SSH_KEY_FILE` | – | Path to the private key (read at start; the key can also be pasted in the UI). |
| `SSH_KNOWN_HOSTS_FILE` | `<database dir>/known_hosts` | Pinned host keys (trust on first use). |
| `CONTAINER_CHECK_CRON` | `0 */6 * * *` | Default container check schedule (5-field cron, `@daily`, …). |
| `CONTAINER_CHECK_CONCURRENCY` | `3` | How many containers are checked at the same time (1–10). |
| `PROXMOX_BACKUP_STORAGE` | – | Storage for backups (`vzdump`) made before updates. |
| `BACKUP_BEFORE_UPDATE` | `false` | Back up before updates by default (containers and single updates can change it). |
| `PUBLIC_URL` | – | Public address behind a reverse proxy, e.g. `https://watcher.example.com`; pins the origin and the passkey relying party; container notifications on Discord link to its Containers page. |
| `TRUST_PROXY` | `false` | Take the client IP from `X-Forwarded-For` (login lockout, session list) – only behind a proxy that sets it. |
| `BASIC_AUTH_USERNAME` / `BASIC_AUTH_PASSWORD` | – | Upgrade path from Basic auth: create the login account with these credentials when none exists. |

> Without a token GitHub allows 60 requests/hour per IP. Each repository costs one request per check
> (fewer with ETag hits), so for more than ~10 repositories at a 15 min interval add a token.

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/repositories` | List watched repositories |
| `POST` | `/api/repositories` | `{ "repository": "owner/repo", "includePrereleases": false, "githubToken"?: "github_pat_…" }` – the token is optional, see below |
| `PUT` | `/api/repositories/:id` | `{ "includePrereleases": true, "isEnabled": true, "installedVersionUrl"?: "https://…", "installedVersionField"?: "data.version", "installedVersionHeaders"?: [{ "name": "Authorization", "value": "Bearer …" }] }` – a header with `value: null` keeps the saved value; `"githubToken"`: omit = keep, `null` = remove |
| `POST` | `/api/installed-version/test` | `{ "url": "https://…", "field": null, "headers": [], "repositoryId"?: 1 }` → detected version and response preview |
| `DELETE` | `/api/repositories/:id` | Stop watching |
| `POST` | `/api/repositories/:id/check` | Check immediately |
| `GET` | `/api/notifiers` | Registered notifiers and whether they are configured |
| `POST` | `/api/notifiers/test` | Send a fake release to all enabled notifiers |
| `GET` | `/api/settings` | Effective settings (secrets masked) and where each value comes from |
| `PUT` | `/api/settings` | Partial update; `null` resets a value to the environment default |
| `GET` | `/api/status` | App version, poller state (next/last run), repository and container counts |
| `POST` | `/api/check-all` | Check all active repositories now |
| `GET` | `/api/github/rate-limit` | Remaining GitHub API quota |
| `POST` | `/api/proxmox/test` | Connect to the node, returns `pveversion` output |
| `GET` | `/api/proxmox/containers` | Containers on the node (`pct list`) with an `added` flag |
| `GET` | `/api/proxmox/storages` | Storages that accept backups (`pvesm status --content backup`) |
| `GET` | `/api/containers` | Added containers with their applications and pending updates; `isBusy` and `activeRunId` (the run in progress – its live log is `GET /api/runs/:id`) |
| `POST` | `/api/containers` | `{ "vmid": 101, "name"?: "…" }` – adds a container and starts a check |
| `PUT` | `/api/containers/:id` | `{ "name", "isEnabled", "aptEnabled", "backupBeforeUpdate"?: true \| false \| null, "startWhenStopped"?: true \| false, "checkCron"?: "0 3 * * *" \| null, "updateCores"?: 4 \| null, "updateMemoryMb"?: 4096 \| null }` – `null` = global default (resources: unchanged), omitted = keep |
| `DELETE` | `/api/containers/:id` | Remove a container (409 while a task runs) |
| `POST` | `/api/containers/node` | Add the Proxmox host itself (`kind: "node"`, `vmid: 0`, named after `hostname`) and start a check → `201`; `409` when already added. apt-upgrade of the host runs `dist-upgrade` without a backup (`{ "backup": true }` → `409`) |
| `POST` | `/api/containers/add-all` | Add every container of the node not added yet and queue their checks → `201` with the added containers (`200` with `[]` when there is nothing to add) |
| `POST` | `/api/containers/check-all` | Queue a check of all enabled containers (202) |
| `POST` | `/api/containers/update-all` | Update every enabled container with pending updates one after another – apt, then applications; not the Proxmox host. Body `{ backup?: boolean }` (`false` = no backups, otherwise each container's default). 202 with `{ containers, updates }`, 409 while running |
| `POST` | `/api/containers/:id/update-all` | Run every pending update of one container one after another (apt, then applications) – queued next to a running "update all". Body `{ backup?: boolean }` overrides the container's default (one backup before the first update). 202 with `{ containers, updates }` (200 with zeros when nothing is pending), 409 while its updates are queued or running |
| `POST` | `/api/containers/:id/check` | Start a check → `202` with the run |
| `POST` | `/api/containers/:id/apt-upgrade` | Start `apt-get upgrade` → `202` with the run; optional `{ "backup": true \| false }` overrides the backup default |
| `POST` | `/api/containers/:id/apps` | `{ "name", "versionCommand", "latestSource": "none" \| "github" \| "command", "repositoryId", "latestCommand", "updateCommand", "useTty", "timeoutSeconds" }` |
| `POST` | `/api/containers/:id/detect-apps` | Applications found in a running container: `[{ "name", "slug", "versionCommand", "installedVersion", "updateCommand", "repository", "repositoryId", "alreadyAdded" }]` (nothing is saved; `409` for a stopped container or the host) |
| `PUT` / `DELETE` | `/api/containers/:id/apps/:appId` | Edit / remove an application |
| `POST` | `/api/containers/:id/apps/:appId/update` | Run the update command → `202` with the run; optional `{ "backup": true \| false }` |
| `GET` | `/api/containers/:id/runs` | Recent runs (without output) |
| `GET` | `/api/runs/:id` | One run with its console output (poll while `status` is `running`) |
| `GET` | `/health` | Liveness |

Everything except `/health` and the public auth endpoints below needs a session cookie (401 otherwise).

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/auth/state` | `{ setupRequired, authenticated, username, hasPasskeys }` (public) |
| `POST` | `/api/auth/setup` | `{ "code", "username", "password" }` – first account, only while none exists (public) |
| `POST` | `/api/auth/login` | `{ "username", "password" }` → session cookie (public; 429 after repeated failures) |
| `POST` | `/api/auth/passkey/options` / `/api/auth/passkey/login` | Passkey sign-in: options with a `challengeId`, then `{ challengeId, response }` (public) |
| `POST` | `/api/auth/logout` | End the current session |
| `PUT` | `/api/auth/account` | `{ "currentPassword", "username"?, "newPassword"? }` – a new password signs out other sessions |
| `GET` / `POST` | `/api/auth/passkeys` | List passkeys / register one (`{ name, response }` after `POST /api/auth/passkeys/options`) |
| `PATCH` / `DELETE` | `/api/auth/passkeys/:id` | Rename (`{ name }`) / remove a passkey |
| `GET` / `DELETE` | `/api/auth/sessions` | List sessions / sign out all other sessions |
| `DELETE` | `/api/auth/sessions/:id` | Sign out one session |

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
  secret-box.ts      AES-256-GCM encryption of secrets stored in the database + key loading
  github.ts          GitHub REST client (ETag aware)
  checker.ts         checks one/all repositories, dispatches notifications
  poller.ts          interval scheduler (interval can change at runtime)
  settings.ts        UI-editable settings stored in SQLite, falling back to env vars
  version.ts         version parsing/comparison, reading the installed version of a self-hosted app
  auth/              login: account + passkeys (@simplewebauthn/server) + sessions, setup code, routes
  cron.ts            5-field cron parser (container check schedule)
  http.ts            problem-details response helpers
  notifiers/         Notifier interface, dispatcher, Discord
  proxmox/           LXC containers: SSH client (system OpenSSH), pct/apt parsing, store, service
                     (checks + updates + run log), cron scheduler, HTTP routes
test/                bun:test tests
deploy/
  releasewatcher.service  systemd unit for a native install (see "Native install")
  install.sh              installs/updates the service inside the target machine (used by deploy-lxc.ts)
scripts/
  ensure-web.ts      builds the UI for `bun start` when needed
  compile.ts         `bun build --compile` flags, used by `bun run compile`, packaging and the Dockerfile
  package.ts         builds the release folder for `bun run package`
  deploy-lxc.ts      `bun run deploy`: build + install/update in a Proxmox LXC through the node
web/                 Angular UI (builds into public/)
  src/app/app.*              shell: sidebar, poller status, toasts
  src/app/pages/repositories watched repositories
  src/app/pages/containers   Proxmox LXC containers, applications, run log
  src/app/pages/settings     Discord, GitHub, polling, Proxmox node settings
  src/app/pages/login, setup, account   sign-in, first-run setup, password / passkeys / sessions
```

## Security note

The server fetches the installed-version URLs you configure (usually LAN addresses) – keep the UI private.
Secrets in the SQLite file – the Discord webhook URL, GitHub tokens (global and per repository), the Proxmox SSH
private key and installed-version header values – are **encrypted with AES-256-GCM**. The key comes from
`ENCRYPTION_KEY` or, when it is not set, from `encryption.key`, generated next to the database on the first start
(plain-text secrets of older versions are encrypted then). A copied database or backup alone does not reveal the
secrets; to also protect against someone who can read the whole data directory, set `ENCRYPTION_KEY` in the
environment (e.g. `/etc/releasewatcher/releasewatcher.env` or a Docker secret) instead of using the key file.
**Back up the key** – without it the app refuses to start on that database (restore the key or delete the database).
**The UI can run commands as root on your Proxmox node.** It requires a login (see Login); keep it on a private
network or behind HTTPS (reverse proxy) – over plain HTTP the password and the session cookie travel in clear text.
Passwords are stored as argon2id hashes, sessions only as SHA-256 hashes of their tokens. The SSH private key is stored encrypted in the SQLite file
when pasted in the UI (or read from `PROXMOX_SSH_KEY_FILE`); it is never returned by the API. Consider a dedicated
key used only by ReleaseWatcher.
