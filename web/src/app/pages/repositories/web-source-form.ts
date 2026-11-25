import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError, fieldErrors } from '../../core/api.service';
import { WatchedRepository, WebSource, WebSourceFormat, WebSourcePreview } from '../../core/models';
import { StatusService } from '../../core/status.service';
import { Icon } from '../../shared/icon';

/** Fields of the form that the server reports validation errors for. */
type WebSourceField =
  | 'name'
  | 'url'
  | 'format'
  | 'items'
  | 'version'
  | 'date'
  | 'link'
  | 'userAgent'
  | 'versionPattern';

/** Keys of the server's validation errors (`errors` of a problem response) and the fields they belong to. */
const ERROR_FIELDS: Record<string, WebSourceField> = {
  name: 'name',
  'webSource.url': 'url',
  'webSource.format': 'format',
  'webSource.items': 'items',
  'webSource.version': 'version',
  'webSource.date': 'date',
  'webSource.link': 'link',
  'webSource.userAgent': 'userAgent',
  versionPattern: 'versionPattern',
};

/** Fields not shown for the text format (the pattern alone finds the versions). */
const STRUCTURED_FIELDS: readonly WebSourceField[] = ['items', 'version', 'date', 'link'];

export const WEB_SOURCE_FORMATS: readonly { value: WebSourceFormat; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'json', label: 'JSON' },
  { value: 'html', label: 'HTML' },
  { value: 'xml', label: 'XML (RSS, Atom)' },
];

/** Field values of a common feed format (format XML). */
export const WEB_SOURCE_PRESETS = {
  rss: { items: 'item', version: 'title', date: 'pubDate', link: 'link' },
  atom: { items: 'entry', version: 'title', date: 'published, updated', link: 'link' },
} as const;

/** Kind and example values (placeholders) of the item fields per structured format. */
const FIELD_COPY: Record<
  Exclude<WebSourceFormat, 'text'>,
  { kind: 'selector' | 'path'; items: string; version: string; date: string; link: string }
> = {
  html: {
    kind: 'selector',
    items: '.release',
    version: 'dt a.gdoc-props__title',
    date: 'time',
    link: 'a',
  },
  json: {
    kind: 'path',
    items: 'downloads[*]',
    version: 'version',
    date: 'released_at',
    link: 'url',
  },
  xml: {
    kind: 'selector',
    items: 'item',
    version: 'title',
    date: 'pubDate',
    link: 'link',
  },
};

/**
 * Values of a web source form, shared by the dialog that adds one and the settings of an existing one: the parent
 * reads them for saving and comparing (unsaved changes), the form edits them. A new draft starts a new form.
 */
export class WebSourceDraft {
  readonly name = signal('');
  readonly url = signal('');
  readonly format = signal<WebSourceFormat>('html');
  readonly items = signal('');
  readonly version = signal('');
  readonly date = signal('');
  readonly link = signal('');
  readonly userAgent = signal('');
  readonly pattern = signal('');
  /** Validation errors of the last request, per field. */
  readonly errors = signal<Partial<Record<WebSourceField, string>>>({});
  /** Result of the last test; null = not tested (or failed, see `previewError`). */
  readonly preview = signal<WebSourcePreview | null>(null);
  readonly previewError = signal<string | null>(null);
  readonly isText = computed(() => this.format() === 'text');

  /** A draft with the values of a saved web source, or an empty one. */
  static of(repository: WatchedRepository | null): WebSourceDraft {
    const draft = new WebSourceDraft();
    const source = repository?.webSource;
    if (repository && source) {
      draft.name.set(repository.name);
      draft.url.set(source.url);
      draft.format.set(source.format);
      draft.items.set(source.items ?? '');
      draft.version.set(source.version ?? '');
      draft.date.set(source.date ?? '');
      draft.link.set(source.link ?? '');
      draft.userAgent.set(source.userAgent ?? '');
      draft.pattern.set(repository.versionPattern ?? '');
    }
    return draft;
  }

  /** The source as sent to the server; the text format sends no selectors. */
  webSource(): WebSource {
    const text = this.isText();
    const optional = (value: string): string | null => (text ? null : value.trim() || null);
    return {
      url: this.url().trim(),
      format: this.format(),
      items: optional(this.items()),
      version: optional(this.version()),
      date: optional(this.date()),
      link: optional(this.link()),
      userAgent: this.userAgent().trim() || null,
    };
  }

