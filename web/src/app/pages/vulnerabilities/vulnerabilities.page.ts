import { DatePipe } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AdvisorySeverity, AdvisorySource, RepositoryAdvisory } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { ToastService } from '../../core/toast.service';
import { Avatar } from '../../shared/avatar';
import { Icon } from '../../shared/icon';
import { InView } from '../../shared/in-view';
import { RelativeTimePipe } from '../../shared/relative-time.pipe';
import { compareSeverity, impactRank, SEVERITY_LABELS, SOURCE_LABELS } from '../../shared/severity';

type Impact = 'all' | 'affecting' | 'unknown' | 'unaffected';

const PAGE_SIZE = 50;

/** Security advisories of all watched repositories, compared with the installed versions. */
@Component({
  selector: 'app-vulnerabilities-page',
  imports: [DatePipe, RouterLink, Avatar, Icon, InView, RelativeTimePipe],
  templateUrl: './vulnerabilities.page.html',
  styleUrl: './vulnerabilities.page.scss',
})
export class VulnerabilitiesPage {
  private readonly api = inject(ApiService);
  private readonly toast = inject(ToastService);
  private readonly statusService = inject(StatusService);

  protected readonly advisories = signal<RepositoryAdvisory[]>([]);
  protected readonly loading = signal(true);
  protected readonly query = signal('');
  protected readonly impact = signal<Impact>('all');
  protected readonly severity = signal<AdvisorySeverity | 'all'>('all');
  protected readonly source = signal<AdvisorySource | 'all'>('all');
  protected readonly sourceLabels = SOURCE_LABELS;
  /** Sources present in the data (the filter is shown only when there are several). */
  protected readonly sources = computed(() => [...new Set(this.advisories().map((a) => a.source))].sort());

  protected readonly severityLabels = SEVERITY_LABELS;
  protected readonly severities: AdvisorySeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];

  protected readonly impacts: { value: Impact; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'affecting', label: 'Affects installed' },
    { value: 'unknown', label: 'Unknown' },
    { value: 'unaffected', label: 'Not affected' },
  ];

  protected readonly counts = computed(() => {
    const list = this.advisories();
    return {
      all: list.length,
      affecting: list.filter((a) => a.affectsInstalled === true).length,
      unknown: list.filter((a) => a.affectsInstalled === null).length,
      unaffected: list.filter((a) => a.affectsInstalled === false).length,
    };
  });

  /** Headline numbers: what needs attention first. */
  protected readonly stats = computed(() => {
    const affecting = this.advisories().filter((a) => a.affectsInstalled === true);
    return {
      affecting: affecting.length,
      critical: affecting.filter((a) => a.severity === 'critical').length,
      repositories: new Set(affecting.map((a) => a.repository.id)).size,
      noFix: affecting.filter((a) => a.vulnerabilities.some((v) => !v.patchedVersions)).length,
    };
  });

  /** Filtered; affecting the installed version first, then by severity, then newest. */
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    const impact = this.impact();
    const severity = this.severity();
    const source = this.source();
    return this.advisories()
      .filter(
        (a) =>
          (impact === 'all' ||
            (impact === 'affecting' && a.affectsInstalled === true) ||
            (impact === 'unknown' && a.affectsInstalled === null) ||
            (impact === 'unaffected' && a.affectsInstalled === false)) &&
          (severity === 'all' || a.severity === severity) &&
          (source === 'all' || a.source === source) &&
          (!q ||
            [a.summary, a.id, a.cveId ?? '', a.repository.fullName, ...a.aliases].some((text) => text.toLowerCase().includes(q))),
      )
      .sort(
        (a, b) =>
          impactRank(b.affectsInstalled) - impactRank(a.affectsInstalled) ||
          compareSeverity(b.severity, a.severity) ||
          Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
      );
  });

  /** Rendered at once and added per step while scrolling; long lists stay fast to render. */
  protected readonly pageSize = PAGE_SIZE;
  protected readonly limit = signal(PAGE_SIZE);
  /** The part of `visible` that is rendered (infinite scrolling). */
  protected readonly shown = computed(() => this.visible().slice(0, this.limit()));
  protected readonly remaining = computed(() => this.visible().length - this.shown().length);

  constructor() {
    // A different filter starts at the top again.
    effect(() => {
      this.query();
      this.impact();
      this.severity();
      this.source();
      untracked(() => this.limit.set(PAGE_SIZE));
    });

    // Reload whenever "Check all now" finished in the sidebar.
    effect(() => {
      this.statusService.revision();
      untracked(() => void this.load());
    });
  }

  protected async load(): Promise<void> {
    try {
      this.advisories.set(await firstValueFrom(this.api.getAllAdvisories()));
    } catch (error) {
      this.toast.error(error);
    } finally {
      this.loading.set(false);
    }
  }

  protected showMore(): void {
    if (this.remaining() > 0) {
      this.limit.update((limit) => limit + PAGE_SIZE);
    }
  }

  protected onSource(value: string): void {
    this.source.set(value as AdvisorySource | 'all');
  }

  protected onSeverity(value: string): void {
    this.severity.set(value as AdvisorySeverity | 'all');
  }
}
