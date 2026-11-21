/**
 * Machines ReleaseWatcher reaches over SSH and the named keys it logs in with. Pure types and validation – no I/O.
 */
import { STORAGE_ID_PATTERN } from '../proxmox/domain.ts';

export const HOST_TYPES = ['proxmox', 'server'] as const;
/** `proxmox` = a Proxmox VE node (its guests and the node itself are targets); `server` = a plain Linux machine. */
export type HostType = (typeof HOST_TYPES)[number];

/** A named SSH private key, shared by any number of hosts. */
export interface SshKey {
  id: number;
  name: string;
  /** OpenSSH/PEM private key without a passphrase. Secret – encrypted at rest, never returned by the API. */
  privateKey: string;
  /** `ssh-ed25519 AAAA… comment` – to copy into `authorized_keys`; null when it could not be derived. */
  publicKey: string | null;
  /** `SHA256:…` fingerprint; null when it could not be derived. */
  fingerprint: string | null;
  createdAt: string;
}

/** A machine reached over SSH. */
export interface Host {
  id: number;
  type: HostType;
  name: string;
  /** Host name or IP address. */
  address: string;
  port: number;
  /** Login user; anything but root runs commands through passwordless `sudo -n`. */
  user: string;
  /** Key used to log in; null = not chosen yet (the host cannot be reached). */
  sshKeyId: number | null;
  /** Proxmox node: storage for vzdump backups before updates; null = the global setting. Always null for servers. */
  backupStorage: string | null;
  createdAt: string;
}

export type HostInput = Pick<Host, 'type' | 'name' | 'address' | 'port' | 'user' | 'sshKeyId' | 'backupStorage'>;

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_SSH_USER = 'root';
export const MAX_NAME_LENGTH = 100;
export const MAX_PRIVATE_KEY_LENGTH = 20_000;

/** Host name or IP address (IPv6 without brackets). */
const ADDRESS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]*$/;
const USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
const PRIVATE_KEY_PATTERN = /^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----$/;

/** Validation errors by field (empty = valid). Messages are shown to the user as they are. */
export type FieldErrors = Partial<Record<string, string>>;

export function validateName(name: string, what: string): string | null {
  if (!name.trim()) return `Enter a name for the ${what}.`;
  if (name.trim().length > MAX_NAME_LENGTH) return `The name must be at most ${MAX_NAME_LENGTH} characters.`;
  return null;
}

export function validateAddress(address: string): string | null {
  return ADDRESS_PATTERN.test(address) && address.length <= 253 ? null : 'Enter a host name or IP address.';
}

export function validatePort(port: number): string | null {
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? null : 'Port must be between 1 and 65535.';
}

export function validateUser(user: string): string | null {
  return USER_PATTERN.test(user) ? null : 'Enter a valid user name.';
}

/** Checks the shape of a pasted private key (the key itself is verified by `ssh-keygen`). */
export function validatePrivateKey(privateKey: string): string | null {
  const key = normalizePrivateKey(privateKey);
  if (key.length > MAX_PRIVATE_KEY_LENGTH || !PRIVATE_KEY_PATTERN.test(key)) {
    return 'Paste the whole private key (-----BEGIN … PRIVATE KEY----- … -----END …).';
  }
  if (/Proc-Type:\s*4,ENCRYPTED/.test(key)) {
    return 'Keys protected with a passphrase are not supported.';
  }
  return null;
}

/** Unix line endings and no surrounding whitespace (OpenSSH adds the trailing newline itself). */
export const normalizePrivateKey = (privateKey: string): string => privateKey.replace(/\r\n/g, '\n').trim();

export function validateHost(input: HostInput): FieldErrors {
  const errors: FieldErrors = {};
  const name = validateName(input.name, 'host');
  if (name) errors['name'] = name;
  const address = validateAddress(input.address);
  if (address) errors['address'] = address;
  const port = validatePort(input.port);
  if (port) errors['port'] = port;
  const user = validateUser(input.user);
  if (user) errors['user'] = user;
  if (input.backupStorage !== null) {
    if (input.type !== 'proxmox') errors['backupStorage'] = 'Only Proxmox nodes have a backup storage.';
    else if (!STORAGE_ID_PATTERN.test(input.backupStorage)) errors['backupStorage'] = 'Enter a Proxmox storage ID, e.g. "local" or "pbs".';
  }
  return errors;
}

/** "root@pve.lan" or "admin@203.0.113.7:2222". */
export const sshDestination = (host: Pick<Host, 'user' | 'address' | 'port'>): string =>
  `${host.user}@${host.address}${host.port === DEFAULT_SSH_PORT ? '' : `:${host.port}`}`;
