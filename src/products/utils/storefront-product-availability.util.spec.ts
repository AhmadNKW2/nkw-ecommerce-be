import {
  isStorefrontAvailableProduct,
  isStorefrontVisibleProductStatus,
  STOREFRONT_VISIBLE_PRODUCT_STATUSES,
} from './storefront-product-availability.util';
import { ProductStatus } from '../entities/product.entity';

describe('storefront product availability', () => {
  it('treats active, review, and updated products as storefront-visible statuses', () => {
    expect(STOREFRONT_VISIBLE_PRODUCT_STATUSES).toEqual([
      ProductStatus.ACTIVE,
      ProductStatus.REVIEW,
      ProductStatus.UPDATED,
    ]);
    expect(isStorefrontVisibleProductStatus(ProductStatus.ACTIVE)).toBe(true);
    expect(isStorefrontVisibleProductStatus(ProductStatus.REVIEW)).toBe(true);
    expect(isStorefrontVisibleProductStatus(ProductStatus.UPDATED)).toBe(true);
  });

  it('rejects archived or missing statuses', () => {
    expect(isStorefrontVisibleProductStatus(ProductStatus.ARCHIVED)).toBe(false);
    expect(isStorefrontVisibleProductStatus(undefined)).toBe(false);
    expect(isStorefrontVisibleProductStatus(null)).toBe(false);
  });

  it('requires both a storefront-visible status and visible=true', () => {
    expect(
      isStorefrontAvailableProduct({
        status: ProductStatus.REVIEW,
        visible: true,
      }),
    ).toBe(true);

    expect(
      isStorefrontAvailableProduct({
        status: ProductStatus.UPDATED,
        visible: false,
      }),
    ).toBe(false);

    expect(
      isStorefrontAvailableProduct({
        status: ProductStatus.ARCHIVED,
        visible: true,
      }),
    ).toBe(false);
  });
});