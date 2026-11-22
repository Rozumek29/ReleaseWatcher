import type { Logger } from '../log.ts';
import type { LegacyProxmoxConnection } from '../settings.ts';
import { DEFAULT_SSH_PORT, DEFAULT_SSH_USER, type Host, normalizePrivateKey, validatePrivateKey } from './domain.ts';
import type { KeyTool } from './keys.ts';
import type { HostStore } from './store.ts';

/** app_meta flag: the former Proxmox settings were moved into a host (done once, so a deleted host stays deleted). */
export const PROXMOX_SEEDED_META = 'proxmoxHostSeeded';

export const SEEDED_KEY_NAME = 'Proxmox node';

export interface SeedDeps {
  hosts: HostStore;
  /** The former connection settings (env PROXMOX_* or values saved in the UI). */
  legacy: LegacyProxmoxConnection;
  /** Removes the former settings saved in the UI once they live in a host. */
  clearLegacy: () => void;
  keyTool: KeyTool;
  log: Pick<Logger, 'info' | 'warn'>;
}

/**
 * Moves the Proxmox connection of older versions (one node configured in Settings or through PROXMOX_* variables)
 * into a host with a named key, once, and assigns the targets added back then to it. Returns the created host.
 */
export async function seedProxmoxHost(deps: SeedDeps): Promise<Host | null> {
  const { hosts, legacy, log } = deps;
  if (hosts.readMeta(PROXMOX_SEEDED_META) !== null) {
    return null;
  }
  let created: Host | null = null;
  if (legacy.host && !hosts.firstProxmoxHost()) {
    let sshKeyId: number | null = null;
    if (legacy.privateKey && validatePrivateKey(legacy.privateKey) === null) {
      const privateKey = normalizePrivateKey(legacy.privateKey);
      const info = await deps.keyTool.inspect(privateKey).catch((error: unknown) => {
        log.warn({ err: error }, 'Could not read the public key of the former Proxmox SSH key');
        return null;
      });
      let name = SEEDED_KEY_NAME;
      for (let i = 2; hosts.keyNameExists(name); i++) name = `${SEEDED_KEY_NAME} ${i}`;
      sshKeyId = hosts.addKey({
        name,
        privateKey,
        publicKey: info?.publicKey ?? null,
        fingerprint: info?.fingerprint ?? null,
      });
    }
    created = hosts.addHost({
      type: 'proxmox',
      name: legacy.host,
      address: legacy.host,
      port: Number.isInteger(legacy.port) ? legacy.port : DEFAULT_SSH_PORT,
      user: legacy.user || DEFAULT_SSH_USER,
      sshKeyId,
      backupStorage: null,
    });
    log.info({ host: legacy.host, withKey: sshKeyId !== null }, 'Moved the Proxmox node settings into a host');
  }
  const node = hosts.firstProxmoxHost();
  if (node) {
    const adopted = hosts.adoptUnassignedTargets(node.id);
    if (adopted > 0) log.info({ host: node.name, targets: adopted }, 'Assigned existing containers to the Proxmox host');
  }
  deps.clearLegacy();
  hosts.writeMeta(PROXMOX_SEEDED_META, new Date().toISOString());
  return created;
}

/** app_meta flag: the former global backup storage was given to the Proxmox nodes (done once). */
export const BACKUP_STORAGE_SEEDED_META = 'nodeBackupStorageSeeded';

export interface BackupStorageSeedDeps {
  hosts: HostStore;
  /** The former global backup storage (saved in the UI or PROXMOX_BACKUP_STORAGE). */
  legacy: string | null;
  /** Removes the former setting saved in the UI once the nodes have it. */
  clearLegacy: () => void;
  log: Pick<Logger, 'info'>;
}

/**
 * Older versions had one global backup storage (Settings → Containers) used by every node without its own. The
 * storage now belongs to the node only: give the former value, once, to every Proxmox node that has none.
 * Returns the number of nodes that got it.
 */
export function seedNodeBackupStorage(deps: BackupStorageSeedDeps): number {
  const { hosts, legacy, log } = deps;
  if (hosts.readMeta(BACKUP_STORAGE_SEEDED_META) !== null) {
    return 0;
  }
  let updated = 0;
  if (legacy) {
    for (const node of hosts.listProxmoxHosts()) {
      if (node.backupStorage === null) {
        hosts.saveHost({ ...node, backupStorage: legacy });
        updated++;
      }
    }
    if (updated > 0) log.info({ storage: legacy, nodes: updated }, 'Moved the global backup storage to the Proxmox nodes');
  }
  deps.clearLegacy();
  hosts.writeMeta(BACKUP_STORAGE_SEEDED_META, new Date().toISOString());
  return updated;
}
