import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Run, RunHistoryPage, RunPage, RunSummary } from '../../core/models';
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
      targetId: 1,
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

  it('asks only for new output while a run is in progress and appends it', async () => {
    const fixture = TestBed.createComponent(RunLogDialog);
    fixture.componentRef.setInput('target', { container: container(), runId: 4 });
    await settle(fixture);
    vi.useFakeTimers();
    try {
      const running = {
        id: 4,
        targetId: 1,
        appId: null,
        kind: 'packages-upgrade',
        trigger: 'manual',
        status: 'running',
        startedAt: '2026-01-01T00:00:00Z',
        finishedAt: null,
        exitCode: null,
      } satisfies RunSummary;
      http
        .expectOne('/api/runs/4')
        .flush({ ...running, output: 'Reading package lists...\n', outputAppend: false, outputCursor: 'a.0.25' } satisfies RunPage);
      await vi.advanceTimersByTimeAsync(1000);
      http
        .expectOne('/api/runs/4?after=a.0.25')
        .flush({ ...running, output: 'Setting up curl\n', outputAppend: true, outputCursor: 'a.0.41' } satisfies RunPage);
      await vi.advanceTimersByTimeAsync(0);

      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('.output')?.textContent).toBe('Reading package lists...\nSetting up curl\n');

      // A stale cursor (e.g. the output was read again after a reconnect) replaces the output.
      await vi.advanceTimersByTimeAsync(1000);
      http.expectOne('/api/runs/4?after=a.0.41').flush({
        ...running,
        status: 'succeeded',
        finishedAt: '2026-01-01T00:01:00Z',
        exitCode: 0,
        output: 'Done.\n',
        outputAppend: false,
        outputCursor: null,
      } satisfies RunPage);
      await vi.advanceTimersByTimeAsync(0);
      expect(el.querySelector('.output')?.textContent).toBe('Done.\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('lists the history and opens a run', async () => {
    const fixture = TestBed.createComponent(RunLogDialog);
    fixture.componentRef.setInput('target', { container: container(), runId: null });
    await settle(fixture);

    http.expectOne('/api/targets/1/runs').flush({
      items: [
        {
          id: 3,
          targetId: 1,
          appId: null,
          kind: 'check',
          trigger: 'schedule',
          status: 'failed',
          startedAt: '2026-01-01T00:00:00Z',
          finishedAt: '2026-01-01T00:00:02Z',
          exitCode: null,
        },
      ],
      nextCursor: null,
    } satisfies RunHistoryPage);
    await settle(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const row = el.querySelector<HTMLButtonElement>('.run-row')!;
    expect(row.textContent).toContain('Check');
    expect(row.textContent).toContain('scheduled');
    row.click();
    http.expectOne('/api/runs/3').flush({
      id: 3,
      targetId: 1,
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

  it('loads older runs of the history page by page', async () => {
    const fixture = TestBed.createComponent(RunLogDialog);
    fixture.componentRef.setInput('target', { container: container(), runId: null });
    await settle(fixture);
    const summary = (id: number): RunSummary => ({
      id,
      targetId: 1,
      appId: null,
      kind: id % 2 ? 'check' : 'packages-upgrade',
      trigger: 'manual',
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:02Z',
      exitCode: 0,
    });

    http
      .expectOne('/api/targets/1/runs')
      .flush({ items: [summary(5), summary(4)], nextCursor: '4' } satisfies RunHistoryPage);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.run-row')).toHaveLength(2);

    // The button below the list loads the next page (by scrolling into view, or by click).
    const more = el.querySelector<HTMLButtonElement>('.more-runs')!;
    expect(more.textContent).toContain('Show older runs');
    more.click();
    http
      .expectOne((req) => req.url === '/api/targets/1/runs' && req.params.get('cursor') === '4')
      .flush({ items: [summary(3)], nextCursor: null } satisfies RunHistoryPage);
    await settle(fixture);

    expect(el.querySelectorAll('.run-row')).toHaveLength(3);
    expect(el.querySelector('.more-runs')).toBeNull();
  });
});
