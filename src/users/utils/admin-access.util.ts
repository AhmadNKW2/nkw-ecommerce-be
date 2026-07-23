import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../entities/user.entity';
import {
  ADMIN_ACCESS_KEYS,
  AdminAccess,
  AdminAccessKey,
  DEFAULT_ADMIN_ACCESS,
  DEFAULT_VENDOR_PORTAL_ACCESS,
} from '../admin-access.constants';

type UserWithAccess = {
  role: UserRole;
  adminAccess?: AdminAccess | null;
};

const ADMIN_STAFF_ROLES: ReadonlySet<UserRole> = new Set([
  UserRole.ADMIN,
  UserRole.CONSTANT_TOKEN_ADMIN,
  UserRole.VENDOR_ADMIN,
  UserRole.STORE_ADMIN,
]);

export function isAdminStaffRole(role: UserRole | string | undefined | null): boolean {
  if (!role) {
    return false;
  }
  return ADMIN_STAFF_ROLES.has(role as UserRole);
}

function getDefaultAccessForRole(role: UserRole): AdminAccess {
  if (role === UserRole.VENDOR_ADMIN || role === UserRole.STORE_ADMIN) {
    return { ...DEFAULT_VENDOR_PORTAL_ACCESS };
  }

  if (role === UserRole.ADMIN || role === UserRole.CONSTANT_TOKEN_ADMIN) {
    return { ...DEFAULT_ADMIN_ACCESS };
  }

  return ADMIN_ACCESS_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {} as AdminAccess);
}

export function normalizeAdminAccess(
  value: unknown,
  fallback: AdminAccess = DEFAULT_ADMIN_ACCESS,
): AdminAccess | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const normalized = { ...fallback };

  for (const key of ADMIN_ACCESS_KEYS) {
    if (typeof record[key] === 'boolean') {
      normalized[key] = record[key] === true;
    }
  }

  return normalized;
}

export function resolveAdminAccess(user: UserWithAccess): AdminAccess {
  const fallback = getDefaultAccessForRole(user.role);
  const explicit = normalizeAdminAccess(user.adminAccess, fallback);
  if (explicit) {
    return explicit;
  }

  return fallback;
}

export function hasAdminAccess(
  user: UserWithAccess,
  key: AdminAccessKey,
): boolean {
  return resolveAdminAccess(user)[key];
}

export function assertAdminAccess(
  user: UserWithAccess | null | undefined,
  key: AdminAccessKey,
): void {
  if (!user) {
    throw new ForbiddenException(
      "You don't have permission to perform this action",
    );
  }

  if (!hasAdminAccess(user, key)) {
    throw new ForbiddenException(
      "You don't have permission to perform this action",
    );
  }
}

/** Require customers and/or admins access based on the roles being managed. */
export function assertUsersManagementAccess(
  user: UserWithAccess | null | undefined,
  roles?: Array<UserRole | string> | null,
): void {
  if (!user) {
    throw new ForbiddenException(
      "You don't have permission to perform this action",
    );
  }

  const roleList = roles?.filter(Boolean) as UserRole[] | undefined;
  const touchesStaff =
    !roleList?.length || roleList.some((role) => isAdminStaffRole(role));
  const touchesCustomers =
    !roleList?.length || roleList.some((role) => role === UserRole.USER);

  if (touchesStaff) {
    assertAdminAccess(user, 'admins');
  }
  if (touchesCustomers) {
    assertAdminAccess(user, 'customers');
  }
}

export function stripProductPricingFields<T extends object>(dto: T): T {
  const next = { ...dto } as T & {
    price?: unknown;
    sale_price?: unknown;
    cost?: unknown;
    original_vendor_price?: unknown;
    original_vendor_sale_price?: unknown;
    original_price?: unknown;
    original_sale_price?: unknown;
  };

  delete next.price;
  delete next.sale_price;
  delete next.cost;
  delete next.original_vendor_price;
  delete next.original_vendor_sale_price;
  delete next.original_price;
  delete next.original_sale_price;

  return next;
}
