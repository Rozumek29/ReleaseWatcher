import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { BackupFile, ImportPreview } from '../../core/models';
import { PreferencesService } from '../../core/preferences.service';
import { settle } from '../../testing';
import { BackupPanel } from './backup';

const backupFile = (extra: Partial<BackupFile> = {}): BackupFile => ({
  format: 'releasewatcher-backup',
  schemaVersion: 1,
  appVersion: '1.7.0',
  exportedAt: '2026-11-24T10:00:00.000Z',
  settings: { releaseCheckCron: '*/30 * * * *', notifyReleases: false },
  repositories: [
    { owner: 'acme', name: 'widget' },
    { owner: 'acme', name: 'gadget' },
  ],
  hosts: [
    {
      type: 'proxmox',
      name: 'pve',
      targets: [
        { kind: 'lxc', name: 'nginx', apps: [{}, {}] },
        { kind: 'node', name: 'pve', apps: [] },
      ],
    },
  ],
  dockerEndpoints: [{ name: 'Synology', url: 'tcp://nas.lan:2375' }],
  secretsOmitted: ['Discord webhook URL', 'GitHub token of acme/widget'],
  ...extra,
});

const preview = (extra: Partial<ImportPreview> = {}): ImportPreview => ({
  mode: 'merge',
  appVersion: '1.7.0',
  exportedAt: '2026-11-24T10:00:00.000Z',
  sections: [
    {
      key: 'settings',
      title: 'Settings',
      added: ['Release check cron'],
      updated: [],
      removed: [],
      unchanged: 1,
    },
    {
      key: 'repositories',
      title: 'Repositories',
      added: ['acme/widget'],
      updated: ['acme/gadget'],
      removed: [],
      unchanged: 0,
    },
    { key: 'machines', title: 'Machines', added: [], updated: [], removed: [], unchanged: 0 },
    {
      key: 'dockerEndpoints',
      title: 'Docker endpoints',
      added: [],
      updated: [],
      removed: [],
      unchanged: 2,
    },
  ],
  secretsToReenter: ['GitHub token of acme/widget'],
  warnings: [],
  ...extra,
});

describe('BackupPanel', () => {
  beforeEach(() => localStorage.removeItem('releasewatcher.preferences'));

  const setup = async (current = backupFile()) => {
    await TestBed.configureTestingModule({
      imports: [BackupPanel],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(BackupPanel);
    let imported = 0;
    fixture.componentInstance.imported.subscribe(() => imported++);
    fixture.detectChanges();
    http.expectOne('/api/backup/export').flush(current);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = (text: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.trim().startsWith(text),
      );
    /** Picks a file in the import file input. */
    const choose = async (content: string, name = 'backup.json') => {
      const input = el.querySelector<HTMLInputElement>('input[type="file"]')!;
      const file = new File([content], name, { type: 'application/json' });
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      input.dispatchEvent(new Event('change'));
      await settle(fixture);
    };
    return { http, fixture, el, button, choose, imported: () => imported };
  };

  it('lists what the export includes and which secrets it leaves out', async () => {
    const { el } = await setup();
    const included = el.querySelector('.items.included')!.textContent!;
    expect(included).toContain('Watched repositories');
    expect(included).toContain('1 hosts, 2 machines, 2 applications');
    expect(
      [...el.querySelectorAll('.items.secrets li')].map((li) => li.textContent?.trim()),
    ).toEqual(['Discord webhook URL', 'GitHub token of acme/widget']);
    expect(el.querySelector('.items.excluded')!.textContent).toContain('passkeys');
  });

  it('downloads the backup with the appearance of this browser', async () => {
    const { http, fixture, button } = await setup();
    const preferences = TestBed.inject(PreferencesService);
    preferences.accent.set('teal');
    let saved: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      saved = blob;
      return 'blob:backup';
    });
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    button('Download backup')!.click();
    http.expectOne('/api/backup/export').flush(backupFile());
    await settle(fixture);

    expect(click).toHaveBeenCalled();
    const file = JSON.parse(await saved!.text()) as BackupFile;
    expect(file.repositories.length).toBe(2);
    expect(file.appearance).toMatchObject({ accent: 'teal', theme: 'system' });
    click.mockRestore();
  });

  it('previews a file and imports it after confirmation', async () => {
    const { http, fixture, el, button, choose, imported } = await setup();
    await choose(JSON.stringify(backupFile()));

    const dryRun = http.expectOne('/api/backup/import');
    expect(dryRun.request.body).toMatchObject({
      mode: 'merge',
      dryRun: true,
      backup: { format: 'releasewatcher-backup' },
    });
    dryRun.flush({ applied: false, preview: preview() });
    await settle(fixture);

    const text = el.querySelector('.preview')!.textContent!;
    expect(text).toContain('+1 new');
    expect(text).toContain('acme/gadget');
    expect(text).toContain('GitHub token of acme/widget');

    button('Import')!.click();
    const apply = http.expectOne('/api/backup/import');
    expect(apply.request.body).toMatchObject({ mode: 'merge', dryRun: false });
    apply.flush({ applied: true, preview: preview() });
    await settle(fixture);
    http.expectOne('/api/backup/export').flush(backupFile());
    await settle(fixture);

    expect(imported()).toBe(1);
    expect(el.querySelector('.done')!.textContent).toContain('GitHub token of acme/widget');
    expect(el.querySelector('.preview')).toBeNull();
  });

  it('runs the preview again when the mode changes and names removals', async () => {
    const { http, fixture, el, button, choose } = await setup();
    await choose(JSON.stringify(backupFile()));
    http.expectOne('/api/backup/import').flush({ applied: false, preview: preview() });
    await settle(fixture);

    button('Replace')!.click();
    await settle(fixture);
    const request = http.expectOne('/api/backup/import');
    expect(request.request.body).toMatchObject({ mode: 'replace', dryRun: true });
    request.flush({
      applied: false,
      preview: preview({
        mode: 'replace',
        sections: [
          {
            key: 'repositories',
            title: 'Repositories',
            added: [],
            updated: [],
            removed: ['old/repo'],
            unchanged: 2,
          },
        ],
      }),
    });
    await settle(fixture);

    expect(el.querySelector('.names.removed')!.textContent).toContain('old/repo');
    expect(el.querySelector('.danger-note')!.textContent).toContain('1 item(s) will be removed');
    expect(button('Replace configuration')).toBeTruthy();
  });

  it('shows why a file cannot be imported', async () => {
    const { http, fixture, el, choose } = await setup();
    await choose('not json');
    expect(el.textContent).toContain('This file is not valid JSON');
    http.expectNone('/api/backup/import');

    await choose(JSON.stringify({ format: 'other' }));
    http
      .expectOne('/api/backup/import')
      .flush(
        {
          status: 400,
          title: 'Invalid',
          errors: { format: ['This is not a ReleaseWatcher backup file.'] },
        },
        { status: 400, statusText: 'Bad Request' },
      );
    await settle(fixture);
    expect(el.querySelector('[role="alert"]')!.textContent).toContain(
      'This is not a ReleaseWatcher backup file.',
    );
    expect(el.querySelector('.preview')).toBeNull();
  });
});
