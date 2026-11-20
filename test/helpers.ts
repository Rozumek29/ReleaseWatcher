import type { ReleaseInfo } from '../src/domain.ts';
import type { ReleaseFetchResult, ReleaseSource } from '../src/github.ts';
import { shQuote } from '../src/proxmox/domain.ts';
import type { CommandResult, NodeShell, RunOptions } from '../src/proxmox/ssh.ts';
import type {
  ContainerUpdatesNotification,
  NotificationEvent,
  Notifier,
  ReleaseNotification,
  UpdateResultNotification,
} from '../src/notifiers/notifier.ts';

export const silentLog = { info() {}, warn() {}, error() {} };

export function release(tag: string, day: number, isPrerelease = false): ReleaseInfo {
  return {
    tag,
    name: null,
    htmlUrl: `https://github.com/acme/widget/releases/${tag}`,
    body: 'notes',
    isPrerelease,
    publishedAt: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
    authorLogin: 'bob',
    authorAvatarUrl: null,
  };
}

export const dayIso = (day: number): string => new Date(Date.UTC(2026, 0, 1 + day)).toISOString();

export class FakeSource implements ReleaseSource {
  releases: ReleaseInfo[] = [];
  notModified = false;
  error: Error | null = null;
  existing = new Set(['acme/widget']);
  calls = 0;
  /** Repositories visible only with a specific token (full name → token). */
  privateRepos = new Map<string, string>();
  /** Token passed with the last call (null/undefined = global token). */
  lastToken: string | null | undefined;

  async repositoryExists(owner: string, name: string, token?: string | null): Promise<boolean> {
    this.lastToken = token;
    const fullName = `${owner}/${name}`.toLowerCase();
    const required = this.privateRepos.get(fullName);
    return required !== undefined ? token === required : this.existing.has(fullName);
  }

  async getRecentReleases(_owner: string, _name: string, etag: string | null, token?: string | null): Promise<ReleaseFetchResult> {
    this.calls++;
    this.lastToken = token;
    if (this.error) {
      throw this.error;
    }
    return this.notModified
      ? { releases: [], etag, notModified: true }
      : { releases: this.releases, etag: '"etag"', notModified: false };
  }
}

export class RecordingNotifier implements Notifier {
  readonly name = 'recording';
  isEnabled = true;
  fail = false;
  readonly sent: ReleaseNotification[] = [];
  readonly containerSent: ContainerUpdatesNotification[] = [];
  readonly resultsSent: UpdateResultNotification[] = [];
  readonly digests: NotificationEvent[][] = [];

  async notify(notification: ReleaseNotification): Promise<void> {
    if (this.fail) {
      throw new Error('boom');
    }
    this.sent.push(notification);
  }

  async notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void> {
    if (this.fail) {
      throw new Error('boom');
    }
    this.containerSent.push(notification);
  }

  async notifyUpdateResult(notification: UpdateResultNotification): Promise<void> {
    if (this.fail) {
      throw new Error('boom');
    }
    this.resultsSent.push(notification);
  }

  async notifyDigest(events: readonly NotificationEvent[]): Promise<void> {
    if (this.fail) {
      throw new Error('boom');
    }
    this.digests.push([...events]);
  }
}

/** Fake Proxmox node: answers commands matching registered patterns (first match wins). */
/** Output of `qm guest exec` for a command that printed `output` and exited with `exitCode`. */
export const guestJson = (output: string, exitCode: number): string =>
  JSON.stringify({ exitcode: exitCode, exited: 1, 'out-data': output, 'out-truncated': 0 }, null, 3);

export class FakeShell implements NodeShell {
  isConfigured = true;
  readonly commands: string[] = [];
  /** Number of `run()` calls – each one is an SSH connection in production. */
  connections = 0;
  /**
   * Detached commands (`systemd-run` units) started on the fake node: the inner command is answered (and recorded in
   * {@link commands}) when the unit starts; following it returns that answer.
   */
  readonly units = new Map<string, CommandResult>();
  /** Inner commands of detached units, with their options (tty). */
  readonly detached: { unit: string; command: string; tty: boolean }[] = [];
  /** The next N follow connections drop (exit 255) after printing part of the output. */
  dropFollows = 0;
  /**
   * Detached units keep running after printing their output (like a script waiting for input) until they are
   * stopped with `detachedStopCommand`; following them then ends without an exit code.
   */
  hangUntilStopped = false;
  /** `qm guest exec` fails like a virtual machine without a running QEMU guest agent. */
  guestAgentDown = false;
  /** Units stopped with `detachedStopCommand`. */
  readonly stoppedUnits: string[] = [];
  private readonly stopWaiters = new Map<string, () => void>();
  private readonly handlers: [RegExp, Partial<CommandResult> | ((command: string) => Partial<CommandResult> | Promise<Partial<CommandResult>>)][] =
    [];

