import { type MessageOptions, renderBody, type SimpleMessage, SLACK_MRKDWN } from './message.ts';
import { postWithRetry, SimpleNotifier } from './simple.ts';

export interface SlackOptions extends MessageOptions {
  /** Incoming webhook URL (Slack app → Incoming Webhooks); null disables the notifier. */
  webhookUrl: string | null;
  fetch?: typeof fetch;
}

const MAX_TEXT = 3500;

/** Posts notifications to a Slack channel through an incoming webhook (mrkdwn text). */
export class SlackNotifier extends SimpleNotifier<SlackOptions> {
  readonly name = 'slack';

  get isEnabled(): boolean {
    return !!this.getOptions().webhookUrl;
  }

  protected async send(message: SimpleMessage, options: SlackOptions): Promise<void> {
    await postWithRetry(options.webhookUrl!, buildSlackPayload(message), {
      service: 'Slack',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }
}

export function buildSlackPayload(message: SimpleMessage) {
  const title = SLACK_MRKDWN.bold(SLACK_MRKDWN.escape(message.title));
  const body = renderBody(message, SLACK_MRKDWN, MAX_TEXT - title.length);
  return { text: body ? `${title}\n${body}` : title, unfurl_links: false, unfurl_media: false };
}
