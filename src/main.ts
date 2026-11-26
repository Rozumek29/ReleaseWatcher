// Bun loads `.env` from the working directory automatically; variables already set in the environment win.
import { dirname, join, resolve } from 'node:path';
import { APP_VERSION } from './app-version.ts';
import { buildApp } from './app.ts';
import { AuthStore } from './auth/store.ts';
import { loadConfig } from './config.ts';
import { RepositoryStore } from './db.ts';
import { embeddedUi } from './embedded-ui.ts';
import { GiteaReleaseSource } from './gitea.ts';
import { GitHubReleaseSource } from './github.ts';
import { GitLabReleaseSource } from './gitlab.ts';
import { serviceCommand, setUpService } from './install.ts';
import { createLogger } from './log.ts';
import { createNotifiers } from './notifiers/index.ts';
import { OsvApiClient } from './osv.ts';
import { ProviderReleaseSource } from './release-source.ts';
import { KEY_FILE_NAME, loadSecretBox } from './secret-box.ts';
import { SettingsService } from './settings.ts';
import { localVersionUrl } from './version.ts';
import { WebReleaseSource } from './web-source/source.ts';

// `--version` / `-v` prints the version and exits before touching the configuration, the database or the port –
// usable as the version command of the container app that runs ReleaseWatcher itself.
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(`v${APP_VERSION}`); // same form as the release tags (v1.2.3)
  process.exit(0);
}

// `--install` sets the executable up as a systemd service (and updates an existing install), `--uninstall [--purge]`
// removes it – also before the configuration and the database are touched.
const service = serviceCommand(process.argv);
if (service) {
  process.exit(
    await setUpService(service, {
      executable: process.execPath,
      compiled: embeddedUi.size > 0,
      platform: process.platform,
      purge: process.argv.includes('--purge'),
    }),
  );
}

const config = loadConfig();
const log = createLogger(config.log.level, { file: config.log.file });
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
// Way back in when password sign-in is off and neither a passkey nor single sign-on works (e.g. the provider is down).
if (process.argv.includes('--enable-password-login')) {
  new AuthStore(store.database).setPasswordLogin(true);
  store.close();
  console.log('Password sign-in turned on – sign in with the user name and password of the account.');
  process.exit(0);
}
const seeded = store.seedNewDatabase(localVersionUrl(config.host, config.port));
if (seeded) {
  log.info({ repository: `${seeded.owner}/${seeded.name}` }, 'New database – watching ReleaseWatcher itself for new releases');
}
const settings = new SettingsService(store, config);
const notifiers = createNotifiers(config, settings);

const app = await buildApp({
  store,
  settings,
  source: new ProviderReleaseSource({
    github: new GitHubReleaseSource({ ...config.github, token: () => settings.current.githubToken }),
    gitea: new GiteaReleaseSource({ releasesPerPage: config.github.releasesPerPage }),
    gitlab: new GitLabReleaseSource({ releasesPerPage: config.github.releasesPerPage }),
    web: new WebReleaseSource(),
  }),
  osv: new OsvApiClient(),
  notifiers,
  knownHostsFile: config.proxmox.knownHostsFile,
  auth: {
    publicUrl: config.publicUrl,
    trustProxy: config.trustProxy,
    dataDir,
    bootstrap: config.basicAuth,
  },
  // A compiled executable carries the UI inside (see scripts/build-executable.ts); from source it is read from disk.
  ...(embeddedUi.size > 0 ? { embeddedUi } : { publicDir: join(import.meta.dir, '..', 'public') }),
  log,
});

const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutting down');
  await app.close(); // also stops the scheduled jobs and the container scheduler and removes temporary key files
  store.close();
  log.close();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const server = app.listen({ port: config.port, hostname: config.host });
app.releaseJob.start(config.initialDelayMs);
// Catches up vulnerability checks missed while the app was not running (only repositories that are due).
app.advisoryJob.start(config.initialDelayMs + 5_000);
app.dockerJob.start(config.initialDelayMs + 10_000);
app.homeAssistantJob.start(config.initialDelayMs + 15_000);
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
    releaseCheckCron: settings.current.releaseCheckCron,
    advisoryCheckCron: settings.current.advisoryCheckCron,
    notifiers: notifiers.filter((n) => n.isEnabled).map((n) => n.name),
    proxmoxConfigured: app.containers.shell.isConfigured,
    containerCheckCron: settings.current.containerCheckCron,
    dockerCheckCron: settings.current.dockerCheckCron,
    homeAssistantCheckCron: settings.current.homeAssistantCheckCron,
  },
  'ReleaseWatcher started',
);
