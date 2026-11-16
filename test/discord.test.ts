import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { buildDiscordPayload, DiscordNotifier, type DiscordOptions } from '../src/notifiers/discord.ts';
import { release } from './helpers.ts';

const options: DiscordOptions = {
  webhookUrl: 'https://discord.test/api/webhooks/1/abc',
  username: 'ReleaseWatcher',
  avatarUrl: null,
  mention: null,
  maxBodyLength: 1500,
};

describe('DiscordNotifier', () => {
  it('builds an embed with release details', () => {
    const payload = buildDiscordPayload(
      { owner: 'acme', repository: 'widget', release: release('v1.2.3', 1, true) },
      { ...options, mention: '@here' },
    );
    assert.equal(payload.content, '@here');
    const [embed] = payload.embeds;
    assert.equal(embed?.title, 'acme/widget v1.2.3');
    assert.equal(embed?.color, 0xf39c12);
    assert.deepEqual(embed?.fields[1], { name: 'Type', value: 'Pre-release', inline: true });
    assert.equal(embed?.author.icon_url, 'https://avatars.githubusercontent.com/acme?s=128');
    assert.equal(embed?.footer?.text, 'Released by bob');
  });

  it('truncates long release notes', () => {
    const payload = buildDiscordPayload(
      { owner: 'acme', repository: 'widget', release: { ...release('v1', 1), body: 'x'.repeat(5000) } },
      { ...options, maxBodyLength: 100 },
    );
    assert.equal(payload.embeds[0]?.description?.length, 100);
    assert.ok(payload.embeds[0]?.description?.endsWith('…'));
  });

  it('is disabled without a webhook URL', () => {
    assert.equal(new DiscordNotifier({ ...options, webhookUrl: null }).isEnabled, false);
  });

  it('posts JSON to the webhook', async () => {
    const calls: { url: string; body: string }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body as string });
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;

    await new DiscordNotifier({ ...options, fetch }).notify({ owner: 'acme', repository: 'widget', release: release('v1', 1) });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, options.webhookUrl);
    const body = JSON.parse(calls[0]!.body);
    assert.equal(body.embeds[0].title, 'acme/widget v1');
    assert.equal('content' in body, false);
  });

  it('throws on an error response', async () => {
    const fetch = (async () => new Response('bad', { status: 400 })) as unknown as typeof globalThis.fetch;
    await assert.rejects(
      new DiscordNotifier({ ...options, fetch }).notify({ owner: 'acme', repository: 'widget', release: release('v1', 1) }),
      /400/,
    );
  });
});
