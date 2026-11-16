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
  containerName: string;
  /** Upgradable apt packages (all of them, not only new ones). */
  aptPackages: { name: string; currentVersion: string | null; newVersion: string }[];
  /** Applications with a newer version available. */
  apps: { name: string; installedVersion: string | null; latestVersion: string | null }[];
}

export const notificationFullName = (n: ReleaseNotification): string => `${n.owner}/${n.repository}`;
export const notificationRepoUrl = (n: ReleaseNotification): string =>
  `https://github.com/${n.owner}/${n.repository}`;

/**
 * A notification channel (Discord, Slack, e-mail, ...).
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
}
