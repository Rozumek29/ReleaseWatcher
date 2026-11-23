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
  polling: { releaseCron: '*/15 * * * *', releaseCronSource: 'env', advisoryCron: '0 */6 * * *', advisoryCronSource: 'env' },
  proxmox: {
    configured: true,
    nodes: [
      { id: 1, name: 'pve', configured: true, backupStorage: 'pbs' },
      { id: 2, name: 'pve2', configured: true, backupStorage: null },
    ],
    checkCron: '0 */6 * * *',
    checkCronSource: 'env',
    checkConcurrency: 3,
    checkConcurrencySource: null,
    minCheckConcurrency: 1,
    maxCheckConcurrency: 10,
    backupBeforeUpdate: true,
    backupBeforeUpdateSource: 'ui',
    runHistoryChecks: null,
    runHistoryUpdates: 30,
    minRunHistory: 1,
    maxRunHistory: 500,
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

  it('saves the release and vulnerability check schedules', async () => {
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
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const section = el.querySelector<HTMLElement>('[aria-labelledby=polling-title]')!;
    expect(section.textContent).toContain('Every 15 min');
    const submit = section.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit.disabled).toBe(true);

    const hourly = [...section.querySelectorAll<HTMLButtonElement>('[aria-label="Release check schedule"] .preset')].find(
      (b) => b.textContent?.trim() === 'Hourly',
    )!;
    hourly.click();
    await settle(fixture);
    expect(hourly.getAttribute('aria-checked')).toBe('true');
    expect(section.querySelector<HTMLInputElement>('#release-cron')!.value).toBe('0 * * * *');

    const advisory = section.querySelector<HTMLInputElement>('#advisory-cron')!;
    advisory.value = '30 4 * * *';
    advisory.dispatchEvent(new Event('input'));
    await settle(fixture);
    submit.click();

    const save = http.expectOne('/api/settings');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual({ releaseCheckCron: '0 * * * *', advisoryCheckCron: '30 4 * * *' });
    save.flush(
      { status: 400, errors: { advisoryCheckCron: ['minute must be between 0 and 59, got 61.'] } },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle(fixture);
    expect(section.querySelector('.error')?.textContent).toContain('minute must be between');
  });

  it('saves the container schedule and backup defaults (the connection lives under Connections)', async () => {
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
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const section = el.querySelector<HTMLElement>('section[aria-labelledby=proxmox-title]')!;
    // The storage belongs to each node (edited under Connections); here it is only listed.
    expect(section.querySelector('select#pve-backup-storage')).toBeNull();
    const rows = [...section.querySelectorAll('.node-storages li')].map((li) =>
      [...li.children].map((c) => c.textContent?.trim()),
    );
    expect(rows).toEqual([
      ['pve', 'pbs'],
      ['pve2', 'none – no backups'],
    ]);
    [...section.querySelectorAll<HTMLElement>('app-switch button, app-switch [role=switch]')]
      .find((b) => b.closest('app-switch')?.textContent?.includes('Back up before updates'))!
      .click();
    expect(section.querySelector('#pve-host')).toBeNull();
    expect(section.textContent).toContain('Node connected');

    const cron = section.querySelector<HTMLInputElement>('#pve-cron')!;
    cron.value = '0 3 * * *';
    cron.dispatchEvent(new Event('input'));
    const concurrency = section.querySelector<HTMLInputElement>('#pve-concurrency')!;
    expect(concurrency.value).toBe('3');
    concurrency.value = '5';
    concurrency.dispatchEvent(new Event('input'));
    const historyChecks = section.querySelector<HTMLInputElement>('#pve-history-checks')!;
    // No limit by default: the field is empty and says so.
    expect(historyChecks.value).toBe('');
    expect(historyChecks.placeholder).toBe('Unlimited');
    historyChecks.value = '4';
    historyChecks.dispatchEvent(new Event('input'));
    // An emptied field keeps all runs again.
    const historyUpdates = section.querySelector<HTMLInputElement>('#pve-history-updates')!;
    expect(historyUpdates.value).toBe('30');
    historyUpdates.value = '';
    historyUpdates.dispatchEvent(new Event('input'));
    section.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const save = http.expectOne('/api/settings');
    expect(save.request.method).toBe('PUT');
    expect(save.request.body).toEqual({
      containerCheckCron: '0 3 * * *',
      containerCheckConcurrency: 5,
      backupBeforeUpdate: false,
      runHistoryChecks: 4,
      runHistoryUpdates: null,
    });
    save.flush(settings);
    await settle(fixture);
    http.expectOne('/api/status').flush({});
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

  it('marks sections with unsaved changes and keeps them when another section is saved', async () => {
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
    const polling = el.querySelector<HTMLElement>('section[aria-labelledby=polling-title]')!;
    const advisories = el.querySelector<HTMLElement>('section[aria-labelledby=advisories-title]')!;
    expect(el.querySelector('app-unsaved-changes')).toBeNull();

    const cron = polling.querySelector<HTMLInputElement>('#release-cron')!;
    cron.value = '0 * * * *';
    cron.dispatchEvent(new Event('input'));
    advisories.querySelector<HTMLButtonElement>('[role=switch][aria-label="OSV.dev"]')!.click();
    await settle(fixture);
    expect(polling.querySelector('app-unsaved-changes')?.textContent).toContain('Unsaved changes');
    expect(advisories.querySelector('app-unsaved-changes')).not.toBeNull();

    // Typing the saved value again is no change.
    cron.value = '*/15 * * * *';
    cron.dispatchEvent(new Event('input'));
    await settle(fixture);
    expect(polling.querySelector('app-unsaved-changes')).toBeNull();
    cron.value = '0 * * * *';
    cron.dispatchEvent(new Event('input'));
    await settle(fixture);

    advisories.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    http.expectOne('/api/settings').flush({ ...settings, advisories: { ...settings.advisories, osv: false } });
    await settle(fixture);
    expect(advisories.querySelector('app-unsaved-changes')).toBeNull();
    // The unsaved schedule survives saving another section.
    expect(cron.value).toBe('0 * * * *');
    expect(polling.querySelector('app-unsaved-changes')).not.toBeNull();
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
