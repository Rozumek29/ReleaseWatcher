import { MARKDOWN, type MessageOptions, type MessagePriority, renderBody, type SimpleMessage } from './message.ts';
import { postWithRetry, SimpleNotifier } from './simple.ts';

export interface NtfyOptions extends MessageOptions {
  /** Server, e.g. https://ntfy.sh or a self-hosted one. */
  serverUrl: string;
  /** Topic to publish to; null disables the notifier. */
  topic: string | null;
  /** Access token (`tk_…`) or `user:password`; null = anonymous. */
  token: string | null;
  fetch?: typeof fetch;
}

/** Public server used when no other one is set. */
export const DEFAULT_NTFY_URL = 'https://ntfy.sh';

/** ntfy shows longer messages as an attachment; stay well below its 4096-byte limit. */
const MAX_BODY = 3500;
const PRIORITY: Record<MessagePriority, number> = { low: 2, normal: 3, high: 4 };

/** Publishes notifications to an ntfy topic (https://ntfy.sh or self-hosted) as Markdown messages. */
export class NtfyNotifier extends SimpleNotifier<NtfyOptions> {
  readonly name = 'ntfy';

  get isEnabled(): boolean {
    const options = this.getOptions();
    return !!options.serverUrl && !!options.topic;
  }

  protected async send(message: SimpleMessage, options: NtfyOptions): Promise<void> {
    await postWithRetry(options.serverUrl.replace(/\/+$/, '') + '/', buildNtfyPayload(message, options), {
      service: 'ntfy',
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.token ? { headers: { Authorization: ntfyAuthorization(options.token) } } : {}),
    });
  }
}

/** JSON publish request (https://docs.ntfy.sh/publish/#publish-as-json). */
export function buildNtfyPayload(message: SimpleMessage, options: Pick<NtfyOptions, 'topic'>) {
  return {
    topic: options.topic,
    title: message.title,
    message: renderBody(message, MARKDOWN, MAX_BODY) || message.title,
    markdown: true,
    priority: PRIORITY[message.priority],
    tags: message.tags,
    ...(message.url ? { click: message.url } : {}),
    ...(message.url && message.urlLabel ? { actions: [{ action: 'view', label: message.urlLabel, url: message.url }] } : {}),
  };
}

/** An access token is sent as a bearer token, `user:password` as basic auth. */
export function ntfyAuthorization(token: string): string {
  return token.includes(':') && !token.startsWith('tk_') ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`;
}
