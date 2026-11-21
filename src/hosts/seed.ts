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
