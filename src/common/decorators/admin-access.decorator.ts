import { SetMetadata } from '@nestjs/common';
import type { AdminAccessKey } from '../../users/admin-access.constants';

export const ADMIN_ACCESS_KEY = 'admin_access';

export type AdminAccessRequirement = {
  key: AdminAccessKey;
  /** Allow catalog_manager through even when the access key is false. */
  catalogManagerBypass?: boolean;
};

export const RequireAdminAccess = (
  key: AdminAccessKey,
  options?: { catalogManagerBypass?: boolean },
) =>
  SetMetadata(ADMIN_ACCESS_KEY, {
    key,
    catalogManagerBypass: options?.catalogManagerBypass === true,
  } satisfies AdminAccessRequirement);
