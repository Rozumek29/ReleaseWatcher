import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
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
};

describe('SettingsPage', () => {
  it('saves the Discord webhook and shows field errors', async () => {
    await TestBed.configureTestingModule({
      imports: [SettingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SettingsPage);
    fixture.detectChanges();

    http.expectOne('/api/settings').flush(settings);
    await settle(fixture);
    http.expectOne('/api/github/rate-limit').flush({ limit: 60, remaining: 42, resetAt: '2026-01-01T00:00:00Z' });
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Not configured');
    expect(el.querySelector('.quota-meta')?.textContent).toContain('42');

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
      providers: [provideHttpClient(), provideHttpClientTesting()],
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
});
