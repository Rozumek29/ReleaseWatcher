import { APP_VERSION } from '../app-version.ts';
import { OSV_ECOSYSTEMS } from '../advisories.ts';
import { validateCron } from '../cron.ts';
import type { RepositoryStore } from '../db.ts';
import { parseEndpointUrl, type DockerEndpoint } from '../docker/domain.ts';
import type { DockerStore } from '../docker/store.ts';
import {
  fullName,
  normalizeGroupName,
  parseRepositoryName,
  parseRepositoryReference,
  PROVIDER_LABELS,
  type RepositoryGroup,
  type RepositoryRef,
  setReleaseSource,
  setWebSource,
  validateIcon,
  WEB_OWNER,
  normalizeWebSourceName,
  webSourceHost,
  webSourceNameError,
  type WatchedRepository,
} from '../domain.ts';
import { DEFAULT_SSH_PORT, DEFAULT_SSH_USER, HOST_TYPES, type Host, type HostType, validateHost } from '../hosts/domain.ts';
import type { HostStore } from '../hosts/store.ts';
import { autoLocator, normalizeLocator, validateLocator } from '../installed-version.ts';
import { normalizePattern, validatePattern } from '../pattern.ts';
import { validateWebSource, type WebSourceConfig } from '../web-source/domain.ts';
import { normalizeWebSource } from '../web-source/routes.ts';
import { normalizeHomeAssistantUrl } from '../proxmox/home-assistant.ts';
import {
  capabilities,
  type Container,
  type ContainerApp,
  DEFAULT_APP_TIMEOUT_SECONDS,
  GUEST_KINDS,
  LATEST_SOURCES,
  type LatestSource,
  MAX_APP_TIMEOUT_SECONDS,
  MAX_UPDATE_CORES,
  MAX_UPDATE_MEMORY_MB,
  MIN_APP_TIMEOUT_SECONDS,
  MIN_UPDATE_CORES,
  MIN_UPDATE_MEMORY_MB,
  NODE_VMID,
  type TargetKind,
} from '../proxmox/domain.ts';
import type { AppInput, ContainerStore } from '../proxmox/store.ts';
import { type SettingKey, type SettingsPatch, type SettingsService, SettingsValidationError, validateSetting } from '../settings.ts';
import { validateVersionUrl } from '../version.ts';
import {
  appKey,
  BACKUP_FORMAT,
  BACKUP_SCHEMA_VERSION,
  type BackupApp,
  type BackupDockerEndpoint,
  type BackupFile,
  type BackupHost,
  type BackupRepository,
  type BackupTarget,
  emptySection,
  EXPORTABLE_SETTING_KEYS,
  hostKey,
  type ImportMode,
  type ImportPreview,
  type ImportSectionPreview,
  repositoryKey,
  sameItem,
  SECRET_SETTING_LABELS,
  settingLabel,
  targetKey,
} from './domain.ts';
import { upgradeBackupInput, type BackupInput } from './schema.ts';

/** The file cannot be imported; `errors` are keyed by the path of the value in the file. */
export class BackupValidationError extends Error {
  override name = 'BackupValidationError';
  readonly errors: Record<string, string[]>;

  constructor(errors: Record<string, string[]>) {
    super('The backup file contains values that cannot be imported.');
    this.errors = errors;
  }
}

/** The import would remove a machine a task is running on. */
export class BackupConflictError extends Error {
  override name = 'BackupConflictError';
}

export interface BackupServiceDeps {
  store: RepositoryStore;
  settings: SettingsService;
  hosts: HostStore;
  containers: ContainerStore;
  docker: DockerStore;
  /** A check, update or other task is running (or queued) on the target. */
  isBusy: (targetId: number) => boolean;
  /** Called after the import committed, for each removed host (to close its SSH connection). */
  onHostRemoved?: (hostId: number) => void;
  /** Called when the import switched Docker listing off for a target (forgets its Docker containers). */
  onDockerDisabled?: (container: Container) => void;
}

export interface ImportPlan {
  preview: ImportPreview;
  /** Applies the import in one transaction. */
  apply(): ImportResult;
}

export interface ImportResult {
  repositoriesAdded: number;
}

const blank = (value: string | null | undefined): string | null => value?.trim() || null;

/** Exports and imports the configuration (settings, repositories, machines, Docker endpoints) without secrets. */
export class BackupService {
  private readonly deps: BackupServiceDeps;

  constructor(deps: BackupServiceDeps) {
    this.deps = deps;
  }

  exportBackup(now = new Date()): BackupFile {
    const { store, settings, hosts, containers, docker } = this.deps;
    const current = settings.current;
    const exportedSettings: BackupFile['settings'] = {};
    for (const key of EXPORTABLE_SETTING_KEYS) {
      const value = current[key];
      if (settings.sourceOf(key) === 'ui' && value !== null) {
        exportedSettings[key] = value;
      }
    }

    const repositories = store.list();
    const groups = groupsById(store.listGroups());
    const repoNames = repositoryRefs(repositories);
    const keyNames = hosts.keyNames();
    const targets = containers.list();
    const apps = containers.listApps();

    const secretsOmitted: string[] = [];
    for (const [key, label] of Object.entries(SECRET_SETTING_LABELS) as [SettingKey, string][]) {
      if (settings.sourceOf(key) === 'ui') secretsOmitted.push(label);
    }
    for (const r of repositories) {
      if (r.accessToken) secretsOmitted.push(`${PROVIDER_LABELS[r.provider]} token of ${fullName(r)}`);
      if (r.installedVersionHeaders.length > 0) {
        secretsOmitted.push(`Version URL headers of ${fullName(r)} (${r.installedVersionHeaders.map((h) => h.name).join(', ')})`);
      }
    }
    for (const key of hosts.listKeys()) {
      secretsOmitted.push(`SSH private key "${key.name}"`);
    }
    for (const t of targets) {
      if (t.homeAssistantToken && t.hostId !== null) secretsOmitted.push(`Home Assistant token of ${t.name}`);
    }

    return {
      format: BACKUP_FORMAT,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: APP_VERSION,
      exportedAt: now.toISOString(),
      settings: exportedSettings,
      repositories: repositories.map((r) => exportRepository(r, groups)),
      hosts: hosts.listHosts().map((h) =>
        exportHost(
          h,
          keyNames,
          targets.filter((t) => t.hostId === h.id),
          apps,
          repoNames,
        ),
      ),
      dockerEndpoints: docker.listEndpoints().map(exportEndpoint),
      secretsOmitted,
    };
  }

