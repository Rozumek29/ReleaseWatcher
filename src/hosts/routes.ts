import { errorMessage } from '../errors.ts';
import { problem, validationProblem } from '../http.ts';
import type { Logger } from '../log.ts';
import { describeSshFailure, ShellNotConfiguredError } from '../proxmox/ssh.ts';
import { type ObjectSchema, parseId, readBody } from '../validation.ts';
import {
  DEFAULT_SSH_PORT,
  DEFAULT_SSH_USER,
  type FieldErrors,
  HOST_TYPES,
  type Host,
  type HostInput,
  type HostType,
  MAX_NAME_LENGTH,
  MAX_PRIVATE_KEY_LENGTH,
  normalizePrivateKey,
  validateHost,
  validateName,
  validatePrivateKey,
} from './domain.ts';
import { InvalidKeyError, type KeyTool } from './keys.ts';
import type { ShellPool } from './shells.ts';
import type { HostStore, SshKeySummary } from './store.ts';

export interface HostRoutesDeps {
  hosts: HostStore;
  shells: ShellPool;
  keyTool: KeyTool;
  knownHostsFile: string;
  log: Pick<Logger, 'info' | 'warn'>;
  /** Called after a host was added (e.g. the first Proxmox node takes over containers saved without a host). */
  onHostAdded?: (host: Host) => void;
  /** Called after a host was edited, with its previous state. */
  onHostUpdated?: (host: Host, previous: Host) => void;
  /**
   * Called before a host is deleted: removes what belongs only to it (a server's own target) and returns null, or
   * returns why it cannot be deleted right now (→ 409).
   */
  beforeDeleteHost?: (host: Host) => string | null;
}

const TEST_TIMEOUT_MS = 30_000;

const addKeySchema: ObjectSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: MAX_NAME_LENGTH },
    privateKey: { type: 'string', maxLength: MAX_PRIVATE_KEY_LENGTH },
  },
  required: ['name', 'privateKey'],
};

const generateKeySchema: ObjectSchema = {
  type: 'object',
  properties: { name: { type: 'string', maxLength: MAX_NAME_LENGTH } },
  required: ['name'],
};

const hostSchema: ObjectSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', maxLength: 20 },
    name: { type: 'string', maxLength: MAX_NAME_LENGTH },
    address: { type: 'string', maxLength: 253 },
    port: { type: 'integer', nullable: true },
    user: { type: 'string', nullable: true, maxLength: 32 },
    sshKeyId: { type: 'integer', nullable: true },
    backupStorage: { type: 'string', nullable: true, maxLength: 100 },
  },
};

interface HostBody {
  type?: string;
  name?: string;
  address?: string;
  port?: number | null;
  user?: string | null;
  sshKeyId?: number | null;
  backupStorage?: string | null;
}

const fieldProblem = (errors: FieldErrors): Response =>
  problem(400, 'One or more validation errors occurred.', {
    errors: Object.fromEntries(Object.entries(errors).map(([field, message]) => [field, [message]])),
  });

/** Key as returned by the API: never the private part. */
const keyDto = (k: SshKeySummary) => ({
  id: k.id,
  name: k.name,
  publicKey: k.publicKey,
  fingerprint: k.fingerprint,
  hostCount: k.hostCount,
  createdAt: k.createdAt,
});

