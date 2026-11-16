import { ownerAvatarUrl } from '../domain.ts';
import {
  type ContainerUpdatesNotification,
  notificationFullName,
  notificationRepoUrl,
  type Notifier,
  type ReleaseNotification,
} from './notifier.ts';

export interface DiscordOptions {
  /** Channel webhook URL (Channel settings → Integrations → Webhooks). Null disables the notifier. */
  webhookUrl: string | null;
  username: string | null;
  avatarUrl: string | null;
  /** Optional text above the embed, e.g. "@here" or "<@&ROLE_ID>". */
  mention: string | null;
  maxBodyLength: number;
  /** Public address of ReleaseWatcher (`PUBLIC_URL`); container notifications link to its Containers page. */
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

  async notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void> {
    const options = this.getOptions();
    await this.post(options, buildContainerPayload(notification, options));
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
          icon_url: ownerAvatarUrl(notification.owner, 128),
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

const CONTAINER_COLOR = 0x3498db; // blue
const MAX_LISTED = 25;

export function buildContainerPayload(
  notification: ContainerUpdatesNotification,
  options: Pick<DiscordOptions, 'username' | 'avatarUrl' | 'mention' | 'maxBodyLength' | 'publicUrl'>,
) {
  // PUBLIC_URL is normalised to an origin (no trailing slash) by the config.
  const containersUrl = options.publicUrl ? `${options.publicUrl}/containers` : null;
  const lines: string[] = [];
  for (const app of notification.apps) {
    lines.push(`**${app.name}**: ${app.installedVersion ?? '?'} → ${app.latestVersion ?? '?'}`);
  }
  if (notification.aptPackages.length > 0) {
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push(`**apt** – ${notification.aptPackages.length} package(s):`);
    for (const pkg of notification.aptPackages.slice(0, MAX_LISTED)) {
      lines.push(`• ${pkg.name} ${pkg.currentVersion ? `${pkg.currentVersion} → ` : ''}${pkg.newVersion}`);
    }
    if (notification.aptPackages.length > MAX_LISTED) {
      lines.push(`… and ${notification.aptPackages.length - MAX_LISTED} more`);
    }
  }
  return {
    ...(options.mention ? { content: options.mention } : {}),
    ...(options.username ? { username: options.username } : {}),
    ...(options.avatarUrl ? { avatar_url: options.avatarUrl } : {}),
    embeds: [
      {
        title: truncate(
          `${notification.isNode ? 'Proxmox host' : `CT ${notification.vmid}`} (${notification.containerName}): updates available`,
          256,
        ),
        ...(containersUrl ? { url: containersUrl } : {}),
        description: truncate(lines.join('\n'), Math.max(options.maxBodyLength, 200)),
        color: CONTAINER_COLOR,
        timestamp: new Date().toISOString(),
      },
    ],
    // A link button below the embed (message components); see `withComponentsUrl()`.
    ...(containersUrl
      ? { components: [{ type: ACTION_ROW, components: [{ type: BUTTON, style: LINK_STYLE, label: 'Open containers', url: containersUrl }] }] }
      : {}),
  };
}

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