  /**
   * Checks a backup file and works out what importing it would change. Throws {@link BackupValidationError} for
   * values that cannot be imported and {@link BackupConflictError} when a machine to remove is busy. Nothing is
   * written until `apply()` is called.
   */
  planImport(input: BackupInput, mode: ImportMode): ImportPlan {
    if (input.format !== BACKUP_FORMAT) {
      throw new BackupValidationError({ format: ['This is not a ReleaseWatcher backup file.'] });
    }
    if (input.schemaVersion < 1 || input.schemaVersion > BACKUP_SCHEMA_VERSION) {
      throw new BackupValidationError({
        schemaVersion: [
          `This backup uses format version ${input.schemaVersion}, this ReleaseWatcher reads up to version ${BACKUP_SCHEMA_VERSION}. Update ReleaseWatcher first.`,
        ],
      });
    }
    return new ImportPlanner(this.deps, upgradeBackupInput(input), mode).plan();
  }
}

// --- Export mappers (also used to compare existing items with the file) ---

const groupsById = (groups: RepositoryGroup[]) => new Map(groups.map((g) => [g.id, g]));

function exportRepository(r: WatchedRepository, groups: Map<number, RepositoryGroup>): BackupRepository {
  const group = r.groupId === null ? undefined : groups.get(r.groupId);
  return {
    provider: r.provider,
    host: r.host,
    owner: r.owner,
    name: r.name,
    includePrereleases: r.includePrereleases,
    releaseSource: r.releaseSource,
    versionPattern: r.versionPattern,
    webSource: r.webSource,
    isEnabled: r.isEnabled,
    icon: r.icon,
    groupName: group?.name ?? null,
    groupIcon: group?.icon ?? null,
    installedVersionUrl: r.installedVersionUrl,
    installedVersionField: r.installedVersionField,
    installedVersionFormat: r.installedVersionFormat,
    installedVersionPattern: r.installedVersionPattern,
    installedVersionHeaderNames: r.installedVersionHeaders.map((h) => h.name),
    installedVersion: r.installedVersionUrl ? null : r.installedVersion,
    osvEcosystem: r.osvEcosystem,
    osvPackage: r.osvPackage,
    hasAccessToken: r.accessToken !== null,
  };
}

/** What apps need to know about the watched repositories when they are exported. */
interface RepositoryRefs {
  /** `owner/name` by id. */
  names: ReadonlyMap<number, string>;
  /** Ids of the apps that repositories read their installed version from. */
  installedVersionApps: ReadonlySet<number>;
}

const repositoryRefs = (repositories: readonly WatchedRepository[]): RepositoryRefs => ({
  names: new Map(repositories.map((r) => [r.id, fullName(r)])),
  installedVersionApps: new Set(
    repositories.flatMap((r) => (r.installedVersionApp?.kind === 'app' ? [r.installedVersionApp.id] : [])),
  ),
});

function exportApp(a: ContainerApp, repoNames: RepositoryRefs): BackupApp {
  return {
    name: a.name,
    versionCommand: a.versionCommand,
    latestSource: a.latestSource,
    repository: a.repositoryId === null ? null : (repoNames.names.get(a.repositoryId) ?? null),
    latestCommand: a.latestCommand,
    updateCommand: a.updateCommand,
    useTty: a.useTty,
    timeoutSeconds: a.timeoutSeconds,
    installedVersion: a.versionCommand ? null : a.installedVersion,
    isInstalledVersionSource: repoNames.installedVersionApps.has(a.id),
  };
}

function exportTarget(c: Container, apps: readonly ContainerApp[], repoNames: RepositoryRefs): BackupTarget {
  return {
    kind: c.kind,
    vmid: c.vmid,
    name: c.name,
    isEnabled: c.isEnabled,
    packagesEnabled: c.packagesEnabled,
    backupBeforeUpdate: c.backupBeforeUpdate,
    startWhenStopped: c.startWhenStopped,
    checkCron: c.checkCron,
    updateCores: c.updateCores,
    updateMemoryMb: c.updateMemoryMb,
    dockerEnabled: c.dockerEnabled,
    homeAssistantUrl: c.homeAssistantUrl,
    homeAssistantInstall: c.homeAssistantInstall,
    hasHomeAssistantToken: c.homeAssistantToken !== null,
    apps: capabilities(c.kind).apps ? apps.filter((a) => a.containerId === c.id).map((a) => exportApp(a, repoNames)) : [],
  };
}

function exportHost(
  h: Host,
  keyNames: ReadonlyMap<number, string>,
  targets: readonly Container[],
  apps: readonly ContainerApp[],
  repoNames: RepositoryRefs,
): BackupHost {
  return {
    type: h.type,
    name: h.name,
    address: h.address,
    port: h.port,
    user: h.user,
    sshKeyName: h.sshKeyId === null ? null : (keyNames.get(h.sshKeyId) ?? null),
    backupStorage: h.backupStorage,
    targets: targets.map((t) => exportTarget(t, apps, repoNames)),
  };
}