  versionPattern(): string | null {
    return this.pattern().trim() || null;
  }

  /** The values compared to tell unsaved changes. */
  values(): unknown {
    return [this.name().trim(), this.webSource(), this.versionPattern()];
  }

  /** Fills in the fields of an RSS or Atom feed. */
  applyPreset(preset: keyof typeof WEB_SOURCE_PRESETS): void {
    const values = WEB_SOURCE_PRESETS[preset];
    this.format.set('xml');
    this.items.set(values.items);
    this.version.set(values.version);
    this.date.set(values.date);
    this.link.set(values.link);
  }

  /**
   * Shows the validation errors of a failed request at their fields. Returns the message left for the form as a whole,
   * or null when every error is shown at a field.
   */
  fail(error: unknown): string | null {
    const errors = fieldErrors(error);
    if (!errors) {
      this.errors.set({});
      return describeError(error);
    }
    const shown: Partial<Record<WebSourceField, string>> = {};
    const rest: string[] = [];
    for (const [key, message] of Object.entries(errors)) {
      const field = ERROR_FIELDS[key];
      if (field && !(this.isText() && STRUCTURED_FIELDS.includes(field))) {
        shown[field] = message;
      } else {
        rest.push(message);
      }
    }
    this.errors.set(shown);
    return rest.length > 0 ? rest.join(' ') : null;
  }
}

/** Fields of a web source (name, URL, format, selectors, pattern) with a test that lists the versions found. */
@Component({
  selector: 'app-web-source-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, FormsModule, Icon],
  templateUrl: './web-source-form.html',
  styleUrl: './web-source-form.scss',
})
export class WebSourceForm {
  private readonly api = inject(ApiService);
  private readonly status = inject(StatusService);

  readonly draft = input.required<WebSourceDraft>();
  /** Sent with the test, so pre-releases are left out like on a check. */
  readonly includePrereleases = input(false);
  /** Prefix of the element ids, unique per dialog. */
  readonly idPrefix = input('web-source');

  protected readonly formats = WEB_SOURCE_FORMATS;
  protected readonly testing = signal(false);
  /** The User-Agent field is shown when set or asked for. */
  protected readonly userAgentOpen = signal(false);

  protected readonly copy = computed(() => {
    const format = this.draft().format();
    return format === 'text' ? null : FIELD_COPY[format];
  });

  protected readonly defaultUserAgent = computed(
    () =>
      `ReleaseWatcher/${this.status.status()?.version ?? '<version>'} (+https://github.com/Rozumek29/ReleaseWatcher)`,
  );

  /** Index of the newest version in the preview (the first entry with it). */
  protected readonly newestIndex = computed(() => {
    const preview = this.draft().preview();
    return preview?.newest ? preview.releases.findIndex((r) => r.version === preview.newest) : -1;
  });

  protected id(field: string): string {
    return `${this.idPrefix()}-${field}`;
  }

  protected formatLabel(format: WebSourceFormat): string {
    return format === 'xml'
      ? 'XML'
      : (WEB_SOURCE_FORMATS.find((f) => f.value === format)?.label ?? format);
  }

  protected size(bytes: number): string {
    return bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} kB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  /** Switches to the format the response looks like and tests again. */
  protected useFormat(format: WebSourceFormat): void {
    this.draft().format.set(format);
    void this.test();
  }

  protected async test(): Promise<void> {
    const draft = this.draft();
    if (!draft.url().trim() || this.testing()) {
      return;
    }
    this.testing.set(true);
    draft.preview.set(null);
    draft.previewError.set(null);
    draft.errors.set({});
    try {
      draft.preview.set(
        await firstValueFrom(
          this.api.previewWebSource({
            webSource: draft.webSource(),
            versionPattern: draft.versionPattern(),
            includePrereleases: this.includePrereleases(),
          }),
        ),
      );
    } catch (error) {
      draft.previewError.set(draft.fail(error) ?? 'Fix the fields marked above and test again.');
    } finally {
      this.testing.set(false);
    }
  }
}
