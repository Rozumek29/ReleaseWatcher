import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../../core/api.service';
import { Container, Run, RunKind, RunSummary } from '../../core/models';
import { kindLabel, targetLabel } from './target';
import { Icon } from '../../shared/icon';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { BackdropClose } from '../../shared/backdrop-close';

/** What the dialog shows: one run (`runId`) or the history of a container (`runId: null`). */
export interface RunLogTarget {
  container: Container;
  runId: number | null;
}

/** Poll interval while a run is still running. */
export const RUN_POLL_MS = 1000;

/** Output kept in the dialog while it grows (the server keeps the same amount). */
const MAX_OUTPUT_LENGTH = 256 * 1024;

function keepTail(output: string): string {
  return output.length > MAX_OUTPUT_LENGTH
    ? `[…output truncated…]\n${output.slice(-MAX_OUTPUT_LENGTH)}`
    : output;
}

/** Console output of a check/update, refreshed live while it runs, plus the run history. */
@Component({
  selector: 'app-run-log-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BackdropClose, DatePipe, Icon, RelativeTimePipe],
  templateUrl: './run-log.dialog.html',
  styleUrls: ['./dialog.scss', './run-log.dialog.scss'],
})
export class RunLogDialog {
  private readonly api = inject(ApiService);

  readonly target = input<RunLogTarget | null>(null);
  /** Emitted once when a watched run leaves the "running" state. */
  readonly finished = output<Run>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly outputEl = viewChild<ElementRef<HTMLPreElement>>('output');

  protected readonly label = targetLabel;
  protected readonly run = signal<Run | null>(null);
  protected readonly history = signal<RunSummary[] | null>(null);
  protected readonly error = signal<string | null>(null);
  /** Keep the output scrolled to the end (disabled when the user scrolls up). */
  protected readonly follow = signal(true);

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped whenever the shown run changes, so stale poll answers are ignored. */
  private generation = 0;

  constructor() {
    effect(() => {
      const target = this.target();
      const dialog = this.dialog().nativeElement;
      untracked(() => {
        this.stop();
        this.run.set(null);
        this.history.set(null);
        this.error.set(null);
        this.follow.set(true);
        if (!target) {
          if (dialog.open) {
            dialog.close();
          }
          return;
        }
        if (!dialog.open) {
          dialog.showModal?.();
        }
        if (target.runId === null) {
          void this.loadHistory(target.container);
        } else {
          void this.open(target.runId);
        }
      });
    });

    afterRenderEffect(() => {
      this.run();
      const pre = this.outputEl()?.nativeElement;
      if (pre && untracked(this.follow)) {
        pre.scrollTop = pre.scrollHeight;
      }
    });

    inject(DestroyRef).onDestroy(() => this.stop());
  }

  protected async loadHistory(container: Container): Promise<void> {
    this.stop();
    this.run.set(null);
    try {
      this.history.set(await firstValueFrom(this.api.getContainerRuns(container.id)));
    } catch (error) {
      this.error.set(describeError(error));
    }
  }

  protected async open(runId: number): Promise<void> {
    this.stop();
    this.follow.set(true);
    const generation = ++this.generation;
    await this.poll(runId, generation, null);
  }

  protected backToHistory(): void {
    const target = this.target();
    if (target) {
      this.history.set(null);
      void this.loadHistory(target.container);
    }
  }

  protected onScroll(pre: HTMLPreElement): void {
    this.follow.set(pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24);
  }

  protected kindLabel(kind: RunKind): string {
    return kindLabel(kind);
  }

  protected appName(run: RunSummary): string | null {
    return run.appId === null
      ? null
      : (this.target()?.container.apps.find((a) => a.id === run.appId)?.name ?? null);
  }

  protected duration(run: RunSummary): string | null {
    if (!run.finishedAt) {
      return null;
    }
    const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  protected close(): void {
    this.stop();
    this.closed.emit();
  }

  /** `cursor` = where the shown output ends, so the server sends only what was written since. */
  private async poll(
    runId: number,
    generation: number,
    previous: Run['status'] | null,
    cursor: string | null = null,
  ): Promise<void> {
    try {
      const { outputAppend, outputCursor, ...fields } = await firstValueFrom(
        this.api.getRun(runId, cursor),
      );
      if (generation !== this.generation) {
        return;
      }
      const shown = this.run();
      const run: Run =
        outputAppend && shown?.id === runId
          ? { ...fields, output: keepTail(shown.output + fields.output) }
          : fields;
      this.run.set(run);
      this.error.set(null);
      if (run.status === 'running') {
        const next = outputCursor ?? null;
        this.timer = setTimeout(() => void this.poll(runId, generation, run.status, next), RUN_POLL_MS);
      } else if (previous === 'running' || (previous === null && this.isTargetRun(runId))) {
        this.finished.emit(run);
      }
    } catch (error) {
      if (generation === this.generation) {
        this.error.set(describeError(error));
      }
    }
  }

  /** The run the dialog was opened for (not one picked from the history). */
  private isTargetRun(runId: number): boolean {
    return this.target()?.runId === runId;
  }

  private stop(): void {
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
