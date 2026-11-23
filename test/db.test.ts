import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { RepositoryStore, SELF_REPOSITORY } from '../src/db.ts';
import { SecretBox, parseKey } from '../src/secret-box.ts';
import { AdvisoryImpacts } from '../src/advisory-impacts.ts';
import { Database } from 'bun:sqlite';
import { DEFAULT_RUN_HISTORY, type RunHistoryLimits, type RunKind } from '../src/proxmox/domain.ts';
import { ContainerStore } from '../src/proxmox/store.ts';
import { addProxmoxHost, advisory } from './helpers.ts';

const box = () => new SecretBox(parseKey(Buffer.alloc(32, 3).toString('base64')));

describe('RepositoryStore seeding', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-db-'));
    path = join(dir, 'test.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('watches its own repository in a new database', () => {
    const store = new RepositoryStore(path, box());
    assert.equal(store.created, true);
    const repo = store.seedNewDatabase();
    assert.equal(repo?.owner, SELF_REPOSITORY.owner);
    assert.equal(repo?.name, SELF_REPOSITORY.name);
    assert.equal(repo?.includePrereleases, false);
    assert.deepEqual(store.list().map((r) => `${r.owner}/${r.name}`), ['rozumek29/releasewatcher']);
    store.close();
  });

  it('reads the installed version from the given URL', () => {
    const store = new RepositoryStore(path, box());
    const repo = store.seedNewDatabase('http://127.0.0.1:8080/api/version')!;
    const saved = store.get(repo.id)!;
    assert.equal(saved.installedVersionUrl, 'http://127.0.0.1:8080/api/version');
    assert.equal(saved.installedVersionField, 'version');
    store.close();
  });

  it('does not add it again to an existing database after the user removed it', () => {
    const first = new RepositoryStore(path, box());
    const seeded = first.seedNewDatabase()!;
    first.delete(seeded.id);
    first.close();

    const store = new RepositoryStore(path, box());
    assert.equal(store.created, false);
    assert.equal(store.seedNewDatabase(), null);
    assert.deepEqual(store.list(), []);
    store.close();
  });

  it('leaves the database empty unless seeding is asked for', () => {
    const store = new RepositoryStore(':memory:');
    assert.equal(store.created, true);
    assert.deepEqual(store.list(), []);
    store.close();
  });
});

