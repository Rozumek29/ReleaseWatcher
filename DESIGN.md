# DESIGN.md

How ReleaseWatcher is built and how new code should look, so that changes made by different people (and their
coding agents) stay consistent. Read it together with:

- `README.md` – what the app does, configuration, API table, deployment,
- `AGENTS.md` – workflow (branches, PRs, CI), commands, TypeScript rules, secrets, “common changes” checklists.

This file does not repeat those; it describes the **shape** of the system, the **UI design system** and the
**patterns** to copy. When code and this document disagree, the code wins – fix the document in the same PR.

---

## 1. Architecture at a glance

```
                 ┌────────────────────────── Bun process (src/main.ts) ──────────────────────────┐
 Browser ──HTTP──▶ app.ts  Bun.serve({ routes })  ── Basic auth guard ── /health is public      │
 (Angular UI)    │   ├─ /api/repositories, /api/settings, /api/status, /api/notifiers …           │
                 │   ├─ proxmox/routes.ts  /api/containers…, /api/proxmox…, /api/runs/:id         │
                 │   └─ static UI (public/ or embedded) + SPA fallback                           │
                 │                                                                                │
                 │ CronJobs (cron) ─▶ ReleaseChecker ─▶ ReleaseSource (github.ts, ETag) ─▶ GitHub   │
                 │                            ├─▶ OsvClient (osv.ts) ─▶ OSV.dev (vulnerabilities)           │
                 │                            └─▶ NotificationDispatcher ─▶ Notifier[] ─▶ Discord/SMTP│
                 │ ContainerScheduler (cron) ─▶ ContainerService ─▶ NodeShell (ssh) ─▶ Proxmox node │
                 │                                                                                │
                 │ RepositoryStore / ContainerStore (bun:sqlite) · SettingsService (DB over env)   │
                 └────────────────────────────────────────────────────────────────────────────────┘
```

- **One process, one SQLite file.** No queue, no cache, no external services besides GitHub, OSV.dev, Discord, the
  user's SMTP server and the Proxmox node over SSH. Keep it that way; the app must stay a single executable that runs in a small LXC.
- **Composition root:** `src/main.ts` builds real implementations; `buildApp(deps)` in `src/app.ts` wires them.
  Tests call `buildApp` with fakes. Anything that does I/O (network, SSH, clock, filesystem) is a dependency.
- **Feature areas** are folders when they grow: `notifiers/`, `proxmox/`. A feature folder owns its
  `domain.ts` (pure logic), `store.ts` (SQL), `service.ts` (orchestration), `routes.ts` (HTTP) – follow
  `src/proxmox/` as the template for any new large feature instead of growing `app.ts`.

### Layer rules

| Layer | Files | May depend on | Must not |
| --- | --- | --- | --- |
| Domain | `domain.ts`, `version.ts`, `advisories.ts`, `cron.ts`, `proxmox/domain.ts` | nothing with I/O | touch DB, network, clock (`Date.now()` is passed in) |
| Store | `db.ts`, `proxmox/store.ts` | domain types | contain business rules |
| Service | `checker.ts`, `cron-job.ts`, `proxmox/service.ts`, `proxmox/scheduler.ts` | domain, stores, interfaces (`ReleaseSource`, `Notifier`, `NodeShell`) | know about HTTP |
| HTTP | `app.ts`, `proxmox/routes.ts`, `http.ts`, `validation.ts` | everything above | hold logic beyond validation, mapping and status codes |

### Background work

- Long operations (container checks, apt upgrades, app updates) are **runs**: the endpoint starts them and
  returns `202 Accepted` with the run DTO and a `Location: /api/runs/:id` header; the UI polls the run.
  Reuse this pattern for anything that can take more than a couple of seconds.
- Long commands on the node (backups, upgrades, updates) run **detached** as transient systemd units
  (`detachedStartCommand` → `detachedFollowCommand` in `proxmox/domain.ts`): the SSH connection only streams their
  output, reconnects re-read it, and the step is stored on the run (`resume`) so a restarted process re-attaches
  (`ContainerService.recover()`). Use `execDetached()` for any new node command that can outlive a connection.
- State that must be undone after a task (e.g. raised container resources) is saved **before** the change and
  cleared after undoing it, so a restart can finish the job.
- At most one task per container at a time (`ContainerService`); schedulers only check, never update.
- **Every schedule is a cron expression** (server time zone): release checks (`releaseCheckCron`) and vulnerability
  checks (`advisoryCheckCron`) run as `CronJob`s (`src/cron-job.ts`, no overlapping runs), container checks per
  container in `ContainerScheduler`. New periodic work gets a cron setting too – no fixed intervals.
