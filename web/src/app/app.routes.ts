import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'repositories' },
  {
    path: 'repositories',
    title: 'Repositories · ReleaseWatcher',
    loadComponent: () => import('./pages/repositories/repositories.page').then((m) => m.RepositoriesPage),
  },
  {
    path: 'containers',
    title: 'Containers · ReleaseWatcher',
    loadComponent: () => import('./pages/containers/containers.page').then((m) => m.ContainersPage),
  },
  {
    path: 'settings',
    title: 'Settings · ReleaseWatcher',
    loadComponent: () => import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'repositories' },
];
