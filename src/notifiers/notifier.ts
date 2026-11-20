import type { SecurityAdvisory } from '../advisories.ts';
import type { ReleaseInfo } from '../domain.ts';

/** Payload passed to every notifier when a new release is detected. */
export interface ReleaseNotification {
  owner: string;
  repository: string;
  release: ReleaseInfo;
  /** Version currently running in the user's environment, when an installed-version URL is configured. */
  installedVersion?: string | null;
}

/** A new security advisory was published for a watched repository. */
export interface VulnerabilityNotification {
  owner: string;
  repository: string;
  advisory: SecurityAdvisory;
  /** Version currently running, when an installed-version URL is configured. */
  installedVersion: string | null;
  /** True/false when the installed version could be compared with the vulnerable ranges, otherwise null. */
  affectsInstalled: boolean | null;
}

/** Pending updates found in a Proxmox LXC container. */
export interface ContainerUpdatesNotification {
  vmid: number;
  /** The Proxmox host itself rather than a container. */
  isNode?: boolean;
  /** A virtual machine rather than a container. */
  isVm?: boolean;
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
  isVm?: boolean;
  containerName: string;
  kind: 'apt-upgrade' | 'app-update' | 'home-assistant-update';
  /** Application name for `app-update` ("Home Assistant" for `home-assistant-update`). */
  appName: string | null;
  succeeded: boolean;
  /** Last line of the run log, e.g. "Update failed – exit code 1". */
  detail: string | null;
}

/** One notification of any kind, as collected for a digest. */
export type NotificationEvent =
  | { type: 'release'; release: ReleaseNotification }
  | { type: 'vulnerability'; vulnerability: VulnerabilityNotification }
  | { type: 'container-updates'; updates: ContainerUpdatesNotification }
  | { type: 'update-result'; result: UpdateResultNotification };

export const notificationFullName = (n: Pick<ReleaseNotification, 'owner' | 'repository'>): string => `${n.owner}/${n.repository}`;
export const notificationRepoUrl = (n: Pick<ReleaseNotification, 'owner' | 'repository'>): string =>
  `https://github.com/${n.owner}/${n.repository}`;

/** "CT 105 (nextcloud)", "VM 137 (debian)" or "Proxmox host (pve)". */
export const targetName = (n: { vmid: number; isNode?: boolean; isVm?: boolean; containerName: string }): string =>
  `${n.isNode ? 'Proxmox host' : n.isVm ? `VM ${n.vmid}` : `CT ${n.vmid}`} (${n.containerName})`;

/** "apt upgrade", "update of Nextcloud" or "update of Home Assistant". */
export const updateLabel = (n: UpdateResultNotification): string =>
  n.kind === 'apt-upgrade' ? 'apt upgrade' : `update of ${n.appName ?? 'the application'}`;

/** Short heading of a digest, e.g. "2 new releases, 1 container with updates". */
export function digestSummary(events: readonly NotificationEvent[]): string {
  const count = (type: NotificationEvent['type']) => events.filter((e) => e.type === type).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts: string[] = [];
  const releases = count('release');
  const vulnerabilities = count('vulnerability');
  const containers = count('container-updates');
  const results = events.filter((e): e is Extract<NotificationEvent, { type: 'update-result' }> => e.type === 'update-result');
  if (releases > 0) parts.push(plural(releases, 'new release', 'new releases'));
  if (vulnerabilities > 0) parts.push(plural(vulnerabilities, 'new vulnerability', 'new vulnerabilities'));
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
  /** Reports a new security advisory of a watched repository. */
  notifyVulnerability(notification: VulnerabilityNotification): Promise<void>;
  /** Reports updates waiting in an LXC container. */
  notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void>;
  /** Reports the result of an update started from the UI. */
  notifyUpdateResult(notification: UpdateResultNotification): Promise<void>;
  /** Sends several notifications as one summary message (digest mode, always at least two events). */
  notifyDigest(events: readonly NotificationEvent[]): Promise<void>;
}

/** "High", "Critical" … */
export const severityLabel = (n: VulnerabilityNotification): string =>
  n.advisory.severity === 'unknown' ? 'Unknown severity' : n.advisory.severity[0]!.toUpperCase() + n.advisory.severity.slice(1);

/** "GHSA-… / CVE-…" */
export const advisoryIds = (n: VulnerabilityNotification): string =>
  n.advisory.cveId ? `${n.advisory.id} / ${n.advisory.cveId}` : n.advisory.id;

/** Line about the installed version, e.g. "Installed 1.2.0 is affected", or null when no version is known. */
export function installedImpact(n: VulnerabilityNotification): string | null {
  if (!n.installedVersion) {
    return null;
  }
  return n.affectsInstalled === true
    ? `Installed ${n.installedVersion} is affected`
    : n.affectsInstalled === false
      ? `Installed ${n.installedVersion} is not affected`
      : `Installed ${n.installedVersion} – could not be compared`;
}

/** Vulnerable and patched versions, e.g. "Vulnerable: < 1.2.3 · Patched: 1.2.3". */
export function affectedVersions(n: VulnerabilityNotification): string | null {
  const parts = n.advisory.vulnerabilities.flatMap((v) => [
    ...(v.vulnerableRange ? [`Vulnerable: ${v.vulnerableRange}`] : []),
    `Patched: ${v.patchedVersions ?? 'no fix yet'}`,
  ]);
  return parts.length > 0 ? parts.join(' · ') : null;
}