- Scheduled runs due in the **same minute** go through `RunSequencer` (`src/run-sequencer.ts`): collected for ~1 s, then
  run one after another by slot (releases 1 → vulnerabilities 2 → containers 3) inside one `dispatcher.batch()`.
  Manual and startup runs skip it. A new scheduled job takes a `sequencer.slot(n)`.
- Release notifications advance the baseline after **each** dispatched release (no duplicates after a crash).
- Notifications go through `NotificationDispatcher` only: it applies the notification types from the settings and,
  in digest mode, collects everything raised inside `dispatcher.batch()` (a run of all repositories, scheduled or
  "check all" container checks) into one `notifyDigest()` per channel when the last open batch ends. Wrap new
  multi-item runs in `batch()`; single on-demand actions stay outside it and notify right away.

---

## 2. HTTP API conventions

Full endpoint list: `README.md` → *API*. Rules for new endpoints:

- **Paths:** `/api/<plural-resource>[/:id][/<action>]`, kebab-case, e.g. `/api/containers/:id/apt-upgrade`.
  Actions that do something (check, test, update) are `POST` to a verb sub-path.
- **JSON in camelCase**, dates as ISO 8601 strings, missing values as `null` (not omitted) in responses.
- **Status codes:** `200` read/update, `201` create, `202` background run started, `204` delete,
  `400` validation, `401` auth, `404` unknown id, `409` conflict with current state (e.g. task already running,
  feature disabled), `502` upstream failure (GitHub, node) when it is the point of the request, `500` only for unexpected errors.
- **Errors** are always problem details via `problem()` / `validationProblem()` (`src/http.ts`):
  `{ status, title, detail?, errors?: { field: [message] } }`. Messages are full English sentences meant for the
  user – the UI shows them as they are (`describeError()` in `api.service.ts`).
- **Validation** uses the schemas in `validation.ts` (`readBody(req, schema)`, `parseId()`); throw
  `RequestValidationError` instead of building 400s by hand.
- **DTOs** are explicit mapper functions (`toDto`, `settingsDto`, `runDto` …) – never return a DB row or entity
  directly. Internal fields (ETags, raw secrets) never leave the server.
- **Update semantics** for partial updates (`PUT /api/settings`, repository/container settings):
  property **omitted = keep**, **`null` = reset/remove** (settings fall back to env), value = set.
  Secrets follow the same rule, so the UI never has to send a saved secret back.
- **Secrets** in responses: `hasX` / `xConfigured` booleans and `maskSecret()` hints only (see `AGENTS.md`).
- Keep `web/src/app/core/models.ts` + `api.service.ts` in sync with the server mappers in the same PR.
- **Server-side memoization:** values derived only from the database (the body of `/api/repositories`) can be cached
  with `cachedByRevision()` (`src/revision-cache.ts`), keyed by `store.revision()` (SQLite `total_changes()` – every
  store shares one connection), so they are rebuilt only after a write. Don't use it for values that depend on anything
  else (time, settings, in-memory task state).
- **Queries:** read only the columns an endpoint needs (`listStatusFields()`, `listAppVersions()`, `statusCounts()`,
  `advisoryTotals()`) – full entities decrypt secrets and parse JSON. Let SQLite count, filter and sort; keep version
  comparisons in TypeScript and store their results when SQLite has to sort or filter by them (`AdvisoryImpacts` keeps
  `repository_advisories.impact` current, recomputing only what changed). Series of writes go into one transaction; an
  upsert skips unchanged rows.
- **Long lists are paged on the server with a cursor (keyset), never `OFFSET`:** sort by stored columns ending in a
  unique key, cover the order with an index, and pass the last row's key as an opaque `cursor`
  (`WHERE (k1, k2, …) < (?, ?, …) ORDER BY k1 DESC, k2 DESC, … LIMIT n + 1`). Response `{ items, nextCursor, … }`;
  counts needed only once come with the first page. See `GET /api/advisories` (`pageAdvisories()`) and the
  Vulnerabilities page (`appInView` loads the next page).
- **Caching:** every `/api/*` response is `Cache-Control: no-store` (added by the route guard via `noStore()`);
  don't add ETags or caching to API responses. The UI is served by `StaticUi` (`src/static-ui.ts`): loaded into
  memory at startup, zstd-compressed (no gzip/brotli – browsers without zstd get the plain file), an `ETag` per
  representation with `304` support, `immutable` for hashed file names, `no-cache` for the rest, and a `404` (not
  `index.html`) for missing paths that have a file extension.

---

## 3. UI design system