const exportEndpoint = (e: DockerEndpoint): BackupDockerEndpoint => ({ name: e.name, url: e.url, isEnabled: e.isEnabled });

const targetLabel = (host: { name: string }, t: { kind: string; vmid: number; name: string }): string =>
  t.kind === 'lxc' || t.kind === 'vm' ? `${host.name} → ${t.name} (${t.vmid})` : `${host.name} → ${t.name}`;

/** One import: validates the file against the current state, builds the preview and the list of writes. */
class ImportPlanner {
  private readonly errors: Record<string, string[]> = {};
  private readonly warnings: string[] = [];
  private readonly secrets: string[] = [];
  /** Writes in order; run inside one transaction. */
  private readonly writes: (() => void)[] = [];
  /** Removals run after all additions and updates (apps first, repositories last). */
  private readonly removals: (() => void)[] = [];
  private readonly removedHostIds: number[] = [];
  /** Repository id by `repositoryKey`, filled while applying (new repositories get their id then). */
  private readonly repoIds = new Map<string, number>();
  private repositoriesAdded = 0;
  private settingsWrite: (() => void) | null = null;

  constructor(
    private readonly deps: BackupServiceDeps,
    private readonly input: BackupInput,
    private readonly mode: ImportMode,
  ) {}

  plan(): ImportPlan {
    const sections = [this.planSettings(), ...this.planRepositoriesAndHosts(), this.planEndpoints()];
    if (Object.keys(this.errors).length > 0) {
      throw new BackupValidationError(this.errors);
    }
    const preview: ImportPreview = {
      mode: this.mode,
      appVersion: this.input.appVersion ?? null,
      exportedAt: this.input.exportedAt ?? null,
      sections,
      secretsToReenter: this.secrets,
      warnings: this.warnings,
    };
    return {
      preview,
      apply: () => {
        const db = this.deps.store.database;
        db.transaction(() => {
          for (const write of [...this.writes, ...this.removals]) write();
          this.settingsWrite?.();
        })();
        for (const id of this.removedHostIds) this.deps.onHostRemoved?.(id);
        return { repositoriesAdded: this.repositoriesAdded };
      },
    };
  }

  private error(path: string, message: string): void {
    (this.errors[path] ??= []).push(message);
  }

  // --- Settings ---

  private planSettings(): ImportSectionPreview {
    const section = emptySection('settings', 'Settings');
    const { settings } = this.deps;
    const current = settings.current;
    const incoming = this.input.settings ?? {};
    const exportable = new Set<string>(EXPORTABLE_SETTING_KEYS);
    const patch: SettingsPatch = {};

    for (const [key, raw] of Object.entries(incoming)) {
      if (!exportable.has(key)) {
        if (key in SECRET_SETTING_LABELS) this.warnings.push(`The secret setting "${settingLabel(key)}" in the file was skipped.`);
        continue;
      }
      const settingKey = key as SettingKey;
      const text = raw === null ? '' : String(raw).trim();
      if (text === '') continue;
      try {
        validateSetting(settingKey, text);
      } catch (error) {
        if (error instanceof SettingsValidationError) {
          this.error(`settings.${key}`, error.message);
          continue;
        }
        throw error;
      }
      const saved = settings.sourceOf(settingKey) === 'ui' ? String(current[settingKey]) : null;
      if (saved === text) {
        section.unchanged++;
        continue;
      }
      (patch as Record<string, string>)[key] = text;
      (saved === null ? section.added : section.updated).push(settingLabel(key));
    }
    if (this.mode === 'replace') {
      for (const key of EXPORTABLE_SETTING_KEYS) {
        const value = incoming[key];
        if (settings.sourceOf(key) === 'ui' && (value === undefined || value === null || String(value).trim() === '')) {
          (patch as Record<string, null>)[key] = null;
          section.removed.push(settingLabel(key));
        }
      }
    }
    // Secret settings the exporting instance had saved (listed in the file) and this one has not.
    const omitted = new Set(this.input.secretsOmitted ?? []);
    for (const [key, label] of Object.entries(SECRET_SETTING_LABELS) as [SettingKey, string][]) {
      if (omitted.has(label) && current[key] === null) this.secrets.push(label);
    }
    if (Object.keys(patch).length > 0) {
      // Last write of the transaction: listeners (cron jobs) see the imported values.
      this.settingsWrite = () => settings.update(patch);
    }
    return section;
  }

  // --- Repositories and machines ---

  private planRepositoriesAndHosts(): ImportSectionPreview[] {
    const repositories = this.planRepositories();
    const machines = this.planHosts();
    return [repositories, machines];
  }

