import { buildMessage, type MessageOptions, type MessagePriority, PLAIN_TEXT, renderBody, type SimpleMessage } from './message.ts';
import type { NotificationEvent } from './notifier.ts';
import { postWithRetry, SimpleNotifier } from './simple.ts';
import type { HttpHeader } from '../version.ts';

export const WEBHOOK_METHODS = ['POST', 'PUT', 'PATCH'] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

export interface WebhookOptions extends MessageOptions {
  /** Any URL that accepts JSON (n8n, Node-RED, Home Assistant, Apprise API …); null disables the notifier. */
  url: string | null;
  /** Defaults to POST. */
  method?: WebhookMethod;
  /** Extra request headers, e.g. `Authorization`; they may replace the default `Content-Type`. */
  headers?: readonly HttpHeader[];
  fetch?: typeof fetch;
}

/** The saved headers setting (JSON `[{ name, value }]`); invalid or empty = none. */
export function parseWebhookHeaders(value: string | null): HttpHeader[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((h): h is HttpHeader => typeof h?.name === 'string' && typeof h?.value === 'string')
      : [];
  } catch {
    return [];
  }
}

/** JSON body of a generic webhook call (documented on the wiki page *Notifications*). */
export interface WebhookPayload {
  source: 'releasewatcher';
  /** The kind of the single event, or `digest` for a summary of several. */
  type: NotificationEvent['type'] | 'digest';
  title: string;
  /** Plain text of the message. */
  message: string;
  url: string | null;
  priority: MessagePriority;
  /** The notifications themselves, for automations that need the data. */
  events: readonly NotificationEvent[];
}

const MAX_MESSAGE = 10_000;

/** Sends every notification as JSON (POST, PUT or PATCH) to a URL of the user's choice. */
export class WebhookNotifier extends SimpleNotifier<WebhookOptions> {
  readonly name = 'webhook';

  get isEnabled(): boolean {
    return !!this.getOptions().url;
  }

  protected async send(message: SimpleMessage, options: WebhookOptions, events: readonly NotificationEvent[]): Promise<void> {
    await postWithRetry(options.url!, buildWebhookPayload(events, message), {
      service: 'The webhook',
      method: options.method ?? 'POST',
      headers: Object.fromEntries((options.headers ?? []).map((h) => [h.name, h.value])),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
}

export function buildWebhookPayload(events: readonly NotificationEvent[], message: SimpleMessage = buildMessage(events)): WebhookPayload {
  const [only] = events;
  return {
    source: 'releasewatcher',
    type: events.length === 1 && only ? only.type : 'digest',
    title: message.title,
    message: renderBody({ ...message, url: null }, PLAIN_TEXT, MAX_MESSAGE),
    url: message.url,
    priority: message.priority,
    events,
  };
}
