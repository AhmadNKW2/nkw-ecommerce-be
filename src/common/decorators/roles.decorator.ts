import { SetMetadata } from '@nestjs/common';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  CATALOG_MANAGER = 'catalog_manager',
  CONSTANT_TOKEN_ADMIN = 'constant_token_admin',
  VENDOR_ADMIN = 'vendor_admin',
  STORE_ADMIN = 'store_admin',
}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
