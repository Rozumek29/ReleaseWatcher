import type { Database } from 'bun:sqlite';
import type { SecretBox } from '../secret-box.ts';
import type { Host, HostInput, HostType, SshKey } from './domain.ts';

interface KeyRow {
  id: number;
  name: string;
  private_key: string;
  public_key: string | null;
  fingerprint: string | null;
  created_at: string;
}

interface HostRow {
  id: number;
  type: string;
  name: string;
  address: string;
  port: number;
  user: string;
  ssh_key_id: number | null;
  backup_storage: string | null;
  created_at: string;
}

const toHost = (r: HostRow): Host => ({
  id: r.id,
  type: r.type as HostType,
  name: r.name,
  address: r.address,
  port: r.port,
  user: r.user,
  sshKeyId: r.ssh_key_id,
  backupStorage: r.backup_storage,
  createdAt: r.created_at,
});

/** A key without its private part – for lists and DTOs (nothing is decrypted). */
export type SshKeySummary = Omit<SshKey, 'privateKey'> & {
  /** Hosts that log in with this key. */
  hostCount: number;
};

/** SQLite persistence of SSH keys (private keys encrypted) and hosts (tables created by `RepositoryStore`). */
export class HostStore {
  private readonly db: Database;
  private readonly secrets: SecretBox;

  constructor(db: Database, secrets: SecretBox) {
    this.db = db;
    this.secrets = secrets;
  }

  listKeys(): SshKeySummary[] {
    return this.db
      .query<Omit<KeyRow, 'private_key'> & { host_count: number }, []>(
        `SELECT k.id, k.name, k.public_key, k.fingerprint, k.created_at,
                (SELECT count(*) FROM hosts h WHERE h.ssh_key_id = k.id) AS host_count
         FROM ssh_keys k ORDER BY k.name COLLATE NOCASE, k.id`,
      )
      .all()
      .map((r) => ({
        id: r.id,
        name: r.name,
        publicKey: r.public_key,
        fingerprint: r.fingerprint,
        createdAt: r.created_at,
        hostCount: r.host_count,
      }));
  }

  /** A key with its decrypted private part (for connecting); null when it does not exist. */
  getKey(id: number): SshKey | null {
    const r = this.db.query<KeyRow, [number]>('SELECT * FROM ssh_keys WHERE id = ?').get(id);
    return r
      ? {
          id: r.id,
          name: r.name,
          privateKey: this.secrets.decrypt(r.private_key),
          publicKey: r.public_key,
          fingerprint: r.fingerprint,
          createdAt: r.created_at,
        }
      : null;
  }

  keySummary(id: number): SshKeySummary | null {
    return this.listKeys().find((k) => k.id === id) ?? null;
  }

  keyNameExists(name: string, exceptId: number | null = null): boolean {
    return (
      this.db
        .query<{ id: number }, [string]>('SELECT id FROM ssh_keys WHERE name = ? COLLATE NOCASE')
        .all(name.trim())
        .some((r) => r.id !== exceptId)
    );
  }

  addKey(key: Pick<SshKey, 'name' | 'privateKey' | 'publicKey' | 'fingerprint'>): number {
    const result = this.db
      .query('INSERT INTO ssh_keys (name, private_key, public_key, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(key.name.trim(), this.secrets.encrypt(key.privateKey), key.publicKey, key.fingerprint, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  renameKey(id: number, name: string): boolean {
    return this.db.query('UPDATE ssh_keys SET name = ? WHERE id = ?').run(name.trim(), id).changes > 0;
  }

  /** Hosts using a key (a key in use cannot be deleted). */
  hostsUsingKey(id: number): Host[] {
    return this.db
      .query<HostRow, [number]>('SELECT * FROM hosts WHERE ssh_key_id = ? ORDER BY name COLLATE NOCASE')
      .all(id)
      .map(toHost);
  }

  deleteKey(id: number): boolean {
    return this.db.query('DELETE FROM ssh_keys WHERE id = ?').run(id).changes > 0;
  }

  listHosts(): Host[] {
    return this.db.query<HostRow, []>('SELECT * FROM hosts ORDER BY type, name COLLATE NOCASE, id').all().map(toHost);
  }

  getHost(id: number): Host | null {
    const r = this.db.query<HostRow, [number]>('SELECT * FROM hosts WHERE id = ?').get(id);
    return r ? toHost(r) : null;
  }

  listProxmoxHosts(): Host[] {
    return this.db.query<HostRow, []>("SELECT * FROM hosts WHERE type = 'proxmox' ORDER BY id").all().map(toHost);
  }

  /** The default Proxmox node (the first one added) – used when a request names none. */
  firstProxmoxHost(): Host | null {
    const r = this.db.query<HostRow, []>("SELECT * FROM hosts WHERE type = 'proxmox' ORDER BY id LIMIT 1").get();
    return r ? toHost(r) : null;
  }

  addHost(input: HostInput): Host {
    const result = this.db
      .query(
        'INSERT INTO hosts (type, name, address, port, user, ssh_key_id, backup_storage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        input.type,
        input.name.trim(),
        input.address,
        input.port,
        input.user,
        input.sshKeyId,
        input.backupStorage,
        new Date().toISOString(),
      );
    return this.getHost(Number(result.lastInsertRowid))!;
  }

  /** Saves the connection fields (the type of a host never changes). */
  saveHost(host: Host): void {
    this.db
      .query('UPDATE hosts SET name = ?, address = ?, port = ?, user = ?, ssh_key_id = ?, backup_storage = ? WHERE id = ?')
      .run(host.name.trim(), host.address, host.port, host.user, host.sshKeyId, host.backupStorage, host.id);
  }

  /** Number of targets (containers, VMs, the node itself) per host. */
  targetCounts(): Map<number, number> {
    const rows = this.db
      .query<{ host_id: number; count: number }, []>(
        'SELECT host_id, count(*) AS count FROM containers WHERE host_id IS NOT NULL GROUP BY host_id',
      )
      .all();
    return new Map(rows.map((r) => [r.host_id, r.count]));
  }

  deleteHost(id: number): boolean {
    return this.db.query('DELETE FROM hosts WHERE id = ?').run(id).changes > 0;
  }

  /** Assigns targets saved before hosts existed to `hostId`; returns how many. */
  adoptUnassignedTargets(hostId: number): number {
    return this.db.query('UPDATE containers SET host_id = ? WHERE host_id IS NULL').run(hostId).changes;
  }

  readMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>('SELECT value FROM app_meta WHERE key = ?').get(key)?.value ?? null;
  }

  writeMeta(key: string, value: string): void {
    this.db
      .query('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }
}
