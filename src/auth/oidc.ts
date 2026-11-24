import { createHash } from 'node:crypto';
import { type JSONWebKeySet, type JWTPayload, createLocalJWKSet, decodeProtectedHeader, errors, jwtVerify } from 'jose';
import { errorMessage } from '../errors.ts';

/** The OpenID Connect provider (settings `oidc*`, env `OIDC_*`). */
export interface OidcConfig {
  /** Issuer URL or its discovery URL (`…/.well-known/openid-configuration`). */
  issuer: string;
  clientId: string;
  /** null = public client (PKCE only). */
  clientSecret: string | null;
  /** Shown on the sign-in button, e.g. "Pocket ID". */
  name: string;
}

/** Who signed in at the provider. */
export interface OidcIdentity {
  /** `iss` of the ID token (exactly as the provider sends it). */
  issuer: string;
  /** `sub` of the ID token – stable per provider. */
  subject: string;
  /** Something a person recognises (user name, e-mail or name); only shown in the UI. */
  label: string | null;
}

/** A failure the UI shows as it is (full English sentence). */
export class OidcError extends Error {
  override name = 'OidcError';
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const WELL_KNOWN = '/.well-known/openid-configuration';
const DISCOVERY_TTL_MS = 60 * 60_000;
/** The key set is fetched again for an unknown key ID at most this often (key rotation). */
const JWKS_REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_CACHED = 20;

/** The issuer without the discovery suffix and trailing slashes – for comparing configured and returned issuers. */
export function normalizeIssuer(value: string): string {
  let url = value.trim();
  if (url.endsWith(WELL_KNOWN)) {
    url = url.slice(0, -WELL_KNOWN.length);
  }
  return url.replace(/\/+$/, '');
}

export function discoveryUrl(issuer: string): string {
  const url = issuer.trim();
  return url.endsWith(WELL_KNOWN) ? url : `${url.replace(/\/+$/, '')}${WELL_KNOWN}`;
}

/** PKCE S256 challenge of a code verifier. */
export function codeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

const claim = (payload: JWTPayload, name: string): string | null => {
  const value = payload[name];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
};

/**
 * Minimal OpenID Connect relying party: discovery, authorization code flow with PKCE and nonce, ID token
 * verification (signature via the provider's JWKS, issuer, audience, expiry). Network access goes through `fetch`
 * so tests can use a fake provider.
 */
export class OidcClient {
  private readonly fetch: FetchLike;
  private readonly now: () => Date;
  private readonly discoveries = new Map<string, { value: Discovery; expires: number }>();
  private readonly keySets = new Map<string, { keys: ReturnType<typeof createLocalJWKSet>; fetchedAt: number }>();

  constructor(options: { fetch?: FetchLike; now?: () => Date } = {}) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? (() => new Date());
  }

  /** URL of the provider's sign-in page for this request. */
  async authorizationUrl(
    config: OidcConfig,
    request: { redirectUri: string; state: string; nonce: string; codeVerifier: string },
  ): Promise<string> {
    const discovery = await this.discover(config);
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', request.redirectUri);
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', request.state);
    url.searchParams.set('nonce', request.nonce);
    url.searchParams.set('code_challenge', codeChallenge(request.codeVerifier));
    url.searchParams.set('code_challenge_method', 'S256');
    return url.toString();
  }

  /** Redeems the authorization code and returns the verified identity of the ID token. */
  async exchange(
    config: OidcConfig,
    request: { code: string; redirectUri: string; codeVerifier: string; nonce: string },
  ): Promise<OidcIdentity> {
    const discovery = await this.discover(config);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: request.code,
      redirect_uri: request.redirectUri,
      code_verifier: request.codeVerifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    };
    const methods = discovery.token_endpoint_auth_methods_supported ?? ['client_secret_basic'];
    if (config.clientSecret && (methods.includes('client_secret_basic') || !methods.includes('client_secret_post'))) {
      // RFC 6749 §2.3.1: both parts are form-encoded before Base64.
      const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
      headers['authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
    } else {
      body.set('client_id', config.clientId);
      if (config.clientSecret) {
        body.set('client_secret', config.clientSecret);
      }
    }
    const response = await this.request(discovery.token_endpoint, { method: 'POST', headers, body }, 'token endpoint');
    const json = (await response.json().catch(() => null)) as { id_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!response.ok || !json || typeof json.id_token !== 'string') {
      const reason = typeof json?.error_description === 'string' ? json.error_description : typeof json?.error === 'string' ? json.error : `HTTP ${response.status}`;
      throw new OidcError(`The provider did not accept the sign-in (${reason}).`);
    }
    return this.verifyIdToken(config, discovery, json.id_token, request.nonce);
  }

