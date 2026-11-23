import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { errorMessage } from './errors.ts';

/** Prefix of an encrypted value: `enc:v1:` + base64(iv | auth tag | ciphertext). */
const PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Thrown when a value cannot be decrypted (wrong key or damaged data). */
export class SecretDecryptionError extends Error {
  constructor() {
    super('A stored secret cannot be decrypted – the encryption key does not match the database.');
    this.name = 'SecretDecryptionError';
  }
}

/**
 * Encrypts secrets stored in the database with AES-256-GCM. Values written before encryption existed are
 * plain text; `isEncrypted()` tells them apart so they can be migrated.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: Uint8Array) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`The encryption key must be ${KEY_BYTES} bytes long.`);
    }
    this.key = Buffer.from(key);
  }

  /** A box with a random key – for tests and in-memory databases. */
  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(KEY_BYTES));
  }

  static isEncrypted(value: string): boolean {
    return value.startsWith(PREFIX);
  }

  encrypt(plain: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }

  /** Decrypts a value; plain-text values (not yet migrated) are returned as they are. */
  decrypt(value: string): string {
    if (!SecretBox.isEncrypted(value)) {
      return value;
    }
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) {
      throw new SecretDecryptionError();
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretDecryptionError();
    }
  }

  encryptNullable(value: string | null): string | null {
    return value === null ? null : this.encrypt(value);
  }

  decryptNullable(value: string | null): string | null {
    return value === null ? null : this.decrypt(value);
  }
}

/** Parses `ENCRYPTION_KEY`: 32 bytes as base64 (44 characters) or hex (64 characters). */
export function parseKey(text: string): Buffer {
  const value = text.trim();
  const key = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `The encryption key must be ${KEY_BYTES} bytes, base64 or hex encoded (e.g. the output of \`openssl rand -base64 32\`).`,
    );
  }
  return key;
}

export const KEY_FILE_NAME = 'encryption.key';

/**
 * Returns the key used for secrets in the database: `ENCRYPTION_KEY` when set, otherwise the key file in the data
 * directory, created with a random key on the first start. Without a data directory (in-memory database) the key
 * is random and lives only as long as the process.
 */
export function loadSecretBox(options: { key: string | null; dataDir: string | null }): {
  box: SecretBox;
  source: 'env' | 'file' | 'created' | 'ephemeral';
} {
  if (options.key) {
    return { box: new SecretBox(parseKey(options.key)), source: 'env' };
  }
  if (!options.dataDir) {
    return { box: SecretBox.ephemeral(), source: 'ephemeral' };
  }
  const file = join(options.dataDir, KEY_FILE_NAME);
  if (existsSync(file)) {
    try {
      return { box: new SecretBox(parseKey(readFileSync(file, 'utf8'))), source: 'file' };
    } catch (error) {
      throw new Error(`Cannot read the encryption key file "${file}": ${errorMessage(error)}`);
    }
  }
  const key = randomBytes(KEY_BYTES);
  writeFileSync(file, `${key.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Not supported on every file system (e.g. Windows); the mode given above applies where it is.
  }
  return { box: new SecretBox(key), source: 'created' };
}
