import { ownerAvatarUrl, rasterIconUrl } from '../domain.ts';
import {
  advisoryIds,
  affectedVersions,
  type ContainerUpdatesNotification,
  digestSummary,
  dockerContainersLine,
  dockerImageLine,
  type DockerUpdatesNotification,
  type NotificationEvent,
  notificationFullName,
  notificationRepoUrl,
  type Notifier,
  type ReleaseNotification,
  targetName,
  updateLabel,
  installedImpact,
  severityLabel,
  type UpdateResultNotification,
  type VulnerabilityNotification,
  packageGroups,
  packageLine,
} from './notifier.ts';

/** Author icon of a repository embed: its custom icon (Discord shows no SVG) or the owner's avatar. */
const repositoryIconUrl = (n: { owner: string; icon?: string | null }): string => rasterIconUrl(n.icon ?? null) ?? ownerAvatarUrl(n.owner, 128);

export interface DiscordOptions {
  /** Channel webhook URL (Channel settings → Integrations → Webhooks). Null disables the notifier. */
  webhookUrl: string | null;
  username: string | null;
  avatarUrl: string | null;
  /** Optional text above the embed, e.g. "@here" or "<@&ROLE_ID>". */
  mention: string | null;
  maxBodyLength: number;
  /** Public address of ReleaseWatcher (`PUBLIC_URL`); container notifications link to its Machines page. */
  publicUrl?: string | null;
  fetch?: typeof fetch;
}

const STABLE_COLOR = 0x2ecc71; // green
const PRERELEASE_COLOR = 0xf39c12; // orange
const MAX_ATTEMPTS = 3;

/** Posts release notifications to a Discord channel via an incoming webhook. */
export class DiscordNotifier implements Notifier {
  readonly name = 'discord';
  private readonly getOptions: () => DiscordOptions;

  /** Accepts a getter so settings changed in the UI apply without a restart. */
  constructor(options: DiscordOptions | (() => DiscordOptions)) {
    this.getOptions = typeof options === 'function' ? options : () => options;
  }

  get isEnabled(): boolean {
    return !!this.getOptions().webhookUrl;
  }

  async notify(notification: ReleaseNotification): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildDiscordPayload(notification, options));
  }

  async notifyVulnerability(notification: VulnerabilityNotification): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildVulnerabilityPayload(notification, options));
  }

  async notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildContainerPayload(notification, options));
  }

  async notifyUpdateResult(notification: UpdateResultNotification): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildUpdateResultPayload(notification, options));
  }

  async notifyDockerUpdates(notification: DockerUpdatesNotification): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildDockerPayload(notification, options));
  }

  async notifyDigest(events: readonly NotificationEvent[]): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildDigestPayload(events, options));
  }

  private async post(options: DiscordOptions, payload: object): Promise<void> {
    const fetchFn = options.fetch ?? globalThis.fetch;
    const body = JSON.stringify(payload);
    const url = 'components' in payload ? withComponentsUrl(options.webhookUrl!) : options.webhookUrl!;

    for (let attempt = 1; ; attempt++) {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ReleaseWatcher/1.0' },
        body,
        signal: AbortSignal.timeout(15_000),
      });

      if (response.ok) {
        return;
      }

      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * attempt);
        continue;
      }

      throw new Error(`Discord webhook returned ${response.status}: ${await response.text()}`);
    }
  }
}

export function buildDiscordPayload(notification: ReleaseNotification, options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention' | 'maxBodyLength'>) {
  const { release } = notification;
  const repo = notificationFullName(notification);
  const title = !release.name || release.name === release.tag
    ? `${repo} ${release.tag}`
    : `${repo} ${release.tag} — ${release.name}`;

  return {
    ...(options.mention ? { content: options.mention } : {}),
    ...(options.username ? { username: options.username } : {}),
    ...(options.avatarUrl ? { avatar_url: options.avatarUrl } : {}),
    embeds: [
      {
        title: truncate(title, 256),
        url: release.htmlUrl,
        ...(release.body?.trim() ? { description: truncate(release.body.trim(), options.maxBodyLength) } : {}),
        color: release.isPrerelease ? PRERELEASE_COLOR : STABLE_COLOR,
        timestamp: release.publishedAt,
        author: {
          name: repo,
          url: notificationRepoUrl(notification),
          icon_url: repositoryIconUrl(notification),
        },
        ...(release.authorLogin
          ? { footer: { text: `Released by ${release.authorLogin}`, ...(release.authorAvatarUrl ? { icon_url: release.authorAvatarUrl } : {}) } }
          : {}),
        fields: [
          { name: 'Tag', value: release.tag, inline: true },
          { name: 'Type', value: release.isPrerelease ? 'Pre-release' : 'Release', inline: true },
          ...(notification.installedVersion
            ? [{ name: 'Installed', value: `${notification.installedVersion} → ${release.tag}`, inline: true }]
            : []),
        ],
      },
    ],
  };
}

