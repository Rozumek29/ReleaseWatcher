import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BackdropClose } from './backdrop-close';

@Component({
  imports: [BackdropClose],
  template: `<dialog appBackdropClose (backdropClose)="closes = closes + 1">
    <p>Content</p>
  </dialog>`,
})
class Host {
  closes = 0;
}

/** The dialog box in the tests; points outside it are on the backdrop. */
const BOX = { left: 100, top: 100, right: 300, bottom: 300, width: 200, height: 200, x: 100, y: 100 };
const OUTSIDE = { clientX: 20, clientY: 20 };
const INSIDE = { clientX: 150, clientY: 150 };

type Point = typeof OUTSIDE;

describe('BackdropClose', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const dialog = element.querySelector('dialog')!;
    dialog.getBoundingClientRect = () => ({ ...BOX, toJSON: () => BOX }) as DOMRect;
    return { host: fixture.componentInstance, dialog, content: element.querySelector('p')! };
  }

  /**
   * A press on one element and a release on another; like a browser, the click goes to the
   * common ancestor (`clickTarget`).
   */
  function gesture(
    down: [Element, Point],
    up: [Element, Point],
    clickTarget: Element = up[0],
  ): void {
    down[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ...down[1] }));
    up[0].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, ...up[1] }));
    clickTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, ...up[1] }));
  }

  it('asks the browser for native light dismiss', () => {
    const { dialog } = setup();
    expect(dialog.getAttribute('closedby')).toBe('any');
  });

  it('closes when pressed and released on the backdrop', () => {
    const { host, dialog } = setup();
    gesture([dialog, OUTSIDE], [dialog, OUTSIDE]);
    expect(host.closes).toBe(1);
  });

  it('stays open when a selection starts inside and ends on the backdrop', () => {
    const { host, dialog, content } = setup();
    gesture([content, INSIDE], [dialog, OUTSIDE]);
    expect(host.closes).toBe(0);
  });

  it('stays open when pressed on the backdrop and released inside', () => {
    const { host, dialog, content } = setup();
    gesture([dialog, OUTSIDE], [content, INSIDE], dialog);
    expect(host.closes).toBe(0);
  });

  it('stays open for clicks on the dialog box itself (padding, scrollbar)', () => {
    const { host, dialog } = setup();
    gesture([dialog, INSIDE], [dialog, INSIDE]);
    expect(host.closes).toBe(0);
  });

  it('stays open for clicks inside the dialog', () => {
    const { host, content } = setup();
    gesture([content, INSIDE], [content, INSIDE]);
    expect(host.closes).toBe(0);
  });
});
