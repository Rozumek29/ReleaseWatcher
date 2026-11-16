// Bun loads `.env` from the working directory automatically; variables already set in the environment win.
import { join } from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { RepositoryStore } from './db.ts';
import { embeddedUi } from './embedded-ui.ts';
import { GitHubReleaseSource } from './github.ts';
import { createLogger } from './log.ts';
import { createNotifiers } from './notifiers/index.ts';
import { SshShell } from './proxmox/ssh.ts';
import { SettingsService } from './settings.ts';

const config = loadConfig();
const log = createLogger(process.env['LOG_LEVEL'] ?? 'info');
const store = new RepositoryStore(config.databasePath);
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
  basicAuth: config.basicAuth,
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
if (!config.basicAuth) {
  log.warn({}, 'BASIC_AUTH_USERNAME/BASIC_AUTH_PASSWORD are not set – anyone who can reach the UI can run updates on the Proxmox node');
}
log.info(
  {
    url: server.url.href,
    intervalMinutes: settings.current.pollIntervalMinutes,
    notifiers: notifiers.filter((n) => n.isEnabled).map((n) => n.name),
    proxmox: shell.isConfigured ? settings.current.proxmoxHost : null,
    containerCheckCron: settings.current.containerCheckCron,
  },
  'ReleaseWatcher started',
);
