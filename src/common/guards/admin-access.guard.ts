import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ADMIN_ACCESS_KEY,
  AdminAccessRequirement,
} from '../decorators/admin-access.decorator';
import { UserRole } from '../decorators/roles.decorator';
import { hasAdminAccess } from '../../users/utils/admin-access.util';

@Injectable()
export class AdminAccessGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<AdminAccessRequirement>(
      ADMIN_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requirement) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new ForbiddenException(
        "You don't have permission to perform this action",
      );
    }

    if (
      requirement.catalogManagerBypass &&
      user.role === UserRole.CATALOG_MANAGER
    ) {
      return true;
    }

    if (!hasAdminAccess(user, requirement.key)) {
      throw new ForbiddenException(
        "You don't have permission to perform this action",
      );
    }

    return true;
  }
}