Angular 22 standalone + signals, zoneless, no component library. The look is a calm, neutral admin UI with a
single indigo accent (Discord-like `#5865f2`), light and dark themes following the OS.

### 3.1 Tokens (`web/src/styles.scss`)

Use CSS custom properties – **never hard-code colours** in component styles.

| Token | Use |
| --- | --- |
| `--bg` | page background |
| `--sidebar-bg` | sidebar, mobile top bar |
| `--surface` | cards, dialogs, inputs, toasts |
| `--surface-2` | subtle fills: badges, counters, `code`, avatar fallback |
| `--hover` | hover background of ghost buttons, nav items, rows |
| `--text` / `--text-muted` | primary text / secondary text, hints, meta |
| `--border` / `--border-strong` | card & divider borders / input & secondary button borders |
| `--accent`, `--accent-strong`, `--accent-soft`, `--accent-contrast` | primary actions, links (`strong`), active nav & focus rings (`soft`), text on accent |
| `--success(-soft)`, `--warning(-soft)`, `--danger(-soft)`, `--danger-border` | status text / status backgrounds |
| `--shadow-sm` (cards), `--shadow-lg` (dialogs, toasts, open mobile sidebar) | elevation |
| `--radius` (12px) | cards |

Every new token gets a value in **both** `:root` and the `prefers-color-scheme: dark` block. Status colours are
always used in pairs: text in `--x`, background in `--x-soft`.

### 3.2 Typography & spacing

- Font: system stack (`Inter` if installed), base `15px / 1.5`. Monospace (`code`, `.mono`) for tags, versions,
  URLs, tokens, commands and command output.
- Sizes in `rem`: page title `1.6rem` / weight 680; dialog & section titles `~1.05rem` / 620–650; body `0.88–0.92rem`
  in controls; hints, meta and badges `0.74–0.85rem`.
- Weights in use: 400, 500, 550/560 (buttons, badges), 600 (labels), 620–680 (headings). Do not add new ones.
- Spacing is on a 2px grid, mostly `4 6 8 10 12 14 16 18 20 24 32`. Gaps between related controls 6–8px,
  between fields 14–18px, between page blocks 16–24px.
- Radii: 999px pills (badges, counters, switch), 8px controls (buttons, inputs, nav items), 10px inner groups
  and avatars, 12px cards (`--radius`), 14px dialogs.

### 3.3 Layout

- **Shell** (`app.html` / `app.scss`): 248px sticky sidebar (brand, nav with counters, poller status,
  *Check all now*) + fluid content (`padding: 32px clamp(16px, 4vw, 48px) 64px`, full width – no max-width).
- **≤ 860px:** sidebar becomes an off-canvas drawer with a backdrop and a sticky mobile bar; it closes on navigation.
- **Page anatomy** (copy an existing page):
  1. `<header class="page-header">` with `h1` + one-line `p` description, optional actions on the right;
  2. optional `.callout` (warning about missing configuration, with a link to Settings);
  3. an “add” card / toolbar (`.toolbar` with `.tabs` filters + search + layout switch);
  4. content: list or grid of `.card` rows, or `.sections` of cards (Settings);
  5. states: loading skeleton → empty state → “nothing matches” → data.
- Other breakpoints used inside pages: 600px (repositories), 560px (settings), 480px (dialogs). Prefer these
  values over new ones; content must work at 360px wide without horizontal scroll.
- Viewport heights use `dvh`, never `vh`: on phones `100vh` is the height without the browser bars, so
  sticky/fixed elements and dialog footers sized with it end up hidden behind the address bar.

### 3.4 Components and global classes

Global classes (from `styles.scss`) – use them instead of restyling:

| Class | Notes |
| --- | --- |
| `.btn` | primary (accent). Variants: `.btn-secondary`, `.btn-ghost`, `.btn-danger-ghost`; sizes `.btn-sm`; `.btn-block` |
| `.icon-btn` | 32×32 icon-only button; **always** with `aria-label` and `title` |
| `.input` (+ `.invalid`, `.mono`) | text inputs, selects, textareas |
| `.field` > `label` + control + `.hint` / `.error` | every form field |
| `.card` | bordered surface |
| `.badge` + `-success` / `-warning` / `-danger` / `-accent` | statuses (“Connected”, “Update available”, “Error”) |
| `.page-header`, `.visually-hidden` | page title block; accessible-only labels |
| `.toolbar` > `.tabs` (`.tab`, `.tab-count`) + `.search` | filter tabs and search above a list |
| `.callout`, `.card.empty` + `.empty-icon`, `.skeleton`, `.spin`, `.muted` | missing config warning, empty state, loading, busy icon, secondary text |
| `.dialog` > `.dialog-card` > `.dialog-head` / `.dialog-body` / `.dialog-foot`, `fieldset.group` | native `<dialog>` shell (see *Dialogs*) |
| `.enter`, `.fade-in` | enter animations (see *Motion*) |

