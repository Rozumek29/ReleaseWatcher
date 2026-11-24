import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { RepositoryStore } from '../src/db.ts';
import { KEY_FILE_NAME, SecretBox, SecretDecryptionError, loadSecretBox, parseKey } from '../src/secret-box.ts';

const KEY = Buffer.alloc(32, 7).toString('base64');

describe('SecretBox', () => {
  it('round-trips values and never stores them in plain text', () => {
    const box = new SecretBox(parseKey(KEY));
    const encrypted = box.encrypt('ghp_secret');
    assert.ok(SecretBox.isEncrypted(encrypted));
    assert.ok(!encrypted.includes('ghp_secret'));
    assert.notEqual(box.encrypt('ghp_secret'), encrypted, 'a fresh IV is used every time');
    assert.equal(box.decrypt(encrypted), 'ghp_secret');
  });

  it('returns legacy plain-text values unchanged', () => {
    assert.equal(SecretBox.ephemeral().decrypt('plain'), 'plain');
  });

  it('refuses values encrypted with another key or tampered with', () => {
    const encrypted = SecretBox.ephemeral().encrypt('value');
    assert.throws(() => SecretBox.ephemeral().decrypt(encrypted), SecretDecryptionError);
    const box = new SecretBox(parseKey(KEY));
    const tampered = box.encrypt('value').slice(0, -2) + 'AA';
    assert.throws(() => box.decrypt(tampered), SecretDecryptionError);
  });

  it('accepts base64 and hex keys of 32 bytes only', () => {
    assert.equal(parseKey(KEY).length, 32);
    assert.equal(parseKey('ab'.repeat(32)).length, 32);
    assert.throws(() => parseKey('too-short'), /32 bytes/);
  });
});

describe('loadSecretBox', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-key-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers ENCRYPTION_KEY', () => {
    const { box, source } = loadSecretBox({ key: KEY, dataDir: dir });
    assert.equal(source, 'env');
    assert.equal(new SecretBox(parseKey(KEY)).decrypt(box.encrypt('x')), 'x');
    assert.ok(!existsSync(join(dir, KEY_FILE_NAME)));
  });

  it('creates a key file on the first start and reuses it afterwards', () => {
    const first = loadSecretBox({ key: null, dataDir: dir });
    assert.equal(first.source, 'created');
    assert.equal(parseKey(readFileSync(join(dir, KEY_FILE_NAME), 'utf8')).length, 32);
    const second = loadSecretBox({ key: null, dataDir: dir });
    assert.equal(second.source, 'file');
    assert.equal(second.box.decrypt(first.box.encrypt('x')), 'x');
  });

  it('uses a random key without a data directory', () => {
    assert.equal(loadSecretBox({ key: null, dataDir: null }).source, 'ephemeral');
  });
});

describe('RepositoryStore secrets', () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rw-db-'));
    path = join(dir, 'test.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const raw = <T>(sql: string): T[] => {
    const db = new Database(path, { readonly: true });
    try {
      return db.query<T, []>(sql).all();
    } finally {
      db.close();
    }
  };

  it('stores tokens, header values and secret settings encrypted', () => {
    const store = new RepositoryStore(path, new SecretBox(parseKey(KEY)));
    const repo = store.add('owner', 'name', false);
    repo.accessToken = 'ghp_repo';
    repo.installedVersionHeaders = [{ name: 'Authorization', value: 'Bearer abc' }];
    store.save(repo);
    store.writeSetting('githubToken', 'ghp_global');
    store.writeSetting('proxmoxSshKey', '-----BEGIN OPENSSH PRIVATE KEY-----');
    store.writeSetting('discordUsername', 'Watcher');

    assert.equal(store.get(repo.id)!.accessToken, 'ghp_repo');
    assert.deepEqual(store.get(repo.id)!.installedVersionHeaders, [{ name: 'Authorization', value: 'Bearer abc' }]);
    assert.equal(store.readSettings()['proxmoxSshKey'], '-----BEGIN OPENSSH PRIVATE KEY-----');
    store.close();

    const file = readFileSync(path).toString('latin1') + (existsSync(`${path}-wal`) ? readFileSync(`${path}-wal`).toString('latin1') : '');
    for (const secret of ['ghp_repo', 'Bearer abc', 'ghp_global', 'PRIVATE KEY']) {
      assert.ok(!file.includes(secret), `${secret} must not be stored in plain text`);
    }
    const settings = Object.fromEntries(raw<{ key: string; value: string }>('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
    assert.equal(settings['discordUsername'], 'Watcher', 'other settings stay readable');
  });

  it('encrypts plain-text secrets left by an older version', () => {
    // An older database: secrets written in plain text before the key check existed.
    new RepositoryStore(path, new SecretBox(parseKey(KEY))).close();
    const db = new Database(path);
    db.run('DELETE FROM app_meta');
    db.run(`INSERT INTO watched_repositories (owner, name, created_at, access_token, installed_version_headers)
            VALUES ('o', 'n', '2026-01-01T00:00:00.000Z', 'ghp_old', '[{"name":"X-Key","value":"v"}]')`);
    db.run(`INSERT INTO settings (key, value) VALUES ('discordWebhookUrl', 'https://discord.com/api/webhooks/1/x')`);
    db.close();

    const store = new RepositoryStore(path, new SecretBox(parseKey(KEY)));
    const [repo] = store.list();
    assert.equal(repo!.accessToken, 'ghp_old');
    assert.deepEqual(repo!.installedVersionHeaders, [{ name: 'X-Key', value: 'v' }]);
    assert.equal(store.readSettings()['discordWebhookUrl'], 'https://discord.com/api/webhooks/1/x');
    store.close();

    const [row] = raw<{ access_token: string; installed_version_headers: string }>(
      'SELECT access_token, installed_version_headers FROM watched_repositories',
    );
    assert.ok(SecretBox.isEncrypted(row!.access_token));
    assert.ok(SecretBox.isEncrypted(row!.installed_version_headers));
    const [setting] = raw<{ value: string }>(`SELECT value FROM settings WHERE key = 'discordWebhookUrl'`);
    assert.ok(SecretBox.isEncrypted(setting!.value));
  });

  it('needs an explicit key for a database file', () => {
    assert.throws(() => new RepositoryStore(path), /needs the encryption key/);
    assert.ok(!existsSync(path), 'nothing is written without a key');
  });

  it('refuses to start with a different key', () => {
    new RepositoryStore(path, new SecretBox(parseKey(KEY))).close();
    assert.throws(() => new RepositoryStore(path, SecretBox.ephemeral()), /encryption key does not match/);
  });
});
