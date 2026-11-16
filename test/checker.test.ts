import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'bun:test';
import { ReleaseChecker } from '../src/checker.ts';
import { RepositoryStore } from '../src/db.ts';
import { NotificationDispatcher } from '../src/notifiers/dispatcher.ts';
import { FakeSource, RecordingNotifier, release, silentLog } from './helpers.ts';

describe('ReleaseChecker', () => {
  let store: RepositoryStore;
  let source: FakeSource;
  let notifier: RecordingNotifier;
  let checker: ReleaseChecker;
  let installed: string | Error = '1.0.0';

  beforeEach(() => {
    store = new RepositoryStore(':memory:');
    source = new FakeSource();
    notifier = new RecordingNotifier();
    checker = new ReleaseChecker({
      store,
      source,
      dispatcher: new NotificationDispatcher([notifier], silentLog),
      log: silentLog,
      fetchInstalledVersion: async () => {
        if (installed instanceof Error) {
          throw installed;
        }
        return { version: installed, preview: installed };
      },
    });
  });

  it('stores a baseline first, then notifies only about the new release', async () => {
    const repo = store.add('acme', 'widget', false);
    source.releases = [release('v1', 1)];
    await checker.check(repo);
    assert.equal(notifier.sent.length, 0);
    assert.equal(store.get(repo.id)?.lastSeenTag, 'v1');

    source.releases = [release('v2', 2), release('v1', 1)];
    const result = await checker.check(repo);

    assert.equal(result.notifiedCount, 1);
    assert.equal(notifier.sent[0]?.release.tag, 'v2');
    assert.equal(store.get(repo.id)?.lastSeenTag, 'v2');
  });

  it('does not notify on 304 Not Modified', async () => {
    const repo = store.add('acme', 'widget', false);
    repo.lastCheckedAt = new Date().toISOString();
    source.notModified = true;
    source.releases = [release('v9', 9)];

    await checker.check(repo);

    assert.equal(notifier.sent.length, 0);
  });

  it('records source errors on the repository', async () => {
    const repo = store.add('acme', 'widget', false);
    source.error = new Error('boom');

    const result = await checker.check(repo);

    assert.equal(result.error, 'boom');
    assert.equal(store.get(repo.id)?.lastError, 'boom');
  });

  it('skips disabled repositories', async () => {
    const repo = store.add('acme', 'widget', false);
    store.save({ ...repo, isEnabled: false });

    await checker.checkAll();

    assert.equal(source.calls, 0);
  });

  it('keeps going when a notifier fails', async () => {
    const repo = store.add('acme', 'widget', false);
    repo.lastCheckedAt = new Date().toISOString();
    notifier.fail = true;
    source.releases = [release('v1', 1)];

    const result = await checker.check(repo);

    assert.equal(result.error, null);
    assert.equal(store.get(repo.id)?.lastSeenTag, 'v1');
  });

  it('reads the installed version and includes it in notifications', async () => {
    const repo = store.add('acme', 'widget', false);
    repo.lastCheckedAt = new Date().toISOString();
    repo.installedVersionUrl = 'https://widget.lan/api/version';
    installed = 'v1';
    source.releases = [release('v2', 2)];

    await checker.check(repo);

    assert.equal(store.get(repo.id)?.installedVersion, 'v1');
    assert.equal(notifier.sent[0]?.installedVersion, 'v1');
  });

  it('skips releases that are already installed', async () => {
    const repo = store.add('acme', 'widget', false);
    repo.lastCheckedAt = new Date().toISOString();
    repo.installedVersionUrl = 'https://widget.lan/api/version';
    installed = '2.0.0';
    source.releases = [release('v1.5.0', 1), release('v2.0.0', 2)];

    const result = await checker.check(repo);

    assert.equal(result.notifiedCount, 0);
    assert.equal(store.get(repo.id)?.lastSeenTag, 'v2.0.0');
  });

  it('keeps checking releases when the installed version cannot be read', async () => {
    const repo = store.add('acme', 'widget', false);
    repo.lastCheckedAt = new Date().toISOString();
    repo.installedVersionUrl = 'https://widget.lan/api/version';
    installed = new Error('unreachable');
    source.releases = [release('v1', 1)];

    const result = await checker.check(repo);

    assert.equal(result.notifiedCount, 1);
    assert.equal(store.get(repo.id)?.installedVersionError, 'unreachable');
    assert.equal(store.get(repo.id)?.lastError, null);
  });
});