  private planRepositories(): ImportSectionPreview {
    const section = emptySection('repositories', 'Repositories');
    const { store } = this.deps;
    const existing = new Map(store.list().map((r) => [repositoryKey(r), r]));
    const groups = groupsById(store.listGroups());
    const seen = new Set<string>();

    (this.input.repositories ?? []).forEach((raw, index) => {
      const path = `repositories[${index}]`;
      const parsed = backupRepositoryRef(raw);
      if (!parsed) {
        const name = fullName({ host: blank(raw.host), owner: raw.owner, name: raw.name });
        this.error(`${path}.name`, `"${name}" is not a valid ${PROVIDER_LABELS[raw.provider ?? 'github']} repository.`);
        return;
      }
      const key = repositoryKey(parsed);
      if (seen.has(key)) {
        this.error(`${path}.name`, `${fullName(parsed)} is listed twice.`);
        return;
      }
      seen.add(key);
      const item = this.normalizeRepository(raw, parsed, path);
      if (!item) return;
      const label = fullName(item);
      const current = existing.get(key);

      if (current) {
        this.repoIds.set(key, current.id);
        const missingHeaders = item.installedVersionHeaderNames.filter(
          (name) => !current.installedVersionHeaders.some((h) => h.name.toLowerCase() === name.toLowerCase()),
        );
        if (item.hasAccessToken && !current.accessToken) this.secrets.push(`${PROVIDER_LABELS[current.provider]} token of ${label}`);
        if (missingHeaders.length > 0) this.secrets.push(`Version URL headers of ${label} (${missingHeaders.join(', ')})`);
        // Secrets of an existing repository are kept, so they are not part of the comparison.
        const before = { ...exportRepository(current, groups), installedVersionHeaderNames: [], hasAccessToken: false };
        // The provider of a host is found when the repository is added and is not changed by an import.
        const after = { ...item, provider: current.provider, installedVersionHeaderNames: [], hasAccessToken: false };
        if (sameItem(before, after)) {
          section.unchanged++;
          return;
        }
        section.updated.push(label);
        this.writes.push(() => {
          const repo = store.get(current.id)!;
          applyRepository(repo, item, store);
          store.save(repo);
        });
        return;
      }

      if (item.hasAccessToken) this.secrets.push(`${PROVIDER_LABELS[item.provider]} token of ${label}`);
      if (item.installedVersionHeaderNames.length > 0) {
        this.secrets.push(`Version URL headers of ${label} (${item.installedVersionHeaderNames.join(', ')})`);
      }
      section.added.push(label);
      this.writes.push(() => {
        const repo = store.add(item.owner, item.name, item.includePrereleases, item);
        applyRepository(repo, item, store);
        store.save(repo);
        this.repoIds.set(key, repo.id);
        this.repositoriesAdded++;
      });
    });

    if (this.mode === 'replace') {
      for (const [key, repo] of existing) {
        if (seen.has(key)) continue;
        section.removed.push(fullName(repo));
        this.removals.push(() => store.delete(repo.id));
      }
    }
    return section;
  }

  private normalizeRepository(
    raw: NonNullable<BackupInput['repositories']>[number],
    parsed: RepositoryRef,
    path: string,
  ): BackupRepository | null {
    let ok = true;
    const icon = blank(raw.icon);
    const iconError = icon ? validateIcon(icon) : null;
    if (iconError) {
      this.error(`${path}.icon`, iconError);
      ok = false;
    }
    const groupName = normalizeGroupName(raw.groupName);
    const groupIcon = blank(raw.groupIcon);
    const groupIconError = groupIcon ? validateIcon(groupIcon) : null;
    if (groupIconError) {
      this.error(`${path}.groupIcon`, groupIconError);
      ok = false;
    }
    const url = blank(raw.installedVersionUrl);
    const urlError = url ? validateVersionUrl(url) : null;
    if (urlError) {
      this.error(`${path}.installedVersionUrl`, urlError);
      ok = false;
    }
    const locator = url
      ? normalizeLocator({
          format: raw.installedVersionFormat ?? null,
          field: raw.installedVersionField ?? null,
          pattern: raw.installedVersionPattern ?? null,
        })
      : autoLocator();
    for (const [field, messages] of Object.entries(validateLocator(locator) ?? {})) {
      messages.forEach((m) => this.error(`${path}.${field}`, m));
      ok = false;
    }
    const ecosystem = blank(raw.osvEcosystem);
    const osvPackage = blank(raw.osvPackage);
    if (ecosystem && !(OSV_ECOSYSTEMS as readonly string[]).includes(ecosystem)) {
      this.error(`${path}.osvEcosystem`, `Choose one of: ${OSV_ECOSYSTEMS.join(', ')}.`);
      ok = false;
    }
    if (!ecosystem !== !osvPackage) {
      this.error(`${path}.osvPackage`, 'Set both the ecosystem and the package name, or neither.');
      ok = false;
    }
    const versionPattern = normalizePattern(raw.versionPattern);
    const patternError = versionPattern === null ? null : validatePattern(versionPattern);
    if (patternError) {
      this.error(`${path}.versionPattern`, patternError);
      ok = false;
    }
    let webSource: WebSourceConfig | null = null;
    if (parsed.provider === 'web') {
      webSource = raw.webSource ? normalizeWebSource(raw.webSource) : null;
      const errors = webSource ? validateWebSource(webSource, versionPattern) : { url: ['A web source needs its URL and locators.'] };
      for (const [field, messages] of Object.entries(errors ?? {})) {
        // An invalid pattern was reported above; a missing one (format text) is not.
        if (field !== 'pattern') messages.forEach((m) => this.error(`${path}.webSource.${field}`, m));
        else if (!patternError) messages.forEach((m) => this.error(`${path}.versionPattern`, m));
        ok = false;
      }
      if (webSource && ok && webSourceHost(webSource.url) !== parsed.host) {
        this.error(`${path}.host`, `The host must be the one of the URL (${webSourceHost(webSource.url)}).`);
        ok = false;
      }
    }
    if (!ok) return null;
    return {
      provider: parsed.provider,
      host: parsed.host,
      owner: parsed.owner,
      name: parsed.name,
      includePrereleases: raw.includePrereleases ?? false,
      releaseSource: raw.releaseSource ?? 'releases',
      versionPattern,
      webSource,
      isEnabled: raw.isEnabled ?? true,
      icon,
      groupName,
      groupIcon: groupName ? groupIcon : null,
      installedVersionUrl: url,
      installedVersionField: locator.field,
      installedVersionFormat: locator.format,
      installedVersionPattern: locator.pattern,
      installedVersionHeaderNames: url ? (raw.installedVersionHeaderNames ?? []).map((n) => n.trim()).filter(Boolean) : [],
      installedVersion: url ? null : blank(raw.installedVersion),
      osvEcosystem: ecosystem,
      osvPackage,
      hasAccessToken: raw.hasAccessToken ?? false,
    };
  }

