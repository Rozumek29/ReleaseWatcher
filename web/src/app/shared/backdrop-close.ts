import { Directive, ElementRef, inject, input, output } from '@angular/core';

/** Whether the browser closes a modal `<dialog closedby="any">` on a backdrop click by itself. */
function hasNativeLightDismiss(): boolean {
  return typeof HTMLDialogElement !== 'undefined' && 'closedBy' in HTMLDialogElement.prototype;
}

/** Whether the pointer event happened on the dialog's backdrop (not on its box, padding or scrollbar). */
function isOnBackdrop(event: MouseEvent): boolean {
  const dialog = event.currentTarget;
  if (!(dialog instanceof Element) || event.target !== dialog) {
    return false;
  }
  const box = dialog.getBoundingClientRect();
  return (
    event.clientX < box.left ||
    event.clientX > box.right ||
    event.clientY < box.top ||
    event.clientY > box.bottom
  );
}

/**
 * Light dismiss for a modal `<dialog>`: a click on the backdrop closes it.
 *
 * Sets `closedby="any"`, so browsers that support it close the dialog natively (the `close` event
 * fires). Elsewhere (Safari) the directive emits `backdropClose` instead – but only when both the
 * press and the release happen on the backdrop. A text selection that starts inside and ends
 * outside, or a press on the backdrop released inside, fires a `click` on the dialog element too
 * (the common ancestor) and must not close it.
 *
 * With `keepOpen` (a form with unsaved changes) neither a backdrop click nor Escape closes the dialog: it shakes
 * instead, and only its own buttons close it.
 */
@Directive({
  selector: 'dialog[appBackdropClose]',
  host: {
    '[attr.closedby]': "keepOpen() ? 'none' : 'any'",
    '(cancel)': 'onCancel($event)',
    '(keydown.escape)': 'onEscape()',
    '(pointerdown)': 'onPointerDown($event)',
    '(pointerup)': 'onPointerUp($event)',
    '(click)': 'onClick($event)',
  },
})
export class BackdropClose {
  readonly backdropClose = output<void>();
  /** Don't close on a backdrop click or Escape (e.g. while the form has unsaved changes). */
  readonly keepOpen = input(false);

  private readonly dialog = inject<ElementRef<HTMLDialogElement>>(ElementRef).nativeElement;

  private pressedOnBackdrop = false;
  private releasedOnBackdrop = false;

  protected onPointerDown(event: PointerEvent): void {
    this.pressedOnBackdrop = isOnBackdrop(event);
    this.releasedOnBackdrop = false;
  }

  protected onPointerUp(event: PointerEvent): void {
    this.releasedOnBackdrop = isOnBackdrop(event);
  }

  protected onClick(event: MouseEvent): void {
    const onBackdrop = this.pressedOnBackdrop && this.releasedOnBackdrop && isOnBackdrop(event);
    this.pressedOnBackdrop = false;
    this.releasedOnBackdrop = false;
    if (!onBackdrop) {
      return;
    }
    if (this.keepOpen()) {
      this.shake();
    } else if (!hasNativeLightDismiss()) {
      this.backdropClose.emit();
    }
  }

  /** Escape fires `cancel` where `closedby` is unsupported; keep the dialog open there too. */
  protected onCancel(event: Event): void {
    if (this.keepOpen()) {
      event.preventDefault();
    }
  }

  protected onEscape(): void {
    if (this.keepOpen()) {
      this.shake();
    }
  }

  /** Restarts the shake animation (`.dialog.shake` in styles.scss). */
  private shake(): void {
    const dialog = this.dialog;
    dialog.classList.remove('shake');
    void dialog.offsetWidth; // reflow, so a repeated shake starts again
    dialog.classList.add('shake');
    dialog.addEventListener('animationend', () => dialog.classList.remove('shake'), { once: true });
  }
}
