import { ChangeDetectionStrategy, Component, computed, input, linkedSignal } from '@angular/core';

/**
 * Repository icon: the custom icon (`icons`, tried in order), then the owner avatar (`src`), then a lettered
 * fallback when no image can be loaded (e.g. offline or a missing selfh.st icon).
 */
@Component({
  selector: 'app-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { 'aria-hidden': 'true', '[style.--size.px]': 'size()' },
  template: `
    @if (current(); as image) {
      <img
        [src]="image.url"
        [class.logo]="image.logo"
        alt=""
        loading="lazy"
        decoding="async"
        [width]="size()"
        [height]="size()"
        (error)="index.set(index() + 1)"
      />
    } @else {
      <span class="fallback">{{ initial() }}</span>
    }
  `,
  styles: `
    :host {
      display: inline-grid;
      flex-shrink: 0;
      width: var(--size);
      height: var(--size);
      border-radius: min(10px, calc(var(--size) * 0.28));
      overflow: hidden;
      background: var(--surface-2);
      box-shadow: inset 0 0 0 1px var(--border);
    }
    img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    /* Logos keep their shape and get some air instead of being cropped like a photo. */
    img.logo {
      object-fit: contain;
      padding: calc(var(--size) * 0.12);
    }
    .fallback {
      display: grid;
      place-items: center;
      color: var(--text-muted);
      font-weight: 650;
      font-size: calc(var(--size) * 0.42);
      text-transform: uppercase;
    }
  `,
})
export class Avatar {
  /** Owner avatar, used when there is no custom icon or none of its URLs loads. */
  readonly src = input<string | null>(null);
  /** URLs of a custom icon, best first. */
  readonly icons = input<readonly string[]>([]);
  readonly name = input('');
  readonly size = input(36);

  private readonly images = computed(() => [
    ...this.icons().map((url) => ({ url, logo: true })),
    ...(this.src() ? [{ url: this.src()!, logo: false }] : []),
  ]);
  /** Image being shown; moves to the next one when it fails to load, starts over when the URLs change. */
  protected readonly index = linkedSignal({ source: this.images, computation: () => 0 });
  protected readonly current = computed(() => this.images()[this.index()] ?? null);
  protected readonly initial = computed(() => this.name().charAt(0) || '?');
}
