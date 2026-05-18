import { BadRequestException } from '@nestjs/common';
import { ProductPriceRule } from './entities/product-price-rule.entity';

export const MIN_PRODUCT_PRICE_RULE_PERCENTAGE = 1;
export const PRODUCT_PRICE_ROUNDING_STEP = 0.1;

type ProductPriceRuleShape = Pick<
  ProductPriceRule,
  'id' | 'min_vendor_price' | 'max_vendor_price' | 'percentage' | 'is_active'
>;

export function roundDownProductPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.floor((value + Number.EPSILON) * 10) / 10;
}

export function assertProductPriceRuleValues(params: {
  min_vendor_price: number;
  max_vendor_price?: number | null;
  percentage: number;
}) {
  if (!Number.isFinite(params.min_vendor_price) || params.min_vendor_price < 0) {
    throw new BadRequestException('min_vendor_price must be a valid number greater than or equal to 0.');
  }

  if (
    params.max_vendor_price !== null &&
    params.max_vendor_price !== undefined &&
    (!Number.isFinite(params.max_vendor_price) ||
      params.max_vendor_price < params.min_vendor_price)
  ) {
    throw new BadRequestException(
      'max_vendor_price must be greater than or equal to min_vendor_price.',
    );
  }

  if (
    !Number.isFinite(params.percentage) ||
    params.percentage < MIN_PRODUCT_PRICE_RULE_PERCENTAGE
  ) {
    throw new BadRequestException(
      `percentage must be at least ${MIN_PRODUCT_PRICE_RULE_PERCENTAGE}.`,
    );
  }
}

export function doProductPriceRulesOverlap(
  left: Pick<ProductPriceRuleShape, 'min_vendor_price' | 'max_vendor_price'>,
  right: Pick<ProductPriceRuleShape, 'min_vendor_price' | 'max_vendor_price'>,
) {
  const leftMax = left.max_vendor_price ?? Number.POSITIVE_INFINITY;
  const rightMax = right.max_vendor_price ?? Number.POSITIVE_INFINITY;

  return left.min_vendor_price <= rightMax && right.min_vendor_price <= leftMax;
}

export function findMatchingProductPriceRule(
  rules: ProductPriceRuleShape[],
  vendorPrice: number,
) {
  return rules.find((rule) => {
    if (rule.is_active === false) {
      return false;
    }

    const maxVendorPrice = rule.max_vendor_price ?? Number.POSITIVE_INFINITY;

    return vendorPrice >= rule.min_vendor_price && vendorPrice <= maxVendorPrice;
  }) ?? null;
}

export function calculateManagedPrice(
  sourcePrice: number,
  percentage: number,
) {
  assertProductPriceRuleValues({
    min_vendor_price: 0,
    max_vendor_price: null,
    percentage,
  });

  return roundDownProductPrice(sourcePrice * (1 - percentage / 100));
}

export function ensureSalePriceBelowPrice(
  price: number,
  salePrice: number | null,
) {
  if (salePrice === null) {
    return null;
  }

  if (salePrice < price) {
    return salePrice;
  }

  const forcedSalePrice = roundDownProductPrice(price - PRODUCT_PRICE_ROUNDING_STEP);

  if (forcedSalePrice > 0 && forcedSalePrice < price) {
    return forcedSalePrice;
  }

  return null;
}