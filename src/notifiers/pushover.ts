import { type MessageOptions, type MessagePriority, PUSHOVER_HTML, renderBody, type SimpleMessage, truncate } from './message.ts';
import { postWithRetry, SimpleNotifier } from './simple.ts';

export interface PushoverOptions extends MessageOptions {
  /** User (or group) key from the Pushover dashboard; null disables the notifier. */
  userKey: string | null;
  /** API token of an application created at pushover.net/apps/build. */
  appToken: string | null;
  /** Replaces https://api.pushover.net (tests). */
  apiBaseUrl?: string;
  fetch?: typeof fetch;
}

/** Pushover limits: message 1024, title 250, URL title 100 characters. */
const MAX_MESSAGE = 1024;
const MAX_TITLE = 250;
const PRIORITY: Record<MessagePriority, string> = { low: '-1', normal: '0', high: '1' };

/** Sends notifications through Pushover. */
export class PushoverNotifier extends SimpleNotifier<PushoverOptions> {
  readonly name = 'pushover';

  get isEnabled(): boolean {
    const options = this.getOptions();
    return !!options.userKey && !!options.appToken;
  }

  protected async send(message: SimpleMessage, options: PushoverOptions): Promise<void> {
    const base = options.apiBaseUrl ?? 'https://api.pushover.net';
    await postWithRetry(`${base}/1/messages.json`, buildPushoverForm(message, options), {
      service: 'Pushover',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
}

export function buildPushoverForm(message: SimpleMessage, options: Pick<PushoverOptions, 'userKey' | 'appToken'>): URLSearchParams {
  const form = new URLSearchParams({
    token: options.appToken ?? '',
    user: options.userKey ?? '',
    title: truncate(message.title, MAX_TITLE),
    // Pushover rejects an empty message.
    message: renderBody(message, PUSHOVER_HTML, MAX_MESSAGE) || PUSHOVER_HTML.escape(truncate(message.title, MAX_MESSAGE)),
    html: '1',
    priority: PRIORITY[message.priority],
  });
  if (message.url) {
    form.set('url', message.url);
    form.set('url_title', truncate(message.urlLabel ?? message.url, 100));
  }
  return form;
}
