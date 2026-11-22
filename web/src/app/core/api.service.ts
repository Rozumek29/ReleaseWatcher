import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map, Observable } from 'rxjs';
import {
  AddRepositoryRequest,
  AdvisoryPage,
  AdvisoryQuery,
  AppSettings,
  AppStatus,
  BackupStorage,
  CheckResult,
  Container,
  ContainerApp,
  ContainerAppRequest,
  DetectedApp,
  DiscoveredContainer,
  HeaderInput,
  Host,
  HostInput,
  InstalledVersionTestResult,
  Notifier,
  RateLimit,
  Run,
  RunPage,
  RunSummary,
  SecurityAdvisory,
  SelfhstIcon,
  SettingsPatch,
  SshKey,
  TestNotificationResult,
  UpdateContainerRequest,
  UpdateRepositoryRequest,
  WatchedRepository,
} from './models';

/** Icon list of https://github.com/selfhst/icons, served by jsDelivr (CORS enabled) – loaded by the browser. */
export const SELFHST_INDEX_URL = 'https://cdn.jsdelivr.net/gh/selfhst/icons/index.json';

interface SelfhstIndexEntry {
  Name?: string;
  Reference?: string;
  SVG?: string;
  Light?: string;
  Dark?: string;
  Category?: string;
  Tags?: string;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api';

  /** All icons of selfh.st/icons (about 3,000) – an external request, not one to the ReleaseWatcher API. */
  getSelfhstIcons(): Observable<SelfhstIcon[]> {
    const yes = (value: string | undefined) => value?.toLowerCase() === 'yes';
    return this.http.get<SelfhstIndexEntry[]>(SELFHST_INDEX_URL).pipe(
      map((entries) =>
        entries
          .filter((e) => !!e.Reference && !!e.Name)
          .map((e) => ({
            name: e.Name!,
            reference: e.Reference!,
            svg: yes(e.SVG),
            light: yes(e.Light),
            dark: yes(e.Dark),
            category: e.Category ?? '',
            tags: (e.Tags ?? '').split(',').map((t) => t.trim()).filter(Boolean),
          })),
      ),
    );
  }

  getRepositories(): Observable<WatchedRepository[]> {
    return this.http.get<WatchedRepository[]>(`${this.baseUrl}/repositories`);
  }

  addRepository(request: AddRepositoryRequest): Observable<WatchedRepository> {
    return this.http.post<WatchedRepository>(`${this.baseUrl}/repositories`, request);
  }

  updateRepository(id: number, request: UpdateRepositoryRequest): Observable<WatchedRepository> {
    return this.http.put<WatchedRepository>(`${this.baseUrl}/repositories/${id}`, request);
  }

  /** Sets the installed version (entered by hand) to the latest release. */
  markRepositoryInstalled(id: number): Observable<WatchedRepository> {
    return this.http.post<WatchedRepository>(`${this.baseUrl}/repositories/${id}/mark-installed`, {});
  }

