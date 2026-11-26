import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import {
  AppSettings,
  NotificationPreferences,
  RateLimit,
  SettingSource,
  SettingsPatch,
  SmtpSecurity,
} from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { describeCron } from '../../shared/cron';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { Switch } from '../../shared/switch';
import { UnsavedChanges, sameValues } from '../../shared/unsaved-changes';
import { AppearancePanel } from './appearance';
import { BackupPanel } from './backup';
import { CHANNELS, ChannelCard } from './channel-card';
import { ConnectionsPanel } from './connections';
import { GitHostTokens } from './git-host-tokens';

type Section = 'discord' | 'email' | 'notifications' | 'github' | 'polling' | 'advisories' | 'proxmox';
const SECTIONS: readonly Section[] = ['discord', 'email', 'notifications', 'github', 'polling', 'advisories', 'proxmox'];
type Tab = 'general' | 'connections' | 'notifications' | 'appearance' | 'backup';
const TABS: readonly Tab[] = ['general', 'connections', 'notifications', 'appearance', 'backup'];

/** Default port of each SMTP security mode (used when the port still has the previous mode's default). */
const SMTP_PORTS: Record<SmtpSecurity, number> = { starttls: 587, tls: 465, none: 25 };

/** The notification kinds shown as switches, in order. */
const NOTIFICATION_KINDS: { key: Exclude<keyof NotificationPreferences, 'digest'>; label: string; hint: string }[] = [
  { key: 'releases', label: 'New releases', hint: 'A watched repository published a new release.' },
  {
    key: 'vulnerabilities',
    label: 'New vulnerabilities',
    hint: 'A security advisory was published for a watched repository (skipped when the installed version is not affected).',
  },
  { key: 'appUpdates', label: 'Application updates', hint: 'A newer version of an application in a container.' },
  { key: 'packageUpdates', label: 'System package updates', hint: 'Upgradable system packages (apt, dnf, zypper, apk, pacman …) and Flatpak / Snap applications on a machine or the Proxmox host.' },
  { key: 'updateSucceeded', label: 'Update finished', hint: 'An update or package upgrade started here completed.' },
  { key: 'updateFailed', label: 'Update failed', hint: 'An update or package upgrade started here failed.' },
  {
    key: 'dockerUpdates',
    label: 'New Docker images',
    hint: 'A newer image was pushed for the tag a Docker container runs (each image is reported once).',
  },
];

