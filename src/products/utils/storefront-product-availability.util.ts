import { ProductStatus } from '../entities/product.entity';

type StorefrontAvailabilityCandidate = {
  status?: ProductStatus | string | null;
  visible?: boolean | null;
};

export const STOREFRONT_VISIBLE_PRODUCT_STATUSES = [
  ProductStatus.ACTIVE,
  ProductStatus.REVIEW,
  ProductStatus.UPDATED,
] as const;

export function isStorefrontVisibleProductStatus(
  status?: ProductStatus | string | null,
): status is (typeof STOREFRONT_VISIBLE_PRODUCT_STATUSES)[number] {
  return STOREFRONT_VISIBLE_PRODUCT_STATUSES.includes(
    status as (typeof STOREFRONT_VISIBLE_PRODUCT_STATUSES)[number],
  );
}

export function isStorefrontAvailableProduct(
  product: StorefrontAvailabilityCandidate,
): boolean {
  return product.visible === true && isStorefrontVisibleProductStatus(product.status);
}