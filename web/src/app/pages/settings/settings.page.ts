import { DecimalPipe } from '@angular/common';
import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import {
  AppSettings,
  BackupStorage,
  NotificationPreferences,
  RateLimit,
  SettingSource,
  SettingsPatch,
  SmtpSecurity,
} from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { Switch } from '../../shared/switch';

type Section = 'discord' | 'email' | 'notifications' | 'github' | 'polling' | 'advisories' | 'proxmox';
type Tab = 'general' | 'notifications';

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
  { key: 'aptUpdates', label: 'apt package updates', hint: 'Upgradable packages in a container or on the Proxmox host.' },
  { key: 'updateSucceeded', label: 'Update finished', hint: 'An update or apt upgrade started here completed.' },
  { key: 'updateFailed', label: 'Update failed', hint: 'An update or apt upgrade started here failed.' },
];

const INTERVAL_PRESETS = [5, 15, 30, 60, 180, 360, 1440];

@Component({
  selector: 'app-settings-page',
  imports: [FormsModule, DecimalPipe, Icon, RelativeTimePipe, Switch],
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
    this.route.snapshot.queryParamMap.get('tab') === 'notifications' ? 'notifications' : 'general',
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
  protected readonly testingNode = signal(false);
  protected readonly nodeTest = signal<{ ok: boolean; text: string } | null>(null);
  protected readonly storages = signal<BackupStorage[] | null>(null);
  protected readonly storagesError = signal<string | null>(null);
  protected readonly loadingStorages = signal(false);

  // Form state. Secrets start empty: an empty field on save means "keep the current value".
  protected webhookUrl = '';
  protected mention = '';
  protected username = '';
  protected token = '';
  protected advisoriesGithub = true;
  protected advisoriesOsv = true;
  protected intervalMinutes = 15;
  protected proxmoxHost = '';
  protected proxmoxPort: number | null = 22;
  protected proxmoxUser = '';
  protected sshKey = '';
  protected checkCron = '';
  protected checkConcurrency: number | null = 3;
  protected backupStorage = '';
  protected backupDefault = false;
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
    aptUpdates: true,
    updateSucceeded: false,
    updateFailed: false,
  };

  protected readonly kinds = NOTIFICATION_KINDS;

  protected readonly presets = INTERVAL_PRESETS;

  protected readonly rateLimitPercent = computed(() => {
    const rl = this.rateLimit();
    return rl && rl.limit > 0 ? Math.round((rl.remaining / rl.limit) * 100) : 0;
  });

  async ngOnInit(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.api.getSettings()));
      if (this.settings()?.proxmox.configured) {
        void this.loadStorages();
      }
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
        notifyAptUpdates: p.aptUpdates,
        notifyUpdateSucceeded: p.updateSucceeded,
        notifyUpdateFailed: p.updateFailed,
      },
      'Notification settings saved.',
    );
  }

  protected notificationsChanged(s: AppSettings): boolean {
    return (Object.keys(this.preferences) as (keyof NotificationPreferences)[]).some(
      (key) => this.preferences[key] !== s.notifications[key],
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
    if (await this.save('polling', { pollIntervalMinutes: Number(this.intervalMinutes) }, 'Polling interval saved.')) {
      void this.statusService.refresh();
    }
  }

  protected async saveProxmox(): Promise<void> {
    const port = this.proxmoxPort === null || `${this.proxmoxPort}` === '' ? null : Number(this.proxmoxPort);
    const concurrency =
      this.checkConcurrency === null || `${this.checkConcurrency}` === '' ? null : Number(this.checkConcurrency);
    const patch: SettingsPatch = {
      // Empty values reset to the environment default.
      proxmoxHost: this.proxmoxHost.trim() || null,
      proxmoxPort: port,
      proxmoxUser: this.proxmoxUser.trim() || null,
      containerCheckCron: this.checkCron.trim() || null,
      containerCheckConcurrency: concurrency,
      backupStorage: this.backupStorage.trim() || null,
      backupBeforeUpdate: this.backupDefault,
    };
    // The key is never shown; an empty field keeps the saved one.
    if (this.sshKey.trim()) {
      patch.proxmoxSshKey = this.sshKey.trim();
    }
    if (await this.save('proxmox', patch, 'Proxmox settings saved.')) {
      this.nodeTest.set(null);
      void this.statusService.refresh();
    }
  }

  /** Lists the node's storages that accept backups. */
  protected async loadStorages(): Promise<void> {
    this.loadingStorages.set(true);
    this.storagesError.set(null);
    try {
      this.storages.set(await firstValueFrom(this.api.getBackupStorages()));
    } catch (error) {
      this.storagesError.set(describeError(error));
    } finally {
      this.loadingStorages.set(false);
    }
  }

  protected isListed(name: string): boolean {
    return (this.storages() ?? []).some((st) => st.name === name);
  }

  protected storageLabel(st: BackupStorage): string {
    const details = [st.type];
    if (st.availableBytes !== null && st.status === 'active') {
      details.push(`${formatBytes(st.availableBytes)} free`);
    }
    if (st.status !== 'active') {
      details.push(st.status);
    }
    return `${st.name} (${details.join(', ')})`;
  }

  protected async resetSshKey(): Promise<void> {
    await this.save('proxmox', { proxmoxSshKey: null }, 'SSH key removed.');
  }

  protected async testNode(): Promise<void> {
    this.testingNode.set(true);
    this.nodeTest.set(null);
    try {
      const { output } = await firstValueFrom(this.api.testProxmoxConnection());
      this.nodeTest.set({ ok: true, text: output || 'Connected.' });
    } catch (error) {
      this.nodeTest.set({ ok: false, text: describeError(error) });
    } finally {
      this.testingNode.set(false);
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

  protected formatInterval(minutes: number): string {
    if (minutes % 1440 === 0) {
      return minutes === 1440 ? '1 day' : `${minutes / 1440} days`;
    }
    if (minutes % 60 === 0) {
      return minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
    }
    return `${minutes} min`;
  }

  protected checksPerHour(): number {
    const minutes = Number(this.intervalMinutes) || 1;
    return Math.ceil(60 / minutes);
  }

  private async save(section: Section, patch: SettingsPatch, successText: string): Promise<boolean> {
    this.saving.set(section);
    this.errors.set({});
    try {
      this.apply(await firstValueFrom(this.api.updateSettings(patch)));
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

  private apply(settings: AppSettings): void {
    this.settings.set(settings);
    this.webhookUrl = '';
    this.token = '';
    this.advisoriesGithub = settings.advisories.github;
    this.advisoriesOsv = settings.advisories.osv;
    this.mention = settings.discord.mention ?? '';
    this.username = settings.discord.username ?? '';
    this.intervalMinutes = settings.polling.intervalMinutes;
    this.proxmoxHost = settings.proxmox.host ?? '';
    this.proxmoxPort = settings.proxmox.port;
    this.proxmoxUser = settings.proxmox.user;
    this.sshKey = '';
    this.checkCron = settings.proxmox.checkCron;
    this.checkConcurrency = settings.proxmox.checkConcurrency;
    this.backupStorage = settings.proxmox.backupStorage ?? '';
    this.backupDefault = settings.proxmox.backupBeforeUpdate;
    this.smtpHost = settings.email.smtpHost ?? '';
    this.smtpPort = settings.email.smtpPort;
    this.smtpSecurity = settings.email.smtpSecurity;
    this.smtpUsername = settings.email.smtpUsername ?? '';
    this.smtpPassword = '';
    this.emailFrom = settings.email.from ?? '';
    this.emailTo = settings.email.to ?? '';
    const n = settings.notifications;
    this.preferences = {
      digest: n.digest,
      releases: n.releases,
      vulnerabilities: n.vulnerabilities,
      appUpdates: n.appUpdates,
      aptUpdates: n.aptUpdates,
      updateSucceeded: n.updateSucceeded,
      updateFailed: n.updateFailed,
    };
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
