import type { Logger } from '../log.ts';
import { notificationFullName, type Notifier, type ReleaseNotification } from './notifier.ts';

/**
 * Fans a notification out to all enabled notifiers.
 * A failure in one channel does not prevent delivery to the others.
 */
export class NotificationDispatcher {
  readonly notifiers: readonly Notifier[];
  private readonly log: Pick<Logger, 'info' | 'error'>;

  constructor(notifiers: readonly Notifier[], log: Pick<Logger, 'info' | 'error'>) {
    this.notifiers = notifiers;
    this.log = log;
  }

  /** Returns names of the notifiers that succeeded and failed. */
  async dispatch(notification: ReleaseNotification): Promise<{ sent: string[]; failed: string[] }> {
    const sent: string[] = [];
    const failed: string[] = [];
    const repo = notificationFullName(notification);

    for (const notifier of this.notifiers.filter((n) => n.isEnabled)) {
      try {
        await notifier.notify(notification);
        sent.push(notifier.name);
        this.log.info({ repo, tag: notification.release.tag, notifier: notifier.name }, 'Notification sent');
      } catch (error) {
        failed.push(notifier.name);
        this.log.error({ err: error, repo, tag: notification.release.tag, notifier: notifier.name }, 'Notifier failed');
      }
    }

    return { sent, failed };
  }
}