  private planHosts(): ImportSectionPreview {
    const section = emptySection('machines', 'Machines');
    const { hosts, containers } = this.deps;
    const existingHosts = new Map(hosts.listHosts().map((h) => [hostKey(h), h]));
    const allTargets = containers.list();
    const allApps = containers.listApps();
    const keyIds = new Map([...hosts.keyNames()].map(([id, name]) => [name.toLowerCase(), id]));
    const repoNames = repositoryRefs(this.deps.store.list());
    const seen = new Set<string>();

    (this.input.hosts ?? []).forEach((raw, index) => {
      const path = `hosts[${index}]`;
      const type = raw.type as HostType;
      if (!(HOST_TYPES as readonly string[]).includes(raw.type)) {
        this.error(`${path}.type`, `Use one of: ${HOST_TYPES.join(', ')}.`);
        return;
      }
      const input = {
        type,
        name: raw.name.trim(),
        address: raw.address.trim(),
        port: raw.port ?? DEFAULT_SSH_PORT,
        user: blank(raw.user) ?? DEFAULT_SSH_USER,
        sshKeyId: null,
        backupStorage: type === 'proxmox' ? blank(raw.backupStorage) : null,
      };
      const hostErrors = validateHost(input);
      for (const [field, message] of Object.entries(hostErrors)) {
        if (message) this.error(`${path}.${field}`, message);
      }
      if (Object.keys(hostErrors).length > 0) return;
      const key = hostKey(input);
      if (seen.has(key)) {
        this.error(`${path}.address`, `${input.address}:${input.port} is listed twice.`);
        return;
      }
      seen.add(key);

      const keyName = blank(raw.sshKeyName);
      const keyId = keyName ? (keyIds.get(keyName.toLowerCase()) ?? null) : null;
      const current = existingHosts.get(key) ?? null;
      const currentTargets = current ? allTargets.filter((t) => t.hostId === current.id) : [];
      const targets = this.normalizeTargets(raw.targets ?? [], type, input.name, path);
      if (!targets) return;
      if (keyName && keyId === null && current?.sshKeyId == null) {
        this.secrets.push(`SSH key "${keyName}" for ${input.name} (add the key and choose it for the machine)`);
      }
      for (const t of targets) {
        const before = currentTargets.find((c) => targetKey(c) === targetKey(t));
        if (t.hasHomeAssistantToken && !before?.homeAssistantToken) this.secrets.push(`Home Assistant token of ${t.name}`);
      }

      if (current) {
        const before = exportHost(current, hosts.keyNames(), currentTargets, allApps, repoNames);
        // A key that does not exist here keeps the one the machine already uses.
        const sshKeyId = keyId ?? current.sshKeyId;
        const { sshKeyId: _unused, ...fields } = input;
        const after: BackupHost = {
          ...fields,
          sshKeyName: sshKeyId === null ? null : (hosts.keyNames().get(sshKeyId) ?? null),
          targets: [],
        };
        const changes = this.planTargets(current, currentTargets, allApps, targets);
        if (sameItem({ ...before, targets: [] }, { ...after, targets: [] }) && !changes) {
          section.unchanged++;
          return;
        }
        section.updated.push(input.name);
        this.writes.push(() => {
          hosts.saveHost({ ...current, ...input, sshKeyId });
        });
        return;
      }

      section.added.push(input.name);
      this.writes.push(() => {
        const host = hosts.addHost({ ...input, sshKeyId: keyId });
        this.writeTargets(host, [], [], targets);
      });
    });

    if (this.mode === 'replace') {
      for (const [key, host] of existingHosts) {
        if (seen.has(key)) continue;
        section.removed.push(host.name);
        const targets = allTargets.filter((t) => t.hostId === host.id);
        const busy = targets.find((t) => this.deps.isBusy(t.id));
        if (busy) {
          throw new BackupConflictError(`A task is running on ${busy.name} – wait for it to finish before replacing the configuration.`);
        }
        this.removals.unshift(() => {
          for (const t of targets) containers.delete(t.id);
          hosts.deleteHost(host.id);
        });
        this.removedHostIds.push(host.id);
      }
    }
    return section;
  }

  /**
   * Plans the writes of the targets of an existing host; returns true when anything changes. Targets and apps
   * missing from the file are removed only in replace mode.
   */
  private planTargets(host: Host, currentTargets: readonly Container[], allApps: readonly ContainerApp[], targets: readonly BackupTarget[]): boolean {
    const repoNames = repositoryRefs(this.deps.store.list());
    let changed = false;
    for (const t of targets) {
      const current = currentTargets.find((c) => targetKey(c) === targetKey(t));
      if (!current) {
        changed = true;
        continue;
      }
      const apps = allApps.filter((a) => a.containerId === current.id);
      const before = exportTarget(current, apps, repoNames);
      const after = { ...t, apps: this.mode === 'replace' ? t.apps : mergeApps(before.apps, t.apps) };
      // The token is kept (never exported), so only the URL and the install switch count.
      if (!sameItem({ ...before, hasHomeAssistantToken: false }, { ...after, hasHomeAssistantToken: false })) changed = true;
    }
    const keys = new Set(targets.map(targetKey));
    const removed = this.mode === 'replace' ? currentTargets.filter((c) => !keys.has(targetKey(c))) : [];
    for (const c of removed) {
      if (this.deps.isBusy(c.id)) {
        throw new BackupConflictError(`A task is running on ${c.name} – wait for it to finish before replacing the configuration.`);
      }
      changed = true;
    }
    if (changed) {
      this.writes.push(() => this.writeTargets(host, currentTargets, allApps, targets));
      if (removed.length > 0) {
        this.removals.unshift(() => {
          for (const c of removed) this.deps.containers.delete(c.id);
        });
      }
    }
    return changed;
  }

