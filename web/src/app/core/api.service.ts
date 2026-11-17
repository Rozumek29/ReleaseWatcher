import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AddRepositoryRequest,
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
  InstalledVersionTestResult,
  Notifier,
  RateLimit,
  Run,
  RunPage,
  RunSummary,
  SettingsPatch,
  TestNotificationResult,
  UpdateContainerRequest,
  UpdateRepositoryRequest,
  WatchedRepository,
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = '/api';

  getRepositories(): Observable<WatchedRepository[]> {
    return this.http.get<WatchedRepository[]>(`${this.baseUrl}/repositories`);
  }

  addRepository(request: AddRepositoryRequest): Observable<WatchedRepository> {
    return this.http.post<WatchedRepository>(`${this.baseUrl}/repositories`, request);
  }

  updateRepository(id: number, request: UpdateRepositoryRequest): Observable<WatchedRepository> {
    return this.http.put<WatchedRepository>(`${this.baseUrl}/repositories/${id}`, request);
  }

  deleteRepository(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/repositories/${id}`);
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

  sendTestNotification(): Observable<TestNotificationResult> {
    return this.http.post<TestNotificationResult>(`${this.baseUrl}/notifiers/test`, {});
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

  /* ---------- Proxmox containers ---------- */

  testProxmoxConnection(): Observable<{ output: string }> {
    return this.http.post<{ output: string }>(`${this.baseUrl}/proxmox/test`, {});
  }

  discoverContainers(): Observable<DiscoveredContainer[]> {
    return this.http.get<DiscoveredContainer[]>(`${this.baseUrl}/proxmox/containers`);
  }

  getBackupStorages(): Observable<BackupStorage[]> {
    return this.http.get<BackupStorage[]>(`${this.baseUrl}/proxmox/storages`);
  }

  getContainers(): Observable<Container[]> {
    return this.http.get<Container[]>(`${this.baseUrl}/containers`);
  }

  getContainer(id: number): Observable<Container> {
    return this.http.get<Container>(`${this.baseUrl}/containers/${id}`);
  }

  addContainer(vmid: number, name: string | null = null): Observable<Container> {
    return this.http.post<Container>(`${this.baseUrl}/containers`, { vmid, name });
  }

  updateContainer(id: number, request: UpdateContainerRequest): Observable<Container> {
    return this.http.put<Container>(`${this.baseUrl}/containers/${id}`, request);
  }

  deleteContainer(id: number): Observable<void> {
    return this.http.delete<void>(`${this.baseUrl}/containers/${id}`);
  }

  /** Adds the Proxmox host itself as a target (apt check and dist-upgrade). */
  addNode(): Observable<Container> {
    return this.http.post<Container>(`${this.baseUrl}/containers/node`, {});
  }

  /** Adds every container of the node that has not been added yet; returns the added ones. */
  addAllContainers(): Observable<Container[]> {
    return this.http.post<Container[]>(`${this.baseUrl}/containers/add-all`, {});
  }

  checkAllContainers(): Observable<{ queued: number }> {
    return this.http.post<{ queued: number }>(`${this.baseUrl}/containers/check-all`, {});
  }

  /**
   * Updates every container with pending updates, one after another (not the Proxmox host).
   * `backup: false` skips backups; `true` backs up the containers set to back up before updates.
   */
  updateAllContainers(backup: boolean): Observable<{ containers: number; updates: number }> {
    return this.http.post<{ containers: number; updates: number }>(
      `${this.baseUrl}/containers/update-all`,
      { backup },
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

  /** `backup` decides about a backup (vzdump) before this update. */
  upgradeApt(id: number, backup: boolean): Observable<Run> {
    return this.http.post<Run>(`${this.baseUrl}/containers/${id}/apt-upgrade`, { backup });
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
