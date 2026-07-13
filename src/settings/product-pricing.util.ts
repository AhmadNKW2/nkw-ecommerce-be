import { BadRequestException } from '@nestjs/common';
import { ProductPriceRule } from './entities/product-price-rule.entity';

export const MIN_PRODUCT_PRICE_RULE_PERCENTAGE = 1;
export const PRODUCT_PRICE_ROUNDING_STEP = 0.5;

export type ProductPriceCondition = 'any' | 'more_than' | 'less_than' | 'between';
export type ProductPriceAdjustmentType = 'increase' | 'decrease';

export type ProductPriceRuleShape = Pick<
  ProductPriceRule,
  | 'id'
  | 'min_vendor_price'
  | 'max_vendor_price'
  | 'percentage'
  | 'is_active'
  | 'vendor_id'
  | 'brand_id'
  | 'category_ids'
  | 'price_condition'
  | 'adjustment_type'
>;

export type ProductPricingContext = {
  vendorId: number | null;
  brandId: number | null;
  categoryIds: number[];
  originalPrice: number;
};

export type AppliedProductPriceRule = {
  id: number;
  percentage: number;
  adjustment_type: ProductPriceAdjustmentType;
  price_condition: ProductPriceCondition;
  vendor_id: number | null;
  brand_id: number | null;
  category_ids: number[] | null;
  min_vendor_price: number;
  max_vendor_price: number | null;
  specificity_score: number;
};

export function roundManagedProductPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Number((Math.round(value * 2) / 2).toFixed(2)));
}

