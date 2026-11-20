import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { AppSettings } from '../../core/models';
import { settle } from '../../testing';
import { SettingsPage } from './settings.page';

const settings: AppSettings = {
  discord: { webhookConfigured: false, webhookUrlMasked: null, webhookSource: null, mention: null, username: 'ReleaseWatcher' },
  github: { tokenConfigured: false, tokenMasked: null, tokenSource: null },
  polling: { intervalMinutes: 15, intervalSource: 'env', minIntervalMinutes: 1, maxIntervalMinutes: 1440 },
  proxmox: {
    configured: true,
    host: 'pve.lan',
    hostSource: 'ui',
    port: 22,
    user: 'root',
    sshKeyConfigured: true,
    sshKeySource: 'ui',
    checkCron: '0 */6 * * *',
    checkCronSource: 'env',
    checkConcurrency: 3,
    checkConcurrencySource: null,
    minCheckConcurrency: 1,
    maxCheckConcurrency: 10,
    backupStorage: 'pbs',
    backupStorageSource: 'ui',
    backupBeforeUpdate: true,
    backupBeforeUpdateSource: 'ui',
  },
  email: {
    configured: false,
    smtpHost: null,
    smtpHostSource: null,
    smtpPort: 587,
    smtpSecurity: 'starttls',
    smtpUsername: null,
    smtpPasswordConfigured: false,
    smtpPasswordSource: null,
    from: null,
    to: null,
    toSource: null,
  },
  notifications: {
    digest: false,
    digestSource: 'env',
    releases: true,
    vulnerabilities: true,
    appUpdates: true,
    aptUpdates: true,
    updateSucceeded: false,
    updateFailed: false,
  },
  advisories: { github: true, osv: true, osvEcosystems: ['npm', 'Go'] },
};

