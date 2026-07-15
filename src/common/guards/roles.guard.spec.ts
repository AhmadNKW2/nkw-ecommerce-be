import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { ADMIN_ACCESS_KEY } from '../decorators/admin-access.decorator';
import { ROLES_KEY, UserRole } from '../decorators/roles.decorator';
import { DEFAULT_ADMIN_ACCESS } from '../../users/admin-access.constants';

describe('RolesGuard admin access', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  } as unknown as Reflector;

  const guard = new RolesGuard(reflector);

  const makeContext = (user: unknown) =>
    ({
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks admin role when required permission is disabled', () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key) => {
      if (key === ROLES_KEY) return [UserRole.ADMIN];
      if (key === ADMIN_ACCESS_KEY) return { key: 'orders' };
      return undefined;
    });

    const user = {
      role: UserRole.ADMIN,
      adminAccess: {
        ...DEFAULT_ADMIN_ACCESS,
        orders: false,
      },
    };

    expect(() => guard.canActivate(makeContext(user))).toThrow(
      ForbiddenException,
    );
  });

  it('allows admin role when required permission is enabled', () => {
    (reflector.getAllAndOverride as jest.Mock).mockImplementation((key) => {
      if (key === ROLES_KEY) return [UserRole.ADMIN];
      if (key === ADMIN_ACCESS_KEY) return { key: 'orders' };
      return undefined;
    });

    const user = {
      role: UserRole.ADMIN,
      adminAccess: {
        ...DEFAULT_ADMIN_ACCESS,
        orders: true,
      },
    };

    expect(guard.canActivate(makeContext(user))).toBe(true);
  });
});
