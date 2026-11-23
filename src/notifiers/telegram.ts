import { type MessageOptions, renderBody, type SimpleMessage, TELEGRAM_HTML } from './message.ts';
import { postWithRetry, SimpleNotifier } from './simple.ts';

export interface TelegramOptions extends MessageOptions {
  /** Token from @BotFather; null disables the notifier. */
  botToken: string | null;
  /** Chat to post to: a user or group id (`-100…` for supergroups and channels) or `@channelname`. */
  chatId: string | null;
  /** Replaces https://api.telegram.org (tests). */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

/** Telegram's limit of a message text. */
const MAX_TEXT = 4096;

/** Sends notifications through a Telegram bot (HTML formatting). */
export class TelegramNotifier extends SimpleNotifier<TelegramOptions> {
  readonly name = 'telegram';

  get isEnabled(): boolean {
    const options = this.getOptions();
    return !!options.botToken && !!options.chatId;
  }

  protected async send(message: SimpleMessage, options: TelegramOptions): Promise<void> {
    const base = options.apiBaseUrl ?? 'https://api.telegram.org';
    await postWithRetry(`${base}/bot${options.botToken}/sendMessage`, buildTelegramPayload(message, options), {
      service: 'Telegram',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
}

export function buildTelegramPayload(message: SimpleMessage, options: Pick<TelegramOptions, 'chatId'>) {
  const title = `<b>${TELEGRAM_HTML.escape(message.title)}</b>`;
  const body = renderBody(message, TELEGRAM_HTML, MAX_TEXT - title.length - 100);
  return {
    chat_id: options.chatId,
    text: body ? `${title}\n\n${body}` : title,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(message.priority === 'low' ? { disable_notification: true } : {}),
  };
}