  on(
    pattern: RegExp,
    result: Partial<CommandResult> | ((command: string) => Partial<CommandResult> | Promise<Partial<CommandResult>>),
  ): this {
    this.handlers.unshift([pattern, result]);
    return this;
  }

  async run(command: string, options: RunOptions): Promise<CommandResult> {
    this.connections++;
    const detached = await this.runDetachedProtocol(command, options);
    if (detached) {
      if (detached.output) options.onOutput?.(detached.output.slice(detached.streamed ?? 0));
      return { exitCode: detached.exitCode, output: detached.output, timedOut: detached.timedOut };
    }
    const token = command.match(/@@RW-[0-9a-f]+@@/)?.[0];
    const result = token ? await this.runCheckBatch(command, token) : await this.answer(command);
    if (result.output) {
      options.onOutput?.(result.output);
    }
    return result;
  }

  /** Emulates `detachedStartCommand`, `detachedFollowCommand` and `detachedCleanupCommand`. */
  private async runDetachedProtocol(
    command: string,
    options: RunOptions,
  ): Promise<(CommandResult & { streamed?: number }) | null> {
    const header = command.match(/^# releasewatcher (detached|follow|cleanup|stop) (\S+)/);
    if (!header) {
      return null;
    }
    const [, action, unit] = header as unknown as [string, string, string];
    const ok = (output = ''): CommandResult => ({ exitCode: 0, output, timedOut: false });
    if (action === 'detached') {
      const encoded = [...command.matchAll(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/g)].map((m) => m[1]!);
      const inner = Buffer.from(encoded[0]!, 'base64').toString('utf8');
      const wrapper = Buffer.from(encoded[1]!, 'base64').toString('utf8');
      this.detached.push({ unit, command: inner, tty: wrapper.startsWith('script ') });
      this.units.set(unit, await this.answer(inner));
      return ok();
    }
    if (action === 'cleanup') {
      this.units.delete(unit);
      return ok();
    }
    if (action === 'stop') {
      this.stoppedUnits.push(unit);
      this.stopWaiters.get(unit)?.();
      return ok();
    }
    const token = command.match(/@@RW-[0-9a-f]+@@/)![0];
    const result = this.units.get(unit);
    if (!result) {
      return ok(`\n${token} missing\n`);
    }
    if (this.dropFollows > 0) {
      this.dropFollows--;
      const partial = `${result.output.slice(0, 5)}\nclient_loop: send disconnect: Broken pipe\n`;
      return { exitCode: 255, output: partial, timedOut: false };
    }
    if (this.hangUntilStopped && !this.stoppedUnits.includes(unit)) {
      options.onOutput?.(result.output);
      await new Promise<void>((resolve) => this.stopWaiters.set(unit, resolve));
      // The output was streamed already – run() passes on only the end marker.
      return { exitCode: 0, output: `${result.output}\n${token} exit lost\n`, timedOut: false, streamed: result.output.length };
    }
    return ok(`${result.output}\n${token} exit ${result.exitCode}\n`);
  }

  /** Answers one command; every answered command is recorded in {@link commands}. */
  private async answer(command: string): Promise<CommandResult> {
    this.commands.push(command);
    const handler = this.handlers.find(([pattern]) => pattern.test(command))?.[1];
    const partial = typeof handler === 'function' ? await handler(command) : (handler ?? { exitCode: 127, output: 'command not found' });
    return { exitCode: 0, output: '', timedOut: false, ...partial };
  }

  /**
   * Emulates the batched check script (`buildCheckScript`): answers `pct status <vmid>` and – for a running
   * container – every step as `pct exec <vmid> -- sh -lc '<step>'`, so handlers can match single commands.
   * A script for the node itself (no `pct status`) answers every step as the plain command.
   */
  private async runCheckBatch(command: string, token: string): Promise<CommandResult> {
    const target = command.match(/(pct|qm) status (\d+)/);
    const cli = target?.[1] ?? 'pct';
    const vmid = target ? Number(target[2]) : null;
    const status =
      vmid === null
        ? { exitCode: 0, output: 'status: running', timedOut: false }
        : await this.answer(`${cli} status ${vmid}`);
    if (status.exitCode === 255) {
      return status; // connection failure: no sections at all
    }
    const section = (id: string, text: string, exitCode: number) =>
      [`${token} begin ${id}`, text, `${token} end ${id} ${exitCode}`, ''].join('\n');
    let output = section('status', status.output.replace(/\n+$/, ''), status.exitCode);
    const encoded = command.match(/printf %s '([A-Za-z0-9+/=]+)' \| base64 -d/)?.[1];
    if (encoded && status.output.includes('status: running')) {
      if (cli === 'qm' && this.guestAgentDown) {
        return { exitCode: 0, output: `${output}QEMU guest agent is not running\n`, timedOut: false };
      }
      const inner = Buffer.from(encoded, 'base64').toString('utf8');
      let steps = '';
      // Steps are single-quoted with shQuote (a quote inside is written as '\'').
      for (const match of inner.matchAll(/^rw_step (\S+) \d+ ('(?:[^']|'\\'')*')/gm)) {
        const script = match[2]!.slice(1, -1).replaceAll("'\\''", "'");
        const exec = cli === 'qm' ? `qm guest exec ${vmid} -- sh -lc` : `pct exec ${vmid} -- sh -lc`;
        const result = await this.answer(vmid === null ? script : `${exec} ${shQuote(script)}`);
        steps += section(match[1]!, result.output, result.exitCode);
      }
      // A virtual machine answers through the guest agent: the steps arrive as JSON.
      output += cli === 'qm' ? `${guestJson(steps, 0)}\n` : steps;
    }
    return { exitCode: 0, output, timedOut: false };
  }
}

