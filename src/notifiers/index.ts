import type { Config } from '../config.ts';
import type { SettingsService } from '../settings.ts';
import { DiscordNotifier } from './discord.ts';
import { EmailNotifier, parseRecipients } from './email.ts';
import { GotifyNotifier } from './gotify.ts';
import type { Notifier } from './notifier.ts';
import { DEFAULT_NTFY_URL, NtfyNotifier } from './ntfy.ts';
import { PushoverNotifier } from './pushover.ts';
import { SlackNotifier } from './slack.ts';
import { TelegramNotifier } from './telegram.ts';
import { parseWebhookHeaders, WebhookNotifier } from './webhook.ts';

/** Registers all notification channels. Add new {@link Notifier} implementations here. */
export function createNotifiers(config: Config, settings: SettingsService): Notifier[] {
  return [
    new DiscordNotifier(() => {
      const current = settings.current;
      return {
        ...config.discord,
        publicUrl: config.publicUrl,
        webhookUrl: current.discordWebhookUrl,
        mention: current.discordMention,
        username: current.discordUsername,
      };
    }),
    new EmailNotifier(() => {
      const current = settings.current;
      return {
        server: current.smtpHost
          ? {
              host: current.smtpHost,
              port: current.smtpPort,
              security: current.smtpSecurity,
              username: current.smtpUsername,
              password: current.smtpPassword,
            }
          : null,
        from: current.emailFrom,
        to: recipients(current.emailTo),
        maxBodyLength: config.email.maxBodyLength,
        publicUrl: config.publicUrl,
      };
    }),
    new NtfyNotifier(() => {
      const current = settings.current;
      return { serverUrl: current.ntfyUrl ?? DEFAULT_NTFY_URL, topic: current.ntfyTopic, token: current.ntfyToken, publicUrl: config.publicUrl };
    }),
    new GotifyNotifier(() => {
      const current = settings.current;
      return { serverUrl: current.gotifyUrl, token: current.gotifyToken, publicUrl: config.publicUrl };
    }),
    new TelegramNotifier(() => {
      const current = settings.current;
      return { botToken: current.telegramBotToken, chatId: current.telegramChatId, publicUrl: config.publicUrl };
    }),
    new SlackNotifier(() => ({ webhookUrl: settings.current.slackWebhookUrl, publicUrl: config.publicUrl })),
    new PushoverNotifier(() => {
      const current = settings.current;
      return { userKey: current.pushoverUserKey, appToken: current.pushoverAppToken, publicUrl: config.publicUrl };
    }),
    new WebhookNotifier(() => {
      const current = settings.current;
      return {
        url: current.webhookUrl,
        method: current.webhookMethod ?? 'POST',
        headers: parseWebhookHeaders(current.webhookHeaders),
        publicUrl: config.publicUrl,
      };
    }),
  ];
}

/** Recipients of the setting; an invalid list from the environment disables e-mail instead of failing every send. */
function recipients(value: string | null): string[] {
  try {
    return value ? parseRecipients(value) : [];
  } catch {
    return [];
  }
}
