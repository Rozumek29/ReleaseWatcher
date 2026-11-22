import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService, describeError } from '../core/api.service';
import { SelfhstIcon } from '../core/models';
import { Avatar } from './avatar';
import { BackdropClose } from './backdrop-close';
import { Icon } from './icon';
import { iconUrls } from './icon-urls';
import { InView } from './in-view';

export type IconVariant = 'default' | 'light' | 'dark';

/** Icons rendered at first and added per "Show more" (the list has about 3,000). */
const PAGE_SIZE = 120;

/** The icon list is loaded once per page load and shared by every picker. */
let catalog: Promise<SelfhstIcon[]> | null = null;

/** Drops the loaded icon list (tests). */
export function forgetIconCatalog(): void {
  catalog = null;
}

/** Visual picker for selfh.st/icons: search, light/dark variants, a grid of previews. Emits `sh:<slug>`. */
@Component({
  selector: 'app-icon-picker-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Avatar, BackdropClose, Icon, InView],
  templateUrl: './icon-picker.dialog.html',
  styleUrl: './icon-picker.dialog.scss',
})
export class IconPickerDialog {
  private readonly api = inject(ApiService);

  /** Current icon value (`sh:…`, a URL or ""); null closes the dialog. */
  readonly value = input<string | null>(null);
  /** Name used as the first search, e.g. the repository name. */
  readonly suggestion = input('');
  readonly picked = output<string>();
  readonly closed = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly icons = signal<SelfhstIcon[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly variant = signal<IconVariant>('default');
  protected readonly limit = signal(PAGE_SIZE);
  protected readonly variants: { id: IconVariant; label: string }[] = [
    { id: 'default', label: 'Default' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  /** Icons matching the search and having the chosen variant; names starting with the search first. */
  protected readonly matches = computed(() => {
    const variant = this.variant();
    const terms = this.query().trim().toLowerCase().split(/\s+/).filter(Boolean);
    const available = this.icons().filter((i) => variant === 'default' || i[variant]);
    if (terms.length === 0) {
      return available;
    }
    const first = terms[0]!;
    return available
      .filter((i) => {
        const text = `${i.name} ${i.reference} ${i.category} ${i.tags.join(' ')}`.toLowerCase();
        return terms.every((t) => text.includes(t));
      })
      .sort((a, b) => rank(a, first) - rank(b, first) || a.name.localeCompare(b.name));
  });
  protected readonly shown = computed(() => this.matches().slice(0, this.limit()));
  /** `sh:` value of the current icon, to highlight it. */
  private readonly selected = computed(() => this.value()?.trim().toLowerCase() ?? '');

  constructor() {
    effect(() => {
      const value = this.value();
      const dialog = this.dialog().nativeElement;
      if (value !== null) {
        this.start(value);
        if (!dialog.open) {
          dialog.showModal?.();
        }
      } else if (dialog.open) {
        dialog.close();
      }
    });
  }

  protected shorthand(icon: SelfhstIcon): string {
    const variant = this.variant();
    return `sh:${icon.reference}${variant === 'default' ? '' : `-${variant}`}`;
  }

  protected previewUrls(icon: SelfhstIcon): string[] {
    return iconUrls(this.shorthand(icon));
  }

  protected isSelected(icon: SelfhstIcon): boolean {
    return this.selected() === this.shorthand(icon);
  }

  protected search(query: string): void {
    this.query.set(query);
    this.limit.set(PAGE_SIZE);
  }

  protected setVariant(variant: IconVariant): void {
    this.variant.set(variant);
    this.limit.set(PAGE_SIZE);
  }

  protected showMore(): void {
    if (this.limit() < this.matches().length) {
      this.limit.update((n) => n + PAGE_SIZE);
    }
  }

  protected pick(icon: SelfhstIcon): void {
    this.picked.emit(this.shorthand(icon));
  }

  protected close(): void {
    const dialog = this.dialog().nativeElement;
    if (dialog.open) {
      dialog.close();
    }
    this.closed.emit();
  }

  protected retry(): void {
    catalog = null;
    void this.load();
  }

  /** Opens on the current icon (its slug and variant) or on the suggested name. */
  private start(value: string): void {
    const current = value
      .trim()
      .toLowerCase()
      .match(/^sh:([a-z0-9_-]+?)(?:-(light|dark))?(?:\.\w+)?$/);
    this.variant.set((current?.[2] as IconVariant | undefined) ?? 'default');
    this.query.set(current?.[1] ?? this.suggestion());
    this.limit.set(PAGE_SIZE);
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.icons().length > 0) {
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      catalog ??= firstValueFrom(this.api.getSelfhstIcons());
      this.icons.set(await catalog);
    } catch (error) {
      catalog = null;
      this.error.set(describeError(error));
    } finally {
      this.loading.set(false);
    }
  }
}

/** 0 = exact slug, 1 = name or slug starts with the term, 2 = anywhere. */
function rank(icon: SelfhstIcon, term: string): number {
  if (icon.reference === term) {
    return 0;
  }
  return icon.reference.startsWith(term) || icon.name.toLowerCase().startsWith(term) ? 1 : 2;
}