  deleteRepository(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/repositories/${id}`);
  }

  /** One page of the advisories of all repositories (filters applied by the server). */
  getAdvisoryPage(query: AdvisoryQuery = {}): Observable<AdvisoryPage> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '' && value !== 'all') {
        params = params.set(key, String(value));
      }
    }
    return this.http.get<AdvisoryPage>(`${this.baseUrl}/advisories`, { params });
  }

  getAdvisories(id: number): Observable<SecurityAdvisory[]> {
    return this.http.get<SecurityAdvisory[]>(`${this.baseUrl}/repositories/${id}/advisories`);
  }

  checkNow(id: number): Observable<CheckResult> {
    return this.http.post<CheckResult>(`${this.baseUrl}/repositories/${id}/check`, {});
  }

  checkAll(): Observable<AppStatus> {
    return this.http.post<AppStatus>(`${this.baseUrl}/check-all`, {});
  }

  getStatus(): Observable<AppStatus> {
    return this.http.get<AppStatus>(`${this.baseUrl}/status`);
  }

  getNotifiers(): Observable<Notifier[]> {
    return this.http.get<Notifier[]>(`${this.baseUrl}/notifiers`);
  }

  /** Sends a sample release to every enabled channel, or only to `notifier` (e.g. "email"). */
  sendTestNotification(notifier?: string): Observable<TestNotificationResult> {
    return this.http.post<TestNotificationResult>(`${this.baseUrl}/notifiers/test`, notifier ? { notifier } : {});
  }

  getSettings(): Observable<AppSettings> {
    return this.http.get<AppSettings>(`${this.baseUrl}/settings`);
  }

  updateSettings(patch: SettingsPatch): Observable<AppSettings> {
    return this.http.put<AppSettings>(`${this.baseUrl}/settings`, patch);
  }

  testInstalledVersion(
    url: string,
    field: string | null,
    headers: HeaderInput[],
    repositoryId: number | null,
  ): Observable<InstalledVersionTestResult> {
    return this.http.post<InstalledVersionTestResult>(`${this.baseUrl}/installed-version/test`, {
      url,
      field,
      headers,
      repositoryId,
    });
  }

  getRateLimit(): Observable<RateLimit | null> {
    return this.http.get<RateLimit | null>(`${this.baseUrl}/github/rate-limit`);
  }

  /* ---------- SSH keys and hosts ---------- */

  getSshKeys(): Observable<SshKey[]> {
    return this.http.get<SshKey[]>(`${this.baseUrl}/ssh-keys`);
  }

  addSshKey(name: string, privateKey: string): Observable<SshKey> {
    return this.http.post<SshKey>(`${this.baseUrl}/ssh-keys`, { name, privateKey });
  }

  /** Creates a new Ed25519 key pair on the server; only the public key is returned. */
  generateSshKey(name: string): Observable<SshKey> {
    return this.http.post<SshKey>(`${this.baseUrl}/ssh-keys/generate`, { name });
  }

  renameSshKey(id: number, name: string): Observable<SshKey> {
    return this.http.put<SshKey>(`${this.baseUrl}/ssh-keys/${id}`, { name });
  }

  deleteSshKey(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/ssh-keys/${id}`);
  }

  getHosts(): Observable<Host[]> {
    return this.http.get<Host[]>(`${this.baseUrl}/hosts`);
  }

  addHost(input: HostInput): Observable<Host> {
    return this.http.post<Host>(`${this.baseUrl}/hosts`, input);
  }

  updateHost(id: number, input: HostInput): Observable<Host> {
    return this.http.put<Host>(`${this.baseUrl}/hosts/${id}`, input);
  }

  deleteHost(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/hosts/${id}`);
  }

  testHost(id: number): Observable<{ output: string }> {
    return this.http.post<{ output: string }>(`${this.baseUrl}/hosts/${id}/test`, {});
  }

  forgetHostKey(id: number): Observable<void> {
    return this.http.post<void>(`${this.baseUrl}/hosts/${id}/forget-host-key`, {});
  }

  /* ---------- Proxmox containers ---------- */

  /** Guests of a Proxmox node (null = the default node). */
  discoverContainers(hostId: number | null = null): Observable<DiscoveredContainer[]> {
    return this.http.get<DiscoveredContainer[]>(`${this.baseUrl}/proxmox/containers${hostQuery(hostId)}`);
  }

  /** Storages of a Proxmox node that accept backups (null = the default node). */
  getBackupStorages(hostId: number | null = null): Observable<BackupStorage[]> {
    return this.http.get<BackupStorage[]>(`${this.baseUrl}/proxmox/storages${hostQuery(hostId)}`);
  }

  getContainers(): Observable<Container[]> {
    return this.http.get<Container[]>(`${this.baseUrl}/containers`);
  }

  getContainer(id: number): Observable<Container> {
    return this.http.get<Container>(`${this.baseUrl}/containers/${id}`);
  }

  addContainer(vmid: number, name: string | null = null, hostId: number | null = null): Observable<Container> {
    return this.http.post<Container>(`${this.baseUrl}/containers`, hostId === null ? { vmid, name } : { vmid, name, hostId });
  }

  updateContainer(id: number, request: UpdateContainerRequest): Observable<Container> {
    return this.http.put<Container>(`${this.baseUrl}/containers/${id}`, request);
  }

  deleteContainer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/containers/${id}`);
  }

  /** Adds the Proxmox host itself as a target (apt check and dist-upgrade). */
  addNode(hostId: number | null = null): Observable<Container> {
    return this.http.post<Container>(`${this.baseUrl}/containers/node${hostQuery(hostId)}`, {});
  }

  /** Adds every container of the node that has not been added yet; returns the added ones. */
  addAllContainers(hostId: number | null = null): Observable<Container[]> {
    return this.http.post<Container[]>(`${this.baseUrl}/containers/add-all${hostQuery(hostId)}`, {});
  }

  checkAllContainers(): Observable<{ queued: number }> {
    return this.http.post<{ queued: number }>(`${this.baseUrl}/containers/check-all`, {});
  }

  /**
   * Updates every container with pending updates, one after another (not the Proxmox host).
   * `backup: false` skips backups; `true` backs up the containers set to back up before updates.
   */
  /** Updates the containers in `ids` (omitted = every container with pending updates) one after another. */
  updateAllContainers(backup: boolean, ids?: number[]): Observable<{ containers: number; updates: number }> {
    return this.http.post<{ containers: number; updates: number }>(
      `${this.baseUrl}/containers/update-all`,
      ids ? { backup, ids } : { backup },
    );
  }

  /**
   * Runs every pending update of one container (apt, then applications) one after another.
   * `backup` decides about one backup (vzdump) before the first update.
   */
  runContainerUpdates(
    id: number,
    backup: boolean,
  ): Observable<{ containers: number; updates: number }> {
    return this.http.post<{ containers: number; updates: number }>(
      `${this.baseUrl}/containers/${id}/update-all`,
      { backup },
    );
  }

  checkContainer(id: number): Observable<Run> {
    return this.http.post<Run>(`${this.baseUrl}/containers/${id}/check`, {});
  }

  /** Restarts a container, or schedules a restart of the Proxmox host. */
  restartContainer(id: number): Observable<Run> {
    return this.http.post<Run>(`${this.baseUrl}/containers/${id}/restart`, {});
  }

  /** `backup` decides about a backup (vzdump) before this update. */
  upgradeApt(id: number, backup: boolean): Observable<Run> {
    return this.http.post<Run>(`${this.baseUrl}/containers/${id}/apt-upgrade`, { backup });
  }

  /**
   * Installs Home Assistant updates of a Home Assistant OS virtual machine: `ids` selects them (omitted = every one
   * that can be installed from here). `backup` decides about a backup (vzdump) first.
   */
  updateHomeAssistant(id: number, backup: boolean, ids?: string[]): Observable<Run> {
    return this.http.post<Run>(`${this.baseUrl}/containers/${id}/home-assistant-update`, {
      backup,
      ...(ids ? { ids } : {}),
    });
  }

  /** Applications found in a running container with their GitHub repository (suggestions, nothing is saved). */
  detectContainerApps(containerId: number): Observable<DetectedApp[]> {
    return this.http.post<DetectedApp[]>(`${this.baseUrl}/containers/${containerId}/detect-apps`, {});
  }

  addContainerApp(containerId: number, request: ContainerAppRequest): Observable<ContainerApp> {
    return this.http.post<ContainerApp>(`${this.baseUrl}/containers/${containerId}/apps`, request);
  }

  updateContainerApp(
    containerId: number,
    appId: number,
    request: ContainerAppRequest,
  ): Observable<ContainerApp> {
    return this.http.put<ContainerApp>(
      `${this.baseUrl}/containers/${containerId}/apps/${appId}`,
      request,
    );
  }

  /** Sets the installed version of an app without a version command to its latest version. */
  markAppInstalled(containerId: number, appId: number): Observable<ContainerApp> {
    return this.http.post<ContainerApp>(
      `${this.baseUrl}/containers/${containerId}/apps/${appId}/mark-installed`,
      {},
    );
  }

  deleteContainerApp(containerId: number, appId: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/containers/${containerId}/apps/${appId}`);
  }

  /** `backup` decides about a backup (vzdump) before this update. */
  updateApp(containerId: number, appId: number, backup: boolean): Observable<Run> {
    return this.http.post<Run>(`${this.baseUrl}/containers/${containerId}/apps/${appId}/update`, {
      backup,
    });
  }

  getContainerRuns(containerId: number): Observable<RunSummary[]> {
    return this.http.get<RunSummary[]>(`${this.baseUrl}/containers/${containerId}/runs`);
  }

  /** `after` = `outputCursor` of the previous answer: only output written since then is returned. */
  getRun(id: number, after: string | null = null): Observable<RunPage> {
    return this.http.get<RunPage>(`${this.baseUrl}/runs/${id}`, after ? { params: { after } } : {});
  }
}

/** Extracts a human readable message from a problem-details response. */
/** `?hostId=…` for requests about one Proxmox node; empty for the default node. */
const hostQuery = (hostId: number | null): string => (hostId === null ? '' : `?hostId=${hostId}`);

export function describeError(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const problem = error.error as { title?: string; detail?: string; errors?: Record<string, string[]> } | null;
    const validation = problem?.errors ? Object.values(problem.errors).flat().join(' ') : null;
    return validation || problem?.detail || problem?.title || error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Field validation errors of a problem-details response (`errors`), one message per field; null when none. */
export function fieldErrors(error: unknown): Record<string, string> | null {
  const errors = (error as { error?: { errors?: Record<string, string[]> } } | null)?.error?.errors;
  return errors ? Object.fromEntries(Object.entries(errors).map(([k, v]) => [k, v.join(' ')])) : null;
}
