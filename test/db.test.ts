import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { MIGRATIONS, RepositoryStore, SELF_REPOSITORY } from '../src/db.ts';
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
    let reads = 0;
    const impacts = new AdvisoryImpacts(store, () => {
      reads++;
      return new Map();
    });
    const affects =() => store.pageAdvisories({}, null, 10).rows.map((r) => [r.advisory.id, r.affects, r.affectedVersions]);
    store.saveAdvisory(repo.id, advisory('GHSA-a', 1, '< 2.0.0'), new Date());
    assert.deepEqual(store.listAdvisoriesForImpact([]).map((a) => a.advisoryId), ['GHSA-a']);

    impacts.refresh();
    assert.deepEqual(affects(), [['GHSA-a', true, ['1.0.0']]]);
    const revision = store.revision();
    const readsBefore = reads;
    impacts.refresh();
    assert.equal(store.revision(), revision, 'nothing changed – nothing written');
    assert.equal(reads, readsBefore, 'nothing written since the last refresh – the installed versions are not read again');

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
    const updates = Array.from({ length: 32 }, () => finish(web.id, 'packages-upgrade'));
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

describe('RepositoryStore installed version from machines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-machine-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the installed version from apps linked before the upgrade', () => {
    const path = join(dir, 'old.db');
    // A database of the version before installed versions were read from apps, with apps already linked to repositories.
    const before = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN installed_app_id'));
    const old = new Database(path);
    for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
    old.exec(`PRAGMA user_version = ${before}`);
    const now = '2026-11-01T00:00:00.000Z';
    old.exec(`
      INSERT INTO watched_repositories (id, owner, name, created_at, installed_version) VALUES
        (1, 'acme', 'app', '${now}', '1.0.0'),
        (2, 'acme', 'url', '${now}', NULL),
        (3, 'acme', 'docker', '${now}', NULL),
        (4, 'acme', 'none', '${now}', NULL);
      UPDATE watched_repositories SET installed_version_url = 'https://url.lan/version' WHERE id = 2;
      INSERT INTO containers (id, vmid, name, created_at) VALUES (1, 101, 'vault', '${now}');
      INSERT INTO container_apps (id, container_id, name, created_at, latest_source, repository_id, version_command, installed_version, checked_at) VALUES
        (1, 1, 'No version', '${now}', 'github', 1, NULL, NULL, NULL),
        (2, 1, 'App', '${now}', 'github', 1, 'cat /v', '1.2.0', '${now}'),
        (3, 1, 'Url', '${now}', 'github', 2, 'cat /v', '2.0.0', '${now}'),
        (4, 1, 'Unknown', '${now}', 'github', 4, NULL, NULL, NULL);
      INSERT INTO docker_containers (id, target_id, name, container_id, image, link_auto, repository_id, installed_version, first_seen_at, last_seen_at) VALUES
        (1, 1, 'docker', 'c1', 'acme/docker:3.0.0', 0, 3, '3.0.0', '${now}', '${now}');
    `);
    old.close();

    const store = new RepositoryStore(path, box());
    const repo = (id: number) => store.get(id)!;
    assert.deepEqual(repo(1).installedVersionApp, { kind: 'app', id: 2 });
    assert.equal(repo(1).installedVersion, '1.2.0');
    assert.equal(repo(2).installedVersionApp, null); // keeps its version URL
    assert.deepEqual(repo(3).installedVersionApp, { kind: 'docker', id: 1 });
    assert.equal(repo(3).installedVersion, '3.0.0');
    assert.equal(repo(4).installedVersionApp, null); // no app reports a version
    assert.deepEqual(store.installedVersionApps().get(3), { kind: 'docker', id: 1, name: 'docker', machine: 'vault' });

    // save() never overwrites the version read from the app with an older copy.
    const stale = repo(1);
    store.database.exec("UPDATE container_apps SET installed_version = '1.3.0' WHERE id = 2");
    store.save(stale);
    assert.equal(repo(1).installedVersion, '1.3.0');
    store.close();
  });
});

