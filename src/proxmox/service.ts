import type { RepositoryStore } from '../db.ts';
import type { Logger } from '../log.ts';
import type { NotificationDispatcher } from '../notifiers/dispatcher.ts';
import {
  APT_CHECK_SCRIPT,
  APT_UPGRADE_SCRIPT,
  appUpdateAvailable,
  type Container,
  type ContainerApp,
  type DiscoveredContainer,
  describeResources,
  detachedCleanupCommand,
  detachedFollowCommand,
  detachedStartCommand,
  detachedStopCommand,
  detectInteractivePrompt,
  appUpdateScript,
  PROMPT_TAIL_LENGTH,
  type DetachedStep,
  detachedUnit,
  parseDetachedOutput,
  parsePctResources,
  pctSetResourcesCommand,
  planResourceRaise,
  firstLine,
  buildCheckScript,
  type CheckStep,
  newCheckToken,
  parseCheckOutput,
  type StepResult,
  parseAptUpgradable,
  parsePctList,
  parsePctStatus,
  parsePvesmStatus,
  NODE_APT_UPGRADE_SCRIPT,
  targetLabel,
  SHUTDOWN_TIMEOUT_SECONDS,
  shutdownContainerCommand,
  START_NETWORK_WAIT_SECONDS,
  startContainerCommand,
  type BackupStorage,
  vzdumpCommand,
  pctExec,
  pendingSignature,
  type Run,
  type RunKind,
  type RunTrigger,
} from './domain.ts';
import {
  appNameFromScript,
  communityScriptUrl,
  DETECT_SCRIPT,
  DETECT_TIMEOUT_SECONDS,
  type DetectedApp,
  detectedApps,
  KNOWN_APPS,
  normalizeAppName,
  parseDetectOutput,
  repositoryFromScript,
} from './detect.ts';
import { type CommandResult, describeSshFailure, type NodeShell } from './ssh.ts';
import type { ContainerStore } from './store.ts';

/** Thrown when another check/update of the same container is still running. */
export class ContainerBusyError extends Error {
  override name = 'ContainerBusyError';
  constructor(vmid: number) {
    super(`Container ${vmid} is busy – wait for the running task to finish.`);
  }
}

interface TaskResult {
  ok: boolean;
  exitCode: number | null;
}

/** Applications cannot be detected in this target right now (the host, a stopped container). */
export class DetectionUnavailableError extends Error {
  override name = 'DetectionUnavailableError';
}

