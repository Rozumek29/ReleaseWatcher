import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'bun:test';
import { ReleaseChecker } from '../src/checker.ts';
import { RepositoryStore } from '../src/db.ts';
import { NotificationDispatcher } from '../src/notifiers/dispatcher.ts';
import type { SecurityAdvisory } from '../src/advisories.ts';
import { advisory, FakeSource, RecordingNotifier, release, silentLog } from './helpers.ts';

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

  it('reads the installed version and the releases at the same time', async () => {
    let releasesRequested = false;
    const getRecentReleases = source.getRecentReleases.bind(source);
    source.getRecentReleases = (...args) => {
      releasesRequested = true;
      return getRecentReleases(...args);
    };
    let requestedWhileReadingVersion = false;
    const parallel = new ReleaseChecker({
      store,
      source,
      dispatcher: new NotificationDispatcher([notifier], silentLog),
      log: silentLog,
      fetchInstalledVersion: async () => {
        await Bun.sleep(1);
        requestedWhileReadingVersion = releasesRequested;
        return { version: '1.0.0', preview: '1.0.0' };
      },
    });
    const repo = store.add('acme', 'widget', false);
    repo.installedVersionUrl = 'https://widget.lan/version';
    source.releases = [release('v1', 1)];

    await parallel.check(repo);

    assert.equal(requestedWhileReadingVersion, true);
    assert.equal(store.get(repo.id)?.installedVersion, '1.0.0');
    assert.equal(store.get(repo.id)?.lastSeenTag, 'v1');
  });

  it('keeps the installed version when reading the releases fails', async () => {
    const repo = store.add('acme', 'widget', false);
    repo.installedVersionUrl = 'https://widget.lan/version';
    source.getRecentReleases = () => Promise.reject(new Error('GitHub is down'));

    const result = await checker.check(repo);

    assert.equal(result.error, 'GitHub is down');
    assert.equal(store.get(repo.id)?.installedVersion, '1.0.0');
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

  describe('security advisories', () => {
    it('stores a baseline first, then notifies about new advisories that may affect the installed version', async () => {
      const repo = store.add('acme', 'widget', false);
      source.advisories = [advisory('GHSA-a', 1)];
      await checker.check(repo);
      assert.equal(notifier.vulnerabilitiesSent.length, 0);
      assert.deepEqual(store.listAdvisories(repo.id).map((a) => a.id), ['GHSA-a']);
      assert.equal(store.get(repo.id)?.advisoriesEtag, '"advisories-etag"');

      installed = '1.5.0';
      repo.installedVersionUrl = 'https://widget.lan/version';
      source.advisories = [
        advisory('GHSA-a', 1),
        advisory('GHSA-affects', 2, '< 2.0.0'),
        advisory('GHSA-older', 3, '< 1.0.0'),
        advisory('GHSA-unknown', 4, null),
      ];
      const result = await checker.check(repo, { forceAdvisories: true });

      assert.equal(result.advisoryCount, 2);
      assert.deepEqual(
        notifier.vulnerabilitiesSent.map((n) => [n.advisory.id, n.affectsInstalled, n.installedVersion]),
        [['GHSA-affects', true, '1.5.0'], ['GHSA-unknown', null, '1.5.0']],
      );
      assert.equal(store.listAdvisories(repo.id).length, 4);
    });

    it('fetches advisories on the first release check and when forced, otherwise only on their schedule', async () => {
      const repo = store.add('acme', 'widget', false);
      await checker.check(repo);
      await checker.check(repo);
      assert.equal(source.advisoryCalls, 1);
      await checker.check(repo, { forceAdvisories: true });
      assert.equal(source.advisoryCalls, 2);
    });

    it('refreshes only the repositories whose scheduled vulnerability check is due', async () => {
      let now = new Date(2026, 10, 20, 12, 0, 5);
      const scheduled = new ReleaseChecker({
        store,
        source,
        dispatcher: new NotificationDispatcher([notifier], silentLog),
        log: silentLog,
        now: () => now,
        advisoryCron: () => '0 */6 * * *',
      });
      const due = store.add('acme', 'due', false);
      due.advisoriesCheckedAt = new Date(2026, 10, 20, 6, 0, 5).toISOString();
      store.save(due);
      const fresh = store.add('acme', 'fresh', false);
      fresh.advisoriesCheckedAt = new Date(2026, 10, 20, 12, 0, 1).toISOString();
      store.save(fresh);
      const disabled = store.add('acme', 'disabled', false);
      disabled.isEnabled = false;
      store.save(disabled);

      await scheduled.checkAllAdvisories();

      assert.equal(source.advisoryCalls, 1);
      assert.equal(store.get(due.id)?.advisoriesCheckedAt, now.toISOString());
      assert.equal(store.get(disabled.id)?.advisoriesCheckedAt, null);

      now = new Date(2026, 10, 20, 18, 0, 5);
      await scheduled.checkAllAdvisories();
      assert.equal(source.advisoryCalls, 3);
    });

    it('removes withdrawn advisories and keeps errors apart from release errors', async () => {
      const repo = store.add('acme', 'widget', false);
      source.advisories = [advisory('GHSA-a', 1), advisory('GHSA-b', 2)];
      await checker.check(repo);
      source.advisories = [advisory('GHSA-b', 2)];
      await checker.check(repo, { forceAdvisories: true });
      assert.deepEqual(store.listAdvisories(repo.id).map((a) => a.id), ['GHSA-b']);

      source.advisoryError = new Error('GitHub API returned 404');
      await checker.check(repo, { forceAdvisories: true });
      const saved = store.get(repo.id)!;
      assert.equal(saved.advisoriesError, 'GitHub: GitHub API returned 404');
      assert.equal(saved.lastError, null);
      assert.equal(store.listAdvisories(repo.id).length, 1);
    });

    it('does not notify when vulnerability notifications are off', async () => {
      const quiet = new ReleaseChecker({
        store,
        source,
        dispatcher: new NotificationDispatcher([notifier], silentLog, () => ({
          digest: false,
          releases: true,
          vulnerabilities: false,
          appUpdates: true,
          aptUpdates: true,
          updateSucceeded: false,
          updateFailed: false,
        })),
        log: silentLog,
      });
      const repo = store.add('acme', 'widget', false);
      await quiet.check(repo);
      source.advisories = [advisory('GHSA-a', 1)];
      await quiet.check(repo, { forceAdvisories: true });
      assert.equal(notifier.vulnerabilitiesSent.length, 0);
      assert.equal(store.listAdvisories(repo.id).length, 1);
    });
      describe('OSV.dev', () => {
      const osvAdvisory = (id: string, day: number, extra: Partial<SecurityAdvisory> = {}) =>
        advisory(id, day, '< 2.0.0', { source: 'osv', htmlUrl: `https://osv.dev/vulnerability/${id}`, ...extra });
      let osvResults: SecurityAdvisory[];
      let osvError: Error | null;
      let sources: { github: boolean; osv: boolean };
      let osvChecker: ReleaseChecker;

      beforeEach(() => {
        osvResults = [];
        osvError = null;
        sources = { github: true, osv: true };
        osvChecker = new ReleaseChecker({
          store,
          source,
          dispatcher: new NotificationDispatcher([notifier], silentLog),
          log: silentLog,
          osv: {
            queryPackage: async () => {
              if (osvError) {
                throw osvError;
              }
              return osvResults;
            },
          },
          advisorySources: () => sources,
        });
      });

      it('reads the package from OSV.dev, skips duplicates of GitHub advisories and keeps a baseline per source', async () => {
        const repo = store.add('acme', 'widget', false);
        source.advisories = [advisory('GHSA-gh', 1)];
        await osvChecker.check(repo);
        assert.equal(source.advisoryCalls, 1);
        assert.deepEqual(store.listAdvisories(repo.id).map((a) => a.id), ['GHSA-gh']);

        // Setting a package later: its first read is a baseline too – no flood of old vulnerabilities.
        repo.osvEcosystem = 'npm';
        repo.osvPackage = 'widget';
        osvResults = [osvAdvisory('GHSA-gh', 1), osvAdvisory('GO-old', 2), osvAdvisory('PYSEC-dup', 3, { aliases: ['ghsa-gh'] })];
        await osvChecker.check(repo, { forceAdvisories: true });
        assert.equal(notifier.vulnerabilitiesSent.length, 0);
        assert.deepEqual(
          store.listAdvisories(repo.id).map((a) => `${a.source}:${a.id}`).sort(),
          ['github:GHSA-gh', 'osv:GO-old'],
        );
        assert.deepEqual(store.get(repo.id)?.advisoryBaselines, ['github', 'osv:npm/widget']);

        osvResults = [...osvResults, osvAdvisory('GO-new', 4)];
        const result = await osvChecker.check(repo, { forceAdvisories: true });
        assert.equal(result.advisoryCount, 1);
        assert.equal(notifier.vulnerabilitiesSent[0]?.advisory.id, 'GO-new');
        assert.equal(notifier.vulnerabilitiesSent[0]?.advisory.source, 'osv');
      });

      it('drops the advisories of a disabled source and starts a new baseline when it is enabled again', async () => {
        const repo = store.add('acme', 'widget', false);
        repo.osvEcosystem = 'npm';
        repo.osvPackage = 'widget';
        source.advisories = [advisory('GHSA-gh', 1)];
        osvResults = [osvAdvisory('GO-1', 2)];
        await osvChecker.check(repo);
        assert.equal(store.listAdvisories(repo.id).length, 2);

        sources = { github: false, osv: true };
        await osvChecker.check(repo, { forceAdvisories: true });
        assert.deepEqual(store.listAdvisories(repo.id).map((a) => a.id), ['GO-1']);
        assert.deepEqual(store.get(repo.id)?.advisoryBaselines, ['osv:npm/widget']);

        sources = { github: true, osv: true };
        source.advisories = [advisory('GHSA-gh', 1), advisory('GHSA-gh2', 3)];
        await osvChecker.check(repo, { forceAdvisories: true });
        assert.equal(notifier.vulnerabilitiesSent.length, 0);
        assert.equal(store.listAdvisories(repo.id).length, 3);
      });

      it('keeps the advisories of a source that failed and reports which one', async () => {
        const repo = store.add('acme', 'widget', false);
        repo.osvEcosystem = 'npm';
        repo.osvPackage = 'widget';
        osvResults = [osvAdvisory('GO-1', 2)];
        await osvChecker.check(repo);
        osvError = new Error('OSV.dev returned 500: down');
        await osvChecker.check(repo, { forceAdvisories: true });
        const saved = store.get(repo.id)!;
        assert.equal(saved.advisoriesError, 'OSV.dev: OSV.dev returned 500: down');
        assert.deepEqual(store.listAdvisories(repo.id).map((a) => a.id), ['GO-1']);
        assert.ok(saved.advisoryBaselines.includes('osv:npm/widget'));
      });
    });
  });
});