describe('SettingsPage', () => {
  it('saves the Discord webhook and shows field errors', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();

    http.expectOne('/api/settings').flush(settings);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    // The meter is already there while loading, so the quota box does not change height.
    expect(el.querySelector('.quota-meta')?.textContent).toContain('Loading');
    expect(el.querySelector('.quota .meter')).not.toBeNull();

    http.expectOne('/api/github/rate-limit').flush({ limit: 60, remaining: 42, resetAt: '2026-01-01T00:00:00Z' });
    await settle(fixture);

    expect(el.querySelector('.quota-meta')?.textContent).toContain('42');
    expect(el.querySelector('.quota .meter')?.getAttribute('aria-valuenow')).toBe('42');

    el.querySelector<HTMLButtonElement>('#tab-notifications')!.click();
    await settle(fixture);
    expect(el.querySelector('#tab-notifications')?.getAttribute('aria-selected')).toBe('true');
    expect(el.textContent).toContain('Not configured');

    const input = el.querySelector<HTMLInputElement>('#webhook')!;
    input.value = 'not-a-url';
    input.dispatchEvent(new Event('input'));
    el.querySelector<HTMLButtonElement>('section form button[type=submit]')!.click();

    const request = http.expectOne('/api/settings');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body.discordWebhookUrl).toBe('not-a-url');
    request.flush(
      { status: 400, errors: { discordWebhookUrl: ['Webhook URL must be a valid URL.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);

    expect(el.querySelector('.error')?.textContent).toContain('valid URL');
  });

  it('saves the Proxmox node without sending an untouched SSH key and tests the connection', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    http.expectOne('/api/settings').flush(settings);
    await settle(fixture);
    http.expectOne('/api/github/rate-limit').flush(null);
    http.expectOne('/api/proxmox/storages').flush([
      { name: 'local', type: 'dir', status: 'active', availableBytes: 50 * 1024 ** 3 },
      { name: 'pbs', type: 'pbs', status: 'active', availableBytes: 2 * 1024 ** 4 },
      { name: 'nas', type: 'cifs', status: 'inactive', availableBytes: 0 },
    ]);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const section = el.querySelector<HTMLElement>('section[aria-labelledby=proxmox-title]')!;
    const storage = section.querySelector<HTMLSelectElement>('#pve-backup-storage')!;
    expect([...storage.options].map((o) => o.textContent?.trim())).toEqual([
      '– none (no backups before updates) –',
      'local (dir, 50 GB free)',
      'pbs (pbs, 2.0 TB free)',
      'nas (cifs, inactive)',
    ]);
    expect(storage.value).toBe('pbs');
    storage.value = 'local';
    storage.dispatchEvent(new Event('change'));
    [...section.querySelectorAll<HTMLElement>('app-switch button, app-switch [role=switch]')]
      .find((b) => b.closest('app-switch')?.textContent?.includes('Back up before updates'))!
      .click();
    expect(section.querySelector<HTMLInputElement>('#pve-host')!.value).toBe('pve.lan');
    expect(section.querySelector<HTMLTextAreaElement>('#pve-key')!.value).toBe('');
    expect(section.textContent).toContain('Configured (saved here)');

    const cron = section.querySelector<HTMLInputElement>('#pve-cron')!;
    cron.value = '0 3 * * *';
    cron.dispatchEvent(new Event('input'));
    const concurrency = section.querySelector<HTMLInputElement>('#pve-concurrency')!;
    expect(concurrency.value).toBe('3');
    concurrency.value = '5';
    concurrency.dispatchEvent(new Event('input'));
    section.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const save = http.expectOne('/api/settings');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual({
      proxmoxHost: 'pve.lan',
      proxmoxPort: 22,
      proxmoxUser: 'root',
      containerCheckCron: '0 3 * * *',
      containerCheckConcurrency: 5,
      backupStorage: 'local',
      backupBeforeUpdate: false,
    });
    save.flush(settings);
    await settle(fixture);
    http.expectOne('/api/status').flush({});

    [...section.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Test connection'))!.click();
    http.expectOne('/api/proxmox/test').flush({ output: 'pve-manager/9.1.1' });
    await settle(fixture);
    expect(section.querySelector('.node-test')?.textContent).toContain('pve-manager/9.1.1');
    http.verify();
  });

  it('opens the Notifications tab from the URL, saves e-mail and the notification types', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    await TestBed.inject(Router).navigateByUrl('/?tab=notifications');
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    http.expectOne('/api/settings').flush({
      ...settings,
      email: { ...settings.email, smtpPasswordConfigured: true, smtpPasswordSource: 'ui' },
    });
    await settle(fixture);
    http.expectOne('/api/github/rate-limit').flush(null);
    http.expectOne('/api/proxmox/storages').flush([]);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('section[aria-labelledby=proxmox-title]')).toBeNull();
    const email = el.querySelector<HTMLElement>('section[aria-labelledby=email-title]')!;
    const type = (selector: string, value: string) => {
      const input = email.querySelector<HTMLInputElement>(selector)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    type('#smtp-host', 'smtp.example.com');
    const security = email.querySelector<HTMLSelectElement>('#smtp-security')!;
    security.value = 'tls';
    security.dispatchEvent(new Event('change'));
    await settle(fixture);
    expect(email.querySelector<HTMLInputElement>('#smtp-port')!.value).toBe('465');
    type('#smtp-user', 'alerts@example.com');
    type('#email-from', 'alerts@example.com');
    type('#email-to', 'me@example.com');
    email.querySelector<HTMLButtonElement>('button[type=submit]')!.click();

    const save = http.expectOne('/api/settings');
    // The saved password is kept: an empty field is not sent.
    expect(save.request.body).toEqual({
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecurity: 'tls',
      smtpUsername: 'alerts@example.com',
      emailFrom: 'alerts@example.com',
      emailTo: 'me@example.com',
    });
    save.flush({ ...settings, email: { ...settings.email, configured: true } });
    await settle(fixture);

    [...email.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Send test'))!.click();
    const test = http.expectOne('/api/notifiers/test');
    expect(test.request.body).toEqual({ notifier: 'email' });
    test.flush({ sent: ['email'], failed: [] });
    await settle(fixture);

    const kinds = el.querySelector<HTMLElement>('section[aria-labelledby=kinds-title]')!;
    const submit = kinds.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.disabled).toBe(true);
    kinds.querySelector<HTMLElement>('[role=switch][aria-label="Update failed"]')!.click();
    kinds.querySelector<HTMLElement>('[role=switch][aria-label="New vulnerabilities"]')!.click();
    kinds.querySelector<HTMLElement>('.digest [role=switch]')!.click();
    await settle(fixture);
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(http.expectOne('/api/settings').request.body).toEqual({
      notificationDigest: true,
      notifyReleases: true,
      notifyVulnerabilities: false,
      notifyAppUpdates: true,
      notifyAptUpdates: true,
      notifyUpdateSucceeded: false,
      notifyUpdateFailed: true,
    });
  });

  it('switches vulnerability sources on and off', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();
    http.expectOne('/api/settings').flush(settings);
    await settle(fixture);
    http.match('/api/github/rate-limit').forEach((r) => r.flush(null));
    const el = fixture.nativeElement as HTMLElement;

    const section = el.querySelector<HTMLElement>('section[aria-labelledby=advisories-title]')!;
    const submit = section.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.disabled).toBe(true);
    section.querySelector<HTMLElement>('[role=switch][aria-label="OSV.dev"]')!.click();
    await settle(fixture);
    expect(submit.disabled).toBe(false);
    submit.click();
    expect(http.expectOne('/api/settings').request.body).toEqual({ advisoriesGithub: true, advisoriesOsv: false });
  });
});