/**
 * Output of `HA_CHECK_SCRIPT` on a Home Assistant OS host (shaped like a real one): the Mosquitto app has an update
 * (shown by the Supervisor and mirrored by its `hassio` update entity) and the marketplace integration Dahua has one.
 */
export const HAOS_PROBE_OUTPUT = [
  'haos',
  'core {"result":"ok","data":{"version":"2026.11.2","version_latest":"2026.11.2","update_available":false,"port":443,"ssl":true}}',
  'os {"result":"ok","data":{"version":"18.4","version_latest":"18.4","update_available":false,"board":"ova"}}',
  'supervisor {"result":"ok","data":{"version":"2026.11.0","version_latest":"2026.11.0","update_available":false,"addons":[' +
    '{"name":"Mosquitto broker","slug":"core_mosquitto","version":"7.1.3","version_latest":"7.2.0","update_available":true,"state":"started"},' +
    '{"name":"Zigbee2MQTT","slug":"45df7312_zigbee2mqtt","version":"2.14.3-1","version_latest":"2.14.3-1","update_available":false}]}}',
  'entities [{"id":"update.mosquitto_broker_update","name":"Mosquitto broker","installed":"7.1.3","latest":"7.2.0","url":null},' +
    '{"id":"update.dahua_update","name":"Dahua","installed":"3.0.0","latest":"3.1.0","url":"https://github.com/rroller/dahua/releases/tag/3.1.0","features":23},' +
    '{"id":"update.frigate_server","name":"Frigate Server","installed":"0.18.0","latest":"0.18.3","url":null,"features":0}]',
  'registry [["update.mosquitto_broker_update","hassio"],["update.dahua_update","marketplace"],["update.frigate_server","frigate"]]',
  'saved 1795180744',
].join('\n');

/** An update entity as returned by `GET /api/states` of Home Assistant. */
export const haState = (
  entityId: string,
  state: 'on' | 'off',
  installed: string,
  latest: string,
  title: string | null = null,
  supportedFeatures = 23,
) => ({
  entity_id: entityId,
  state,
  attributes: {
    installed_version: installed,
    latest_version: latest,
    in_progress: false,
    release_url: null,
    title,
    friendly_name: `${entityId} friendly`,
    supported_features: supportedFeatures,
  },
});