/** HTTP routes for SSH keys and hosts (registered by `buildApp`). */
export function hostRoutes(deps: HostRoutesDeps) {
  const { hosts, shells, keyTool } = deps;

  /** Target counts and key names for {@link hostDto} – read once for a whole list. */
  const hostContext = () => ({
    targetCounts: hosts.targetCounts(),
    keyNames: hosts.keyNames(),
  });

  const hostDto = (h: Host, { targetCounts, keyNames } = hostContext()) => {
    const keyName = h.sshKeyId === null ? null : (keyNames.get(h.sshKeyId) ?? null);
    return {
      id: h.id,
      type: h.type,
      name: h.name,
      address: h.address,
      port: h.port,
      user: h.user,
      sshKeyId: h.sshKeyId,
      sshKeyName: keyName,
      /** Proxmox node: storage for backups before updates; null = the global setting. */
      backupStorage: h.backupStorage,
      /** A key is chosen, so commands can run (whether the host answers shows "Test connection"). */
      configured: keyName !== null,
      /** Containers, virtual machines and the node itself watched through this host. */
      targetCount: targetCounts.get(h.id) ?? 0,
      createdAt: h.createdAt,
    };
  };

  /** Adds a key after checking it with ssh-keygen; returns the response. */
  const saveKey = async (name: string, privateKey: string, status: number): Promise<Response> => {
    const nameError = validateName(name, 'key');
    if (nameError) return validationProblem('name', nameError);
    if (hosts.keyNameExists(name)) return validationProblem('name', `A key named "${name.trim()}" already exists.`);
    let info;
    try {
      info = await keyTool.inspect(privateKey);
    } catch (error) {
      if (error instanceof InvalidKeyError) return validationProblem('privateKey', error.message);
      throw error;
    }
    const id = hosts.addKey({
      name,
      privateKey,
      publicKey: info?.publicKey ?? null,
      fingerprint: info?.fingerprint ?? null,
    });
    return Response.json(keyDto(hosts.keySummary(id)!), { status, headers: { location: `/api/ssh-keys/${id}` } });
  };

  /** Validates a key reference (null = no key). */
  const keyError = (sshKeyId: number | null): FieldErrors =>
    sshKeyId !== null && !hosts.keySummary(sshKeyId) ? { sshKeyId: 'Choose one of the saved SSH keys.' } : {};

  return {
    '/api/ssh-keys': {
      GET: () => Response.json(hosts.listKeys().map(keyDto)),
      POST: async (req: Request) => {
        const body = await readBody<{ name: string; privateKey: string }>(req, addKeySchema);
        const shapeError = validatePrivateKey(body.privateKey);
        if (shapeError) return validationProblem('privateKey', shapeError);
        return saveKey(body.name, normalizePrivateKey(body.privateKey), 201);
      },
    },
    // Creates a new Ed25519 key pair here – only the public key leaves the server.
    '/api/ssh-keys/generate': {
      POST: async (req: Request) => {
        const body = await readBody<{ name: string }>(req, generateKeySchema);
        const nameError = validateName(body.name, 'key');
        if (nameError) return validationProblem('name', nameError);
        if (hosts.keyNameExists(body.name)) return validationProblem('name', `A key named "${body.name.trim()}" already exists.`);
        let privateKey: string;
        try {
          privateKey = normalizePrivateKey(await keyTool.generate(`releasewatcher ${body.name.trim()}`));
        } catch (error) {
          return problem(500, 'Generating the key failed.', { detail: errorMessage(error) });
        }
        return saveKey(body.name, privateKey, 201);
      },
    },
    '/api/ssh-keys/:id': {
      PUT: async (req: Bun.BunRequest<'/api/ssh-keys/:id'>) => {
        const id = parseId(req.params.id);
        const body = await readBody<{ name: string }>(req, generateKeySchema);
        if (!hosts.keySummary(id)) return problem(404, 'SSH key not found.');
        const nameError = validateName(body.name, 'key');
        if (nameError) return validationProblem('name', nameError);
        if (hosts.keyNameExists(body.name, id)) return validationProblem('name', `A key named "${body.name.trim()}" already exists.`);
        hosts.renameKey(id, body.name);
        return Response.json(keyDto(hosts.keySummary(id)!));
      },
      DELETE: (req: Bun.BunRequest<'/api/ssh-keys/:id'>) => {
        const id = parseId(req.params.id);
        if (!hosts.keySummary(id)) return problem(404, 'SSH key not found.');
        const users = hosts.hostsUsingKey(id);
        if (users.length > 0) {
          return problem(409, `The key is used by ${users.map((h) => h.name).join(', ')} – choose another key there first.`);
        }
        hosts.deleteKey(id);
        return new Response(null, { status: 204 });
      },
    },

    '/api/hosts': {
      GET: () => {
        const context = hostContext();
        return Response.json(hosts.listHosts().map((h) => hostDto(h, context)));
      },
      POST: async (req: Request) => {
        const body = await readBody<HostBody>(req, hostSchema);
        if (!HOST_TYPES.includes(body.type as HostType)) {
          return validationProblem('type', `Choose one of: ${HOST_TYPES.join(', ')}.`);
        }
        const input: HostInput = {
          type: body.type as HostType,
          name: body.name?.trim() || body.address?.trim() || '',
          address: body.address?.trim() ?? '',
          port: body.port ?? DEFAULT_SSH_PORT,
          user: body.user?.trim() || DEFAULT_SSH_USER,
          sshKeyId: body.sshKeyId ?? null,
          backupStorage: body.backupStorage?.trim() || null,
        };
        const errors = { ...validateHost(input), ...keyError(input.sshKeyId) };
        if (Object.keys(errors).length > 0) return fieldProblem(errors);
        const host = hosts.addHost(input);
        deps.onHostAdded?.(host);
        deps.log.info({ host: host.name, type: host.type }, 'Host added');
        return Response.json(hostDto(host), { status: 201, headers: { location: `/api/hosts/${host.id}` } });
      },
    },
    '/api/hosts/:id': {
      GET: (req: Bun.BunRequest<'/api/hosts/:id'>) => {
        const host = hosts.getHost(parseId(req.params.id));
        return host ? Response.json(hostDto(host)) : problem(404, 'Host not found.');
      },
      // Omitted = keep, value = set; `sshKeyId: null` removes the key.
      PUT: async (req: Bun.BunRequest<'/api/hosts/:id'>) => {
        const id = parseId(req.params.id);
        const body = await readBody<HostBody>(req, hostSchema);
        const host = hosts.getHost(id);
        if (!host) return problem(404, 'Host not found.');
        if (body.type !== undefined && body.type !== host.type) {
          return validationProblem('type', 'The type of a host cannot be changed – add a new host instead.');
        }
        const updated: Host = {
          ...host,
          name: body.name === undefined ? host.name : body.name.trim(),
          address: body.address === undefined ? host.address : body.address.trim(),
          port: body.port === undefined || body.port === null ? host.port : body.port,
          user: body.user === undefined || body.user === null ? host.user : body.user.trim() || DEFAULT_SSH_USER,
          sshKeyId: body.sshKeyId === undefined ? host.sshKeyId : body.sshKeyId,
          backupStorage: body.backupStorage === undefined ? host.backupStorage : body.backupStorage?.trim() || null,
        };
        const errors = { ...validateHost(updated), ...keyError(updated.sshKeyId) };
        if (Object.keys(errors).length > 0) return fieldProblem(errors);
        hosts.saveHost(updated);
        deps.onHostUpdated?.(updated, host);
        return Response.json(hostDto(updated));
      },
      DELETE: (req: Bun.BunRequest<'/api/hosts/:id'>) => {
        const id = parseId(req.params.id);
        const host = hosts.getHost(id);
        if (!host) return problem(404, 'Host not found.');
        const blocked = deps.beforeDeleteHost?.(host) ?? null;
        if (blocked) return problem(409, blocked);
        const targets = hosts.targetCounts().get(id) ?? 0;
        if (targets > 0) {
          return problem(409, `${host.name} still has ${targets} watched machine(s) – remove them on the Machines page first.`);
        }
        hosts.deleteHost(id);
        shells.remove(id);
        return new Response(null, { status: 204 });
      },
    },
    // Connects and prints what runs there (`pveversion` on a Proxmox node, `uname -a` elsewhere).
    '/api/hosts/:id/test': {
      POST: async (req: Bun.BunRequest<'/api/hosts/:id/test'>) => {
        const host = hosts.getHost(parseId(req.params.id));
        if (!host) return problem(404, 'Host not found.');
        const shell = shells.forHost(host.id);
        if (!shell.isConfigured) return problem(409, `Choose an SSH key for ${host.name} first.`);
        const command = host.type === 'proxmox' ? 'pveversion 2>/dev/null || uname -a' : 'uname -a';
        try {
          const result = await shell.run(command, { timeoutMs: TEST_TIMEOUT_MS });
          if (result.exitCode !== 0) {
            return problem(502, `Could not connect to ${host.name}.`, { detail: describeSshFailure(result) });
          }
          return Response.json({ output: result.output.trim() });
        } catch (error) {
          if (error instanceof ShellNotConfiguredError) return problem(409, error.message);
          return problem(502, `Could not connect to ${host.name}.`, { detail: errorMessage(error) });
        }
      },
    },
    // Removes the pinned host key (after the machine was reinstalled); the next connection trusts the new one.
    '/api/hosts/:id/forget-host-key': {
      POST: async (req: Bun.BunRequest<'/api/hosts/:id/forget-host-key'>) => {
        const host = hosts.getHost(parseId(req.params.id));
        if (!host) return problem(404, 'Host not found.');
        try {
          await keyTool.forgetHostKey(deps.knownHostsFile, host.address, host.port);
        } catch (error) {
          return problem(500, 'Removing the host key failed.', { detail: errorMessage(error) });
        }
        deps.log.info({ host: host.name }, 'Forgot the pinned SSH host key');
        return new Response(null, { status: 204 });
      },
    },
  };
}