  /** Adds or updates the targets of `host` (and their apps) from the file. */
  private writeTargets(host: Host, currentTargets: readonly Container[], allApps: readonly ContainerApp[], targets: readonly BackupTarget[]): void {
    const { containers } = this.deps;
    for (const t of targets) {
      let container = currentTargets.find((c) => targetKey(c) === targetKey(t)) ?? null;
      const isNew = container === null;
      if (container) {
        container = containers.get(container.id)!;
      } else if (t.kind === 'node') {
        container = containers.addNode(host.id, t.name);
      } else if (t.kind === 'server') {
        container = containers.getServer(host.id) ?? containers.addServer(host.id, t.name);
      } else {
        container = containers.add(host.id, t.vmid, t.name, t.kind as 'lxc' | 'vm');
      }
      const dockerWasEnabled = container.dockerEnabled;
      applyTarget(container, t);
      containers.save(container);
      if (!isNew && dockerWasEnabled && !container.dockerEnabled) this.deps.onDockerDisabled?.(container);

      if (!capabilities(container.kind).apps) continue;
      const apps = isNew ? [] : allApps.filter((a) => a.containerId === container.id);
      for (const app of t.apps) {
        const input = this.appInput(app);
        const existing = apps.find((a) => appKey(a) === appKey(app));
        let saved: ContainerApp;
        if (existing) {
          saved = containers.getApp(container.id, existing.id)!;
          Object.assign(saved, input);
          if (!input.versionCommand && app.installedVersion !== null) saved.installedVersion = app.installedVersion;
          containers.saveApp(saved);
        } else {
          saved = containers.addApp(container.id, input);
          if (!input.versionCommand && app.installedVersion !== null) {
            saved.installedVersion = app.installedVersion;
            containers.saveApp(saved);
          }
        }
        this.writeInstalledVersionSource(saved, app.isInstalledVersionSource);
      }
      if (this.mode === 'replace') {
        const keep = new Set(t.apps.map(appKey));
        for (const a of apps) {
          if (!keep.has(appKey(a))) containers.deleteApp(container.id, a.id);
        }
      }
    }
  }

  /**
   * Makes the app the source of its repository's installed version, as the file says – or stops reading the version
   * from it (the last one stays as entered by hand).
   */
  private writeInstalledVersionSource(app: ContainerApp, isSource: boolean): void {
    const { store } = this.deps;
    if (isSource && app.repositoryId !== null) {
      store.setInstalledVersionApp(app.repositoryId, { kind: 'app', id: app.id });
      return;
    }
    for (const repo of store.list()) {
      if (repo.installedVersionApp?.kind === 'app' && repo.installedVersionApp.id === app.id) {
        store.setInstalledVersionApp(repo.id, null);
      }
    }
  }

  private appInput(app: BackupApp): AppInput {
    const repositoryId = app.latestSource === 'repository' && app.repository ? (this.repoIds.get(app.repository.toLowerCase()) ?? null) : null;
    return {
      name: app.name,
      versionCommand: app.versionCommand,
      latestSource: (app.latestSource === 'repository' && repositoryId === null ? 'none' : app.latestSource) as LatestSource,
      repositoryId,
      latestCommand: app.latestCommand,
      updateCommand: app.updateCommand,
      useTty: app.useTty,
      timeoutSeconds: app.timeoutSeconds,
    };
  }

