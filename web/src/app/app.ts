import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { StatusService } from './core/status.service';
import { ToastService } from './core/toast.service';
import { Icon, IconName } from './shared/icon';
import { RelativeTimePipe } from './shared/relative-time.pipe';

interface NavItem {
  path: string;
  label: string;
  icon: IconName;
}

/** App shell: sidebar navigation, poller status and global toasts. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, Icon, RelativeTimePipe],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  protected readonly statusService = inject(StatusService);
  protected readonly toastService = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly nav: NavItem[] = [
    { path: '/repositories', label: 'Repositories', icon: 'repo' },
    { path: '/containers', label: 'Containers', icon: 'box' },
    { path: '/settings', label: 'Settings', icon: 'settings' },
  ];

  protected readonly sidebarOpen = signal(false);
  /** Ticks every 30 s so relative times ("in 5 minutes") stay current. */
  protected readonly now = signal(Date.now());

  constructor() {
    inject(Router)
      .events.pipe(filter((e) => e instanceof NavigationEnd))
      .subscribe(() => this.sidebarOpen.set(false));
  }

  ngOnInit(): void {
    void this.statusService.refresh();
    const timer = setInterval(() => {
      this.now.set(Date.now());
      void this.statusService.refresh();
    }, 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }
}
