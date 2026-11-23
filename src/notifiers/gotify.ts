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
    await postWithRetry(joinUrl(options.serverUrl!, '/message'), buildGotifyPayload(message), {
      service: 'Gotify',
      headers: { 'X-Gotify-Key': options.token! },
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
}

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
