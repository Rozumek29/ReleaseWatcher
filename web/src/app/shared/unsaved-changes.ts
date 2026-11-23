import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Icon } from './icon';

/**
 * "Unsaved changes" note placed next to the save button of a form whose values differ from the saved ones.
 * Content (e.g. a link to the unsaved part) is shown after the text.
 */
@Component({
  selector: 'app-unsaved-changes',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { role: 'status', class: 'fade-in' },
  template: `<app-icon name="alert" [size]="14" /><span>{{ text() }}<ng-content /></span>`,
  styles: `
    :host {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      color: var(--warning);
      font-size: 0.82rem;
      font-weight: 550;
    }
    app-icon {
      flex-shrink: 0;
    }
  `,
})
export class UnsavedChanges {
  readonly text = input('Unsaved changes');
}

/** Whether two form snapshots hold the same values. */
export const sameValues = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