export function assertProductPriceRuleValues(params: {
  min_vendor_price: number;
  max_vendor_price?: number | null;
  percentage: number;
  price_condition?: ProductPriceCondition;
  adjustment_type?: ProductPriceAdjustmentType;
}) {
  const priceCondition = params.price_condition ?? 'between';

  if (!Number.isFinite(params.min_vendor_price) || params.min_vendor_price < 0) {
    throw new BadRequestException(
      'min_vendor_price must be a valid number greater than or equal to 0.',
    );
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

  if (priceCondition === 'more_than' && params.min_vendor_price < 0) {
    throw new BadRequestException(
      'more_than rules require a valid minimum original price threshold.',
    );
  }

  if (
    priceCondition === 'less_than' &&
    (params.max_vendor_price === null || params.max_vendor_price === undefined)
  ) {
    throw new BadRequestException(
      'less_than rules require a maximum original price threshold.',
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

export function normalizeProductPriceRuleShape(
  rule: Partial<ProductPriceRuleShape> & {
    min_vendor_price: number;
    percentage: number;
  },
): ProductPriceRuleShape {
  return {
    id: rule.id ?? 0,
    min_vendor_price: Number(rule.min_vendor_price),
    max_vendor_price:
      rule.max_vendor_price === undefined || rule.max_vendor_price === null
        ? null
        : Number(rule.max_vendor_price),
    percentage: Number(rule.percentage),
    is_active: rule.is_active ?? true,
    vendor_id:
      rule.vendor_id === undefined || rule.vendor_id === null
        ? null
        : Number(rule.vendor_id),
    brand_id:
      rule.brand_id === undefined || rule.brand_id === null
        ? null
        : Number(rule.brand_id),
    category_ids: normalizeCategoryIds(rule.category_ids),
    price_condition: rule.price_condition ?? 'between',
    adjustment_type: rule.adjustment_type ?? 'decrease',
  };
}

export function normalizeCategoryIds(
  categoryIds: number[] | null | undefined,
): number[] | null {
  if (!categoryIds || categoryIds.length === 0) {
    return null;
  }

  const normalized = Array.from(
    new Set(
      categoryIds
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );

  return normalized.length > 0 ? normalized : null;
}

export function doesProductPriceRuleMatch(
  rule: ProductPriceRuleShape,
  context: ProductPricingContext,
): boolean {
  if (rule.is_active === false) {
    return false;
  }

  if (rule.vendor_id !== null && rule.vendor_id !== context.vendorId) {
    return false;
  }

  if (rule.brand_id !== null && rule.brand_id !== context.brandId) {
    return false;
  }

  const ruleCategoryIds = normalizeCategoryIds(rule.category_ids);
  if (ruleCategoryIds && ruleCategoryIds.length > 0) {
    const hasMatchingCategory = ruleCategoryIds.some((categoryId) =>
      context.categoryIds.includes(categoryId),
    );

    if (!hasMatchingCategory) {
      return false;
    }
  }

  const originalPrice = context.originalPrice;
  const priceCondition = rule.price_condition ?? 'between';

  switch (priceCondition) {
    case 'any':
      return true;
    case 'more_than':
      return originalPrice > rule.min_vendor_price;
    case 'less_than':
      return (
        rule.max_vendor_price !== null &&
        originalPrice < rule.max_vendor_price
      );
    case 'between':
    default: {
      const maxVendorPrice = rule.max_vendor_price ?? Number.POSITIVE_INFINITY;
      return (
        originalPrice >= rule.min_vendor_price &&
        originalPrice <= maxVendorPrice
      );
    }
  }
}

export function getProductPriceRuleSpecificityScore(
  rule: ProductPriceRuleShape,
): number {
  let score = 0;

  if (rule.vendor_id !== null) {
    score += 1_000_000;
  }

  if (rule.brand_id !== null) {
    score += 100_000;
  }

  const categoryIds = normalizeCategoryIds(rule.category_ids);
  if (categoryIds && categoryIds.length > 0) {
    score += 10_000 * categoryIds.length;
  }

  const priceCondition = rule.price_condition ?? 'between';

  switch (priceCondition) {
    case 'between': {
      const min = rule.min_vendor_price ?? 0;
      const max = rule.max_vendor_price ?? Number.POSITIVE_INFINITY;
      const rangeWidth = max - min;

      if (Number.isFinite(rangeWidth) && rangeWidth > 0) {
        score += Math.round(10_000 / (rangeWidth + 1));
      }

      score += 1_000;
      break;
    }
    case 'more_than':
    case 'less_than':
      score += 500;
      break;
    case 'any':
    default:
      break;
  }

  return score;
}

export function findBestMatchingProductPriceRule(
  rules: ProductPriceRuleShape[],
  context: ProductPricingContext,
): ProductPriceRuleShape | null {
  const rankedRules = rules
    .filter((rule) => doesProductPriceRuleMatch(rule, context))
    .map((rule) => ({
      rule,
      score: getProductPriceRuleSpecificityScore(rule),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.rule.id - right.rule.id;
    });

  return rankedRules[0]?.rule ?? null;
}

export function findMatchingProductPriceRule(
  rules: ProductPriceRuleShape[],
  vendorPrice: number,
) {
  return findBestMatchingProductPriceRule(rules, {
    vendorId: null,
    brandId: null,
    categoryIds: [],
    originalPrice: vendorPrice,
  });
}

export function toAppliedProductPriceRule(
  rule: ProductPriceRuleShape,
): AppliedProductPriceRule {
  return {
    id: rule.id,
    percentage: rule.percentage,
    adjustment_type: rule.adjustment_type ?? 'decrease',
    price_condition: rule.price_condition ?? 'between',
    vendor_id: rule.vendor_id ?? null,
    brand_id: rule.brand_id ?? null,
    category_ids: normalizeCategoryIds(rule.category_ids),
    min_vendor_price: rule.min_vendor_price,
    max_vendor_price: rule.max_vendor_price ?? null,
    specificity_score: getProductPriceRuleSpecificityScore(rule),
  };
}

export function calculateManagedPrice(
  sourcePrice: number,
  percentage: number,
  adjustmentType: ProductPriceAdjustmentType = 'decrease',
) {
  assertProductPriceRuleValues({
    min_vendor_price: 0,
    max_vendor_price: null,
    percentage,
    adjustment_type: adjustmentType,
  });

  const multiplier =
    adjustmentType === 'increase'
      ? 1 + percentage / 100
      : 1 - percentage / 100;

  return roundManagedProductPrice(sourcePrice * multiplier);
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

  const forcedSalePrice = roundManagedProductPrice(
    price - PRODUCT_PRICE_ROUNDING_STEP,
  );

  if (forcedSalePrice > 0 && forcedSalePrice < price) {
    return forcedSalePrice;
  }

  return null;
}

export function doProductPriceRulesOverlap(
  left: Pick<ProductPriceRuleShape, 'min_vendor_price' | 'max_vendor_price'>,
  right: Pick<ProductPriceRuleShape, 'min_vendor_price' | 'max_vendor_price'>,
) {
  const leftMax = left.max_vendor_price ?? Number.POSITIVE_INFINITY;
  const rightMax = right.max_vendor_price ?? Number.POSITIVE_INFINITY;

  return left.min_vendor_price <= rightMax && right.min_vendor_price <= leftMax;
}

export function doScopedProductPriceRulesConflict(
  left: ProductPriceRuleShape,
  right: ProductPriceRuleShape,
) {
  if (left.vendor_id !== right.vendor_id) {
    return false;
  }

  if (left.brand_id !== right.brand_id) {
    return false;
  }

  const leftCategoryIds = normalizeCategoryIds(left.category_ids) ?? [];
  const rightCategoryIds = normalizeCategoryIds(right.category_ids) ?? [];

  if (leftCategoryIds.length > 0 || rightCategoryIds.length > 0) {
    const sharesCategory =
      leftCategoryIds.length === 0 ||
      rightCategoryIds.length === 0 ||
      leftCategoryIds.some((categoryId) => rightCategoryIds.includes(categoryId));

    if (!sharesCategory) {
      return false;
    }
  }

  if ((left.price_condition ?? 'between') !== (right.price_condition ?? 'between')) {
    return false;
  }

  return doProductPriceRulesOverlap(left, right);
}
