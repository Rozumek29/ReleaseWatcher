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
  type BackupStorage,
  vzdumpCommand,
  pctExec,
  pendingSignature,
  type Run,
  type RunKind,
  type RunTrigger,
} from './domain.ts';
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

const NODE_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_SECONDS = 2 * 60;
const APT_CHECK_TIMEOUT_SECONDS = 5 * 60;
const APT_UPGRADE_TIMEOUT_MS = 60 * 60_000;
const BACKUP_TIMEOUT_MS = 4 * 60 * 60_000;
/** Output kept per run (the tail is preserved). */
const MAX_OUTPUT_LENGTH = 256 * 1024;
const OUTPUT_FLUSH_MS = 1000;

/** Collects the console output of a run and periodically writes it to the database. */
class RunLog {
  private text = '';
  private dirty = false;
  private timer: Timer | null = null;
  private readonly store: ContainerStore;
  readonly run: Run;

  constructor(store: ContainerStore, run: Run) {
    this.store = store;
    this.run = run;
  }

  /** Appends raw command output. */
  write(chunk: string): void {
    this.text += chunk;
    if (this.text.length > MAX_OUTPUT_LENGTH) {
      this.text = `[…output truncated…]\n${this.text.slice(-MAX_OUTPUT_LENGTH)}`;
    }
    this.dirty = true;
    this.timer ??= setTimeout(() => this.flush(), OUTPUT_FLUSH_MS);
  }

  /** Appends a status line written by ReleaseWatcher itself. */
  note(line: string): void {
    this.write(`${this.text && !this.text.endsWith('\n') ? '\n' : ''}» ${line}\n`);
  }

  get output(): string {
    return this.text;
  }

  private flush(): void {
    this.timer = null;
    if (this.dirty) {
      this.dirty = false;
      this.store.saveRunOutput(this.run.id, this.text);
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
      output: this.text,
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
}

/** Checks LXC containers for pending apt/application updates and runs updates on request. */
export class ContainerService {
  private readonly deps: ContainerServiceDeps;
  private readonly now: () => Date;
  /** Running task per container ID – at most one check/update per container at a time. */
  private readonly active = new Map<number, Promise<Run>>();
  /** Most recent task per container (kept after it finished, for {@link wait}). */
  private readonly latest = new Map<number, Promise<Run>>();

  constructor(deps: ContainerServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get shell(): NodeShell {
    return this.deps.shell;
  }

  isBusy(containerId: number): boolean {
    return this.active.has(containerId);
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

  /** Lists containers on the node (`pct list`). */
  async discover(): Promise<DiscoveredContainer[]> {
    const result = await this.deps.shell.run('pct list', { timeoutMs: NODE_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      throw new Error(describeSshFailure(result));
    }
    return parsePctList(result.output);
  }

  /** Starts a check in the background; returns the created run. */
  startCheck(container: Container, trigger: RunTrigger): Run {
    return this.start(container, null, 'check', trigger, async (log) => {
      const errors = await this.check(container, log, true);
      return { ok: errors === 0, exitCode: null };
    });
  }

  /** @param backupStorage back up to this storage first (null = no backup) */
  startAptUpgrade(container: Container, backupStorage: string | null): Run {
    return this.start(container, null, 'apt-upgrade', 'manual', async (log) => {
      await this.backupFirst(container, backupStorage, log, 'apt upgrade');
      log.note(`apt-get update && apt-get upgrade in CT ${container.vmid}`);
      const result = await this.exec(container.vmid, APT_UPGRADE_SCRIPT, log, { timeoutMs: APT_UPGRADE_TIMEOUT_MS });
      return this.finishUpdate(container, log, result);
    });
  }

  /** @param backupStorage back up to this storage first (null = no backup) */
  startAppUpdate(container: Container, app: ContainerApp, backupStorage: string | null): Run {
    if (!app.updateCommand) {
      throw new Error(`No update command is configured for ${app.name}.`);
    }
    const command = app.updateCommand;
    return this.start(container, app.id, 'app-update', 'manual', async (log) => {
      await this.backupFirst(container, backupStorage, log, `update of ${app.name}`);
      log.note(`Updating ${app.name}: ${command}`);
      const result = await this.exec(container.vmid, command, log, {
        timeoutMs: app.timeoutSeconds * 1000,
        tty: app.useTty,
      });
      return this.finishUpdate(container, log, result);
    });
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
    const log = new RunLog(store, run);

    const promise = (async () => {
      try {
        const result = await task(log);
        return log.finish(result.ok, result.exitCode);
      } catch (error) {
        log.note(`Failed: ${error instanceof Error ? error.message : String(error)}`);
        this.deps.log.warn({ err: error, vmid: container.vmid, kind }, 'Container task failed');
        return log.finish(false, null);
      } finally {
        this.active.delete(container.id);
      }
    })();
    this.active.set(container.id, promise);
    this.latest.set(container.id, promise);
    return { ...run };
  }

  /** Waits for the most recent task of a container (tests, scheduler). */
  async wait(containerId: number): Promise<Run | null> {
    return (await this.latest.get(containerId)) ?? null;
  }

  private exec(
    vmid: number,
    script: string,
    log: RunLog | null,
    options: { timeoutMs: number; tty?: boolean },
  ): Promise<CommandResult> {
    return this.deps.shell.run(pctExec(vmid, script), {
      timeoutMs: options.timeoutMs,
      tty: options.tty ?? false,
      ...(log ? { onOutput: (chunk: string) => log.write(chunk) } : {}),
    });
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

  /** Backs the container up with vzdump; a failed backup aborts the update. */
  private async backupFirst(container: Container, storage: string | null, log: RunLog, reason: string): Promise<void> {
    if (!storage) {
      log.note('No backup before this update');
      return;
    }
    log.note(`Backing up CT ${container.vmid} to storage "${storage}" (vzdump)`);
    const result = await this.deps.shell.run(
      vzdumpCommand(container.vmid, storage, `ReleaseWatcher: before ${reason} (${this.now().toISOString()})`),
      { timeoutMs: BACKUP_TIMEOUT_MS, onOutput: (chunk) => log.write(chunk) },
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

    log.note(`Checking CT ${container.vmid} (${container.name})`);
    const result = await this.deps.shell.run(buildCheckScript(container.vmid, steps, token), {
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

    if (container.status !== 'running') {
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

    if (notify) {
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
      containerName: container.name,
      aptPackages: container.aptUpgradable,
      apps: apps
        .filter((a) => appUpdateAvailable(a))
        .map((a) => ({ name: a.name, installedVersion: a.installedVersion, latestVersion: a.latestVersion })),
    });
    if (result.sent.length > 0) {
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
