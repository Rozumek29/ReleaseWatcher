import assert from 'node:assert/strict';
import { describe, it } from 'bun:test';
import { buildDigestPayload, buildUpdateResultPayload, buildVulnerabilityPayload } from '../src/notifiers/discord.ts';
import { buildEmail } from '../src/notifiers/email.ts';
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationDispatcher, type NotificationPreferences } from '../src/notifiers/dispatcher.ts';
import {
  targetName,
  type ContainerUpdatesNotification,
  type NotificationEvent,
  type UpdateResultNotification,
  type VulnerabilityNotification,
} from '../src/notifiers/notifier.ts';
import { advisory, RecordingNotifier, release, silentLog } from './helpers.ts';

const releaseOf = (tag: string) => ({ owner: 'acme', repository: 'widget', release: release(tag, 1) });
const containerUpdates: ContainerUpdatesNotification = {
  vmid: 105,
  targetKind: 'lxc',
  containerName: 'cloud',
  apps: [{ name: 'Nextcloud', installedVersion: '29.0.1', latestVersion: '29.0.2' }],
  aptPackages: [{ name: 'curl', currentVersion: '8.0', newVersion: '8.1' }],
};
const failedUpdate: UpdateResultNotification = {
  vmid: 105,
  targetKind: 'lxc',
  containerName: 'cloud',
  kind: 'apt-upgrade',
  appName: null,
  succeeded: false,
  detail: 'Update failed – exit code 100',
};

function setup(preferences: Partial<NotificationPreferences> = {}) {
  const notifier = new RecordingNotifier();
  const current = { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences };
  const dispatcher = new NotificationDispatcher([notifier], silentLog, () => current);
  return { notifier, dispatcher, current };
}

describe('NotificationDispatcher preferences', () => {
  it('skips releases when they are switched off', async () => {
    const { notifier, dispatcher } = setup({ releases: false });
    const result = await dispatcher.dispatch(releaseOf('v1'));
    assert.equal(result.skipped, true);
    assert.equal(notifier.sent.length, 0);
  });

  it('leaves out apt packages or applications that are switched off', async () => {
    const { notifier, dispatcher, current } = setup({ aptUpdates: false });
    await dispatcher.dispatchContainerUpdates(containerUpdates);
    assert.deepEqual(notifier.containerSent[0]?.aptPackages, []);
    assert.equal(notifier.containerSent[0]?.apps.length, 1);

    current.appUpdates = false;
    const result = await dispatcher.dispatchContainerUpdates(containerUpdates);
    assert.equal(result.skipped, true);
    assert.equal(notifier.containerSent.length, 1);
  });

  it('sends update results only when switched on', async () => {
    const { notifier, dispatcher, current } = setup();
    assert.equal((await dispatcher.dispatchUpdateResult(failedUpdate)).skipped, true);
    current.updateFailed = true;
    await dispatcher.dispatchUpdateResult(failedUpdate);
    await dispatcher.dispatchUpdateResult({ ...failedUpdate, succeeded: true });
    assert.deepEqual(notifier.resultsSent, [failedUpdate]);
  });

  it('sends a test to the named channel regardless of the preferences', async () => {
    const { notifier, dispatcher } = setup({ releases: false, digest: true });
    assert.deepEqual(await dispatcher.test(releaseOf('v0'), 'recording'), { sent: ['recording'], failed: [] });
    assert.deepEqual(await dispatcher.test(releaseOf('v0'), 'other'), { sent: [], failed: [] });
    assert.equal(notifier.sent.length, 1);
  });
});

describe('NotificationDispatcher digest', () => {
  it('collects the notifications of a batch into one digest', async () => {
    const { notifier, dispatcher } = setup({ digest: true });
    await dispatcher.batch(async () => {
      assert.equal((await dispatcher.dispatch(releaseOf('v1'))).queued, true);
      await dispatcher.dispatch(releaseOf('v2'));
      await dispatcher.dispatchContainerUpdates(containerUpdates);
      assert.equal(notifier.digests.length, 0);
    });
    assert.equal(notifier.digests.length, 1);
    assert.deepEqual(
      notifier.digests[0]?.map((e) => e.type),
      ['release', 'release', 'container-updates'],
    );
    assert.equal(notifier.sent.length, 0);
  });

  it('sends a single collected notification as a normal message', async () => {
    const { notifier, dispatcher } = setup({ digest: true });
    await dispatcher.batch(() => dispatcher.dispatch(releaseOf('v1')));
    assert.equal(notifier.sent.length, 1);
    assert.equal(notifier.digests.length, 0);
  });

  it('waits for overlapping batches and sends nothing for an empty one', async () => {
    const { notifier, dispatcher } = setup({ digest: true });
    let releaseOuter!: () => void;
    const outer = dispatcher.batch(async () => {
      await dispatcher.dispatch(releaseOf('v1'));
      await new Promise<void>((resolve) => (releaseOuter = resolve));
    });
    await dispatcher.batch(() => dispatcher.dispatchContainerUpdates(containerUpdates));
    assert.equal(notifier.digests.length + notifier.sent.length + notifier.containerSent.length, 0);
    releaseOuter();
    await outer;
    assert.equal(notifier.digests.length, 1);
    await dispatcher.batch(async () => undefined);
    assert.equal(notifier.digests.length, 1);
  });

  it('sends right away outside a batch or without digest mode', async () => {
    const { notifier, dispatcher, current } = setup({ digest: true });
    await dispatcher.dispatch(releaseOf('v1'));
    current.digest = false;
    await dispatcher.batch(async () => {
      await dispatcher.dispatch(releaseOf('v2'));
      assert.equal(notifier.sent.length, 2);
    });
    assert.equal(notifier.digests.length, 0);
  });

  it('flushes when the batch fails', async () => {
    const { notifier, dispatcher } = setup({ digest: true });
    await assert.rejects(
      dispatcher.batch(async () => {
        await dispatcher.dispatch(releaseOf('v1'));
        await dispatcher.dispatch(releaseOf('v2'));
        throw new Error('boom');
      }),
    );
    assert.equal(notifier.digests.length, 1);
  });
});

