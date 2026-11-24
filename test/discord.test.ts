import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { buildContainerPayload, buildDiscordPayload, buildDockerPayload, DiscordNotifier, type DiscordOptions } from '../src/notifiers/discord.ts';
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

  it('uses a raster version of the custom repository icon as the author icon', () => {
    const icon = (value: string | null) =>
      buildDiscordPayload({ owner: 'acme', repository: 'widget', release: release('v1', 1), icon: value }, options).embeds[0]?.author.icon_url;
    assert.equal(icon('sh:frigate-light'), 'https://cdn.jsdelivr.net/gh/selfhst/icons/png/frigate-light.png');
    assert.equal(icon('sh:frigate.svg'), 'https://cdn.jsdelivr.net/gh/selfhst/icons/png/frigate.png');
    assert.equal(icon('sh:frigate.webp'), 'https://cdn.jsdelivr.net/gh/selfhst/icons/webp/frigate.webp');
    assert.equal(icon('https://example.com/logo.png'), 'https://example.com/logo.png');
    // Discord can't show SVG: the owner's avatar instead.
    assert.equal(icon('https://example.com/logo.svg?v=2'), 'https://avatars.githubusercontent.com/acme?s=128');
    assert.equal(icon(null), 'https://avatars.githubusercontent.com/acme?s=128');
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

  it('links container notifications to the Machines page when PUBLIC_URL is set', () => {
    const notification = {
      vmid: 101,
      targetKind: 'lxc' as const,
      containerName: 'vaultwarden',
      systemPackages: [{ name: 'curl', currentVersion: '8.0', newVersion: '8.1' }],
      apps: [{ name: 'Vaultwarden', installedVersion: '1.30.0', latestVersion: '1.32.0' }],
    };
    const payload = buildContainerPayload(notification, { ...options, publicUrl: 'https://updater.example.com' });
    const linked = payload.embeds[0]!;
    assert.equal(linked.url, 'https://updater.example.com/machines');
    assert.equal(linked.description.includes('Open machines'), false);
    assert.deepEqual(payload.components, [
      { type: 1, components: [{ type: 2, style: 5, label: 'Open machines', url: 'https://updater.example.com/machines' }] },
    ]);

    // Without a public URL there is nothing to link to.
    const plain = buildContainerPayload(notification, options);
    assert.equal('url' in plain.embeds[0]!, false);
    assert.equal('components' in plain, false);
  });

  it('lists the system packages, then Flatpak and Snap updates of a machine', () => {
    const payload = buildContainerPayload(
      {
        vmid: 0,
        targetKind: 'server',
        containerName: 'desktop',
        systemPackages: [{ name: 'curl', currentVersion: '8.0', newVersion: '8.1' }],
        packageManager: 'dnf',
        appStores: [{ name: 'Flatpak', packages: [{ name: 'org.gnome.Calculator', currentVersion: '51.0', newVersion: '51.1' }] }],
        apps: [],
      },
      options,
    );
    assert.equal(
      payload.embeds[0]!.description,
      ['**dnf** – 1 package(s):', '• curl 8.0 → 8.1', '', '**Flatpak** – 1 update(s):', '• org.gnome.Calculator 51.0 → 51.1'].join('\n'),
    );
  });

  it('asks Discord to accept components when the message has a link button', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 204 });
    }) as unknown as typeof globalThis.fetch;
    const notification = { vmid: 101, targetKind: 'lxc' as const, containerName: 'vaultwarden', systemPackages: [], apps: [] };

    await new DiscordNotifier({ ...options, fetch, webhookUrl: `${options.webhookUrl}?thread_id=9` }).notifyContainerUpdates(notification);
    await new DiscordNotifier({ ...options, fetch, publicUrl: 'https://updater.example.com' }).notifyContainerUpdates(notification);

    assert.deepEqual(urls, [`${options.webhookUrl}?thread_id=9`, `${options.webhookUrl}?with_components=true`]);
  });

  it('lists new Docker images and links to the Docker page', () => {
    const payload = buildDockerPayload(
      { images: [{ image: 'nginx:1.27', installedVersion: '1.27.2', latestVersion: '1.27.3', containers: [{ name: 'web', source: 'NAS' }, { name: 'proxy', source: null }] }] },
      { ...options, publicUrl: 'https://rw.example.com' },
    );
    assert.equal(payload.embeds[0]?.title, 'New Docker image: nginx:1.27');
    assert.equal(payload.embeds[0]?.url, 'https://rw.example.com/docker');
    assert.equal(payload.embeds[0]?.description, '• **nginx:1.27 1.27.2 → 1.27.3** – web on NAS, proxy');
  });
});
