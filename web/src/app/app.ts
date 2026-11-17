import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { AuthService } from './core/auth.service';
import { StatusService } from './core/status.service';
import { ToastService } from './core/toast.service';
import { Icon, IconName } from './shared/icon';
import { RelativeTimePipe } from './shared/relative-time.pipe';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
}

/** App shell: sidebar navigation, poller status and global toasts; sign-in pages get a bare layout. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, RelativeTimePipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  protected readonly statusService = inject(StatusService);
  protected readonly toastService = inject(ToastService);
  protected readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly nav: NavItem[] = [
    { path: '/repositories', label: 'Repositories', icon: 'repo' },
    { path: '/containers', label: 'Containers', icon: 'box' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  /** Source code and releases of ReleaseWatcher itself. */
  protected readonly repositoryUrl = 'https://github.com/Rozumek29/ReleaseWatcher';
  /** Running version from the status ("v1.2.3"; pre-release tags like "beta-1.2.3" stay as they are). */
  protected readonly version = computed(() => {
    const version = this.statusService.status()?.version;
    return version ? (/^\d/.test(version) ? `v${version}` : version) : '';
  });

  protected readonly sidebarOpen = signal(false);
  /** Ticks every 30 s so relative times ("in 5 minutes") stay current. */
  protected readonly now = signal(Date.now());
  private readonly url = signal(this.router.url);
  /** Sign-in and setup pages: no sidebar. */
  protected readonly authLayout = computed(() => /^\/(login|setup)(\/|\?|$)/.test(this.url()));

  constructor() {
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe((e) => {
      this.url.set(e.urlAfterRedirects);
      this.sidebarOpen.set(false);
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
      this.now.set(Date.now());
      void this.statusService.refresh();
      timer = setInterval(() => {
        this.now.set(Date.now());
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
    const onVisibilityChange = () => (document.visibilityState === 'hidden' ? stop() : startPolling());
    document.addEventListener('visibilitychange', onVisibilityChange);
    inject(DestroyRef).onDestroy(() => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  protected async signOut(): Promise<void> {
    await this.auth.logout();
    await this.router.navigateByUrl('/login');
  }
}