  /** Normalizes and validates the targets of one host; null when any of them is invalid. */
  private normalizeTargets(
    raw: NonNullable<NonNullable<BackupInput['hosts']>[number]['targets']>,
    type: HostType,
    hostName: string,
    hostPath: string,
  ): BackupTarget[] | null {
    const allowed: readonly TargetKind[] = type === 'proxmox' ? [...GUEST_KINDS, 'node'] : ['server'];
    const result: BackupTarget[] = [];
    const seen = new Set<string>();
    let ok = true;
    const fail = (path: string, message: string) => {
      this.error(path, message);
      ok = false;
    };
    // Repositories the imported apps may link to: the file's, plus the existing ones when merging.
    const knownRepos = new Set(
      (this.input.repositories ?? []).map((r) => repositoryKey({ host: blank(r.host), owner: r.owner.trim(), name: r.name.trim() })),
    );
    if (this.mode === 'merge') {
      for (const r of this.deps.store.list()) knownRepos.add(repositoryKey(r));
    }

    raw.forEach((t, index) => {
      const path = `${hostPath}.targets[${index}]`;
      if (!(allowed as readonly string[]).includes(t.kind)) {
        fail(`${path}.kind`, `A ${type === 'proxmox' ? 'Proxmox node' : 'server'} cannot have a target of kind "${t.kind}".`);
        return;
      }
      const kind = t.kind as TargetKind;
      const vmid = kind === 'lxc' || kind === 'vm' ? t.vmid : NODE_VMID;
      if ((kind === 'lxc' || kind === 'vm') && vmid < 1) {
        fail(`${path}.vmid`, 'Enter the VMID of the guest.');
        return;
      }
      const key = targetKey({ kind, vmid });
      if (seen.has(key) || (kind !== 'node' && kind !== 'server' && seen.has(targetKey({ kind: kind === 'lxc' ? 'vm' : 'lxc', vmid })))) {
        fail(`${path}.vmid`, `${hostName} lists the target ${vmid} twice.`);
        return;
      }
      if (kind === 'server' && seen.size > 0) {
        fail(`${path}.kind`, 'A server has only one target.');
        return;
      }
      seen.add(key);
      const name = t.name.trim();
      if (!name) fail(`${path}.name`, 'Enter a name.');
      const can = capabilities(kind);
      const checkCron = blank(t.checkCron);
      const cronError = checkCron ? validateCron(checkCron) : null;
      if (cronError) fail(`${path}.checkCron`, cronError);
      const cores = can.updateResources ? (t.updateCores ?? null) : null;
      if (cores !== null && (cores < MIN_UPDATE_CORES || cores > MAX_UPDATE_CORES)) {
        fail(`${path}.updateCores`, `CPU cores must be between ${MIN_UPDATE_CORES} and ${MAX_UPDATE_CORES}.`);
      }
      const memory = can.updateResources ? (t.updateMemoryMb ?? null) : null;
      if (memory !== null && (memory < MIN_UPDATE_MEMORY_MB || memory > MAX_UPDATE_MEMORY_MB)) {
        fail(`${path}.updateMemoryMb`, `Memory must be between ${MIN_UPDATE_MEMORY_MB} and ${MAX_UPDATE_MEMORY_MB} MiB.`);
      }
      let homeAssistantUrl = can.homeAssistant ? blank(t.homeAssistantUrl) : null;
      if (homeAssistantUrl) {
        const normalized = normalizeHomeAssistantUrl(homeAssistantUrl);
        if ('error' in normalized) fail(`${path}.homeAssistantUrl`, normalized.error);
        else homeAssistantUrl = normalized.url;
      }

      const apps: BackupApp[] = [];
      const appNames = new Set<string>();
      if (can.apps) {
        (t.apps ?? []).forEach((a, appIndex) => {
          const appPath = `${path}.apps[${appIndex}]`;
          const appName = a.name.trim();
          if (!appName) {
            fail(`${appPath}.name`, 'Enter a name.');
            return;
          }
          if (appNames.has(appName.toLowerCase())) {
            fail(`${appPath}.name`, `${name} lists the application ${appName} twice.`);
            return;
          }
          appNames.add(appName.toLowerCase());
          const source = a.latestSource ?? 'none';
          if (!(LATEST_SOURCES as readonly string[]).includes(source)) {
            fail(`${appPath}.latestSource`, `Use one of: ${LATEST_SOURCES.join(', ')}.`);
            return;
          }
          const latestCommand = source === 'command' ? blank(a.latestCommand) : null;
          if (source === 'command' && !latestCommand) {
            fail(`${appPath}.latestCommand`, 'Enter a command that prints the latest version.');
          }
          const timeoutSeconds = a.timeoutSeconds ?? DEFAULT_APP_TIMEOUT_SECONDS;
          if (timeoutSeconds < MIN_APP_TIMEOUT_SECONDS || timeoutSeconds > MAX_APP_TIMEOUT_SECONDS) {
            fail(`${appPath}.timeoutSeconds`, `Timeout must be between ${MIN_APP_TIMEOUT_SECONDS} and ${MAX_APP_TIMEOUT_SECONDS} seconds.`);
          }
          let repository = source === 'repository' ? blank(a.repository) : null;
          let latestSource = source;
          if (source === 'repository' && (!repository || !knownRepos.has(repository.toLowerCase()))) {
            this.warnings.push(
              `${appName} on ${name}: the repository ${repository ?? '(none)'} is not watched, so its latest version is not looked up.`,
            );
            repository = null;
            latestSource = 'none';
          }
          const versionCommand = blank(a.versionCommand);
          apps.push({
            name: appName,
            versionCommand,
            latestSource,
            repository,
            latestCommand,
            updateCommand: blank(a.updateCommand),
            useTty: a.useTty ?? false,
            timeoutSeconds,
            installedVersion: versionCommand ? null : blank(a.installedVersion),
            // Only an app linked to a repository can be the source of its installed version.
            isInstalledVersionSource: repository !== null && (a.isInstalledVersionSource ?? false),
          });
        });
      }

      result.push({
        kind,
        vmid,
        name,
        isEnabled: t.isEnabled ?? true,
        packagesEnabled: !can.packagesOptional || (t.packagesEnabled ?? true),
        backupBeforeUpdate: can.backup === null ? null : (t.backupBeforeUpdate ?? null),
        startWhenStopped: can.power && (t.startWhenStopped ?? false),
        checkCron,
        updateCores: cores,
        updateMemoryMb: memory,
        dockerEnabled: t.dockerEnabled ?? true,
        homeAssistantUrl,
        homeAssistantInstall: can.homeAssistant && (t.homeAssistantInstall ?? false),
        hasHomeAssistantToken: can.homeAssistant && (t.hasHomeAssistantToken ?? false),
        apps,
      });
    });
    if (type === 'server' && result.length === 0) {
      // A server always has its one target.
      result.push(defaultServerTarget(hostName));
    }
    return ok ? result : null;
  }

  // --- Docker endpoints ---

  private planEndpoints(): ImportSectionPreview {
    const section = emptySection('dockerEndpoints', 'Docker endpoints');
    const { docker } = this.deps;
    const existing = new Map(docker.listEndpoints().map((e) => [e.url, e]));
    const seen = new Set<string>();

    (this.input.dockerEndpoints ?? []).forEach((raw, index) => {
      const path = `dockerEndpoints[${index}]`;
      const name = raw.name.trim();
      if (!name) {
        this.error(`${path}.name`, 'Enter a name.');
        return;
      }
      const parsed = parseEndpointUrl(raw.url);
      if ('error' in parsed) {
        this.error(`${path}.url`, parsed.error);
        return;
      }
      if (seen.has(parsed.url)) {
        this.error(`${path}.url`, `${parsed.url} is listed twice.`);
        return;
      }
      seen.add(parsed.url);
      const item: BackupDockerEndpoint = { name, url: parsed.url, isEnabled: raw.isEnabled ?? true };
      const current = existing.get(parsed.url);
      if (current) {
        if (sameItem(exportEndpoint(current), item)) {
          section.unchanged++;
          return;
        }
        section.updated.push(name);
        this.writes.push(() => docker.saveEndpoint({ ...current, ...item }));
        return;
      }
      section.added.push(name);
      this.writes.push(() => {
        const endpoint = docker.addEndpoint(item.name, item.url);
        if (!item.isEnabled) docker.saveEndpoint({ ...endpoint, isEnabled: false });
      });
    });

    if (this.mode === 'replace') {
      for (const [url, endpoint] of existing) {
        if (seen.has(url)) continue;
        section.removed.push(endpoint.name);
        this.removals.push(() => docker.deleteEndpoint(endpoint.id));
      }
    }
    return section;
  }
}