Shared components in `web/src/app/shared/`:

- `<app-icon name="…" [size]>` – inline Lucide-style stroke icons (`currentColor`, 2px stroke). Add a new icon by
  adding its path data to `ICONS` in `icon.ts` (copy from lucide.dev, subpaths separated by `" M"`); do not add an
  icon font or image files. Default size 18; 16 in buttons, 14 in small buttons, 12 in badges, 20–22 in headers/empty states.
- `<app-switch [checked] label (toggled)>` – the only on/off control (no bare checkboxes for settings).
- `<app-avatar [src] [name] [size]>` – repository owner avatar with a letter fallback.
- `relativeTime` pipe – “in 5 minutes” / “3 hours ago”; pass the shell's `now()` signal so values tick.
- `appInView` directive – emits `(inView)` when the element nears the viewport (`IntersectionObserver`); used for
  infinite scrolling: put `appInView` on a *Show N more* button below the list, so it also works by click and without the
  observer. It loads the next server page (`nextCursor`) for lists paged by the server, or renders a longer slice
  (`limit` signal, reset when filters change) of a short client-side list.
- `appBackdropClose` directive on a `<dialog>` – light dismiss: sets `closedby="any"` (the browser closes the dialog and
  fires `close`); where that is unsupported (Safari), `(backdropClose)` fires when press and release both happen on the backdrop.

### 3.5 Interaction patterns

- **Loading:** skeleton cards (`.card.skeleton`), never a full-page spinner. Busy buttons are disabled, show a
  spinning `refresh` icon (`.spin`) and an “…ing…” label (`Adding…`, `Saving…`, `Testing…`). Track per-row busy
  state with a `Set<id>` signal.
- **Empty states:** `.card.empty` with an icon in `.empty-icon`, an `h2` and a hint with an example.
- **Feedback:** success/info/error after an action → `ToastService` (`toast.success('Repository added.')`,
  `toast.error(error)`). Errors that belong to a form are shown inline (`.field .error`, `.save-error` in the
  dialog footer) and keep the dialog open.
- **Destructive actions:** inline confirmation in place of the action buttons (“Remove? Yes / No”) for simple
  deletes; actions that change a machine (updates, upgrades) use a confirmation with the relevant options (e.g.
  *Backup first*). No `window.confirm()`.
- **Dialogs:** native `<dialog>` opened with `showModal()` from an `effect()` on an input signal
  (`input<T | null>` – `null` closes), `saved` / `closed` outputs, backdrop click closes
  (`appBackdropClose` – not a bare `(click)`, which also fires when a text selection ends outside the dialog), structure `.dialog > .dialog-card > .dialog-head / .dialog-body / .dialog-foot`,
  grouped fields in `fieldset.group` with a `legend`. The dialog shell (`.dialog`, `.dialog-*`, `.group`, `.optional`,
  `.save-error`) lives in `styles.scss`; a component only overrides what differs (e.g. the width). Dialogs and their
  `::backdrop` set `overscroll-behavior: contain` (the backdrop also `overflow: hidden`) so scrolling never moves the
  page underneath. Footer: ghost *Cancel* left of the primary *Save* (`Save` / `Save container` – name the object when the dialog has several forms).
- **Filters:** `.tabs` with `role="tab"` buttons and counters (`.tab-count`, `.danger` when errors > 0).
- **Secrets in forms:** password input + *Show/Hide* ghost button; placeholder shows the masked saved value;
  hint says “Leave empty to keep the current one.”
- **Live data:** the shell refreshes `/api/status` every 30 s; pages reload when `StatusService.revision()`
  changes (after *Check all now*). Poll runs while they are active, stop when they finish.
- **Per-browser preferences** (layout etc.) go to `PreferencesService` (localStorage with a safe fallback),
  never to the server.
- **Motion:** short (0.12–0.26s), ease-out, only `transform`/`opacity` for movement. Use the global classes from
  `styles.scss`: `.enter` for list items and cards appearing (stagger with `[style.--i]="$index"`, capped at 12),
  `.fade-in` for swapped content (e.g. the containers detail pane); buttons press with `scale(0.97)`; pages fade in on
  navigation (`app.scss`). Use `animation-fill-mode: backwards` so finished animations release. A global
  `prefers-reduced-motion` rule switches all animations and transitions off – don't override it.

### 3.6 Accessibility

