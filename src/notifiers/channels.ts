import type { SettingKey } from '../settings.ts';

/**
 * The settings of the push channels, per channel (Settings → Notifications). Discord and e-mail have their own,
 * richer settings DTOs; these channels share one generic shape (`channels` in the settings DTO).
 */
export const CHANNEL_SETTINGS = {
  ntfy: ['ntfyUrl', 'ntfyTopic', 'ntfyToken'],
  gotify: ['gotifyUrl', 'gotifyToken'],
  telegram: ['telegramBotToken', 'telegramChatId'],
  slack: ['slackWebhookUrl'],
  pushover: ['pushoverUserKey', 'pushoverAppToken'],
  // The headers are sent separately (names only) as `channels.webhook.headers`.
  webhook: ['webhookUrl', 'webhookMethod'],
} as const satisfies Record<string, readonly SettingKey[]>;

export type ChannelName = keyof typeof CHANNEL_SETTINGS;
export const CHANNEL_NAMES = Object.keys(CHANNEL_SETTINGS) as ChannelName[];

/** Characters left visible at the start of a masked secret (URLs show their host, tokens only the end). */
export const MASK_VISIBLE_START: Partial<Record<SettingKey, number>> = {
  slackWebhookUrl: 34,
  webhookUrl: 16,
};