/** Quick picks for the check schedules (cron expressions). */
const RELEASE_PRESETS = ['*/5 * * * *', '*/15 * * * *', '*/30 * * * *', '0 * * * *', '0 */3 * * *', '0 */6 * * *'];
const ADVISORY_PRESETS = ['0 * * * *', '0 */3 * * *', '0 */6 * * *', '0 */12 * * *', '0 3 * * *'];

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    FormsModule,
    DecimalPipe,
    AppearancePanel,
    BackupPanel,
    ChannelCard,
    ConnectionsPanel,
    GitHostTokens,
    Icon,
    RelativeTimePipe,
    Switch,
    UnsavedChanges,
  ],
  templateUrl: './settings.page.html',
  styleUrl: './settings.page.scss',
})
export class SettingsPage implements OnInit {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly statusService = inject(StatusService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly tab = signal<Tab>(
    TABS.find((t) => t === this.route.snapshot.queryParamMap.get('tab')) ?? 'general',
  );

  protected readonly settings = signal<AppSettings | null>(null);
  protected readonly saving = signal<Section | null>(null);
  protected readonly errors = signal<Record<string, string>>({});
  /** Channel whose test is being sent. */
  protected readonly testing = signal<string | null>(null);
  protected readonly showSmtpPassword = signal(false);
  protected readonly rateLimit = signal<RateLimit | null>(null);
  protected readonly rateLimitError = signal<string | null>(null);
  protected readonly loadingRateLimit = signal(false);
  protected readonly showWebhook = signal(false);
  protected readonly showToken = signal(false);

  // Form state. Secrets start empty: an empty field on save means "keep the current value".
  protected webhookUrl = '';
  protected mention = '';
  protected username = '';
  protected token = '';
  protected advisoriesGithub = true;
  protected advisoriesOsv = true;
  protected releaseCron = '';
  protected advisoryCron = '';
  protected checkCron = '';
  protected dockerCron = '';
  protected checkConcurrency: number | null = 3;
  protected backupDefault = false;
  protected runHistoryChecks: number | null = null;
  protected runHistoryUpdates: number | null = null;
  protected smtpHost = '';
  protected smtpPort: number | null = 587;
  protected smtpSecurity: SmtpSecurity = 'starttls';
  protected smtpUsername = '';
  protected smtpPassword = '';
  protected emailFrom = '';
  protected emailTo = '';
  protected preferences: NotificationPreferences = {
    digest: false,
    releases: true,
    vulnerabilities: true,
    appUpdates: true,
    packageUpdates: true,
    updateSucceeded: false,
    updateFailed: false,
    dockerUpdates: true,
  };

  /** Form values of each section as last loaded or saved, to tell which sections have unsaved changes. */
  private savedValues: Partial<Record<Section, unknown>> = {};

  protected readonly kinds = NOTIFICATION_KINDS;
  protected readonly channels = CHANNELS;

  protected readonly releasePresets = RELEASE_PRESETS;
  protected readonly advisoryPresets = ADVISORY_PRESETS;
  protected readonly describeCron = describeCron;

  protected readonly rateLimitPercent = computed(() => {
    const rl = this.rateLimit();
    return rl && rl.limit > 0 ? Math.round((rl.remaining / rl.limit) * 100) : 0;
  });

  async ngOnInit(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.api.getSettings()));
    } catch (error) {
      this.toast.error(error);
    }
    void this.loadRateLimit();
  }

  protected async saveDiscord(): Promise<void> {
    const patch: SettingsPatch = {
      discordMention: this.mention,
      discordUsername: this.username,
    };
    if (this.webhookUrl.trim()) {
      patch.discordWebhookUrl = this.webhookUrl.trim();
    }
    await this.save('discord', patch, 'Discord settings saved.');
  }

  protected async resetWebhook(): Promise<void> {
    await this.save('discord', { discordWebhookUrl: null }, 'Webhook removed.');
  }

  protected selectTab(tab: Tab): void {
    this.tab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab: tab === 'general' ? null : tab },
      replaceUrl: true,
    });
  }

  /** Switching the security mode also switches a port that still has the old mode's default. */
  protected setSmtpSecurity(security: SmtpSecurity): void {
    if (this.smtpPort === null || Object.values(SMTP_PORTS).includes(Number(this.smtpPort))) {
      this.smtpPort = SMTP_PORTS[security];
    }
    this.smtpSecurity = security;
  }

  protected async saveEmail(): Promise<void> {
    const port = this.smtpPort === null || `${this.smtpPort}` === '' ? null : Number(this.smtpPort);
    const patch: SettingsPatch = {
      // Empty values reset to the environment default.
      smtpHost: this.smtpHost.trim() || null,
      smtpPort: port,
      smtpSecurity: this.smtpSecurity,
      smtpUsername: this.smtpUsername.trim() || null,
      emailFrom: this.emailFrom.trim() || null,
      emailTo: this.emailTo.trim() || null,
    };
    // The password is never shown; an empty field keeps the saved one.
    if (this.smtpPassword) {
      patch.smtpPassword = this.smtpPassword;
    }
    await this.save('email', patch, 'E-mail settings saved.');
  }

  protected async resetSmtpPassword(): Promise<void> {
    await this.save('email', { smtpPassword: null }, 'SMTP password removed.');
  }

  protected toggle(key: keyof NotificationPreferences): void {
    this.preferences = { ...this.preferences, [key]: !this.preferences[key] };
  }

  protected async saveNotifications(): Promise<void> {
    const p = this.preferences;
    await this.save(
      'notifications',
      {
        notificationDigest: p.digest,
        notifyReleases: p.releases,
        notifyVulnerabilities: p.vulnerabilities,
        notifyAppUpdates: p.appUpdates,
        notifyPackageUpdates: p.packageUpdates,
        notifyUpdateSucceeded: p.updateSucceeded,
        notifyUpdateFailed: p.updateFailed,
        notifyDockerUpdates: p.dockerUpdates,
      },
      'Notification settings saved.',
    );
  }

  protected async saveGitHub(): Promise<void> {
    if (!this.token.trim()) {
      return;
    }
    if (await this.save('github', { githubToken: this.token.trim() }, 'GitHub token saved.')) {
      void this.loadRateLimit();
    }
  }

  protected async resetToken(): Promise<void> {
    if (await this.save('github', { githubToken: null }, 'GitHub token removed.')) {
      void this.loadRateLimit();
    }
  }

  protected async saveAdvisories(): Promise<void> {
    await this.save(
      'advisories',
      { advisoriesGithub: this.advisoriesGithub, advisoriesOsv: this.advisoriesOsv },
      'Vulnerability sources saved.',
    );
  }

  protected async savePolling(): Promise<void> {
    const patch: SettingsPatch = {
      // Empty values reset to the environment default.
      releaseCheckCron: this.releaseCron.trim() || null,
      advisoryCheckCron: this.advisoryCron.trim() || null,
      dockerCheckCron: this.dockerCron.trim() || null,
    };
    if (await this.save('polling', patch, 'Check schedules saved.')) {
      void this.statusService.refresh();
    }
  }

  protected async saveProxmox(): Promise<void> {
    const count = (value: number | null) => (value === null || `${value}` === '' ? null : Number(value));
    const patch: SettingsPatch = {
      // Empty values reset to the environment (or built-in) default.
      containerCheckCron: this.checkCron.trim() || null,
      containerCheckConcurrency: count(this.checkConcurrency),
      backupBeforeUpdate: this.backupDefault,
      runHistoryChecks: count(this.runHistoryChecks),
      runHistoryUpdates: count(this.runHistoryUpdates),
    };
    if (await this.save('proxmox', patch, 'Container settings saved.')) {
      void this.statusService.refresh();
    }
  }

  /** Hosts or keys changed: whether a Proxmox node is configured may have changed too. */
  /** An imported backup changed the settings: show the new values (unsaved edits are discarded). */
  protected async backupImported(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.api.getSettings()));
      void this.statusService.refresh();
    } catch (error) {
      this.toast.error(error);
    }
  }

  protected async connectionsChanged(): Promise<void> {
    try {
      this.settings.set(await firstValueFrom(this.api.getSettings()));
      void this.statusService.refresh();
    } catch (error) {
      this.toast.error(error);
    }
  }

  /** Sends a sample release through one channel. */
  protected async sendTest(channel: 'discord' | 'email'): Promise<void> {
    this.testing.set(channel);
    try {
      const result = await firstValueFrom(this.api.sendTestNotification(channel));
      if (result.failed.length > 0) {
        this.toast.error(
          channel === 'email'
            ? 'Sending the test e-mail failed. Check the server, login and addresses – the server log has the details.'
            : 'Sending to Discord failed. Check the webhook URL and server logs.',
        );
      } else if (result.sent.length === 0) {
        this.toast.error(`${channel === 'email' ? 'E-mail' : 'Discord'} is not configured.`);
      } else {
        this.toast.success(channel === 'email' ? 'Test e-mail sent.' : 'Test notification sent to Discord.');
      }
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.testing.set(null);
    }
  }

  protected async loadRateLimit(): Promise<void> {
    this.loadingRateLimit.set(true);
    try {
      this.rateLimit.set(await firstValueFrom(this.api.getRateLimit()));
      this.rateLimitError.set(null);
    } catch {
      this.rateLimitError.set('Could not reach the GitHub API.');
    } finally {
      this.loadingRateLimit.set(false);
    }
  }

  protected sourceLabel(source: SettingSource): string {
    return source === 'ui' ? 'Saved here' : source === 'env' ? 'From environment' : 'Not set';
  }

  /** Whether the fields of a section differ from the saved values (read by the template on every check). */
  protected changed(section: Section): boolean {
    return !sameValues(this.sectionValues(section), this.savedValues[section]);
  }

  /** The form values of one section, as compared by `changed()`. */
  private sectionValues(section: Section): unknown {
    switch (section) {
      case 'github':
        return this.token.trim();
      case 'polling':
        return [this.releaseCron.trim(), this.advisoryCron.trim(), this.dockerCron.trim()];
      case 'advisories':
        return [this.advisoriesGithub, this.advisoriesOsv];
      case 'proxmox':
        return [
          this.checkCron.trim(),
          `${this.checkConcurrency ?? ''}`,
          this.backupDefault,
          `${this.runHistoryChecks ?? ''}`,
          `${this.runHistoryUpdates ?? ''}`,
        ];
      case 'discord':
        return [this.webhookUrl.trim(), this.mention, this.username];
      case 'email':
        return [
          this.smtpHost.trim(),
          `${this.smtpPort ?? ''}`,
          this.smtpSecurity,
          this.smtpUsername.trim(),
          this.smtpPassword,
          this.emailFrom.trim(),
          this.emailTo.trim(),
        ];
      case 'notifications':
        return this.preferences;
    }
  }

  private async save(section: Section, patch: SettingsPatch, successText: string): Promise<boolean> {
    this.saving.set(section);
    this.errors.set({});
    try {
      // Only the saved section is reset: unsaved changes in other sections are kept.
      this.apply(await firstValueFrom(this.api.updateSettings(patch)), section);
      this.toast.success(successText);
      return true;
    } catch (error) {
      const fieldErrors = (error as { error?: { errors?: Record<string, string[]> } })?.error?.errors;
      if (fieldErrors) {
        this.errors.set(Object.fromEntries(Object.entries(fieldErrors).map(([k, v]) => [k, v.join(' ')])));
      } else {
        this.toast.error(error);
      }
      return false;
    } finally {
      this.saving.set(null);
    }
  }

  /** Fills the form from the settings: every section, or only the one just saved. */
  private apply(settings: AppSettings, only?: Section): void {
    this.settings.set(settings);
    for (const section of only ? [only] : SECTIONS) {
      this.reset(section, settings);
      this.savedValues[section] = this.sectionValues(section);
    }
  }

  private reset(section: Section, settings: AppSettings): void {
    switch (section) {
      case 'github':
        this.token = '';
        break;
      case 'advisories':
        this.advisoriesGithub = settings.advisories.github;
        this.advisoriesOsv = settings.advisories.osv;
        break;
      case 'discord':
        this.webhookUrl = '';
        this.mention = settings.discord.mention ?? '';
        this.username = settings.discord.username ?? '';
        break;
      case 'polling':
        this.releaseCron = settings.polling.releaseCron;
        this.advisoryCron = settings.polling.advisoryCron;
        this.dockerCron = settings.docker.checkCron;
        break;
      case 'proxmox':
        this.checkCron = settings.proxmox.checkCron;
        this.checkConcurrency = settings.proxmox.checkConcurrency;
        this.backupDefault = settings.proxmox.backupBeforeUpdate;
        this.runHistoryChecks = settings.proxmox.runHistoryChecks;
        this.runHistoryUpdates = settings.proxmox.runHistoryUpdates;
        break;
      case 'email':
        this.smtpHost = settings.email.smtpHost ?? '';
        this.smtpPort = settings.email.smtpPort;
        this.smtpSecurity = settings.email.smtpSecurity;
        this.smtpUsername = settings.email.smtpUsername ?? '';
        this.smtpPassword = '';
        this.emailFrom = settings.email.from ?? '';
        this.emailTo = settings.email.to ?? '';
        break;
      case 'notifications': {
        const n = settings.notifications;
        this.preferences = {
          digest: n.digest,
          releases: n.releases,
          vulnerabilities: n.vulnerabilities,
          appUpdates: n.appUpdates,
          packageUpdates: n.packageUpdates,
          updateSucceeded: n.updateSucceeded,
          updateFailed: n.updateFailed,
          dockerUpdates: n.dockerUpdates,
        };
        break;
      }
    }
  }
}
