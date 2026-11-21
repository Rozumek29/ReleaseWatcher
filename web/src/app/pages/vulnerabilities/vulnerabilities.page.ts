import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AdvisoryOverview, AdvisoryQuery, AdvisorySeverity, AdvisorySource, RepositoryAdvisory } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { Avatar } from '../../shared/avatar';
import { describeCron } from '../../shared/cron';
import { Icon } from '../../shared/icon';
import { InView } from '../../shared/in-view';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { SEVERITY_LABELS, SOURCE_LABELS } from '../../shared/severity';

type Impact = 'all' | 'affecting' | 'unknown' | 'unaffected';
type Filter = Required<Pick<AdvisoryQuery, 'impact' | 'severity' | 'source' | 'q'>>;

const PAGE_SIZE = 50;
/** Pause after the last key press before the search is sent. */
export const SEARCH_DELAY_MS = 250;

/** Security advisories of all watched repositories, compared with the installed versions. */
@Component({
  selector: 'app-vulnerabilities-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, RouterLink, Avatar, Icon, InView, RelativeTimePipe],
  templateUrl: './vulnerabilities.page.html',
  styleUrl: './vulnerabilities.page.scss',
})
export class VulnerabilitiesPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  protected readonly statusService = inject(StatusService);
  protected readonly describeCron = describeCron;

  /** Pages loaded so far (sorted and filtered by the server). */
  protected readonly advisories = signal<RepositoryAdvisory[]>([]);
  /** Advisories matching the filters. */
  protected readonly total = signal(0);
  private readonly overview = signal<AdvisoryOverview | null>(null);
  private readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadingMore = signal(false);
  /** Text in the search box; the search follows it after {@link SEARCH_DELAY_MS}, not with every key press. */
  protected readonly searchText = signal('');
  private readonly query = signal('');
  /** Starts on the advisories affecting an installed version (falls back to all on the first load when there are none). */
  protected readonly impact = signal<Impact>('affecting');
  private firstLoad = true;
  protected readonly severity = signal<AdvisorySeverity | 'all'>('all');
  protected readonly source = signal<AdvisorySource | 'all'>('all');
  protected readonly sourceLabels = SOURCE_LABELS;
  /** Sources present in the data (the filter is shown only when there are several). */
  protected readonly sources = computed(() => this.overview()?.sources ?? []);

  protected readonly severityLabels = SEVERITY_LABELS;
  protected readonly severities: AdvisorySeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

  protected readonly impacts: { value: Impact; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'affecting', label: 'Affects installed' },
    { value: 'unknown', label: 'Unknown' },
    { value: 'unaffected', label: 'Not affected' },
  ];

  /** Tab counters over all advisories (the other filters do not change them). */
  protected readonly counts = computed(() => {
    const o = this.overview();
    return { all: o?.total ?? 0, affecting: o?.affecting ?? 0, unknown: o?.unknown ?? 0, unaffected: o?.unaffected ?? 0 };
  });

  /** Headline numbers: what needs attention first. */
  protected readonly stats = computed(() => {
    const o = this.overview();
    return { affecting: o?.affecting ?? 0, critical: o?.critical ?? 0, repositories: o?.repositories ?? 0, noFix: o?.noFix ?? 0 };
  });

  /** Whether any advisory is stored at all (otherwise the empty state is shown instead of "nothing matches"). */
  protected readonly hasAny = computed(() => (this.overview()?.total ?? 0) > 0);
  protected readonly hasMore = computed(() => this.nextCursor() !== null);
  protected readonly pageSize = PAGE_SIZE;
  protected readonly remaining = computed(() => Math.max(0, this.total() - this.advisories().length));

  /** Filters of the loaded pages (following pages must use the same). */
  private filter: Filter = { impact: 'affecting', severity: 'all', source: 'all', q: '' };
  /** Answers to requests started before the latest first-page request are dropped. */
  private generation = 0;

  constructor() {
    effect((onCleanup) => {
      const text = this.searchText().trim();
      const timer = setTimeout(() => this.query.set(text), SEARCH_DELAY_MS);
      onCleanup(() => clearTimeout(timer));
    });

    // The first page again whenever a filter changes or "Check all now" finished in the sidebar.
    effect(() => {
      const filter: Filter = { impact: this.impact(), severity: this.severity(), source: this.source(), q: this.query() };
      this.statusService.revision();
      untracked(() => void this.load(filter));
    });
  }

  protected async load(filter: Filter): Promise<void> {
    const generation = ++this.generation;
    try {
      const page = await firstValueFrom(this.api.getAdvisoryPage({ ...filter, limit: PAGE_SIZE }));
      if (generation !== this.generation) {
        return;
      }
      if (this.firstLoad && filter.impact === 'affecting' && page.overview && page.overview.affecting === 0 && page.overview.total > 0) {
        // Nothing affects an installed version: show all instead (the effect loads them).
        this.firstLoad = false;
        this.impact.set('all');
        return;
      }
      this.firstLoad = false;
      this.filter = filter;
      this.advisories.set(page.items);
      this.total.set(page.total ?? page.items.length);
      this.overview.set(page.overview);
      this.nextCursor.set(page.nextCursor);
      this.loading.set(false);
    } catch (error) {
      if (generation === this.generation) {
        this.toast.error(error);
        this.loading.set(false);
      }
    }
  }

  /** Loads the next page (infinite scrolling); keyset pagination, so rows added meanwhile never repeat. */
  protected async showMore(): Promise<void> {
    const cursor = this.nextCursor();
    if (!cursor || this.loadingMore()) {
      return;
    }
    const generation = this.generation;
    this.loadingMore.set(true);
    try {
      const page = await firstValueFrom(this.api.getAdvisoryPage({ ...this.filter, cursor, limit: PAGE_SIZE }));
      if (generation === this.generation) {
        this.advisories.update((list) => [...list, ...page.items]);
        this.nextCursor.set(page.nextCursor);
      }
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.loadingMore.set(false);
    }
  }

  protected onSource(value: string): void {
    this.source.set(value as AdvisorySource | 'all');
  }

  protected onSeverity(value: string): void {
    this.severity.set(value as AdvisorySeverity | 'all');
  }
}
