import type { Config } from '../config.ts';
import type { SettingsService } from '../settings.ts';
import { DiscordNotifier } from './discord.ts';
import { EmailNotifier, parseRecipients } from './email.ts';
import type { Notifier } from './notifier.ts';

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
