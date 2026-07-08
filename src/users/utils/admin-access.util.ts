import { UserRole } from '../entities/user.entity';
import {
  ADMIN_ACCESS_KEYS,
  AdminAccess,
  AdminAccessKey,
  DEFAULT_ADMIN_ACCESS,
  DEFAULT_CATALOG_MANAGER_ACCESS,
} from '../admin-access.constants';

type UserWithAccess = {
  role: UserRole;
  adminAccess?: AdminAccess | null;
};

export function normalizeAdminAccess(
  value: unknown,
): AdminAccess | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const normalized = {} as AdminAccess;

  for (const key of ADMIN_ACCESS_KEYS) {
    normalized[key] = record[key] === true;
  }

  return normalized;
}

export function resolveAdminAccess(user: UserWithAccess): AdminAccess {
  const explicit = normalizeAdminAccess(user.adminAccess);
  if (explicit) {
    return explicit;
  }

  if (user.role === UserRole.CATALOG_MANAGER) {
    return { ...DEFAULT_CATALOG_MANAGER_ACCESS };
  }

  if (
    user.role === UserRole.ADMIN ||
    user.role === UserRole.CONSTANT_TOKEN_ADMIN
  ) {
    return { ...DEFAULT_ADMIN_ACCESS };
  }

  return ADMIN_ACCESS_KEYS.reduce((acc, key) => {
    acc[key] = false;
    return acc;
  }, {} as AdminAccess);
}

export function hasAdminAccess(
  user: UserWithAccess,
  key: AdminAccessKey,
): boolean {
  return resolveAdminAccess(user)[key];
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
