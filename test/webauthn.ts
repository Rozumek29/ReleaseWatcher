import { createHash, randomBytes } from 'node:crypto';

// --- A software passkey (ES256), producing real WebAuthn responses ---

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

/** Minimal CBOR encoder: unsigned/negative integers, byte and text strings, maps. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), value]);
  }
  const entries = value instanceof Map ? [...value.entries()] : Object.entries(value as object);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

/** Raw ECDSA signature (r‖s) → ASN.1 DER, as authenticators send it. */
function derSignature(raw: Uint8Array): Buffer {
  const int = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const trimmed = bytes.slice(i);
    const value = trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : Buffer.from(trimmed);
    return Buffer.concat([Buffer.from([0x02, value.length]), value]);
  };
  const body = Buffer.concat([int(raw.slice(0, 32)), int(raw.slice(32))]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

export class SoftwarePasskey {
  readonly credentialId = randomBytes(16);
  private counter = 0;
  private keys!: CryptoKeyPair;
  userHandle = '';

  async init(): Promise<this> {
    this.keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    return this;
  }

  async register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string) {
    this.userHandle = options.user.id;
    const jwk = await crypto.subtle.exportKey('jwk', this.keys.publicKey);
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const idLength = Buffer.from([this.credentialId.length >> 8, this.credentialId.length & 0xff]);
    const authData = Buffer.concat([
      sha256(options.rp.id!),
      Buffer.from([0x45]), // user present + user verified + attested credential data
      Buffer.alloc(4),
      Buffer.alloc(16), // AAGUID
      idLength,
      this.credentialId,
      cose,
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin }));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(cbor({ fmt: 'none', attStmt: {}, authData })),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  async authenticate(options: { challenge: string; rpId?: string }, origin: string) {
    this.counter++;
    const authData = Buffer.concat([
      sha256(options.rpId!),
      Buffer.from([0x05]), // user present + user verified
      Buffer.from([0, 0, 0, this.counter]),
    ]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin }));
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.keys.privateKey,
        Buffer.concat([authData, sha256(clientDataJSON)]),
      ),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    };
  }
}
