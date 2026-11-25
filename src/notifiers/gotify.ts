import { MARKDOWN, type MessageOptions, type MessagePriority, renderBody, type SimpleMessage } from './message.ts';
import { joinUrl, postWithRetry, SimpleNotifier } from './simple.ts';

export interface GotifyOptions extends MessageOptions {
  /** Gotify server, e.g. https://gotify.example.com; null disables the notifier. */
  serverUrl: string | null;
  /** Token of an application (Gotify → Apps → Create application). */
  token: string | null;
  fetch?: typeof fetch;
}

const MAX_BODY = 8000;
const PRIORITY: Record<MessagePriority, number> = { low: 2, normal: 5, high: 8 };

/** Sends notifications to a Gotify server as Markdown messages. */
export class GotifyNotifier extends SimpleNotifier<GotifyOptions> {
  readonly name = 'gotify';

  get isEnabled(): boolean {
    const options = this.getOptions();
    return !!options.serverUrl && !!options.token;
  }

  protected async send(message: SimpleMessage, options: GotifyOptions): Promise<void> {
    const post = (payload: ReturnType<typeof buildGotifyPayload>) =>
      postWithRetry(joinUrl(options.serverUrl!, '/message'), payload, {
        service: 'Gotify',
        headers: { 'X-Gotify-Key': options.token! },
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    const payload = buildGotifyPayload(message);
    try {
      await post(payload);
    } catch (error) {
      // Gotify on MySQL/MariaDB with a `utf8` (3-byte) table rejects emoji and other 4-byte characters
      // ("Error 1366: Incorrect string value"); send the message again without them.
      if (!isIncorrectStringError(error)) {
        throw error;
      }
      await post({
        ...payload,
        title: withoutFourByteCharacters(payload.title),
        message: withoutFourByteCharacters(payload.message),
      });
    }
  }
}

const isIncorrectStringError = (error: unknown): boolean =>
  error instanceof Error && /Incorrect string value/i.test(error.message);

/**
 * `text` without characters outside the Basic Multilingual Plane (emoji and the like, 4 bytes in UTF-8) and the
 * variation selectors / zero-width joiners that follow them.
 */
export const withoutFourByteCharacters = (text: string): string =>
  text.replace(/[\u{10000}-\u{10FFFF}][️‍]*/gu, '');

export function buildGotifyPayload(message: SimpleMessage) {
  return {
    title: message.title,
    message: renderBody(message, MARKDOWN, MAX_BODY) || message.title,
    priority: PRIORITY[message.priority],
    extras: {
      'client::display': { contentType: 'text/markdown' },
      ...(message.url ? { 'client::notification': { click: { url: message.url } } } : {}),
    },
  };
}
