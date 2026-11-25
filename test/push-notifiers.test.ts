import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { GotifyNotifier } from '../src/notifiers/gotify.ts';
import { buildMessage, MARKDOWN, PLAIN_TEXT, renderBody, TELEGRAM_HTML } from '../src/notifiers/message.ts';
import type { NotificationEvent, ReleaseNotification } from '../src/notifiers/notifier.ts';
import { ntfyAuthorization, NtfyNotifier } from '../src/notifiers/ntfy.ts';
import { PushoverNotifier } from '../src/notifiers/pushover.ts';
import { SlackNotifier } from '../src/notifiers/slack.ts';
import { TelegramNotifier } from '../src/notifiers/telegram.ts';
import { WebhookNotifier } from '../src/notifiers/webhook.ts';
import { release } from './helpers.ts';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch that records requests and answers with the given statuses in turn (then 200). */
function fakeFetch(...statuses: number[]): { fetch: typeof fetch; requests: Captured[] } {
  const requests: Captured[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: String(init?.body ?? ''),
    });
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? '{}' : 'nope', { status, headers: { 'retry-after': '0' } });
  };
  return { fetch: fn as unknown as typeof fetch, requests };
}

const sample: ReleaseNotification = {
  owner: 'immich-app',
  repository: 'immich',
  release: {
    ...release('v1.2.0', 1),
    name: 'Big <release>',
    body: '## Changes\n- faster & better',
    htmlUrl: 'https://github.com/immich-app/immich/releases/tag/v1.2.0',
  },
  installedVersion: 'v1.1.0',
};

const containerEvent: NotificationEvent = {
  type: 'container-updates',
  updates: {
    vmid: 105,
    targetKind: 'lxc',
    containerName: 'nextcloud',
    apps: [{ name: 'Nextcloud', installedVersion: '29.0.1', latestVersion: '29.0.2' }],
    systemPackages: Array.from({ length: 30 }, (_, i) => ({ name: `pkg${i}`, currentVersion: '1', newVersion: '2' })),
  },
};

