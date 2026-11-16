import { ownerAvatarUrl } from '../domain.ts';
import {
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
    const fetchFn = options.fetch ?? globalThis.fetch;
    const body = JSON.stringify(buildDiscordPayload(notification, options));

    for (let attempt = 1; ; attempt++) {
      const response = await fetchFn(options.webhookUrl!, {
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

const truncate = (value: string, max: number): string =>
  value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
