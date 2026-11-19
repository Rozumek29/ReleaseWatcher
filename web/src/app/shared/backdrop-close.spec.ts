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

describe('BackdropClose', () => {
  function setup() {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    return {
      host: fixture.componentInstance,
      dialog: element.querySelector('dialog')!,
      content: element.querySelector('p')!,
    };
  }

  function press(target: Element): void {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  }

  function click(target: Element): void {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }

  it('closes when pressed and released on the backdrop', () => {
    const { host, dialog } = setup();
    press(dialog);
    click(dialog);
    expect(host.closes).toBe(1);
  });

  it('stays open when a selection starts inside and ends on the backdrop', () => {
    const { host, dialog, content } = setup();
    press(content);
    click(dialog);
    expect(host.closes).toBe(0);
  });

  it('stays open for clicks inside the dialog', () => {
    const { host, content } = setup();
    press(content);
    click(content);
    expect(host.closes).toBe(0);
  });
});
