import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

/** App pages: need a session; without an account go to the setup screen. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const auth = await inject(AuthService).ensureLoaded();
  if (auth.setupRequired) {
    return router.createUrlTree(['/setup']);
  }
  if (!auth.authenticated) {
    return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
  }
  return true;
};

/** Login page: only for signed-out users of an existing account. */
export const loginGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const auth = await inject(AuthService).ensureLoaded();
  if (auth.setupRequired) {
    return router.createUrlTree(['/setup']);
  }
  return auth.authenticated ? router.createUrlTree(['/']) : true;
};

/** Setup page: only while no account exists. */
export const setupGuard: CanActivateFn = async () => {
  const router = inject(Router);
  const auth = await inject(AuthService).load();
  if (auth.setupRequired) {
    return true;
  }
  return router.createUrlTree([auth.authenticated ? '/' : '/login']);
};
