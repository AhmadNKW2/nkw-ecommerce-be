import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isObservable, Observable } from 'rxjs';
import { catchError, of } from 'rxjs';

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  canActivate(
    context: ExecutionContext,
  ): boolean | Promise<boolean> | Observable<boolean> {
    const result = super.canActivate(context);

    if (result instanceof Promise) {
      return result.catch(() => true);
    }

    if (isObservable(result)) {
      return result.pipe(catchError(() => of(true)));
    }

    return result;
  }

  handleRequest<TUser = any>(err: any, user: any): TUser {
    return user ?? null;
  }
}
