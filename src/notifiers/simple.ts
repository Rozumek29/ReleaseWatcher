import { buildMessage, type MessageOptions, type SimpleMessage } from './message.ts';
import type {
  ContainerUpdatesNotification,
  DockerUpdatesNotification,
  NotificationEvent,
  Notifier,
  ReleaseNotification,
  UpdateResultNotification,
  VulnerabilityNotification,
} from './notifier.ts';

/**
 * Base of the push channels that send every kind of notification as one {@link SimpleMessage}
 * (ntfy, Gotify, Telegram, Slack, Pushover, webhook). A channel implements `isEnabled` and `send()`.
 */
export abstract class SimpleNotifier<O extends MessageOptions> implements Notifier {
  abstract readonly name: string;
  protected readonly getOptions: () => O;

  /** Accepts a getter so settings changed in the UI apply without a restart. */
  constructor(options: O | (() => O)) {
    this.getOptions = typeof options === 'function' ? options : () => options;
  }

  abstract get isEnabled(): boolean;

  /** Delivers one message; `events` are the notifications it was built from (for channels that send data). */
  protected abstract send(message: SimpleMessage, options: O, events: readonly NotificationEvent[]): Promise<void>;

  notify(notification: ReleaseNotification): Promise<void> {
    return this.deliver([{ type: 'release', release: notification }]);
  }

  notifyVulnerability(notification: VulnerabilityNotification): Promise<void> {
    return this.deliver([{ type: 'vulnerability', vulnerability: notification }]);
  }

  notifyContainerUpdates(notification: ContainerUpdatesNotification): Promise<void> {
    return this.deliver([{ type: 'container-updates', updates: notification }]);
  }

  notifyUpdateResult(notification: UpdateResultNotification): Promise<void> {
    return this.deliver([{ type: 'update-result', result: notification }]);
  }

  notifyDockerUpdates(notification: DockerUpdatesNotification): Promise<void> {
    return this.deliver([{ type: 'docker-updates', docker: notification }]);
  }

  notifyDigest(events: readonly NotificationEvent[]): Promise<void> {
    return this.deliver(events);
  }

  private deliver(events: readonly NotificationEvent[]): Promise<void> {
    const options = this.getOptions();
    return this.send(buildMessage(events, options), options, events);
  }
}

export interface HttpRequestOptions {
  fetch?: typeof fetch;
  /** Name of the service in error messages, e.g. "ntfy". */
  service: string;
  headers?: Record<string, string>;
  /** Defaults to POST. */
  method?: string;
}

const MAX_ATTEMPTS = 3;

/**
 * Sends a body (POST unless `method` says otherwise; JSON for objects, as is for strings and form data) and retries a few times on 429 (honouring
 * Retry-After). Throws with the status and response text on any other error.
 */
export async function postWithRetry(url: string, body: object | string | URLSearchParams, options: HttpRequestOptions): Promise<void> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const isJson = typeof body === 'object' && !(body instanceof URLSearchParams);
  const headers = new Headers({ 'User-Agent': 'ReleaseWatcher/1.0', ...(isJson ? { 'Content-Type': 'application/json' } : {}) });
  // Custom headers replace the defaults whatever their case.
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  const payload = isJson ? JSON.stringify(body) : body;
  for (let attempt = 1; ; attempt++) {
    const response = await fetchFn(url, { method: options.method ?? 'POST', headers, body: payload, signal: AbortSignal.timeout(15_000) });
    if (response.ok) {
      return;
    }
    if (response.status === 429 && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(response.headers.get('retry-after'));
      await Bun.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 2000 * attempt);
      continue;
    }
    const text = (await response.text().catch(() => '')).slice(0, 300);
    throw new Error(`${options.service} returned ${response.status}${text ? `: ${text}` : ''}`);
  }
}

/** `base` without trailing slashes joined with `path`. */
export const joinUrl = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path}`;