describe('RepositoryStore providers', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-provider-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('rebuilds the repositories with provider and host, keeping links, advisories and triggers', () => {
    const path = join(dir, 'old.db');
    const before = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE watched_repositories_new'));
    const old = new Database(path);
    for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
    old.exec(`PRAGMA user_version = ${before}`);
    const now = '2026-11-01T00:00:00.000Z';
    old.exec(`
      INSERT INTO watched_repositories (id, owner, name, created_at, github_token) VALUES
        (5, 'Acme', 'App', '${now}', NULL),
        (9, 'acme', 'docker', '${now}', NULL);
      INSERT INTO containers (id, vmid, name, created_at) VALUES (1, 101, 'vault', '${now}');
      INSERT INTO container_apps (id, container_id, name, created_at, latest_source, repository_id, version_command, installed_version, checked_at) VALUES
        (2, 1, 'App', '${now}', 'github', 5, 'cat /v', '1.2.0', '${now}');
      INSERT INTO docker_containers (id, target_id, name, container_id, image, link_auto, label_repository, installed_version, first_seen_at, last_seen_at) VALUES
        (1, 1, 'docker', 'c1', 'acme/docker:3.0.0', 1, 'acme/docker', '3.0.0', '${now}', '${now}');
      UPDATE watched_repositories SET installed_app_id = 2 WHERE id = 5;
      UPDATE watched_repositories SET installed_docker_id = 1 WHERE id = 9;
      INSERT INTO repository_advisories (repository_id, advisory_id, source, aliases, summary, severity, html_url, published_at, vulnerabilities, first_seen_at)
        VALUES (5, 'GHSA-1', 'github', '[]', 'Bug', 'high', 'https://x', '${now}', '[]', '${now}');
    `);
    old.close();

    const store = new RepositoryStore(path, box());
    const app = store.get(5)!;
    assert.deepEqual([app.provider, app.host, app.owner, app.name], ['github', null, 'Acme', 'App']);
    assert.deepEqual(app.installedVersionApp, { kind: 'app', id: 2 });
    assert.equal(store.listAdvisories(5).length, 1);
    // New repositories continue after the highest id.
    assert.equal(store.add('acme', 'next', false).id, 10);

    // The triggers read the rebuilt table: a Docker container linked through its labels keeps the version in sync …
    store.database.exec("UPDATE docker_containers SET installed_version = '3.1.0' WHERE id = 1");
    assert.equal(store.get(9)!.installedVersion, '3.1.0');
    // … and is dropped when its labels point elsewhere.
    store.database.exec("UPDATE docker_containers SET label_repository = 'codeberg.org/acme/docker' WHERE id = 1");
    assert.equal(store.get(9)!.installedVersionApp, null);
    // Removing a repository still removes its advisories.
    store.delete(5);
    assert.equal(store.database.query<{ n: number }, []>('SELECT count(*) AS n FROM repository_advisories').get()!.n, 0);
    store.close();
  });

  it('keeps one repository per host, owner and name', () => {
    const store = new RepositoryStore(':memory:');
    const codeberg = store.add('acme', 'docker', false, { provider: 'gitea', host: 'codeberg.org' });
    store.add('acme', 'docker', false);
    assert.deepEqual([codeberg.provider, codeberg.host], ['gitea', 'codeberg.org']);
    assert.equal(store.exists('ACME', 'Docker', 'Codeberg.org'), true);
    assert.equal(store.exists('acme', 'docker', 'gitlab.com'), false);
    assert.throws(() => store.add('Acme', 'DOCKER', false, { provider: 'gitlab', host: 'CODEBERG.org' }), /UNIQUE/);
    // GitHub never has a host, the others always do.
    assert.throws(() => store.database.exec("INSERT INTO watched_repositories (provider, owner, name, created_at) VALUES ('gitea', 'a', 'b', 'x')"), /CHECK/);
    store.close();
  });
});

describe('Renamed columns', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-rename-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps tokens, package updates, app sources, runs and settings of older databases', () => {
    const path = join(dir, 'old.db');
    const before = MIGRATIONS.findIndex((m) => m.includes('RENAME COLUMN github_token TO access_token'));
    const old = new Database(path);
    for (const migration of MIGRATIONS.slice(0, before)) old.exec(migration);
    old.exec(`PRAGMA user_version = ${before}`);
    const now = '2026-11-01T00:00:00.000Z';
    old.exec(`
      INSERT INTO watched_repositories (id, owner, name, created_at, github_token, etag) VALUES (1, 'acme', 'app', '${now}', 'tok', '"e1"');
      INSERT INTO hosts (id, type, name, address, created_at) VALUES (1, 'proxmox', 'pve', 'pve.lan', '${now}');
      INSERT INTO containers (id, host_id, vmid, name, created_at, apt_enabled, apt_upgradable, notified_signature) VALUES
        (1, 1, 101, 'vault', '${now}', 0, '[{"name":"curl","currentVersion":"1","newVersion":"2"}]', 'apt:curl=2|app:1=3|flatpak:x=1');
      INSERT INTO container_apps (id, container_id, name, created_at, latest_source, repository_id) VALUES (1, 1, 'App', '${now}', 'github', 1);
      INSERT INTO container_runs (container_id, kind, trigger, status, started_at) VALUES (1, 'apt-upgrade', 'manual', 'success', '${now}');
      INSERT INTO settings (key, value) VALUES ('notifyAptUpdates', 'false');
    `);
    old.close();

    const store = new RepositoryStore(path, box());
    const repo = store.get(1)!;
    assert.deepEqual([repo.accessToken, repo.releasesEtag], ['tok', '"e1"']);
    const containers = new ContainerStore(store.database, store.secretBox);
    const container = containers.get(1)!;
    assert.equal(container.packagesEnabled, false);
    assert.deepEqual(container.packageUpdates.map((p) => p.name), ['curl']);
    assert.equal(container.notifiedSignature, 'pkg:curl=2|app:1=3|flatpak:x=1');
    assert.equal(containers.listApps(1)[0]!.latestSource, 'repository');
    assert.equal(containers.listRuns(1)[0]!.kind, 'packages-upgrade');
    assert.equal(store.readSettings()['notifyPackageUpdates'], 'false');
    store.close();
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

    const run = containers.startRun(container.id, null, 'packages-upgrade', 'manual');
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
