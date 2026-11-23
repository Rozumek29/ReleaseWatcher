import { Injectable, signal } from '@angular/core';

/**
 * The current time behind relative times ("in 5 minutes"), shared by the shell and the pages. The shell ticks it with
 * the status poll (every 30 s while the tab is visible), so pages need no timers of their own; a page calls `tick()`
 * right after it shows a new time.
 */
@Injectable({ providedIn: 'root' })
export class ClockService {
  private readonly time = signal(Date.now());
  readonly now = this.time.asReadonly();

  tick(): void {
    this.time.set(Date.now());
  }
}
