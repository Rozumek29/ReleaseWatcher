// Bun loads `.env` from the working directory automatically; variables already set in the environment win.
import { dirname, join, resolve } from 'node:path';
import { APP_VERSION } from './app-version.ts';
import { buildApp } from './app.ts';
import { AuthStore } from './auth/store.ts';
import { loadConfig } from './config.ts';
import { RepositoryStore } from './db.ts';
import { embeddedUi } from './embedded-ui.ts';
import { GitHubReleaseSource } from './github.ts';
import { createLogger } from './log.ts';
import { createNotifiers } from './notifiers/index.ts';
import { SshShell } from './proxmox/ssh.ts';
import { KEY_FILE_NAME, loadSecretBox } from './secret-box.ts';
import { SettingsService } from './settings.ts';

// `--version` prints the version and exits before touching the configuration, the database or the port – usable as
// the version command of the container app that runs ReleaseWatcher itself.
if (process.argv.includes('--version')) {
  console.log(APP_VERSION);
  process.exit(0);
}

const config = loadConfig();
const log = createLogger(process.env['LOG_LEVEL'] ?? 'info');
const dataDir = config.databasePath === ':memory:' ? null : dirname(resolve(config.databasePath));
const secrets = loadSecretBox({ key: config.encryptionKey, dataDir });
if (secrets.source === 'created') {
  log.warn(
    { file: join(dataDir!, KEY_FILE_NAME) },
    'Created a new encryption key for secrets in the database – back it up together with the database',
  );
}
const store = new RepositoryStore(config.databasePath, secrets.box);

// Emergency reset when the password is forgotten and no passkey is at hand: removes the account (data stays),
// the next visit of the UI shows the setup screen with a new setup code.
if (process.argv.includes('--reset-login')) {
  new AuthStore(store.database).resetAll();
  store.close();
  console.log('Login reset: the account, its passkeys and all sessions were removed.');
  console.log('Open the UI and create the account again with the setup code from the log / setup-code file.');
  process.exit(0);
}
const settings = new SettingsService(store, config);
const notifiers = createNotifiers(config, settings);
const shell = new SshShell(() => {
  const current = settings.current;
  return {
    host: current.proxmoxHost,
    port: current.proxmoxPort,
    user: current.proxmoxUser,
    privateKey: current.proxmoxSshKey,
    knownHostsFile: config.proxmox.knownHostsFile,
  };
});

const app = await buildApp({
  store,
  settings,
  source: new GitHubReleaseSource({ ...config.github, token: () => settings.current.githubToken }),
  notifiers,
  shell,
  auth: {
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    dataDir,
    bootstrap: config.basicAuth,
  },
  // A compiled executable carries the UI inside (see scripts/compile.ts); from source it is read from disk.
  ...(embeddedUi.size > 0 ? { embeddedUi } : { publicDir: join(import.meta.dir, '..', 'public') }),
  log,
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutting down');
  await app.close(); // also stops the poller and the container scheduler
  shell.dispose();
  store.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const server = app.listen({ port: config.port, hostname: config.host });
app.poller.start(config.initialDelayMs);
app.scheduler.start();
// Updates keep running on the node while ReleaseWatcher restarts – re-attach to them and restore raised resources.
app.containers.recover().catch((err: unknown) => log.error({ err }, 'Re-attaching to running updates failed'));
if (!config.publicUrl && !config.trustProxy) {
  log.info({}, 'Passkeys need HTTPS with a host name – put the app behind a reverse proxy and set PUBLIC_URL to use them');
}
log.info(
  {
    version: APP_VERSION,
    url: server.url.href,
    intervalMinutes: settings.current.pollIntervalMinutes,
    notifiers: notifiers.filter((n) => n.isEnabled).map((n) => n.name),
    proxmox: shell.isConfigured ? settings.current.proxmoxHost : null,
    containerCheckCron: settings.current.containerCheckCron,
  },
  'ReleaseWatcher started',
);
