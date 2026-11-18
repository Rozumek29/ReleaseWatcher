import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { RepositoryStore, SELF_REPOSITORY } from '../src/db.ts';
import { SecretBox, parseKey } from '../src/secret-box.ts';

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
