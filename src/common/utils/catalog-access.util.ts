import { UserRole } from '../decorators/roles.decorator';

export function isCatalogAdminUser(user?: { role?: string } | null): boolean {
  return (
    user?.role === UserRole.ADMIN ||
    user?.role === UserRole.CATALOG_MANAGER ||
    user?.role === UserRole.CONSTANT_TOKEN_ADMIN ||
    user?.role === 'products_api'
  );
}

export function shouldReturnAdminEntityDetail(
  user: { role?: string } | null | undefined,
  filterDto?: { is_admin?: boolean },
): boolean {
  return isCatalogAdminUser(user) && filterDto?.is_admin === true;
}
