import { inject } from '@angular/core';
import { RedirectFunction, Routes } from '@angular/router';
import { authGuard, loginGuard, setupGuard } from './core/auth.guards';
import { NavigationService } from './core/navigation';

/** `/` and unknown paths open the first page of the sidebar (its order is a preference of this browser). */
const toHome: RedirectFunction = () => inject(NavigationService).home();

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: toHome },
  {
    path: 'login',
    title: 'Sign in · ReleaseWatcher',
    canActivate: [loginGuard],
    loadComponent: () => import('./pages/auth/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'setup',
    title: 'Set up · ReleaseWatcher',
    canActivate: [setupGuard],
    loadComponent: () => import('./pages/auth/setup.page').then((m) => m.SetupPage),
  },
  {
    path: 'repositories',
    title: 'Repositories · ReleaseWatcher',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/repositories/repositories.page').then((m) => m.RepositoriesPage),
  },
  {
    path: 'vulnerabilities',
    title: 'Vulnerabilities · ReleaseWatcher',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/vulnerabilities/vulnerabilities.page').then((m) => m.VulnerabilitiesPage),
  },
  {
    path: 'machines',
    title: 'Machines · ReleaseWatcher',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/containers/containers.page').then((m) => m.ContainersPage),
  },
  {
    path: 'docker',
    title: 'Docker · ReleaseWatcher',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/docker/docker.page').then((m) => m.DockerPage),
  },
  // The page was called Containers before servers and several Proxmox nodes (old links and notifications).
  { path: 'containers', redirectTo: 'machines' },
  {
    path: 'settings',
    title: 'Settings · ReleaseWatcher',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
  {
    path: 'account',
    title: 'Account · ReleaseWatcher',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/account/account.page').then((m) => m.AccountPage),
  },
  { path: '**', redirectTo: toHome },
];
