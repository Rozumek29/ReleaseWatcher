import type { Logger } from '../log.ts';
import {
  type ContainerUpdatesNotification,
  type NotificationEvent,
  notificationFullName,
  type Notifier,
  type ReleaseNotification,
  type UpdateResultNotification,
  type VulnerabilityNotification,
} from './notifier.ts';

/** Which kinds of notifications are sent (Settings → Notifications). */
export interface NotificationPreferences {
  /** Collect the notifications of one check run and send them as one summary. */
  digest: boolean;
  releases: boolean;
  /** New security advisories of watched repositories. */
  vulnerabilities: boolean;
  appUpdates: boolean;
  aptUpdates: boolean;
  updateSucceeded: boolean;
  updateFailed: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  digest: false,
  releases: true,
  vulnerabilities: true,
  appUpdates: true,
  aptUpdates: true,
  updateSucceeded: false,
  updateFailed: false,
};

export interface DispatchResult {
  sent: string[];
  failed: string[];
  /** Held back for the digest of the running check (sent when the run ends). */
  queued?: boolean;
  /** Not sent because this kind of notification is switched off. */
  skipped?: boolean;
}

/**
 * Fans a notification out to all enabled notifiers.
 * A failure in one channel does not prevent delivery to the others.
 *
 * Checks of many repositories/containers run inside {@link batch}. In digest mode, notifications raised while a batch is
 * open are collected and sent as one summary per channel when the last open batch ends.
 */
export class NotificationDispatcher {
  readonly notifiers: readonly Notifier[];
  private readonly log: Pick<Logger, 'info' | 'error'>;
  private readonly preferences: () => NotificationPreferences;
  private openBatches = 0;
  private queue: NotificationEvent[] = [];

  constructor(
    notifiers: readonly Notifier[],
    log: Pick<Logger, 'info' | 'error'>,
    preferences: () => NotificationPreferences = () => DEFAULT_NOTIFICATION_PREFERENCES,
  ) {
    this.notifiers = notifiers;
    this.log = log;
    this.preferences = preferences;
  }

  /** New release of a watched repository. */
  dispatch(notification: ReleaseNotification): Promise<DispatchResult> {
    if (!this.preferences().releases) {
      return Promise.resolve(skipped());
    }
    return this.send({ type: 'release', release: notification });
  }

  /** New security advisory of a watched repository. */
  dispatchVulnerability(notification: VulnerabilityNotification): Promise<DispatchResult> {
    if (!this.preferences().vulnerabilities) {
      return Promise.resolve(skipped());
    }
    return this.send({ type: 'vulnerability', vulnerability: notification });
  }

  /** Pending updates in a container; apt packages and applications are left out when switched off. */
  dispatchContainerUpdates(notification: ContainerUpdatesNotification): Promise<DispatchResult> {
    const preferences = this.preferences();
    const filtered: ContainerUpdatesNotification = {
      ...notification,
      apps: preferences.appUpdates ? notification.apps : [],
      aptPackages: preferences.aptUpdates ? notification.aptPackages : [],
    };
    if (filtered.apps.length === 0 && filtered.aptPackages.length === 0) {
      return Promise.resolve(skipped());
    }
    return this.send({ type: 'container-updates', updates: filtered });
  }

  /** Result of an update started from the UI. */
  dispatchUpdateResult(notification: UpdateResultNotification): Promise<DispatchResult> {
    const preferences = this.preferences();
    if (!(notification.succeeded ? preferences.updateSucceeded : preferences.updateFailed)) {
      return Promise.resolve(skipped());
    }
    return this.send({ type: 'update-result', result: notification });
  }

  /** Sends a sample release to the enabled notifiers (all, or only `name`) – ignores the preferences and digest mode. */
  test(notification: ReleaseNotification, name?: string): Promise<DispatchResult> {
    return this.deliver([{ type: 'release', release: notification }], name);
  }

  /**
   * Runs `task` as one check run: in digest mode its notifications are collected and sent together when it (and any
   * batch running at the same time) ends. Notifications held back are lost if the process stops before that.
   */
  async batch<T>(task: () => Promise<T>): Promise<T> {
    this.openBatches++;
    try {
      return await task();
    } finally {
      this.openBatches--;
      if (this.openBatches === 0) {
        await this.flush();
      }
    }
  }

  private async send(event: NotificationEvent): Promise<DispatchResult> {
    if (this.openBatches > 0 && this.preferences().digest) {
      this.queue.push(event);
      return { sent: [], failed: [], queued: true };
    }
    return this.deliver([event]);
  }

  private async flush(): Promise<void> {
    const events = this.queue;
    this.queue = [];
    if (events.length > 0) {
      await this.deliver(events);
    }
  }

  /** One event goes out as a normal message, several as one digest. */
  private async deliver(events: readonly NotificationEvent[], only?: string): Promise<DispatchResult> {
    const sent: string[] = [];
    const failed: string[] = [];
    const context = describe(events);
    for (const notifier of this.notifiers.filter((n) => n.isEnabled && (only === undefined || n.name === only))) {
      try {
        await sendTo(notifier, events);
        sent.push(notifier.name);
        this.log.info({ ...context, notifier: notifier.name }, 'Notification sent');
      } catch (error) {
        failed.push(notifier.name);
        this.log.error({ err: error, ...context, notifier: notifier.name }, 'Notifier failed');
      }
    }
    return { sent, failed };
  }
}

const skipped = (): DispatchResult => ({ sent: [], failed: [], skipped: true });

function sendTo(notifier: Notifier, events: readonly NotificationEvent[]): Promise<void> {
  const [event] = events;
  if (events.length !== 1 || !event) {
    return notifier.notifyDigest(events);
  }
  switch (event.type) {
    case 'release':
      return notifier.notify(event.release);
    case 'vulnerability':
      return notifier.notifyVulnerability(event.vulnerability);
    case 'container-updates':
      return notifier.notifyContainerUpdates(event.updates);
    case 'update-result':
      return notifier.notifyUpdateResult(event.result);
  }
}

/** Log fields of a delivery. */
function describe(events: readonly NotificationEvent[]): Record<string, unknown> {
  const [event] = events;
  if (events.length !== 1 || !event) {
    return { digest: events.length };
  }
  switch (event.type) {
    case 'release':
      return { repo: notificationFullName(event.release), tag: event.release.release.tag };
    case 'vulnerability':
      return { repo: notificationFullName(event.vulnerability), advisory: event.vulnerability.advisory.id };
    case 'container-updates':
      return { vmid: event.updates.vmid };
    case 'update-result':
      return { vmid: event.result.vmid, kind: event.result.kind, succeeded: event.result.succeeded };
  }
}
