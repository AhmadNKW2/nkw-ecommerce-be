import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '../entities/user.entity';
import {
  assertAdminAccess,
  assertUsersManagementAccess,
  hasAdminAccess,
  isAdminStaffRole,
  resolveAdminAccess,
} from './admin-access.util';
import {
  CATALOG_PRESET_ACCESS,
  DEFAULT_ADMIN_ACCESS,
} from '../admin-access.constants';

describe('admin-access.util', () => {
  it('resolves explicit adminAccess over role defaults', () => {
    const access = resolveAdminAccess({
      role: UserRole.ADMIN,
      adminAccess: {
        ...DEFAULT_ADMIN_ACCESS,
        orders: false,
        products: true,
      },
    });

    expect(access.orders).toBe(false);
    expect(access.products).toBe(true);
  });

  it('denies disabled permissions for admin users', () => {
    const user = {
      role: UserRole.ADMIN,
      adminAccess: {
        ...DEFAULT_ADMIN_ACCESS,
        orders: false,
      },
    };

    expect(hasAdminAccess(user, 'orders')).toBe(false);
    expect(() => assertAdminAccess(user, 'orders')).toThrow(ForbiddenException);
    expect(() => assertAdminAccess(user, 'products')).not.toThrow();
  });

  it('keeps catalog preset restrictions for admin with catalog access', () => {
    const user = {
      role: UserRole.ADMIN,
      adminAccess: { ...CATALOG_PRESET_ACCESS },
    };

    expect(hasAdminAccess(user, 'concepts')).toBe(true);
    expect(hasAdminAccess(user, 'settings')).toBe(false);
    expect(hasAdminAccess(user, 'admins')).toBe(false);
    expect(() => assertAdminAccess(user, 'concepts')).not.toThrow();
    expect(() => assertAdminAccess(user, 'settings')).toThrow(ForbiddenException);
  });

  it('requires admins vs customers access based on managed roles', () => {
    const customersOnly = {
      role: UserRole.ADMIN,
      adminAccess: {
        ...DEFAULT_ADMIN_ACCESS,
        customers: true,
        admins: false,
      },
    };

    expect(() =>
      assertUsersManagementAccess(customersOnly, [UserRole.USER]),
    ).not.toThrow();
    expect(() =>
      assertUsersManagementAccess(customersOnly, [UserRole.ADMIN]),
    ).toThrow(ForbiddenException);
    expect(isAdminStaffRole(UserRole.ADMIN)).toBe(true);
    expect(isAdminStaffRole(UserRole.USER)).toBe(false);
  });
});
