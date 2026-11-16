import type { Config } from '../config.ts';
import type { SettingsService } from '../settings.ts';
import { DiscordNotifier } from './discord.ts';
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
  ];
}
