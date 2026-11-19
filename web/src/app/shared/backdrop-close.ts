import { Directive, output } from '@angular/core';

/**
 * Emits `backdropClose` when a modal `<dialog>` is clicked on its backdrop. Both the press and the
 * release must happen on the backdrop – a text selection that starts inside the dialog and ends
 * outside it fires a `click` on the dialog element too, and must not close it.
 */
@Directive({
  selector: 'dialog[appBackdropClose]',
  host: {
    '(pointerdown)': 'onPointerDown($event)',
    '(click)': 'onClick($event)',
  },
})
export class BackdropClose {
  readonly backdropClose = output<void>();

  private pressedOnBackdrop = false;

  protected onPointerDown(event: PointerEvent): void {
    this.pressedOnBackdrop = event.target === event.currentTarget;
  }

  protected onClick(event: MouseEvent): void {
    const onBackdrop = this.pressedOnBackdrop && event.target === event.currentTarget;
    this.pressedOnBackdrop = false;
    if (onBackdrop) {
      this.backdropClose.emit();
    }
  }
}
