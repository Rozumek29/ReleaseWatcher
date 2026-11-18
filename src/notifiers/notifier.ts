import type { ReleaseInfo } from '../domain.ts';

/** Payload passed to every notifier when a new release is detected. */
export interface ReleaseNotification {
  owner: string;
  repository: string;
  release: ReleaseInfo;
  /** Version currently running in the user's environment, when an installed-version URL is configured. */
  installedVersion?: string | null;
}

/** Pending updates found in a Proxmox LXC container. */
export interface ContainerUpdatesNotification {
  vmid: number;
  /** The Proxmox host itself rather than a container. */
  isNode?: boolean;
  containerName: string;
  /** Upgradable apt packages (all of them, not only new ones). */
  aptPackages: { name: string; currentVersion: string | null; newVersion: string }[];
  /** Applications with a newer version available. */
  apps: { name: string; installedVersion: string | null; latestVersion: string | null }[];
}

/** An update started from the UI (apt upgrade or application update) has finished. */
export interface UpdateResultNotification {
  vmid: number;
  isNode?: boolean;
  containerName: string;
  kind: 'apt-upgrade' | 'app-update';
  /** Application name for `app-update`. */
  appName: string | null;
  succeeded: boolean;
  /** Last line of the run log, e.g. "Update failed – exit code 1". */
  detail: string | null;
}

/** One notification of any kind, as collected for a digest. */
export type NotificationEvent =
  | { type: 'release'; release: ReleaseNotification }
  | { type: 'container-updates'; updates: ContainerUpdatesNotification }
  | { type: 'update-result'; result: UpdateResultNotification };

export const notificationFullName = (n: ReleaseNotification): string => `${n.owner}/${n.repository}`;
export const notificationRepoUrl = (n: ReleaseNotification): string =>
  `https://github.com/${n.owner}/${n.repository}`;

/** "CT 105 (nextcloud)" or "Proxmox host (pve)". */
export const targetName = (n: { vmid: number; isNode?: boolean; containerName: string }): string =>
  `${n.isNode ? 'Proxmox host' : `CT ${n.vmid}`} (${n.containerName})`;

/** "apt upgrade" or "update of Nextcloud". */
export const updateLabel = (n: UpdateResultNotification): string =>
  n.kind === 'app-update' ? `update of ${n.appName ?? 'the application'}` : 'apt upgrade';

/** Short heading of a digest, e.g. "2 new releases, 1 container with updates". */
export function digestSummary(events: readonly NotificationEvent[]): string {
  const count = (type: NotificationEvent['type']) => events.filter((e) => e.type === type).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const releases = count('release');
  const containers = count('container-updates');
  const results = events.filter((e): e is Extract<NotificationEvent, { type: 'update-result' }> => e.type === 'update-result');
  if (releases > 0) parts.push(plural(releases, 'new release', 'new releases'));
  if (containers > 0) parts.push(plural(containers, 'container with updates', 'containers with updates'));
  const ok = results.filter((e) => e.result.succeeded).length;
  const failed = results.length - ok;
  if (ok > 0) parts.push(plural(ok, 'update finished', 'updates finished'));
  if (failed > 0) parts.push(plural(failed, 'update failed', 'updates failed'));
  return parts.join(', ');
}

/**
 * A notification channel (Discord, e-mail, ...).
 * To add a channel implement this interface and register it in `notifiers/index.ts`.
 */
export interface Notifier {
  /** Unique, human readable channel name, e.g. "discord". */
  readonly name: string;
  /** False when the channel is not configured; it will be skipped. */
  readonly isEnabled: boolean;
  notify(notification: ReleaseNotification): Promise<void>;
  /** Reports updates waiting in an LXC container. */
  notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void>;
  /** Reports the result of an update started from the UI. */
  notifyUpdateResult(notification: UpdateResultNotification): Promise<void>;
  /** Sends several notifications as one summary message (digest mode, always at least two events). */
  notifyDigest(events: readonly NotificationEvent[]): Promise<void>;
}