describe('simple messages', () => {
  it('builds a release message with notes and the main link', () => {
    const message = buildMessage([{ type: 'release', release: sample }]);
    assert.equal(message.title, 'immich-app/immich v1.2.0 – Big <release>');
    assert.equal(message.url, 'https://github.com/immich-app/immich/releases/tag/v1.2.0');
    const body = renderBody(message, PLAIN_TEXT, 1000);
    assert.match(body, /Installed: v1\.1\.0 → v1\.2\.0/);
    assert.match(body, /- faster & better/);
    assert.ok(body.endsWith(message.url!));
  });

  it('escapes HTML for Telegram but keeps release notes as Markdown for Markdown channels', () => {
    const message = buildMessage([{ type: 'release', release: sample }]);
    const html = renderBody(message, TELEGRAM_HTML, 1000);
    assert.match(html, /faster &amp; better/);
    assert.match(html, /<a href="https:\/\/github\.com\/immich-app\/immich\/releases\/tag\/v1\.2\.0">Open release<\/a>/);
    assert.match(renderBody(message, MARKDOWN, 1000), /## Changes/);
  });

  it('leaves out lines that do not fit instead of cutting markup', () => {
    const message = buildMessage([containerEvent], { publicUrl: 'https://rw.example.com' });
    assert.equal(message.url, 'https://rw.example.com/machines');
    const body = renderBody(message, TELEGRAM_HTML, 300);
    assert.ok(body.length <= 300, `${body.length}`);
    assert.match(body, /… and \d+ more/);
    assert.ok(body.endsWith('<a href="https://rw.example.com/machines">Open machines</a>'));
  });

  it('builds a digest with linked lines and a high priority for failed updates', () => {
    const message = buildMessage([
      { type: 'release', release: sample },
      { type: 'update-result', result: { vmid: 105, targetKind: 'lxc', containerName: 'nextcloud', kind: 'packages-upgrade', appName: null, succeeded: false, detail: null } },
      { type: 'docker-updates', docker: { images: [{ image: 'nginx:1.27', installedVersion: '1.27.2', latestVersion: '1.27.3', containers: [{ name: 'web', source: 'NAS' }] }] } },
    ]);
    assert.equal(message.title, 'ReleaseWatcher: 1 new release, 1 new Docker image, 1 update failed');
    assert.equal(message.priority, 'high');
    const markdown = renderBody(message, MARKDOWN, 2000);
    assert.match(markdown, /\[immich-app\/immich v1\.2\.0 \(installed v1\.1\.0\)\]\(https:\/\/github\.com/);
    assert.match(markdown, /nginx:1\.27 1\.27\.2 → 1\.27\.3 – web on NAS/);
  });
});

describe('push channels', () => {
  it('publishes to ntfy as JSON with a token', async () => {
    const { fetch, requests } = fakeFetch();
    const notifier = new NtfyNotifier({ serverUrl: 'https://ntfy.example.com/', topic: 'rw', token: 'tk_abc', fetch });
    assert.equal(notifier.isEnabled, true);
    await notifier.notify(sample);
    assert.equal(requests[0]?.url, 'https://ntfy.example.com/');
    assert.equal(requests[0]?.headers['authorization'], 'Bearer tk_abc');
    const body = JSON.parse(requests[0]!.body);
    assert.equal(body.topic, 'rw');
    assert.equal(body.markdown, true);
    assert.equal(body.click, sample.release.htmlUrl);
    assert.equal(ntfyAuthorization('me:secret'), `Basic ${btoa('me:secret')}`);
    assert.equal(new NtfyNotifier({ serverUrl: 'https://ntfy.sh', topic: null, token: null }).isEnabled, false);
  });

  it('sends to Gotify with the application token', async () => {
    const { fetch, requests } = fakeFetch();
    await new GotifyNotifier({ serverUrl: 'https://gotify.example.com/', token: 'Axyz', fetch }).notify(sample);
    assert.equal(requests[0]?.url, 'https://gotify.example.com/message');
    assert.equal(requests[0]?.headers['x-gotify-key'], 'Axyz');
    assert.equal(JSON.parse(requests[0]!.body).extras['client::display'].contentType, 'text/markdown');
  });

  it('sends to Gotify again without emoji when its MySQL table cannot store them', async () => {
    const bodies: string[] = [];
    const fetcher = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return bodies.length === 1
        ? new Response(`{"errorDescription":"Error 1366 (22007): Incorrect string value: '\\\\xF0\\\\x9F\\\\x8E\\\\x89'"}`, { status: 500 })
        : new Response('{}');
    }) as typeof fetch;
    const party = { ...sample, release: { ...sample.release, name: 'Party 🎉', body: '🚀 Features\n- ❤️ faster 👨‍👩‍👧' } };
    await new GotifyNotifier({ serverUrl: 'https://gotify.example.com', token: 'Axyz', fetch: fetcher }).notify(party);
    assert.equal(bodies.length, 2);
    assert.match(JSON.parse(bodies[0]!).message, /🚀/);
    const retried = JSON.parse(bodies[1]!);
    assert.doesNotMatch(`${retried.title}${retried.message}`, /[\u{10000}-\u{10FFFF}]/u);
    assert.match(retried.message, / Features\n- ❤️ faster /);
    assert.match(retried.title, /Party $/);
  });

  it('does not resend to Gotify on other errors', async () => {
    const { fetch, requests } = fakeFetch(500);
    const gotify = new GotifyNotifier({ serverUrl: 'https://gotify.example.com', token: 'Axyz', fetch });
    await assert.rejects(gotify.notify(sample), /Gotify returned 500/);
    assert.equal(requests.length, 1);
  });

  it('sends to Telegram as HTML and retries when rate limited', async () => {
    const { fetch, requests } = fakeFetch(429);
    await new TelegramNotifier({ botToken: '123:abc', chatId: '-100', fetch }).notify(sample);
    assert.equal(requests.length, 2);
    assert.equal(requests[1]?.url, 'https://api.telegram.org/bot123:abc/sendMessage');
    const body = JSON.parse(requests[1]!.body);
    assert.equal(body.parse_mode, 'HTML');
    assert.match(body.text, /^<b>immich-app\/immich v1\.2\.0 – Big &lt;release&gt;<\/b>/);
  });

  it('posts mrkdwn to Slack and reports errors without the URL', async () => {
    const { fetch, requests } = fakeFetch(400);
    const slack = new SlackNotifier({ webhookUrl: 'https://hooks.slack.com/services/secret', fetch });
    await assert.rejects(slack.notify(sample), (error: Error) => error.message === 'Slack returned 400: nope');
    assert.match(JSON.parse(requests[0]!.body).text, /^\*immich-app\/immich v1\.2\.0 – Big &lt;release&gt;\*/);
  });

  it('sends a Pushover form with the link as its own field', async () => {
    const { fetch, requests } = fakeFetch();
    await new PushoverNotifier({ userKey: 'u'.repeat(30), appToken: 'a'.repeat(30), fetch }).notify(sample);
    assert.equal(requests[0]?.url, 'https://api.pushover.net/1/messages.json');
    const form = new URLSearchParams(requests[0]!.body);
    assert.equal(form.get('html'), '1');
    assert.equal(form.get('url'), sample.release.htmlUrl);
    assert.equal(form.get('url_title'), 'Open release');
    assert.ok(form.get('message')!.length <= 1024);
  });

  it('posts the events as JSON to a generic webhook', async () => {
    const { fetch, requests } = fakeFetch();
    await new WebhookNotifier({ url: 'https://n8n.example.com/webhook/x', fetch }).notifyDigest([{ type: 'release', release: sample }, containerEvent]);
    const body = JSON.parse(requests[0]!.body);
    assert.equal(body.source, 'releasewatcher');
    assert.equal(body.type, 'digest');
    assert.equal(body.events.length, 2);
    assert.equal(body.events[0].release.release.tag, 'v1.2.0');
    assert.match(body.message, /New releases/);
  });

  it('uses the chosen method and custom headers, which may replace the content type', async () => {
    const { fetch, requests } = fakeFetch();
    const calls: string[] = [];
    const recording = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(init?.method ?? 'GET');
      return fetch(input, init);
    }) as typeof globalThis.fetch;
    await new WebhookNotifier({
      url: 'https://hooks.example.com/x',
      method: 'PUT',
      headers: [
        { name: 'Authorization', value: 'Bearer abc' },
        { name: 'content-type', value: 'application/vnd.rw+json' },
      ],
      fetch: recording,
    }).notify(sample);
    assert.deepEqual(calls, ['PUT']);
    assert.equal(requests[0]?.headers['authorization'], 'Bearer abc');
    assert.equal(requests[0]?.headers['content-type'], 'application/vnd.rw+json');
  });
});
