import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ADMIN_ACCESS_KEY,
  AdminAccessRequirement,
} from '../decorators/admin-access.decorator';
import { ROLES_KEY, UserRole } from '../decorators/roles.decorator';
import { hasAdminAccess } from '../../users/utils/admin-access.util';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  private getEffectiveRoles(role?: string): Set<string> {
    const effectiveRoles = new Set<string>();

    if (!role) {
      return effectiveRoles;
    }

    effectiveRoles.add(role);

    if (
      role === UserRole.CONSTANT_TOKEN_ADMIN ||
      role === 'products_api'
    ) {
      effectiveRoles.add(UserRole.ADMIN);
      effectiveRoles.add(UserRole.CONSTANT_TOKEN_ADMIN);
    }

    return effectiveRoles;
  }

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const { user } = context.switchToHttp().getRequest();

    if (requiredRoles) {
      const effectiveRoles = this.getEffectiveRoles(user?.role);
      if (!requiredRoles.some((role) => effectiveRoles.has(role))) {
        return false;
      }
    }

    const requirement = this.reflector.getAllAndOverride<AdminAccessRequirement>(
      ADMIN_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requirement) {
      return true;
    }

    if (!user) {
      throw new ForbiddenException(
        "You don't have permission to perform this action",
      );
    }

    if (!hasAdminAccess(user, requirement.key)) {
      throw new ForbiddenException(
        "You don't have permission to perform this action",
      );
    }

    return true;
  }
}