/**
 * Repository of a backup entry: GitHub (no host), a Gitea/Forgejo or GitLab instance, or a web source (host of its URL,
 * owner `web`, its name); null when invalid.
 */
function backupRepositoryRef(raw: NonNullable<BackupInput['repositories']>[number]): RepositoryRef | null {
  const provider = raw.provider ?? 'github';
  const host = blank(raw.host);
  const owner = raw.owner.trim();
  const name = raw.name.trim();
  if (provider === 'web') {
    const webName = normalizeWebSourceName(name);
    return host && owner === WEB_OWNER && webSourceNameError(webName) === null ? { provider, host: host.toLowerCase(), owner, name: webName! } : null;
  }
  if (provider === 'github') {
    const parsed = host === null ? parseRepositoryName(`${owner}/${name}`) : null;
    return parsed ? { provider, host: null, ...parsed } : null;
  }
  const parsed = host === null ? null : parseRepositoryReference(`https://${host}/${owner}/${name}`);
  if (!parsed?.host || parsed.owner !== owner || parsed.name !== name || (provider === 'gitea' && owner.includes('/'))) {
    return null;
  }
  return { provider, host: parsed.host, owner, name };
}

function applyRepository(repo: WatchedRepository, item: BackupRepository, store: RepositoryStore): void {
  if (repo.includePrereleases !== item.includePrereleases) {
    // Filter changed: force a full fetch on the next check.
    repo.releasesEtag = null;
  }
  repo.includePrereleases = item.includePrereleases;
  if (repo.provider === 'web' && item.webSource) {
    setWebSource(repo, item.webSource, item.versionPattern);
  } else {
    setReleaseSource(repo, item.releaseSource, item.versionPattern);
  }
  repo.isEnabled = item.isEnabled;
  repo.icon = item.icon;
  // The group is found by name (or created); its icon is the one in the file.
  repo.groupId = item.groupName ? store.ensureGroup(item.groupName) : null;
  if (repo.groupId !== null) store.updateGroup(repo.groupId, { icon: item.groupIcon });
  if (
    repo.installedVersionUrl !== item.installedVersionUrl ||
    repo.installedVersionField !== item.installedVersionField ||
    repo.installedVersionFormat !== item.installedVersionFormat ||
    repo.installedVersionPattern !== item.installedVersionPattern
  ) {
    // Read again by the next check.
    repo.installedVersion = null;
    repo.installedVersionCheckedAt = null;
    repo.installedVersionError = null;
  }
  repo.installedVersionUrl = item.installedVersionUrl;
  repo.installedVersionField = item.installedVersionField;
  repo.installedVersionFormat = item.installedVersionFormat;
  repo.installedVersionPattern = item.installedVersionPattern;
  // Header values are secrets: keep the saved ones the file still names, drop the others.
  const names = new Set(item.installedVersionHeaderNames.map((n) => n.toLowerCase()));
  repo.installedVersionHeaders = item.installedVersionUrl ? repo.installedVersionHeaders.filter((h) => names.has(h.name.toLowerCase())) : [];
  if (!item.installedVersionUrl && item.installedVersion !== null) {
    repo.installedVersion = item.installedVersion;
  }
  if (repo.osvEcosystem !== item.osvEcosystem || repo.osvPackage !== item.osvPackage) {
    repo.advisoriesEtag = null;
  }
  repo.osvEcosystem = item.osvEcosystem;
  repo.osvPackage = item.osvPackage;
}

function applyTarget(c: Container, t: BackupTarget): void {
  const can = capabilities(c.kind);
  c.name = t.name;
  c.isEnabled = t.isEnabled;
  c.packagesEnabled = t.packagesEnabled;
  if (!c.packagesEnabled) c.packageUpdates = [];
  c.backupBeforeUpdate = t.backupBeforeUpdate;
  c.startWhenStopped = t.startWhenStopped;
  c.checkCron = t.checkCron;
  c.updateCores = t.updateCores;
  c.updateMemoryMb = t.updateMemoryMb;
  c.dockerEnabled = t.dockerEnabled;
  c.homeAssistantUrl = t.homeAssistantUrl;
  c.homeAssistantInstall = t.homeAssistantInstall;
  if (!can.homeAssistant || t.homeAssistantUrl === null) {
    // A token without its URL cannot be used.
    c.homeAssistantToken = null;
  }
}

function mergeApps(before: readonly BackupApp[], incoming: readonly BackupApp[]): BackupApp[] {
  const keys = new Set(incoming.map(appKey));
  return [...before.filter((a) => !keys.has(appKey(a))), ...incoming];
}

function defaultServerTarget(name: string): BackupTarget {
  return {
    kind: 'server',
    vmid: NODE_VMID,
    name,
    isEnabled: true,
    packagesEnabled: true,
    backupBeforeUpdate: null,
    startWhenStopped: false,
    checkCron: null,
    updateCores: null,
    updateMemoryMb: null,
    dockerEnabled: true,
    homeAssistantUrl: null,
    homeAssistantInstall: false,
    hasHomeAssistantToken: false,
    apps: [],
  };
}