describe('RepositoryStore advisories', () => {
  let store: RepositoryStore;

  beforeEach(() => {
    store = new RepositoryStore(':memory:');
  });

  afterEach(() => store.close());

  it('advances the revision on writes but not when an unchanged advisory is saved again', () => {
    const repo = store.add('acme', 'widget', false);
    const now = new Date(Date.UTC(2026, 0, 2));
    const before = store.revision();
    store.saveAdvisories(repo.id, [advisory('GHSA-a', 1), advisory('GHSA-b', 2)], now);
    const saved = store.revision();
    assert.ok(saved > before);

    store.saveAdvisories(repo.id, [advisory('GHSA-a', 1), advisory('GHSA-b', 2)], new Date(Date.UTC(2026, 0, 5)));
    assert.equal(store.revision(), saved);

    store.saveAdvisory(repo.id, advisory('GHSA-a', 1, '< 3.0.0'), now);
    assert.ok(store.revision() > saved);
    assert.equal(store.listAdvisories(repo.id).find((a) => a.id === 'GHSA-a')?.vulnerabilities[0]?.vulnerableRange, '< 3.0.0');
  });

  it('removes only stale advisories of one source', () => {
    const repo = store.add('acme', 'widget', false);
    const now = new Date();
    store.saveAdvisories(
      repo.id,
      [advisory('GHSA-a', 1), advisory('GHSA-b', 2), advisory('GO-1', 3, '< 2.0.0', { source: 'osv', aliases: ['CVE-1'] })],
      now,
    );

    store.removeAdvisoriesExcept(repo.id, 'github', ['GHSA-b']);
    assert.deepEqual(store.listAdvisories(repo.id).map((a) => a.id).sort(), ['GHSA-b', 'GO-1']);
    assert.deepEqual(store.listAdvisoryKeys(repo.id, 'osv'), [{ id: 'GO-1', aliases: ['CVE-1'], cveId: null }]);

    store.removeAdvisoriesExcept(repo.id, 'osv');
    assert.deepEqual(store.listAdvisoryKeys(repo.id).map((a) => a.id), ['GHSA-b']);
  });

  it('keeps computed impacts until the vulnerable ranges or the installed versions change', () => {
    const repo = store.add('acme', 'widget', false);
    repo.installedVersion = '1.0.0';
    store.save(repo);
    const impacts = new AdvisoryImpacts(store, () => new Map());
    const affects = () => store.pageAdvisories({}, null, 10).rows.map((r) => [r.advisory.id, r.affects, r.affectedVersions]);
    store.saveAdvisory(repo.id, advisory('GHSA-a', 1, '< 2.0.0'), new Date());
    assert.deepEqual(store.listAdvisoriesForImpact([]).map((a) => a.advisoryId), ['GHSA-a']);

    impacts.refresh();
    assert.deepEqual(affects(), [['GHSA-a', true, ['1.0.0']]]);
    const revision = store.revision();
    impacts.refresh();
    assert.equal(store.revision(), revision, 'nothing changed – nothing written');

    store.saveAdvisory(repo.id, advisory('GHSA-a', 1, '< 2.0.0', { summary: 'Reworded' }), new Date());
    assert.deepEqual(store.listAdvisoriesForImpact([]), []);
    store.saveAdvisory(repo.id, advisory('GHSA-a', 1, '< 0.5.0'), new Date());
    assert.equal(store.listAdvisoriesForImpact([]).length, 1);
    impacts.refresh();
    assert.deepEqual(affects(), [['GHSA-a', false, []]]);

    repo.installedVersion = '0.1.0';
    store.save(repo);
    impacts.refresh();
    assert.deepEqual(affects(), [['GHSA-a', true, ['0.1.0']]]);
    assert.deepEqual(store.advisorySummaries().get(repo.id), { total: 1, affecting: 1, highestSeverity: 'high' });
  });
});

