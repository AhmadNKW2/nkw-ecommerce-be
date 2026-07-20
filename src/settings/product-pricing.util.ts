import { BadRequestException } from '@nestjs/common';
import { ProductPriceRule } from './entities/product-price-rule.entity';

export const MIN_PRODUCT_PRICE_RULE_PERCENTAGE = 1;
export const PRODUCT_PRICE_ROUNDING_STEP = 0.5;

export type ProductPriceCondition = 'any' | 'more_than' | 'less_than' | 'between' | null;
export type ProductPriceAdjustmentType = 'increase' | 'decrease';

export type ProductPriceRuleShape = Pick<
  ProductPriceRule,
  | 'id'
  | 'min_product_price'
  | 'max_product_price'
  | 'percentage'
  | 'is_active'
  | 'vendor_ids'
  | 'brand_ids'
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
  vendor_ids: number[] | null;
  brand_ids: number[] | null;
  category_ids: number[] | null;
  min_product_price: number | null;
  max_product_price: number | null;
  specificity_score: number;
};

export function roundManagedProductPrice(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  return Math.max(0, Number((Math.round(value * 2) / 2).toFixed(2)));
}

export function normalizeIdList(
  ids: number[] | null | undefined,
): number[] | null {
  if (!ids || ids.length === 0) {
    return null;
  }

  const normalized = Array.from(
    new Set(
      ids
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0),
    ),
  );

  return normalized.length > 0 ? normalized : null;
}

export function normalizeCategoryIds(
  categoryIds: number[] | null | undefined,
): number[] | null {
  return normalizeIdList(categoryIds);
}

export function normalizeVendorIds(
  vendorIds: number[] | null | undefined,
): number[] | null {
  return normalizeIdList(vendorIds);
}

export function normalizeBrandIds(
  brandIds: number[] | null | undefined,
): number[] | null {
  return normalizeIdList(brandIds);
}