/** Downloads the community-scripts script of an application; null when it does not exist. */
export async function fetchCommunityScript(slug: string): Promise<string | null> {
  const response = await fetch(communityScriptUrl(slug), { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} for the community-scripts script ${slug}.sh`);
  }
  return response.text();
}

const NODE_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_SECONDS = 2 * 60;
const APT_CHECK_TIMEOUT_SECONDS = 5 * 60;
const APT_UPGRADE_TIMEOUT_MS = 60 * 60_000;
const BACKUP_TIMEOUT_MS = 4 * 60 * 60_000;
/**
 * Checks whether a running container sees CPU cores raised with `pct set` – Proxmox writes the config at once, but
 * pvestatd applies the new cpuset only in its next cycle (~10 s), and update scripts check `nproc` right away.
 */
const CORES_POLL_ATTEMPTS = 30;
/** Output kept per run (the tail is preserved). */
const MAX_OUTPUT_LENGTH = 256 * 1024;
/**
 * How often the output of a running task is written to the database. The live log is served from memory
 * ({@link ContainerService.liveRun}), so the stored copy matters only after a restart.
 */
const OUTPUT_FLUSH_MS = 5000;

/** Output of a running task for a reader that already has the part before `cursor`. */
export interface LiveOutput {
  /** Text after the reader's cursor (`append`), or the whole output when the cursor was missing or stale. */
  output: string;
  append: boolean;
  /** Pass back as `after` to receive only what is written later. */
  cursor: string;
}

/** Collects the console output of a run and periodically writes it to the database. */
class RunLog {
  private text = '';
  /** Characters dropped from the start to stay under {@link MAX_OUTPUT_LENGTH}. */
  private dropped = 0;
  /** Identifies this instance in cursors (a re-attached run after a restart starts a new log). */
  private readonly instance = crypto.randomUUID().slice(0, 8);
  /** Bumped when output is replaced instead of appended, so older cursors are no longer valid. */
  private revision = 0;
  private dirty = false;
  private timer: Timer | null = null;
  private readonly store: ContainerStore;
  readonly run: Run;

  /** @param initial output already stored for the run (when re-attaching after a restart) */
  constructor(store: ContainerStore, run: Run, initial = '') {
    this.store = store;
    this.run = run;
    this.text = initial;
  }

  /** Appends raw command output. */
  write(chunk: string): void {
    this.text += chunk;
    if (this.text.length > MAX_OUTPUT_LENGTH) {
      const cut = this.text.length - MAX_OUTPUT_LENGTH;
      this.text = this.text.slice(cut);
      this.dropped += cut;
    }
    this.markDirty();
  }

  /** Appends a status line written by ReleaseWatcher itself. */
  note(line: string): void {
    this.write(`${this.text && !this.text.endsWith('\n') ? '\n' : ''}» ${line}\n`);
  }

  /** Current position, for {@link truncate}. */
  mark(): number {
    return this.dropped + this.text.length;
  }

  /** Removes everything written after `mark` (output that is about to be read again). */
  truncate(mark: number): void {
    this.revision++;
    const local = mark - this.dropped;
    if (local >= 0) {
      this.text = this.text.slice(0, local);
    } else {
      this.text = '';
      this.dropped = mark;
    }
    this.markDirty();
  }

  get output(): string {
    return this.dropped > 0 ? `[…output truncated…]\n${this.text}` : this.text;
  }

  /** Output written after `cursor` (from an earlier read), or the whole output when the cursor is missing or stale. */
  read(cursor: string | null): LiveOutput {
    const end = this.dropped + this.text.length;
    const prefix = `${this.instance}.${this.revision}.`;
    const next = `${prefix}${end}`;
    if (cursor?.startsWith(prefix)) {
      const position = Number(cursor.slice(prefix.length));
      if (Number.isInteger(position) && position >= this.dropped && position <= end) {
        return { output: this.text.slice(position - this.dropped), append: true, cursor: next };
      }
    }
    return { output: this.output, append: false, cursor: next };
  }

  private markDirty(): void {
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), OUTPUT_FLUSH_MS);
  }

  private flush(): void {
    this.timer = null;
    if (this.dirty) {
      this.dirty = false;
      this.store.saveRunOutput(this.run.id, this.output);
    }
  }

  finish(succeeded: boolean, exitCode: number | null): Run {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    Object.assign(this.run, {
      status: succeeded ? 'succeeded' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode,
      output: this.output,
    });
    this.store.finishRun(this.run);
    return this.run;
  }
}

export interface ContainerServiceDeps {
  containers: ContainerStore;
  repositories: RepositoryStore;
  shell: NodeShell;
  dispatcher: NotificationDispatcher;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  now?: () => Date;
  /** Pause before reconnecting to a detached command after the SSH connection dropped (default 5 s). */
  reconnectDelayMs?: number;
  /** Pause between checks whether a container already sees raised CPU cores (default 2 s). */
  resourcePollMs?: number;
  /**
   * How long a running update may show an interactive prompt without new output before it is stopped
   * (default 45 s) – a script waiting for input would otherwise run into its full timeout.
   */
  promptIdleMs?: number;
  /** Downloads a community-scripts `ct/<slug>.sh` script (null = not found); defaults to {@link fetchCommunityScript}. */
  fetchAppScript?: (slug: string) => Promise<string | null>;
}

/** Extra time to wait for a detached command after its own timeout (systemd stops it at the timeout). */
const FOLLOW_GRACE_MS = 60_000;

/** A detached command that was stopped because it waited for input. */
interface PromptStop {
  prompt: string;
  idleSeconds: number;
}

/** Checks LXC containers for pending apt/application updates and runs updates on request. */
export class ContainerService {
  private readonly deps: ContainerServiceDeps;
  private readonly now: () => Date;
  private readonly reconnectDelayMs: number;
  private readonly resourcePollMs: number;
  private readonly promptIdleMs: number;
  /** Running task per container ID – at most one check/update per container at a time. */
  private readonly active = new Map<number, Promise<Run>>();
  /** Most recent task per container (kept after it finished, for {@link wait}). */
  private readonly latest = new Map<number, Promise<Run>>();
  /** Run ID of the task in {@link active}. */
  private readonly activeRuns = new Map<number, number>();
  /** Logs of the runs in progress by run ID – their live output is read from memory, not the database. */
  private readonly logs = new Map<number, RunLog>();

  constructor(deps: ContainerServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.reconnectDelayMs = deps.reconnectDelayMs ?? 5000;
    this.resourcePollMs = deps.resourcePollMs ?? 2000;
    this.promptIdleMs = deps.promptIdleMs ?? 45_000;
  }

  get shell(): NodeShell {
    return this.deps.shell;
  }

  isBusy(containerId: number): boolean {
    return this.active.has(containerId);
  }

  /** ID of the run in progress in a container (null = none), so its live log can be shown. */
  activeRunId(containerId: number): number | null {
    return this.activeRuns.get(containerId) ?? null;
  }

  /**
   * A run in progress in this process with its output after `cursor` (see {@link LiveOutput});
   * null when the run is not running here (read it from the store).
   */
  liveRun(runId: number, cursor: string | null): { run: Run; output: LiveOutput } | null {
    const log = this.logs.get(runId);
    return log ? { run: { ...log.run }, output: log.read(cursor) } : null;
  }

  /** Waits for all running tasks (used on shutdown and in tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.active.values()]);
  }

  /** Connects to the node and returns `pveversion` output. */
  async testConnection(): Promise<string> {
    const result = await this.deps.shell.run('pveversion 2>/dev/null || uname -a', { timeoutMs: NODE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(describeSshFailure(result));
    }
    return result.output.trim();
  }

  /** Host name of the node (`hostname`). */
  async nodeHostname(): Promise<string> {
    const result = await this.deps.shell.run('hostname', { timeoutMs: NODE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(describeSshFailure(result));
    }
    return firstLine(result.output) ?? 'Proxmox host';
  }

  /** Lists containers on the node (`pct list`). */
  async discover(): Promise<DiscoveredContainer[]> {
    const result = await this.deps.shell.run('pct list', { timeoutMs: NODE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(describeSshFailure(result));
    }
    return parsePctList(result.output);
  }

  /**
   * Finds applications in a running container (community-scripts traces and version files) together with their
   * GitHub repository. Only reads – nothing is saved; the UI adds the suggestions the user confirms.
   */
  async detectApps(container: Container): Promise<DetectedApp[]> {
    if (container.kind === 'node') {
      throw new DetectionUnavailableError('Applications can be detected in containers only, not on the Proxmox host.');
    }
    const token = newCheckToken();
    const steps: CheckStep[] = [{ id: 'detect', script: DETECT_SCRIPT, timeoutSeconds: DETECT_TIMEOUT_SECONDS }];
    const result = await this.deps.shell.run(buildCheckScript(container.vmid, steps, token), {
      timeoutMs: NODE_TIMEOUT_MS + DETECT_TIMEOUT_SECONDS * 1000,
    });
    const batch = parseCheckOutput(result.output, token);
    if (!batch.status) {
      throw new Error(describeSshFailure(result));
    }
    const status = batch.status.exitCode === 0 ? parsePctStatus(batch.status.output) : null;
    if (status !== 'running') {
      throw new DetectionUnavailableError(
        `${targetLabel(container)} is ${status ?? 'in an unknown state'} – start it to detect its applications.`,
      );
    }
    const step = batch.steps.get('detect');
    if (step?.exitCode !== 0) {
      throw new Error(`Detecting applications failed: ${describeStep(step)}`);
    }
    const probe = parseDetectOutput(step.output);
    const names = probe.scriptSlug ? [probe.scriptSlug] : probe.versionFiles.map((f) => f.appName);
    const resolved = new Map<string, { repository: string | null; name: string | null }>();
    for (const name of names) {
      resolved.set(name, await this.resolveApp(name, name === probe.scriptSlug));
    }
    return detectedApps(probe, (name) => resolved.get(name) ?? { repository: null, name: null });
  }

  /** Repository and display name of an application: the built-in list first, then its community-scripts script. */
  private async resolveApp(name: string, isScript: boolean): Promise<{ repository: string | null; name: string | null }> {
    const known = KNOWN_APPS.get(normalizeAppName(name));
    if (known) {
      return known;
    }
    if (!isScript) {
      return { repository: null, name: null };
    }
    try {
      const script = await (this.deps.fetchAppScript ?? fetchCommunityScript)(name);
      return script ? { repository: repositoryFromScript(script), name: appNameFromScript(script) } : { repository: null, name: null };
    } catch (error) {
      this.deps.log.warn({ err: error, slug: name }, 'Downloading the community-scripts script failed');
      return { repository: null, name: null };
    }
  }

  /** Starts a check in the background; returns the created run. */
  startCheck(container: Container, trigger: RunTrigger): Run {
    return this.start(container, null, 'check', trigger, async (log) => {
      // Without the option a stopped container is detected by the batched check itself (no extra connection).
      const started = container.startWhenStopped ? await this.prepare(container, log, false) : false;
      try {
        const errors = await this.check(container, log, true);
        return { ok: errors === 0, exitCode: null };
      } finally {
        if (started) await this.shutDownAgain(container, log);
      }
    });
  }

  /** @param backupStorage back up to this storage first (null = no backup; always null for the host) */
  startAptUpgrade(container: Container, backupStorage: string | null): Run {
    if (container.kind === 'node') {
      return this.start(container, null, 'apt-upgrade', 'manual', async (log) => {
        log.note('apt-get update && apt-get dist-upgrade on the Proxmox host (no backup – vzdump backs up guests only)');
        const result = await this.execDetached(log, 'update', NODE_APT_UPGRADE_SCRIPT, {
          timeoutMs: APT_UPGRADE_TIMEOUT_MS,
          startedContainer: false,
        });
        return this.finishUpdate(container, log, result);
      });
    }
    return this.start(container, null, 'apt-upgrade', 'manual', (log) =>
      this.whileRunning(container, log, async (startedContainer) => {
        await this.backupFirst(container, backupStorage, log, 'apt upgrade', startedContainer);
        const result = await this.withUpdateResources(container, log, () => {
          log.note(`apt-get update && apt-get upgrade in CT ${container.vmid}`);
          return this.execDetached(log, 'update', pctExec(container.vmid, APT_UPGRADE_SCRIPT), {
            timeoutMs: APT_UPGRADE_TIMEOUT_MS,
            startedContainer,
          });
        });
        return this.finishUpdate(container, log, result);
      }),
    );
  }

  /** @param backupStorage back up to this storage first (null = no backup) */
  startAppUpdate(container: Container, app: ContainerApp, backupStorage: string | null): Run {
    if (!app.updateCommand) {
      throw new Error(`No update command is configured for ${app.name}.`);
    }
    const command = app.updateCommand;
    return this.start(container, app.id, 'app-update', 'manual', (log) =>
      this.whileRunning(container, log, async (startedContainer) => {
        await this.backupFirst(container, backupStorage, log, `update of ${app.name}`, startedContainer);
        const result = await this.withUpdateResources(container, log, () => {
          log.note(`Updating ${app.name}: ${command}`);
          return this.execDetached(log, 'update', pctExec(container.vmid, appUpdateScript(command)), {
            timeoutMs: app.timeoutSeconds * 1000,
            tty: app.useTty,
            startedContainer,
          });
        });
        return this.finishUpdate(container, log, result);
      }),
    );
  }

  /**
   * Re-attaches to updates that were still running on the node (detached) when the previous process stopped, and
   * restores resources left raised. Runs without a detached step are marked as failed by the store on startup.
   */
  async recover(): Promise<void> {
    const { containers, shell } = this.deps;
    const resumable = containers.listResumableRuns();
    if (!shell.isConfigured) {
      if (resumable.length > 0) containers.failInterruptedRuns(true);
      return;
    }
    for (const { run, resume } of resumable) {
      const container = containers.get(run.containerId);
      if (!container || this.active.has(container.id)) {
        const log = new RunLog(containers, run, run.output);
        log.note('ReleaseWatcher was restarted while this was running');
        log.finish(false, null);
        continue;
      }
      this.track(container, run, new RunLog(containers, run, run.output), async (log) => {
        log.note('ReleaseWatcher was restarted – re-attaching to the command still running on the node');
        try {
          const result = await this.follow(log, resume.unit, resume.timeoutSeconds * 1000);
          if (resume.step === 'backup') {
            log.note(
              result.exitCode === 0
                ? 'The backup finished, but the update was not started because ReleaseWatcher was restarted – start it again.'
                : `Backup failed – update not started. ${describeSshFailure(result)}`,
            );
            return { ok: false, exitCode: result.exitCode };
          }
          return await this.finishUpdate(container, log, result);
        } finally {
          await this.restoreResources(container, log);
          if (resume.startedContainer) await this.shutDownAgain(container, log);
        }
      });
    }
    for (const container of containers.list()) {
      if (container.resourcesToRestore && !this.active.has(container.id)) {
        await this.restoreResources(container, null);
      }
    }
  }

  /**
   * Runs `task` as a tracked run. The returned run is already persisted with status "running";
   * the task continues in the background and finishes the run.
   */
  private start(
    container: Container,
    appId: number | null,
    kind: RunKind,
    trigger: RunTrigger,
    task: (log: RunLog) => Promise<TaskResult>,
  ): Run {
    if (this.active.has(container.id)) {
      throw new ContainerBusyError(container.vmid);
    }
    const store = this.deps.containers;
    const run = store.startRun(container.id, appId, kind, trigger);
    this.track(container, run, new RunLog(store, run), task);
    return { ...run };
  }

  /** Runs `task` in the background for an existing run and finishes the run with its result. */
  private track(container: Container, run: Run, log: RunLog, task: (log: RunLog) => Promise<TaskResult>): void {
    const promise = (async () => {
      let finished: Run;
      try {
        const result = await task(log);
        finished = log.finish(result.ok, result.exitCode);
      } catch (error) {
        log.note(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        this.deps.log.warn({ err: error, vmid: container.vmid, kind: run.kind }, 'Container task failed');
        finished = log.finish(false, null);
      } finally {
        this.active.delete(container.id);
        this.activeRuns.delete(container.id);
        this.logs.delete(run.id);
      }
      // After the container is free again: sending can take a few seconds (SMTP).
      try {
        await this.notifyUpdateResult(container, finished);
      } catch (error) {
        this.deps.log.error({ err: error, vmid: container.vmid }, 'Sending the update result failed');
      }
      return finished;
    })();
    this.active.set(container.id, promise);
    this.activeRuns.set(container.id, run.id);
    this.logs.set(run.id, log);
    this.latest.set(container.id, promise);
  }

  /** Reports a finished update (checks are reported by {@link notifyNewUpdates}). */
  private async notifyUpdateResult(container: Container, run: Run): Promise<void> {
    if (run.kind === 'check') {
      return;
    }
    const app = run.appId === null ? null : this.deps.containers.getApp(container.id, run.appId);
    await this.deps.dispatcher.dispatchUpdateResult({
      vmid: container.vmid,
      isNode: container.kind === 'node',
      containerName: container.name,
      kind: run.kind,
      appName: app?.name ?? null,
      succeeded: run.status === 'succeeded',
      detail: lastNote(run.output, run.status === 'succeeded'),
    });
  }

  /** Waits for the most recent task of a container (tests, scheduler). */
  async wait(containerId: number): Promise<Run | null> {
    return (await this.latest.get(containerId)) ?? null;
  }

  /**
   * Runs a long node command (backup, upgrade, update) detached from the SSH connection (a transient systemd unit)
   * and streams its output into the run log. The step is recorded on the run, so a restarted ReleaseWatcher can
   * re-attach to it ({@link recover}).
   */
  private async execDetached(
    log: RunLog,
    step: DetachedStep,
    command: string,
    options: { timeoutMs: number; tty?: boolean; startedContainer: boolean },
  ): Promise<CommandResult> {
    const unit = detachedUnit(log.run.id, step);
    const timeoutSeconds = Math.ceil(options.timeoutMs / 1000);
    const start = await this.deps.shell.run(
      detachedStartCommand(unit, command, { tty: options.tty ?? false, timeoutSeconds }),
      { timeoutMs: NODE_TIMEOUT_MS },
    );
    if (start.exitCode !== 0) {
      return { ...start, output: `Could not start the command on the node. ${start.output}`.trim() };
    }
    this.deps.containers.setRunResume(log.run.id, { unit, step, timeoutSeconds, startedContainer: options.startedContainer });
    try {
      return await this.follow(log, unit, options.timeoutMs);
    } finally {
      this.deps.containers.setRunResume(log.run.id, null);
    }
  }

  /**
   * Streams the output of a detached unit until it finishes. When the SSH connection drops, it reconnects and reads
   * the output again from the start (replacing the partial copy) – the command itself keeps running on the node.
   */
  private async follow(log: RunLog, unit: string, timeoutMs: number): Promise<CommandResult> {
    const { shell } = this.deps;
    const mark = log.mark();
    const deadline = Date.now() + timeoutMs + FOLLOW_GRACE_MS;
    let stopped: PromptStop | null = null;
    for (let attempt = 0; ; attempt++) {
      const token = newCheckToken();
      log.truncate(mark);
      const watch = this.watchForPrompt(unit, (stop) => (stopped ??= stop));
      let result: CommandResult;
      try {
        result = await shell.run(detachedFollowCommand(unit, token), {
          timeoutMs: Math.max(1000, deadline - Date.now()),
          onOutput: (chunk) => {
            watch.output(chunk);
            log.write(chunk);
          },
        });
      } finally {
        watch.dispose();
      }
      const parsed = parseDetachedOutput(result.output, token);
      if (parsed.state !== 'incomplete') {
        log.truncate(mark);
        log.write(parsed.output);
        if (attempt > 0) {
          log.note(`The connection to the node dropped ${attempt}× – the command kept running and its output was read again`);
        }
        if (stopped && parsed.state !== 'missing') {
          const { prompt, idleSeconds }: PromptStop = stopped;
          await shell.run(detachedCleanupCommand(unit), { timeoutMs: NODE_TIMEOUT_MS }).catch(() => undefined);
          return {
            exitCode: -1,
            output:
              `The command stopped at ${prompt} and waited ${idleSeconds} s for input, so it was cancelled – ` +
              'updates cannot answer prompts. Use a non-interactive update command (community-scripts read ' +
              'PHS_SILENT=1, which ReleaseWatcher sets for every application update).',
            timedOut: false,
          };
        }
        if (parsed.state === 'missing') {
          return { exitCode: -1, output: 'The command output on the node is gone (was the node restarted?).', timedOut: false };
        }
        await shell.run(detachedCleanupCommand(unit), { timeoutMs: NODE_TIMEOUT_MS }).catch(() => undefined);
        return parsed.state === 'finished'
          ? { exitCode: parsed.exitCode ?? -1, output: parsed.output, timedOut: false }
          : { exitCode: -1, output: parsed.output, timedOut: true };
      }
      if (Date.now() >= deadline) {
        return { exitCode: -1, output: parsed.output, timedOut: true };
      }
      this.deps.log.warn({ unit, attempt: attempt + 1, exitCode: result.exitCode }, 'Lost the connection to a running command – reconnecting');
      await Bun.sleep(this.reconnectDelayMs);
    }
  }

  /**
   * Watches the output of a detached command: when it ends at an interactive prompt and nothing new arrives for
   * `promptIdleMs`, the unit is stopped on the node (the follow connection then ends) and `onStop` is called once.
   */
  private watchForPrompt(unit: string, onStop: (stop: PromptStop) => void): { output: (chunk: string) => void; dispose: () => void } {
    let tail = '';
    let lastOutputAt = Date.now();
    let stopping = false;
    const timer = setInterval(
      () => {
        const idleMs = Date.now() - lastOutputAt;
        if (stopping || idleMs < this.promptIdleMs) return;
        const prompt = detectInteractivePrompt(tail);
        if (!prompt) return;
        stopping = true;
        onStop({ prompt, idleSeconds: Math.round(idleMs / 1000) });
        this.deps.log.warn({ unit, prompt }, 'Command is waiting for input – stopping it');
        this.deps.shell.run(detachedStopCommand(unit), { timeoutMs: NODE_TIMEOUT_MS }).catch(() => undefined);
      },
      Math.max(10, Math.min(5000, Math.floor(this.promptIdleMs / 4))),
    );
    return {
      output: (chunk) => {
        tail = (tail + chunk).slice(-PROMPT_TAIL_LENGTH);
        lastOutputAt = Date.now();
      },
      dispose: () => clearInterval(timer),
    };
  }

  /** Raises CPU/memory for an update when configured and restores the previous values afterwards. */
  private async withUpdateResources(container: Container, log: RunLog, update: () => Promise<CommandResult>): Promise<CommandResult> {
    await this.raiseResources(container, log);
    try {
      return await update();
    } finally {
      await this.restoreResources(container, log);
    }
  }

  private async raiseResources(container: Container, log: RunLog): Promise<void> {
    if (container.kind === 'node' || (container.updateCores === null && container.updateMemoryMb === null)) {
      return;
    }
    const { shell, containers } = this.deps;
    const config = await shell.run(`pct config ${container.vmid}`, { timeoutMs: NODE_TIMEOUT_MS });
    if (config.exitCode !== 0) {
      throw new Error(`Reading the container configuration failed – ${describeSshFailure(config)}`);
    }
    const plan = planResourceRaise(parsePctResources(config.output), {
      cores: container.updateCores,
      memoryMb: container.updateMemoryMb,
    });
    if (!plan) {
      log.note('CPU and memory are already at least the values configured for updates');
      return;
    }
    // Saved before the change: if ReleaseWatcher stops now, the next start restores them.
    containers.setResourcesToRestore(container, plan.restore);
    log.note(`Raising resources for the update: ${describeResources(plan.raise)}`);
    const result = await shell.run(pctSetResourcesCommand(container.vmid, plan.raise), {
      timeoutMs: NODE_TIMEOUT_MS,
      onOutput: (chunk) => log.write(chunk),
    });
    if (result.exitCode !== 0) {
      containers.setResourcesToRestore(container, null);
      throw new Error(`Raising the resources failed – update not started. ${describeSshFailure(result)}`);
    }
    if (typeof plan.raise.cores === 'number') {
      await this.waitForCores(container, plan.raise.cores, log);
    }
  }

  /**
   * Waits until the container sees `cores` CPUs: `pct set --cores` changes the cpuset of a running container only
   * when pvestatd rebalances it, and update scripts (community-scripts) refuse to run on too few `nproc`.
   */
  private async waitForCores(container: Container, cores: number, log: RunLog): Promise<void> {
    let seen: number | null = null;
    for (let attempt = 0; attempt < CORES_POLL_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await Bun.sleep(this.resourcePollMs);
      }
      const result = await this.deps.shell.run(`pct exec ${container.vmid} -- nproc`, { timeoutMs: NODE_TIMEOUT_MS });
      const count = Number.parseInt(result.output.trim(), 10);
      if (result.exitCode !== 0 || !Number.isInteger(count)) {
        return; // stopped container or no nproc: nothing to wait for
      }
      seen = count;
      if (count >= cores) {
        if (attempt > 0) {
          log.note(`CT ${container.vmid} now sees ${count} CPU cores`);
        }
        return;
      }
      if (attempt === 0) {
        log.note(`Waiting for Proxmox to apply the CPU cores (CT ${container.vmid} sees ${count})…`);
      }
    }
    log.note(`CT ${container.vmid} still sees ${seen} CPU cores – starting the update anyway`);
  }

  /** Restores resources raised for an update; on failure they stay recorded and are restored on the next start. */
  private async restoreResources(container: Container, log: RunLog | null): Promise<void> {
    const restore = this.deps.containers.get(container.id)?.resourcesToRestore ?? null;
    if (!restore) {
      return;
    }
    log?.note(`Restoring resources: ${describeResources(restore)}`);
    const result = await this.deps.shell.run(pctSetResourcesCommand(container.vmid, restore), {
      timeoutMs: NODE_TIMEOUT_MS,
      ...(log ? { onOutput: (chunk: string) => log.write(chunk) } : {}),
    });
    if (result.exitCode !== 0) {
      log?.note(`Restoring the resources failed – ${describeSshFailure(result)}. ReleaseWatcher retries on its next start.`);
      this.deps.log.warn({ vmid: container.vmid }, 'Restoring container resources after an update failed');
      return;
    }
    this.deps.containers.setResourcesToRestore(container, null);
    if (!log) {
      this.deps.log.info({ vmid: container.vmid, restored: restore }, 'Restored container resources left raised by an update');
    }
  }

  /** Logs the result of an update command and refreshes the container state afterwards. */
  private async finishUpdate(container: Container, log: RunLog, result: CommandResult): Promise<TaskResult> {
    const ok = result.exitCode === 0;
    log.note(ok ? 'Update finished successfully' : `Update failed – ${describeSshFailure(result)}`);
    log.note('Refreshing pending updates');
    // No notification: the user is looking at the result right now.
    await this.check(container, log, false);
    return { ok, exitCode: result.exitCode };
  }

  /** Lists storages on the node that accept backups. */
  async backupStorages(): Promise<BackupStorage[]> {
    const result = await this.deps.shell.run('pvesm status --content backup', { timeoutMs: NODE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(describeSshFailure(result));
    }
    return parsePvesmStatus(result.output);
  }

  /** Runs an update while the container runs: started first when allowed, shut down again afterwards. */
  private async whileRunning(
    container: Container,
    log: RunLog,
    task: (startedContainer: boolean) => Promise<TaskResult>,
  ): Promise<TaskResult> {
    const started = await this.prepare(container, log, true);
    try {
      return await task(started);
    } finally {
      if (started) await this.shutDownAgain(container, log);
    }
  }

  /**
   * Reads the live status (commands cannot run in a stopped container) and starts a stopped container when its
   * settings allow it. Returns true when it was started here and must be shut down again.
   * @param required throw when the container does not run afterwards (updates); checks report it themselves
   */
  private async prepare(container: Container, log: RunLog, required: boolean): Promise<boolean> {
    const result = await this.deps.shell.run(`pct status ${container.vmid}`, { timeoutMs: NODE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(`pct status failed – ${describeSshFailure(result)}`);
    }
    const status = parsePctStatus(result.output);
    this.saveStatus(container, status);
    if (status === 'running') {
      log.note(`CT ${container.vmid} is running`);
      return false;
    }
    if (status === 'stopped' && container.startWhenStopped) {
      log.note(`CT ${container.vmid} is stopped – starting it for this task (it is shut down again afterwards)`);
      const start = await this.deps.shell.run(startContainerCommand(container.vmid), {
        timeoutMs: NODE_TIMEOUT_MS + START_NETWORK_WAIT_SECONDS * 1000,
        onOutput: (chunk) => log.write(chunk),
      });
      if (start.exitCode !== 0) {
        throw new Error(`Starting CT ${container.vmid} failed – ${describeSshFailure(start)}`);
      }
      this.saveStatus(container, 'running');
      log.note(`CT ${container.vmid} started`);
      return true;
    }
    if (required) {
      throw new Error(
        `CT ${container.vmid} is ${status ?? 'in an unknown state'} – start it, then run the update again` +
          (status === 'stopped' ? ' (or let ReleaseWatcher start it temporarily in the container settings).' : '.'),
      );
    }
    return false;
  }

  /** Shuts down a container that was started for a task; a failure is logged, the task result stays. */
  private async shutDownAgain(container: Container, log: RunLog): Promise<void> {
    log.note(`Shutting CT ${container.vmid} down again`);
    const result = await this.deps.shell.run(shutdownContainerCommand(container.vmid), {
      timeoutMs: NODE_TIMEOUT_MS + SHUTDOWN_TIMEOUT_SECONDS * 1000,
      onOutput: (chunk) => log.write(chunk),
    });
    if (result.exitCode !== 0) {
      log.note(`Shutdown failed – ${describeSshFailure(result)}. The container is still running.`);
      this.deps.log.warn({ vmid: container.vmid }, 'Shutting down a temporarily started container failed');
      return;
    }
    this.saveStatus(container, 'stopped');
    log.note(`CT ${container.vmid} stopped`);
  }

  private saveStatus(container: Container, status: string | null): void {
    if (status !== container.status) {
      container.status = status;
      this.deps.containers.save(container);
    }
  }

  /** Backs the container up with vzdump; a failed backup aborts the update. */
  private async backupFirst(
    container: Container,
    storage: string | null,
    log: RunLog,
    reason: string,
    startedContainer: boolean,
  ): Promise<void> {
    if (!storage) {
      log.note('No backup before this update');
      return;
    }
    log.note(`Backing up CT ${container.vmid} to storage "${storage}" (vzdump)`);
    const result = await this.execDetached(
      log,
      'backup',
      vzdumpCommand(container.vmid, storage, `ReleaseWatcher: before ${reason} (${this.now().toISOString()})`),
      { timeoutMs: BACKUP_TIMEOUT_MS, startedContainer },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Backup failed – update not started. ${describeSshFailure(result)}`);
    }
    log.note('Backup finished');
  }

  /**
   * Reads container status, pending apt packages and app versions. Never throws for container-level
   * problems – they are stored in `lastError`. Notifies about newly pending updates when `notify` is set.
   */
  private async check(container: Container, log: RunLog, notify: boolean): Promise<number> {
    const { containers } = this.deps;
    const errors: string[] = [];
    const apps = containers.listApps(container.id);

    // Everything is read with one SSH connection and one `pct exec` (see buildCheckScript).
    const steps: CheckStep[] = [];
    if (container.aptEnabled) {
      steps.push({ id: 'apt', script: APT_CHECK_SCRIPT, timeoutSeconds: APT_CHECK_TIMEOUT_SECONDS });
    }
    for (const app of apps) {
      if (app.versionCommand) {
        steps.push({ id: `v${app.id}`, script: app.versionCommand, timeoutSeconds: CHECK_TIMEOUT_SECONDS });
      }
      if (app.latestSource === 'command' && app.latestCommand) {
        steps.push({ id: `l${app.id}`, script: app.latestCommand, timeoutSeconds: CHECK_TIMEOUT_SECONDS });
      }
    }
    const token = newCheckToken();
    const totalSeconds = steps.reduce((sum, step) => sum + step.timeoutSeconds, 0);

    log.note(`Checking ${targetLabel(container)} (${container.name})`);
    const target = container.kind === 'node' ? null : container.vmid;
    const result = await this.deps.shell.run(buildCheckScript(target, steps, token), {
      timeoutMs: NODE_TIMEOUT_MS + totalSeconds * 1000,
    });
    const batch = parseCheckOutput(result.output, token);
    if (!batch.status) {
      throw new Error(describeSshFailure(result));
    }
    if (batch.status.exitCode !== 0) {
      throw new Error(`pct status failed: ${batch.status.output.trim() || `exit code ${batch.status.exitCode}`}`);
    }
    container.status = parsePctStatus(batch.status.output);
    log.note(`Status: ${container.status ?? 'unknown'}`);

    const stopped = container.status === 'stopped';
    if (stopped) {
      // Not an error: a stopped container is skipped, never started. Results of the last check are kept.
      log.note('Container is stopped – apt and application checks skipped (it is not started automatically)');
    } else if (container.status !== 'running') {
      errors.push(`Container is ${container.status ?? 'in an unknown state'} – start it to check for updates.`);
    } else {
      if (container.aptEnabled) {
        const apt = batch.steps.get('apt');
        if (apt?.exitCode === 0) {
          container.aptUpgradable = parseAptUpgradable(apt.output);
          log.note(`apt: ${container.aptUpgradable.length} upgradable package(s)`);
          for (const pkg of container.aptUpgradable) {
            log.write(`   ${pkg.name} ${pkg.currentVersion ?? '?'} → ${pkg.newVersion}\n`);
          }
        } else {
          errors.push(`apt: ${describeStep(apt)}`);
          log.note(`apt check failed: ${describeStep(apt)}`);
        }
      } else {
        container.aptUpgradable = [];
      }

      for (const app of apps) {
        this.applyAppResults(app, batch.steps, log);
        if (app.error) {
          errors.push(`${app.name}: ${app.error}`);
        }
      }
    }

    container.lastCheckedAt = this.now().toISOString();
    container.lastError = errors.length > 0 ? errors.join('\n').slice(0, 2000) : null;

    if (notify && !stopped) {
      await this.notifyNewUpdates(container, apps, log);
    }
    containers.save(container);
    return errors.length;
  }

  private applyAppResults(app: ContainerApp, results: ReadonlyMap<string, StepResult>, log: RunLog): void {
    const errors: string[] = [];
    if (app.versionCommand) {
      const result = results.get(`v${app.id}`);
      const version = result?.exitCode === 0 ? firstLine(result.output) : null;
      if (version) {
        app.installedVersion = version;
      } else {
        errors.push(`version command: ${result?.exitCode === 0 ? 'printed nothing' : describeStep(result)}`);
      }
    }

    switch (app.latestSource) {
      case 'github': {
        const repo = app.repositoryId === null ? null : this.deps.repositories.get(app.repositoryId);
        if (!repo) {
          errors.push('the linked GitHub repository is no longer watched');
        } else {
          app.latestVersion = repo.lastSeenTag;
        }
        break;
      }
      case 'command': {
        if (!app.latestCommand) {
          errors.push('no command for the latest version');
          break;
        }
        const result = results.get(`l${app.id}`);
        const version = result?.exitCode === 0 ? firstLine(result.output) : null;
        if (version) {
          app.latestVersion = version;
        } else {
          errors.push(`latest-version command: ${result?.exitCode === 0 ? 'printed nothing' : describeStep(result)}`);
        }
        break;
      }
      case 'none':
        app.latestVersion = null;
        break;
    }

    app.error = errors.length > 0 ? errors.join('; ').slice(0, 1000) : null;
    app.checkedAt = this.now().toISOString();
    this.deps.containers.saveApp(app);

    const update = appUpdateAvailable(app);
    log.note(
      `${app.name}: installed ${app.installedVersion ?? '?'}, latest ${app.latestVersion ?? '?'}` +
        (update ? ' → update available' : '') +
        (app.error ? ` (error: ${app.error})` : ''),
    );
  }

  /** Sends a notification when something pending was not part of the previous notification. */
  private async notifyNewUpdates(container: Container, apps: readonly ContainerApp[], log: RunLog): Promise<void> {
    const signature = pendingSignature(container, apps);
    const previous = new Set(container.notifiedSignature?.split('|') ?? []);
    const hasNew = signature !== null && signature.split('|').some((item) => !previous.has(item));
    container.notifiedSignature = signature;
    if (!hasNew) {
      return;
    }
    const result = await this.deps.dispatcher.dispatchContainerUpdates({
      vmid: container.vmid,
      isNode: container.kind === 'node',
      containerName: container.name,
      aptPackages: container.aptUpgradable,
      apps: apps
        .filter((a) => appUpdateAvailable(a))
        .map((a) => ({ name: a.name, installedVersion: a.installedVersion, latestVersion: a.latestVersion })),
    });
    if (result.queued) {
      log.note('Notification queued for the summary of this check run');
    } else if (result.sent.length > 0) {
      log.note(`Notification sent (${result.sent.join(', ')})`);
    }
  }
}

/** Explains a failed check step (missing = the batch was cut off, 124 = `timeout` fired). */
function describeStep(result: StepResult | undefined): string {
  if (!result) {
    return 'did not run (the check was cut off – connection lost or overall timeout)';
  }
  if (result.exitCode === 124) {
    return 'timed out';
  }
  const text = result.output.trim();
  return text ? `exit code ${result.exitCode}: ${text.slice(-500)}` : `exit code ${result.exitCode}`;
}

/** The status line explaining a failed update ("Update failed – exit code 1", "Backup failed – …"); null when it succeeded. */
function lastNote(output: string, succeeded: boolean): string | null {
  if (succeeded) {
    return null;
  }
  const notes = output
    .split('\n')
    .filter((line) => line.startsWith('» '))
    .map((line) => line.slice(2).trim());
  const reason = notes.findLast((line) => /\bfail/i.test(line) || /\bcancel|\bstopped at\b|timed out/i.test(line));
  return (reason ?? notes.at(-1) ?? null)?.slice(0, 500) ?? null;
}