- Real `<button type="button">` / `<a routerLink>` – no clickable `div`s (except the dialog backdrop).
- Every input has a `<label for>` (visible or `.visually-hidden`); icon-only buttons have `aria-label`.
- Focus is visible (`:focus-visible` outline in `--accent`); state is exposed (`aria-current`, `aria-selected`,
  `aria-checked`, `aria-live` toasts).
- Text/background pairs must keep WCAG AA contrast in both themes – check dark mode for every new colour usage.

### 3.7 Copy

- English, **sentence case** for headings, buttons and labels (“Check all now”, “Back up before updates”).
- Buttons are verbs (“Watch”, “Save”, “Test URL”); toasts are short sentences ending with a period.
- Use the typographic `…` for in-progress labels and placeholders and an en dash `–` in prose.
- Hints explain *where to get a value* (e.g. Discord → channel settings → Integrations → Webhooks).

---

## 4. Angular code conventions

- Standalone components only, `inject()` for DI, `input()` / `output()` / `viewChild()` functions, signals and
  `computed()` for state; `effect()` only for side effects (opening dialogs, saving preferences, reloads).
- Every component uses `changeDetection: ChangeDetectionStrategy.OnPush`: a component is checked only when a signal
  it reads, an input or one of its template events changes, so ticks elsewhere (clock, status poll, run log) don't
  re-check every list. State shown in a template therefore lives in signals; a plain field (e.g. an `ngModel` form
  value) may only be written from a template event, an `effect()` or together with a signal the template reads.
- New control flow (`@if`, `@for` with `track`, `@else`), no `*ngIf` / `*ngFor`.
- Template-driven forms (`FormsModule`, `ngModel`) are the project standard; keep forms small.
- HTTP only through `ApiService`; components convert with `firstValueFrom` and use `async/await` + `try/finally`
  for busy flags.
- File naming: `*.page.ts` for routed pages (lazy-loaded in `app.routes.ts` with a `title`),
  `*.dialog.ts` for dialogs, plain names in `shared/`. Each has its own `.html` and `.scss` (inline template/styles
  only for tiny shared components). Selector prefix `app-`.
- Component styles stay under the 8 kB budget (`angular.json`); anything used by two pages belongs in
  `styles.scss` or `shared/`.
- New page checklist: route in `app.routes.ts`, nav item (+ icon) in `app.ts`, `page-header`, loading/empty/error
  states, spec file, README *UI* section.

---

## 5. Testing

- Server: `bun:test` in `test/`, one file per module/feature; API tests through real HTTP against
  `buildApp(...).listen({ port: 0 })` with fakes from `test/helpers.ts`.
- UI: Vitest specs next to components, `HttpTestingController` for HTTP, `settle(fixture)` from `testing.ts`
  to flush promises. Test behaviour visible to the user (rendered text, requests sent), not private fields.
- Fixtures: build DTOs with small factory functions (`repo(id, name, extra)`, `pages/containers/fixtures.ts`).
- Every behaviour change ships with tests; bug fixes start with a failing test.

---

## 6. Adding a feature end to end (recipe)

1. **Domain:** types + pure functions (and their tests) in the feature's `domain.ts`.
2. **Storage:** new migration appended in `db.ts`, mapping in the store (see `AGENTS.md` → Database).
3. **Service:** orchestration with injected I/O; long work → run + `202`.
4. **HTTP:** schema + route + DTO mapper; problem responses; secrets masked; API tests.
5. **UI contract:** `models.ts` + `ApiService` method.
6. **UI:** page/dialog following §3 (tokens, global classes, states, a11y, copy) + spec.
7. **Docs:** README (API table, configuration, UI section), `.env.example` for new env vars, this file if a new
   pattern was introduced.

---

## 7. Known inconsistencies (clean up when touching the code)

These exist today; do not copy them into new code:

- `run-log.dialog.scss` hard-codes terminal colours (`#0f1115`, `#dfe3ea`) – should become tokens
  (e.g. `--terminal-bg`, `--terminal-text`).
- Repository, settings and status routes still live in `app.ts` (600+ lines); new areas should get their own
  `routes.ts` like `proxmox/routes.ts`, and repositories can be moved out the same way.
- Unsafe requests (`POST`/`PUT`/`DELETE`) have no CSRF protection: with Basic auth enabled the browser re-sends
  cached credentials on a cross-site form post, and e.g. `POST /api/containers/:id/apt-upgrade` accepts an empty
  body. Planned fix: reject unsafe requests whose `Sec-Fetch-Site`/`Origin` is cross-site. New endpoints must not
  rely on “nobody can reach it” as protection.
