import {
  calculateManagedPrice,
  findBestMatchingProductPriceRule,
  normalizeProductPriceRuleShape,
  roundManagedProductPrice,
} from './product-pricing.util';

describe('product-pricing.util', () => {
  const baseRule = (overrides: Record<string, unknown> = {}) =>
    normalizeProductPriceRuleShape({
      id: 1,
      min_vendor_price: 0,
      max_vendor_price: null,
      percentage: 10,
      is_active: true,
      vendor_id: null,
      brand_id: null,
      category_ids: null,
      price_condition: 'between',
      adjustment_type: 'increase',
      ...overrides,
    });

  it('applies increase percentage to managed price', () => {
    expect(calculateManagedPrice(50, 10, 'increase')).toBe(55);
    expect(calculateManagedPrice(60, 10, 'increase')).toBe(66);
  });

  it('applies decrease percentage to managed price', () => {
    expect(calculateManagedPrice(100, 10, 'decrease')).toBe(90);
  });

  it('prefers vendor-specific rule over generic rule', () => {
    const genericRule = baseRule({ id: 1, percentage: 5 });
    const vendorRule = baseRule({
      id: 2,
      vendor_id: 7,
      percentage: 10,
    });

    const matched = findBestMatchingProductPriceRule(
      [genericRule, vendorRule],
      {
        vendorId: 7,
        brandId: null,
        categoryIds: [],
        originalPrice: 50,
      },
    );

    expect(matched?.id).toBe(2);
    expect(calculateManagedPrice(50, matched!.percentage, matched!.adjustment_type)).toBe(55);
  });

  it('prefers vendor + brand + category rule over vendor-only rule', () => {
    const vendorRule = baseRule({
      id: 2,
      vendor_id: 7,
      percentage: 5,
    });
    const specificRule = baseRule({
      id: 3,
      vendor_id: 7,
      brand_id: 12,
      category_ids: [4],
      percentage: 15,
    });

    const matched = findBestMatchingProductPriceRule(
      [vendorRule, specificRule],
      {
        vendorId: 7,
        brandId: 12,
        categoryIds: [4, 9],
        originalPrice: 50,
      },
    );

    expect(matched?.id).toBe(3);
    expect(calculateManagedPrice(50, matched!.percentage, matched!.adjustment_type)).toBe(57.5);
  });

  it('rounds managed prices to .00 or .50 endings', () => {
    expect(roundManagedProductPrice(100.52)).toBe(100.5);
    expect(roundManagedProductPrice(100.99)).toBe(101);
    expect(roundManagedProductPrice(100.42)).toBe(100.5);
    expect(roundManagedProductPrice(100.21)).toBe(100);
  });

  it('supports more_than price condition', () => {
    const rule = baseRule({
      id: 4,
      price_condition: 'more_than',
      min_vendor_price: 40,
      percentage: 20,
    });

    const matched = findBestMatchingProductPriceRule([rule], {
      vendorId: null,
      brandId: null,
      categoryIds: [],
      originalPrice: 50,
    });

    expect(matched?.id).toBe(4);
  });
});
