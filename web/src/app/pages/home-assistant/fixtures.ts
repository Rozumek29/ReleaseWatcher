import { HomeAssistantComponent, HomeAssistantConnection, HomeAssistantOverview } from '../../core/models';

/** Test data shared by the Home Assistant specs. */
export const haConnection = (overrides: Partial<HomeAssistantConnection> = {}): HomeAssistantConnection => ({
  id: 1,
  name: 'Home',
  url: 'http://homeassistant.local:8123',
  tokenMasked: 'eyJh…k3Xw',
  isEnabled: true,
  lastCheckedAt: '2026-01-01T00:00:00Z',
  lastError: null,
  createdAt: '2026-01-01T00:00:00Z',
  isChecking: false,
  ...overrides,
});

export const haComponent = (overrides: Partial<HomeAssistantComponent> = {}): HomeAssistantComponent => ({
  id: 1,
  connectionId: 1,
  entityId: 'update.button_card_update',
  name: 'Button Card',
  installedVersion: 'v7.0.0',
  latestVersion: 'v7.0.1',
  releaseUrl: 'https://github.com/custom-cards/button-card/releases/tag/v7.0.1',
  repositoryName: 'custom-cards/button-card',
  lastSeenAt: '2026-01-01T00:00:00Z',
  versionComparable: true,
  homeAssistantUpdate: true,
  repository: null,
  suggestedRepository: 'custom-cards/button-card',
  updateAvailable: null,
  ...overrides,
});

export const haOverview = (overrides: Partial<HomeAssistantOverview> = {}): HomeAssistantOverview => ({
  connections: [haConnection()],
  components: [
    haComponent(),
    haComponent({
      id: 2,
      entityId: 'update.home_assistant_core_update',
      name: 'Home Assistant Core',
      installedVersion: '2026.11.3',
      latestVersion: '2026.11.3',
      releaseUrl: 'https://www.home-assistant.io/latest-release-notes/',
      repositoryName: 'home-assistant/core',
      suggestedRepository: 'home-assistant/core',
      homeAssistantUpdate: false,
    }),
    haComponent({
      id: 3,
      entityId: 'update.some_integration_update',
      name: 'Some integration',
      installedVersion: 'a358575',
      latestVersion: 'a358575',
      releaseUrl: 'https://github.com/owner/some-integration',
      repositoryName: 'owner/some-integration',
      suggestedRepository: 'owner/some-integration',
      versionComparable: false,
      homeAssistantUpdate: false,
    }),
  ],
  check: { cron: '0 */6 * * *', isRunning: false, lastRunStartedAt: null, lastRunFinishedAt: null, nextRunAt: null },
  ...overrides,
});