function normalizeOptionalProductPrice(
  value: number | null | undefined,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizePriceCondition(
  value: ProductPriceCondition | undefined,
): ProductPriceCondition {
  if (value === undefined || value === null || value === 'any') {
    return null;
  }

  return value;
}

export function assertProductPriceRuleValues(params: {
  min_product_price?: number | null;
  max_product_price?: number | null;
  percentage: number;
  price_condition?: ProductPriceCondition;
  adjustment_type?: ProductPriceAdjustmentType;
}) {
  const priceCondition = normalizePriceCondition(params.price_condition);
  const minProductPrice = normalizeOptionalProductPrice(params.min_product_price);
  const maxProductPrice = normalizeOptionalProductPrice(params.max_product_price);

  if (minProductPrice !== null && minProductPrice < 0) {
    throw new BadRequestException(
      'min_product_price must be a valid number greater than or equal to 0.',
    );
  }

  if (maxProductPrice !== null && maxProductPrice < 0) {
    throw new BadRequestException(
      'max_product_price must be a valid number greater than or equal to 0.',
    );
  }

  if (
    minProductPrice !== null &&
    maxProductPrice !== null &&
    maxProductPrice < minProductPrice
  ) {
    throw new BadRequestException(
      'max_product_price must be greater than or equal to min_product_price.',
    );
  }

  if (priceCondition === 'more_than' && minProductPrice === null) {
    throw new BadRequestException(
      'more_than rules require a minimum product price threshold.',
    );
  }

  if (priceCondition === 'less_than' && maxProductPrice === null) {
    throw new BadRequestException(
      'less_than rules require a maximum product price threshold.',
    );
  }

  if (
    priceCondition === 'between' &&
    (minProductPrice === null || maxProductPrice === null)
  ) {
    throw new BadRequestException(
      'between rules require both minimum and maximum product price thresholds.',
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
    percentage: number;
  },
): ProductPriceRuleShape {
  const priceCondition = normalizePriceCondition(rule.price_condition);

  return {
    id: rule.id ?? 0,
    min_product_price:
      priceCondition === 'more_than' || priceCondition === 'between'
        ? normalizeOptionalProductPrice(rule.min_product_price)
        : null,
    max_product_price:
      priceCondition === 'less_than' || priceCondition === 'between'
        ? normalizeOptionalProductPrice(rule.max_product_price)
        : null,
    percentage: Number(rule.percentage),
    is_active: rule.is_active ?? true,
    vendor_ids: normalizeVendorIds(rule.vendor_ids),
    brand_ids: normalizeBrandIds(rule.brand_ids),
    category_ids: normalizeCategoryIds(rule.category_ids),
    price_condition: priceCondition,
    adjustment_type: rule.adjustment_type ?? 'decrease',
  };
}

function doIdListsOverlap(
  left: number[] | null,
  right: number[] | null,
): boolean {
  const leftIds = left ?? [];
  const rightIds = right ?? [];

  if (leftIds.length === 0 || rightIds.length === 0) {
    return true;
  }

  return leftIds.some((id) => rightIds.includes(id));
}

function doesProductPriceMatch(
  rule: ProductPriceRuleShape,
  originalPrice: number,
): boolean {
  const priceCondition = normalizePriceCondition(rule.price_condition);
  const minProductPrice = rule.min_product_price;
  const maxProductPrice = rule.max_product_price;

  if (priceCondition === null) {
    return true;
  }

  switch (priceCondition) {
    case 'more_than':
      return minProductPrice !== null && originalPrice > minProductPrice;
    case 'less_than':
      return maxProductPrice !== null && originalPrice < maxProductPrice;
    case 'between':
    default: {
      // Legacy rows stored "any product price" as between with empty bounds.
      if (minProductPrice === null && maxProductPrice === null) {
        return true;
      }

      if (minProductPrice === null || maxProductPrice === null) {
        return false;
      }

      return originalPrice >= minProductPrice && originalPrice <= maxProductPrice;
    }
  }
}

export function doesProductPriceRuleMatch(
  rule: ProductPriceRuleShape,
  context: ProductPricingContext,
): boolean {
  if (rule.is_active === false) {
    return false;
  }

  const ruleVendorIds = normalizeVendorIds(rule.vendor_ids);
  if (
    ruleVendorIds &&
    ruleVendorIds.length > 0 &&
    (context.vendorId === null || !ruleVendorIds.includes(context.vendorId))
  ) {
    return false;
  }

  const ruleBrandIds = normalizeBrandIds(rule.brand_ids);
  if (
    ruleBrandIds &&
    ruleBrandIds.length > 0 &&
    (context.brandId === null || !ruleBrandIds.includes(context.brandId))
  ) {
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

  return doesProductPriceMatch(rule, context.originalPrice);
}

export function getProductPriceRuleSpecificityScore(
  rule: ProductPriceRuleShape,
): number {
  let score = 0;

  const vendorIds = normalizeVendorIds(rule.vendor_ids);
  if (vendorIds && vendorIds.length > 0) {
    score += 1_000_000 * vendorIds.length;
  }

  const brandIds = normalizeBrandIds(rule.brand_ids);
  if (brandIds && brandIds.length > 0) {
    score += 100_000 * brandIds.length;
  }

  const categoryIds = normalizeCategoryIds(rule.category_ids);
  if (categoryIds && categoryIds.length > 0) {
    score += 10_000 * categoryIds.length;
  }

  const priceCondition = normalizePriceCondition(rule.price_condition);

  switch (priceCondition) {
    case 'between': {
      const min = rule.min_product_price ?? Number.NEGATIVE_INFINITY;
      const max = rule.max_product_price ?? Number.POSITIVE_INFINITY;
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
    case null:
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
    price_condition: normalizePriceCondition(rule.price_condition),
    vendor_ids: normalizeVendorIds(rule.vendor_ids),
    brand_ids: normalizeBrandIds(rule.brand_ids),
    category_ids: normalizeCategoryIds(rule.category_ids),
    min_product_price: rule.min_product_price ?? null,
    max_product_price: rule.max_product_price ?? null,
    specificity_score: getProductPriceRuleSpecificityScore(rule),
  };
}

export function calculateManagedPrice(
  sourcePrice: number,
  percentage: number,
  adjustmentType: ProductPriceAdjustmentType = 'decrease',
) {
  assertProductPriceRuleValues({
    min_product_price: null,
    max_product_price: null,
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
  left: Pick<ProductPriceRuleShape, 'min_product_price' | 'max_product_price'>,
  right: Pick<ProductPriceRuleShape, 'min_product_price' | 'max_product_price'>,
) {
  const leftMin = left.min_product_price ?? Number.NEGATIVE_INFINITY;
  const leftMax = left.max_product_price ?? Number.POSITIVE_INFINITY;
  const rightMin = right.min_product_price ?? Number.NEGATIVE_INFINITY;
  const rightMax = right.max_product_price ?? Number.POSITIVE_INFINITY;

  return leftMin <= rightMax && rightMin <= leftMax;
}

export function doScopedProductPriceRulesConflict(
  left: ProductPriceRuleShape,
  right: ProductPriceRuleShape,
) {
  if (!doIdListsOverlap(normalizeVendorIds(left.vendor_ids), normalizeVendorIds(right.vendor_ids))) {
    return false;
  }

  if (!doIdListsOverlap(normalizeBrandIds(left.brand_ids), normalizeBrandIds(right.brand_ids))) {
    return false;
  }

  if (
    !doIdListsOverlap(
      normalizeCategoryIds(left.category_ids),
      normalizeCategoryIds(right.category_ids),
    )
  ) {
    return false;
  }

  if (
    normalizePriceCondition(left.price_condition) !==
    normalizePriceCondition(right.price_condition)
  ) {
    return false;
  }

  return doProductPriceRulesOverlap(left, right);
}
