import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Run } from '../../core/models';
import { settle } from '../../testing';
import { container } from './fixtures';
import { RunLogDialog } from './run-log.dialog';

describe('RunLogDialog', () => {
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [RunLogDialog],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('shows the output of a running update', async () => {
    const fixture = TestBed.createComponent(RunLogDialog);
    const finished: Run[] = [];
    fixture.componentInstance.finished.subscribe((r) => finished.push(r));
    fixture.componentRef.setInput('target', { container: container(), runId: 4 });
    await settle(fixture);

    http.expectOne('/api/runs/4').flush({
      id: 4,
      containerId: 1,
      appId: 7,
      kind: 'app-update',
      trigger: 'manual',
      status: 'running',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: null,
      exitCode: null,
      output: '» Updating Vaultwarden: update\n',
    } satisfies Run);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h2')?.textContent).toContain('Application update');
    expect(el.querySelector('h2')?.textContent).toContain('Vaultwarden');
    expect(el.querySelector('.run-status')?.textContent).toContain('Running');
    expect(el.querySelector('.output')?.textContent).toContain('Updating Vaultwarden');
    expect(finished.length).toBe(0);

    // Closing stops polling.
    fixture.componentRef.setInput('target', null);
    await settle(fixture);
  });

  it('lists the history and opens a run', async () => {
    const fixture = TestBed.createComponent(RunLogDialog);
    fixture.componentRef.setInput('target', { container: container(), runId: null });
    await settle(fixture);

    http.expectOne('/api/containers/1/runs').flush([
      {
        id: 3,
        containerId: 1,
        appId: null,
        kind: 'check',
        trigger: 'schedule',
        status: 'failed',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: '2026-01-01T00:00:02Z',
        exitCode: null,
      },
    ]);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector<HTMLButtonElement>('.run-row')!;
    expect(row.textContent).toContain('Check');
    expect(row.textContent).toContain('scheduled');
    row.click();
    http.expectOne('/api/runs/3').flush({
      id: 3,
      containerId: 1,
      appId: null,
      kind: 'check',
      trigger: 'schedule',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:02Z',
      exitCode: null,
      output: 'SSH connection failed\n',
    } satisfies Run);
    await settle(fixture);

    expect(el.querySelector('.run-status')?.textContent).toContain('Failed');
    expect(el.querySelector('.output')?.textContent).toContain('SSH connection failed');
    expect(el.textContent).toContain('History');
  });
});
