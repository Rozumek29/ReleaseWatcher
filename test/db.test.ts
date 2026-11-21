import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { RepositoryStore, SELF_REPOSITORY } from '../src/db.ts';
import { SecretBox, parseKey } from '../src/secret-box.ts';
import { advisory } from './helpers.ts';

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

  it('lists names and installed versions sorted like the full list', () => {
    const b = store.add('acme', 'beta', false);
    store.add('acme', 'Alpha', false);
    b.installedVersion = '1.2.0';
    b.githubToken = 'ghp_secret';
    store.save(b);
    assert.deepEqual(store.listNames().map((r) => [r.name, r.installedVersion]), [['Alpha', null], ['beta', '1.2.0']]);
    assert.deepEqual(Object.keys(store.listNames()[0]!).sort(), ['id', 'installedVersion', 'name', 'owner']);
  });
});