  private async verifyIdToken(config: OidcConfig, discovery: Discovery, idToken: string, nonce: string): Promise<OidcIdentity> {
    let payload: JWTPayload;
    try {
      const options = { issuer: discovery.issuer, audience: config.clientId, clockTolerance: 60, currentDate: this.now() };
      const { alg } = decodeProtectedHeader(idToken);
      if (typeof alg === 'string' && alg.startsWith('HS')) {
        // Some providers sign with the client secret when no signing key is set up.
        if (!config.clientSecret) {
          throw new OidcError('The ID token is signed with the client secret, but no client secret is set.');
        }
        ({ payload } = await jwtVerify(idToken, new TextEncoder().encode(config.clientSecret), { ...options, algorithms: [alg] }));
      } else {
        ({ payload } = await this.verifyWithKeys(discovery, idToken, options));
      }
    } catch (error) {
      if (error instanceof OidcError) {
        throw error;
      }
      throw new OidcError(`The ID token could not be verified: ${errorMessage(error)}`);
    }
    if (payload['nonce'] !== nonce) {
      throw new OidcError('The ID token does not belong to this sign-in (nonce mismatch).');
    }
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload['azp'] !== config.clientId) {
      throw new OidcError('The ID token was issued to another client.');
    }
    if (typeof payload.sub !== 'string' || !payload.sub) {
      throw new OidcError('The ID token has no subject.');
    }
    return {
      issuer: discovery.issuer,
      subject: payload.sub,
      label: claim(payload, 'preferred_username') ?? claim(payload, 'email') ?? claim(payload, 'name'),
    };
  }

  private async verifyWithKeys(discovery: Discovery, idToken: string, options: Parameters<typeof jwtVerify>[2]) {
    const cached = this.keySets.get(discovery.jwks_uri);
    const keys = cached?.keys ?? (await this.loadKeys(discovery.jwks_uri));
    try {
      return await jwtVerify(idToken, keys, options);
    } catch (error) {
      // A new signing key (rotation): fetch the key set again, but not more than once a minute.
      if (
        error instanceof errors.JWKSNoMatchingKey &&
        cached &&
        this.now().getTime() - cached.fetchedAt >= JWKS_REFRESH_MS
      ) {
        return jwtVerify(idToken, await this.loadKeys(discovery.jwks_uri), options);
      }
      throw error;
    }
  }

  private async loadKeys(uri: string) {
    const response = await this.request(uri, { headers: { accept: 'application/json' } }, 'key set (jwks_uri)');
    const json = (await response.json().catch(() => null)) as JSONWebKeySet | null;
    if (!response.ok || !json || !Array.isArray(json.keys)) {
      throw new OidcError(`The provider's key set could not be read (HTTP ${response.status}).`);
    }
    const keys = createLocalJWKSet(json);
    this.remember(this.keySets, uri, { keys, fetchedAt: this.now().getTime() });
    return keys;
  }

  /** The provider's metadata (cached for an hour); checks that it belongs to the configured issuer. */
  async discover(config: OidcConfig): Promise<Discovery> {
    const url = discoveryUrl(config.issuer);
    const cached = this.discoveries.get(url);
    if (cached && cached.expires > this.now().getTime()) {
      return cached.value;
    }
    const response = await this.request(url, { headers: { accept: 'application/json' } }, 'discovery document');
    const json = (await response.json().catch(() => null)) as Partial<Discovery> | null;
    if (!response.ok || !json) {
      throw new OidcError(`The discovery document ${url} could not be read (HTTP ${response.status}).`);
    }
    if (
      typeof json.issuer !== 'string' ||
      !isHttpUrl(json.authorization_endpoint) ||
      !isHttpUrl(json.token_endpoint) ||
      !isHttpUrl(json.jwks_uri)
    ) {
      throw new OidcError(`The discovery document ${url} is incomplete (issuer, endpoints or jwks_uri missing).`);
    }
    if (normalizeIssuer(json.issuer) !== normalizeIssuer(config.issuer)) {
      throw new OidcError(`The provider reports the issuer ${json.issuer}, not ${normalizeIssuer(config.issuer)}.`);
    }
    const value: Discovery = {
      issuer: json.issuer,
      authorization_endpoint: json.authorization_endpoint,
      token_endpoint: json.token_endpoint,
      jwks_uri: json.jwks_uri,
      ...(Array.isArray(json.token_endpoint_auth_methods_supported)
        ? { token_endpoint_auth_methods_supported: json.token_endpoint_auth_methods_supported }
        : {}),
    };
    this.remember(this.discoveries, url, { value, expires: this.now().getTime() + DISCOVERY_TTL_MS });
    return value;
  }

  private async request(url: string, init: RequestInit, what: string): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new OidcError(`The provider's ${what} could not be reached: ${errorMessage(error)}`);
    }
  }

  private remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    if (map.size >= MAX_CACHED) {
      map.delete(map.keys().next().value!);
    }
    map.set(key, value);
  }
}