describe('RepositoryStore file size', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-size-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pragma = (db: Database, name: string) => Object.values(db.query(`PRAGMA ${name}`).get() as object)[0] as number;

  it('keeps the last checks and the last other runs of a container separately', () => {
    const store = new RepositoryStore(':memory:');
    let limits: RunHistoryLimits = { ...DEFAULT_RUN_HISTORY };
    const containers = new ContainerStore(store.database, store.secretBox, () => limits);
    const host = addProxmoxHost(store).id;
    const [web, db] = [containers.add(host, 101, 'web'), containers.add(host, 102, 'db')];
    const finish = (containerId: number, kind: RunKind) => {
      const run = containers.startRun(containerId, null, kind, 'schedule');
      containers.finishRun({ ...run, status: 'succeeded', finishedAt: new Date().toISOString(), exitCode: 0, output: 'x' });
      return run.id;
    };
    const ids = (containerId: number, check: boolean) =>
      containers
        .listRuns(containerId, 1000)
        .filter((r) => (r.kind === 'check') === check)
        .map((r) => r.id);
    // No limits by default: every run is kept.
    const kept = Array.from({ length: 60 }, () => finish(web.id, 'check'));
    assert.deepEqual(ids(web.id, true), kept.reverse());
    assert.equal(containers.pruneRuns(), 0);

    limits = { checks: 10, others: 30 };
    const updates = Array.from({ length: 32 }, () => finish(web.id, 'apt-upgrade'));
    const checks = Array.from({ length: 50 }, () => finish(web.id, 'check'));
    const dbChecks = Array.from({ length: 5 }, () => finish(db.id, 'check'));

    assert.deepEqual(ids(web.id, true), checks.slice(-10).reverse());
    // Many checks after the updates did not push the update logs out.
    assert.deepEqual(ids(web.id, false), updates.slice(-30).reverse());

    // Lowered limits (Settings) are applied to every container at once; null keeps all runs of that kind.
    limits = { checks: 2, others: null };
    assert.equal(containers.pruneRuns(), 0 + 8 + 3);
    assert.deepEqual(ids(web.id, false), updates.slice(-30).reverse());
    limits = { checks: 2, others: 3 };
    assert.equal(containers.pruneRuns(), 27);
    assert.deepEqual(ids(web.id, true), checks.slice(-2).reverse());
    assert.deepEqual(ids(web.id, false), updates.slice(-3).reverse());
    assert.deepEqual(ids(db.id, true), dbChecks.slice(-2).reverse());
    // A running run is never pruned.
    const running = containers.startRun(db.id, null, 'check', 'manual');
    limits = { checks: 1, others: 1 };
    containers.pruneRuns();
    assert.deepEqual(ids(db.id, true), [running.id]);
  });

  it('converts an existing file to incremental auto-vacuum and gives freed pages back', () => {
    const path = join(dir, 'old.db');
    // A database written by an older version: no auto_vacuum, plus free pages after a big delete.
    const old = new Database(path);
    old.run('PRAGMA journal_mode = WAL');
    old.run('CREATE TABLE filler (data TEXT)');
    old.query('INSERT INTO filler VALUES (?)').run('x'.repeat(400_000));
    old.run('DELETE FROM filler');
    assert.equal(pragma(old, 'auto_vacuum'), 0);
    assert.ok(pragma(old, 'freelist_count') > 50);
    old.close();

    const store = new RepositoryStore(path, box());
    assert.equal(pragma(store.database, 'auto_vacuum'), 2);
    assert.equal(pragma(store.database, 'freelist_count'), 0);
    store.close();

    const fresh = new RepositoryStore(join(dir, 'new.db'), box());
    assert.equal(pragma(fresh.database, 'auto_vacuum'), 2);
    fresh.close();
  });
});

describe('ContainerStore run output', () => {
  it('stores the output of finished runs compressed and reads it back', () => {
    const store = new RepositoryStore(':memory:');
    const containers = new ContainerStore(store.database, store.secretBox);
    const container = containers.add(addProxmoxHost(store).id, 101, 'web');
    const log = Array.from({ length: 200 }, (_, i) => `Setting up package-${i} (1.${i}) …`).join('\n');
    const storedType = (id: number) =>
      (store.database.query('SELECT typeof(output) AS t FROM container_runs WHERE id = ?').get(id) as { t: string }).t;

    const run = containers.startRun(container.id, null, 'apt-upgrade', 'manual');
    containers.saveRunOutput(run.id, log);
    assert.equal(storedType(run.id), 'text'); // live output stays text while running
    containers.finishRun({ ...run, status: 'succeeded', finishedAt: new Date().toISOString(), exitCode: 0, output: log });
    assert.equal(storedType(run.id), 'blob');
    assert.equal(containers.getRun(run.id)?.output, log);

    // A run finished before compression existed is packed at startup; short output stays text.
    const old = containers.startRun(container.id, null, 'check', 'manual');
    const short = containers.startRun(container.id, null, 'check', 'manual');
    store.database.run(`UPDATE container_runs SET status = 'succeeded', output = ? WHERE id = ?`, [log, old.id]);
    store.database.run(`UPDATE container_runs SET status = 'succeeded', output = 'ok' WHERE id = ?`, [short.id]);
    assert.equal(containers.packFinishedOutputs(), 1);
    assert.equal(storedType(old.id), 'blob');
    assert.equal(containers.getRun(old.id)?.output, log);
    assert.equal(containers.getRun(short.id)?.output, 'ok');
    assert.equal(containers.packFinishedOutputs(), 0);
  });
});