const SEVERITY_COLORS: Record<string, number> = {
  critical: 0x8b0000, // dark red
  high: 0xe74c3c, // red
  medium: 0xf39c12, // orange
  low: 0xf1c40f, // yellow
  unknown: 0x95a5a6, // grey
};

export function buildVulnerabilityPayload(
  notification: VulnerabilityNotification,
  options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention'>,
) {
  const { advisory } = notification;
  const repo = notificationFullName(notification);
  const impact = installedImpact(notification);
  const versions = affectedVersions(notification);
  return {
    ...messageHeader(options),
    embeds: [
      {
        title: truncate(`${repo}: ${advisory.summary}`, 256),
        url: advisory.htmlUrl,
        ...(versions ? { description: truncate(versions, 1000) } : {}),
        color: SEVERITY_COLORS[advisory.severity] ?? SEVERITY_COLORS['unknown'],
        timestamp: advisory.publishedAt,
        author: { name: repo, url: notificationRepoUrl(notification), icon_url: repositoryIconUrl(notification) },
        fields: [
          { name: 'Advisory', value: advisoryIds(notification), inline: true },
          {
            name: 'Severity',
            value: advisory.cvssScore !== null ? `${severityLabel(notification)} (${advisory.cvssScore.toFixed(1)})` : severityLabel(notification),
            inline: true,
          },
          ...(impact ? [{ name: 'Installed', value: impact, inline: true }] : []),
        ],
      },
    ],
  };
}

const CONTAINER_COLOR = 0x3498db; // blue
const MAX_LISTED = 25;

export function buildContainerPayload(
  notification: ContainerUpdatesNotification,
  options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention' | 'maxBodyLength' | 'publicUrl'>,
) {
  // PUBLIC_URL is normalised to an origin (no trailing slash) by the config.
  const containersUrl = options.publicUrl ? `${options.publicUrl}/machines` : null;
  const lines: string[] = [];
  for (const app of notification.apps) {
    lines.push(`**${app.name}**: ${app.installedVersion ?? '?'} → ${app.latestVersion ?? '?'}`);
  }
  for (const group of packageGroups(notification)) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(`**${group.name}**${group.title.slice(group.name.length)}:`);
    for (const pkg of group.packages.slice(0, MAX_LISTED)) {
      lines.push(`• ${packageLine(pkg)}`);
    }
    if (group.packages.length > MAX_LISTED) {
      lines.push(`… and ${group.packages.length - MAX_LISTED} more`);
    }
  }
  return {
    ...(options.mention ? { content: options.mention } : {}),
    ...(options.username ? { username: options.username } : {}),
    ...(options.avatarUrl ? { avatar_url: options.avatarUrl } : {}),
    embeds: [
      {
        title: truncate(`${targetName(notification)}: updates available`, 256),
        ...(containersUrl ? { url: containersUrl } : {}),
        description: truncate(lines.join('\n'), Math.max(options.maxBodyLength, 200)),
        color: CONTAINER_COLOR,
        timestamp: new Date().toISOString(),
      },
    ],
    // A link button below the embed (message components); see `withComponentsUrl()`.
    ...(containersUrl
      ? { components: [{ type: ACTION_ROW, components: [{ type: BUTTON, style: LINK_STYLE, label: 'Open machines', url: containersUrl }] }] }
      : {}),
  };
}

const SUCCESS_COLOR = 0x2ecc71; // green
const FAILURE_COLOR = 0xe74c3c; // red
const DIGEST_COLOR = 0x5865f2; // accent
/** Discord limit of an embed description. */
const MAX_DESCRIPTION = 4096;

