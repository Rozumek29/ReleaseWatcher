import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { AuthService } from './auth.service';

/**
 * A 401 from the API (outside /api/auth) means the session is gone – expired, signed out elsewhere or the password
 * was changed. Mark the user signed out and go to the login page, coming back afterwards.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((error: unknown) => {
      const path = new URL(req.url, 'http://local').pathname;
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        path.startsWith('/api/') &&
        !path.startsWith('/api/auth/')
      ) {
        auth.markSignedOut();
        const current = router.url;
        if (!current.startsWith('/login') && !current.startsWith('/setup')) {
          void router.navigate(['/login'], { queryParams: { returnUrl: current } });
        }
      }
      return throwError(() => error);
    }),
  );
};