describe('Discord digest and update results', () => {
  const options = { username: 'ReleaseWatcher', avatarUrl: null, mention: '@here', publicUrl: 'https://rw.example.com' };

  it('lists every event in one embed', () => {
    const events: NotificationEvent[] = [
      { type: 'release', release: releaseOf('v1.2.3') },
      { type: 'container-updates', updates: containerUpdates },
      { type: 'update-result', result: failedUpdate },
    ];
    const payload = buildDigestPayload(events, options);
    assert.equal(payload.content, '@here');
    const [embed] = payload.embeds;
    assert.equal(embed?.title, '1 new release, 1 container with updates, 1 update failed');
    assert.equal(embed?.url, 'https://rw.example.com/machines');
    assert.match(embed!.description, /\*\*New releases\*\*\n• \*\*acme\/widget\*\* \[v1\.2\.3\]\(/);
    assert.match(embed!.description, /CT 105 \(cloud\)\*\*: Nextcloud 29\.0\.1 → 29\.0\.2, 1 apt package\(s\)/);
    assert.match(embed!.description, /❌ \*\*CT 105 \(cloud\)\*\*: apt upgrade failed/);
  });

  it('colours an update result by its outcome', () => {
    const failed = buildUpdateResultPayload(failedUpdate, options).embeds[0];
    assert.equal(failed?.title, 'CT 105 (cloud): apt upgrade failed');
    assert.equal(failed?.description, 'Update failed – exit code 100');
    assert.equal(failed?.color, 0xe74c3c);
    const ok = buildUpdateResultPayload({ ...failedUpdate, kind: 'app-update', appName: 'Nextcloud', succeeded: true, detail: null }, options).embeds[0];
    assert.equal(ok?.title, 'CT 105 (cloud): update of Nextcloud finished');
    assert.equal(ok?.color, 0x2ecc71);
  });
});

describe('targetName', () => {
  it('names containers, virtual machines and the host', () => {
    assert.equal(targetName({ vmid: 105, targetKind: 'lxc', containerName: 'nextcloud' }), 'CT 105 (nextcloud)');
    assert.equal(targetName({ vmid: 137, targetKind: 'vm', containerName: 'debian' }), 'VM 137 (debian)');
    assert.equal(targetName({ vmid: 0, targetKind: 'node', containerName: 'pve' }), 'Proxmox host (pve)');
  });
});

describe('Vulnerability notifications', () => {
  const vulnerability: VulnerabilityNotification = {
    owner: 'acme',
    repository: 'widget',
    advisory: advisory('GHSA-aaaa-bbbb-cccc', 1, '< 2.0.0', { cveId: 'CVE-2026-1234', severity: 'critical', cvssScore: 9.8 }),
    installedVersion: '1.5.0',
    affectsInstalled: true,
  };
  const options = { username: null, avatarUrl: null, mention: null, publicUrl: 'https://rw.example.com' };

  it('builds a Discord embed coloured by severity', () => {
    const [embed] = buildVulnerabilityPayload(vulnerability, options).embeds;
    assert.equal(embed?.title, 'acme/widget: Problem GHSA-aaaa-bbbb-cccc');
    assert.equal(embed?.url, 'https://github.com/acme/widget/security/advisories/GHSA-aaaa-bbbb-cccc');
    assert.equal(embed?.color, 0x8b0000);
    assert.equal(embed?.description, 'Vulnerable: < 2.0.0 · Patched: 2.0.0');
    assert.deepEqual(embed?.fields, [
      { name: 'Advisory', value: 'GHSA-aaaa-bbbb-cccc / CVE-2026-1234', inline: true },
      { name: 'Severity', value: 'Critical (9.8)', inline: true },
      { name: 'Installed', value: 'Installed 1.5.0 is affected', inline: true },
    ]);
  });

  it('appears in digests without the containers link', () => {
    const events: NotificationEvent[] = [
      { type: 'release', release: releaseOf('v2.0.0') },
      { type: 'vulnerability', vulnerability },
    ];
    const [embed] = buildDigestPayload(events, options).embeds;
    assert.equal(embed?.title, '1 new release, 1 new vulnerability');
    assert.equal(embed?.url, undefined);
    assert.match(embed!.description, /\*\*New vulnerabilities\*\*\n• \*\*acme\/widget\*\* \[GHSA-aaaa-bbbb-cccc\]\(.+\) · Critical – Problem GHSA-aaaa-bbbb-cccc \(installed 1\.5\.0 is affected\)/);
  });

  it('builds an e-mail', () => {
    const mail = buildEmail([{ type: 'vulnerability', vulnerability }], { maxBodyLength: 1000, publicUrl: null });
    assert.equal(mail.subject, 'acme/widget: critical vulnerability – Problem GHSA-aaaa-bbbb-cccc');
    assert.match(mail.text, /Critical \(CVSS 9\.8\) · GHSA-aaaa-bbbb-cccc \/ CVE-2026-1234/);
    assert.match(mail.text, /Installed 1\.5\.0 is affected/);
    assert.match(mail.html, /Vulnerable: &lt; 2\.0\.0/);
  });

  it('is skipped when switched off', async () => {
    const { notifier, dispatcher } = setup({ vulnerabilities: false });
    assert.equal((await dispatcher.dispatchVulnerability(vulnerability)).skipped, true);
    assert.equal(notifier.vulnerabilitiesSent.length, 0);
  });
});