export function buildUpdateResultPayload(
  notification: UpdateResultNotification,
  options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention' | 'publicUrl'>,
) {
  const containersUrl = options.publicUrl ? `${options.publicUrl}/machines` : null;
  return {
    ...messageHeader(options),
    embeds: [
      {
        title: truncate(`${targetName(notification)}: ${updateLabel(notification)} ${notification.succeeded ? 'finished' : 'failed'}`, 256),
        ...(containersUrl ? { url: containersUrl } : {}),
        ...(notification.detail ? { description: truncate(notification.detail, 1000) } : {}),
        color: notification.succeeded ? SUCCESS_COLOR : FAILURE_COLOR,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

const DOCKER_COLOR = 0x1d63ed; // Docker blue

export function buildDockerPayload(
  notification: DockerUpdatesNotification,
  options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention' | 'publicUrl'>,
) {
  const dockerUrl = options.publicUrl ? `${options.publicUrl}/docker` : null;
  const [only] = notification.images;
  const lines = notification.images.map((i) => `• **${dockerImageLine(i)}** – ${dockerContainersLine(i)}`);
  return {
    ...messageHeader(options),
    embeds: [
      {
        title: truncate(notification.images.length === 1 && only ? `New Docker image: ${only.image}` : `${notification.images.length} new Docker images`, 256),
        ...(dockerUrl ? { url: dockerUrl } : {}),
        description: truncate(lines.join('\n'), MAX_DESCRIPTION),
        color: DOCKER_COLOR,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/** Several notifications as one message: one embed with a section per kind. */
export function buildDigestPayload(
  events: readonly NotificationEvent[],
  options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention' | 'publicUrl'>,
) {
  const containersUrl = options.publicUrl ? `${options.publicUrl}/machines` : null;
  const releases: string[] = [];
  const vulnerabilities: string[] = [];
  const containers: string[] = [];
  const results: string[] = [];
  const images: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'release': {
        const { release } = event.release;
        const installed = event.release.installedVersion ? ` (installed ${event.release.installedVersion})` : '';
        releases.push(
          `• **${notificationFullName(event.release)}** [${release.tag}](${release.htmlUrl})${release.isPrerelease ? ' · pre-release' : ''}${installed}`,
        );
        break;
      }
      case 'vulnerability': {
        const v = event.vulnerability;
        const impact = installedImpact(v);
        vulnerabilities.push(
          `• **${notificationFullName(v)}** [${v.advisory.id}](${v.advisory.htmlUrl}) · ${severityLabel(v)} – ${v.advisory.summary}${impact ? ` (${impact.toLowerCase()})` : ''}`,
        );
        break;
      }
      case 'container-updates': {
        const { updates } = event;
        const parts = [
          ...updates.apps.map((a) => `${a.name} ${a.installedVersion ?? '?'} → ${a.latestVersion ?? '?'}`),
          ...packageGroups(updates).map((g) => g.summary),
        ];
        containers.push(`• **${targetName(updates)}**: ${parts.join(', ')}`);
        break;
      }
      case 'update-result':
        results.push(
          `• ${event.result.succeeded ? '✅' : '❌'} **${targetName(event.result)}**: ${updateLabel(event.result)} ${event.result.succeeded ? 'finished' : 'failed'}`,
        );
        break;
      case 'docker-updates':
        images.push(...event.docker.images.map((i) => `• **${dockerImageLine(i)}** – ${dockerContainersLine(i)}`));
        break;
    }
  }
  const blocks = [
    ...(releases.length > 0 ? [`**New releases**\n${releases.join('\n')}`] : []),
    ...(vulnerabilities.length > 0 ? [`**New vulnerabilities**\n${vulnerabilities.join('\n')}`] : []),
    ...(containers.length > 0 ? [`**Container updates**\n${containers.join('\n')}`] : []),
    ...(images.length > 0 ? [`**Docker images**\n${images.join('\n')}`] : []),
    ...(results.length > 0 ? [`**Finished updates**\n${results.join('\n')}`] : []),
  ];
  return {
    ...messageHeader(options),
    embeds: [
      {
        title: truncate(digestSummary(events), 256),
        ...(containersUrl && events.some(isContainerEvent) ? { url: containersUrl } : {}),
        description: truncate(blocks.join('\n\n'), MAX_DESCRIPTION),
        color: DIGEST_COLOR,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

const isContainerEvent = (e: NotificationEvent): boolean => e.type === 'container-updates' || e.type === 'update-result';

const messageHeader = (options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention'>) => ({
  ...(options.mention ? { content: options.mention } : {}),
  ...(options.username ? { username: options.username } : {}),
  ...(options.avatarUrl ? { avatar_url: options.avatarUrl } : {}),
});

const ACTION_ROW = 1;
const BUTTON = 2;
const LINK_STYLE = 5;

/**
 * Webhooks not owned by an application may only send (non-interactive) components such as link buttons
 * when `with_components=true` is set on the execute URL; otherwise Discord ignores them.
 */
export function withComponentsUrl(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  url.searchParams.set('with_components', 'true');
  return url.toString();
}

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
