import { afterNextRender, DestroyRef, Directive, ElementRef, inject, input, output } from '@angular/core';

/**
 * Emits `inView` when the host element scrolls into (or near) the viewport – the trigger for infinite
 * scrolling. While the element stays visible it emits again after each emission (the observer is
 * re-attached on the next frame), so a tall screen keeps loading until the element is pushed out of view.
 * Does nothing where `IntersectionObserver` is missing; keep a clickable fallback on the host.
 */
@Directive({ selector: '[appInView]' })
export class InView {
  /** How far before the viewport the element counts as visible (CSS margin syntax). */
  readonly inViewMargin = input('400px');
  readonly inView = output<void>();

  constructor() {
    const element = inject<ElementRef<Element>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (typeof IntersectionObserver === 'undefined') {
        return;
      }
      let frame = 0;
      const observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) {
            return;
          }
          this.inView.emit();
          observer.unobserve(element);
          frame = requestAnimationFrame(() => observer.observe(element));
        },
        { rootMargin: this.inViewMargin() },
      );
      observer.observe(element);
      destroyRef.onDestroy(() => {
        cancelAnimationFrame(frame);
        observer.disconnect();
      });
    });
  }
}
