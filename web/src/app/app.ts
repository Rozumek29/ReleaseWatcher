import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  Injector,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { ClockService } from './core/clock.service';
import { AuthService } from './core/auth.service';
import type { NavPageId } from './core/nav-pages';
import { NavigationService } from './core/navigation';
import { PreferencesService } from './core/preferences.service';
import { StatusService } from './core/status.service';
import { ToastService } from './core/toast.service';
import { describeCron } from './shared/cron';
import { Icon } from './shared/icon';
import { RelativeTimePipe } from './shared/relative-time.pipe';

/** A sidebar item being dragged in rearrange mode. */
interface NavDrag {
  id: NavPageId;
  pointerId: number;
  /** Pointer position at which the item would sit in its current slot. */
  originY: number;
  /** Item heights (by page) and the gap between items, measured when the drag starts. */
  heights: Map<NavPageId, number>;
  gap: number;
}

/** App shell: sidebar navigation, poller status and global toasts; sign-in pages get a bare layout. */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, RelativeTimePipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly statusService = inject(StatusService);
  protected readonly toastService = inject(ToastService);
  protected readonly auth = inject(AuthService);
  // Applies the saved theme and accent colour.
  protected readonly preferences = inject(PreferencesService);
  private readonly router = inject(Router);

  /** Sidebar pages in the order chosen in this browser; rearranged by dragging in edit mode. */
  protected readonly navigation = inject(NavigationService);
  private readonly injector = inject(Injector);
  private readonly editList = viewChild<ElementRef<HTMLElement>>('editList');
  private drag: NavDrag | null = null;
  protected readonly draggingId = signal<NavPageId | null>(null);
  protected readonly dragOffset = signal(0);
  /** Read by screen readers after an item was moved. */
  protected readonly moveAnnouncement = signal('');

  /** Source code and releases of ReleaseWatcher itself. */
  protected readonly repositoryUrl = 'https://github.com/Rozumek29/ReleaseWatcher';
  /** Running version from the status ("v1.2.3"; pre-release tags like "beta-1.2.3" stay as they are). */
  protected readonly version = computed(() => {
    const version = this.statusService.status()?.version;
    return version ? (/^\d/.test(version) ? `v${version}` : version) : '';
  });

  protected readonly sidebarOpen = signal(false);
  private readonly clock = inject(ClockService);
  /** Ticked with the status poll (every 30 s) so relative times ("in 5 minutes") stay current. */
  protected readonly now = this.clock.now;
  protected readonly describeCron = describeCron;
  private readonly url = signal(this.router.url);
  /** Sign-in and setup pages: no sidebar. */
  protected readonly authLayout = computed(() => /^\/(login|setup)(\/|\?|$)/.test(this.url()));

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      this.url.set(e.urlAfterRedirects);
      this.sidebarOpen.set(false);
      this.navigation.editing.set(false);
    });
    // Rearranging happens in the sidebar, so on phones the drawer opens for it.
    effect(() => {
      if (this.navigation.editing()) {
        untracked(() => this.sidebarOpen.set(true));
      } else {
        this.moveAnnouncement.set('');
      }
    });

    // Poll the status only while signed in – otherwise every request would be a 401 – and only while the tab
    // is visible; a tab coming back refreshes at once.
    let timer: ReturnType<typeof setInterval> | null = null;
    let signedIn = false;
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startPolling = () => {
      stop();
      if (!signedIn || document.visibilityState === 'hidden') {
        return;
      }
      this.clock.tick();
      void this.statusService.refresh();
      timer = setInterval(() => {
        this.clock.tick();
        void this.statusService.refresh();
      }, 30_000);
    };
    effect(() => {
      signedIn = this.auth.authenticated();
      untracked(() => {
        startPolling();
        if (!signedIn) {
          this.statusService.status.set(null);
        }
      });
    });
    const onVisibilityChange = () =>
      document.visibilityState === 'hidden' ? stop() : startPolling();
    document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  protected closeSidebar(): void {
    this.sidebarOpen.set(false);
    this.navigation.editing.set(false);
  }

  protected startDrag(event: PointerEvent, id: NavPageId): void {
    const list = this.editList()?.nativeElement;
    if (!list || event.button !== 0 || this.drag) return;
    const items = [...list.querySelectorAll<HTMLElement>('[data-page]')];
    const rects = items.map((item) => item.getBoundingClientRect());
    const [first, second] = rects;
    this.drag = {
      id,
      pointerId: event.pointerId,
      originY: event.clientY,
      heights: new Map(
        items.map((item, i) => [item.dataset['page'] as NavPageId, rects[i]?.height ?? 0]),
      ),
      gap: first && second ? Math.max(0, second.top - first.bottom) : 0,
    };
    list.setPointerCapture?.(event.pointerId);
    this.draggingId.set(id);
    this.dragOffset.set(0);
  }

  /** Moves the dragged item into a neighbour's slot once it is dragged past half of that neighbour. */
  protected moveDrag(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const step = (id: NavPageId | undefined) => (id ? (drag.heights.get(id) ?? 0) + drag.gap : 0);
    for (;;) {
      const order = this.navigation.pages().map((p) => p.id);
      const index = order.indexOf(drag.id);
      const offset = event.clientY - drag.originY;
      const next = order[index + 1];
      const previous = order[index - 1];
      if (next && offset > step(next) / 2) {
        this.navigation.move(index, index + 1);
        drag.originY += step(next);
      } else if (previous && offset < -step(previous) / 2) {
        this.navigation.move(index, index - 1);
        drag.originY -= step(previous);
      } else {
        break;
      }
    }
    this.dragOffset.set(event.clientY - drag.originY);
  }

  protected endDrag(): void {
    if (!this.drag) return;
    this.drag = null;
    this.draggingId.set(null);
    this.dragOffset.set(0);
  }

  /** Keyboard alternative to dragging: arrow keys move the focused item, Home/End to the start/end. */
  protected moveByKey(event: KeyboardEvent, index: number): void {
    const last = this.navigation.pages().length - 1;
    const targets: Record<string, number> = {
      ArrowUp: index - 1,
      ArrowDown: index + 1,
      Home: 0,
      End: last,
    };
    const target = targets[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const page = this.navigation.pages()[index];
    if (!page || target < 0 || target > last || target === index) return;
    this.navigation.move(index, target);
    this.moveAnnouncement.set(
      `${page.label} moved to position ${target + 1} of ${last + 1}.` +
        (target === 0 ? ' It is now the start page.' : ''),
    );
    // Moving the element in the DOM can drop its focus.
    afterNextRender(
      () =>
        this.editList()
          ?.nativeElement.querySelector<HTMLElement>(`[data-page="${page.id}"]`)
          ?.focus(),
      { injector: this.injector },
    );
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
