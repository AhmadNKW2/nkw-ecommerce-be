import { SetMetadata } from '@nestjs/common';
import type { AdminAccessKey } from '../../users/admin-access.constants';

export const ADMIN_ACCESS_KEY = 'admin_access';

export type AdminAccessRequirement = {
  key: AdminAccessKey;
};

export const RequireAdminAccess = (key: AdminAccessKey) =>
  SetMetadata(ADMIN_ACCESS_KEY, {
    key,
  } satisfies AdminAccessRequirement);
