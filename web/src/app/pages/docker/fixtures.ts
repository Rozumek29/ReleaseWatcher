import { DockerContainer, DockerEndpoint, DockerOverview } from '../../core/models';

/** Test data shared by the Docker specs. */
export const dockerContainer = (overrides: Partial<DockerContainer> = {}): DockerContainer => ({
  id: 1,
  source: { kind: 'endpoint', id: 1, name: 'NAS' },
  name: 'searxng',
  image: 'searxng/searxng:latest',
  imageDisplay: 'searxng/searxng:latest',
  tag: 'latest',
  state: 'running',
  present: true,
  ignored: false,
  composeProject: 'search',
  composeService: 'searxng',
  installedVersion: '2026.11.1-a1b2c3d4e',
  installedVersionSource: 'digest',
  linkAuto: true,
  repository: null,
  suggestedRepository: 'searxng/searxng',
  updateAvailable: null,
  registry: { state: 'update-available', latestVersion: '2026.11.20-f1e2d3c4b', checkedAt: '2026-01-01T00:00:00Z', error: null, note: null },
  ...overrides,
});

export const dockerEndpoint = (overrides: Partial<DockerEndpoint> = {}): DockerEndpoint => ({
  id: 1,
  name: 'NAS',
  url: 'tcp://socket-proxy:2375',
  isEnabled: true,
  engine: 'docker 27.3.1',
  lastCheckedAt: '2026-01-01T00:00:00Z',
  lastError: null,
  createdAt: '2026-01-01T00:00:00Z',
  isChecking: false,
  ...overrides,
});

export const dockerOverview = (overrides: Partial<DockerOverview> = {}): DockerOverview => ({
  endpoints: [dockerEndpoint()],
  containers: [
    dockerContainer(),
    dockerContainer({
      id: 2,
      name: 'redis',
      image: 'redis:7.4.1',
      imageDisplay: 'redis:7.4.1',
      tag: '7.4.1',
      installedVersion: '7.4.1',
      installedVersionSource: 'tag',
      suggestedRepository: null,
      registry: { state: 'up-to-date', latestVersion: null, checkedAt: '2026-01-01T00:00:00Z', error: null, note: null },
    }),
    dockerContainer({
      id: 3,
      name: 'homeassistant',
      source: { kind: 'target', id: 7, name: 'docker-host' },
      image: 'ghcr.io/home-assistant/home-assistant:stable',
      imageDisplay: 'ghcr.io/home-assistant/home-assistant:stable',
      tag: 'stable',
      composeProject: null,
      installedVersion: null,
      installedVersionSource: null,
      suggestedRepository: null,
      registry: { state: 'unknown', latestVersion: null, checkedAt: null, error: null, note: null },
    }),
  ],
  check: { cron: '0 */6 * * *', isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null, nextRunAt: null },
  ...overrides,
});
