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
      min_product_price: null,
      max_product_price: null,
      percentage: 10,
      is_active: true,
      vendor_ids: null,
      brand_ids: null,
      category_ids: null,
      price_condition: null,
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
      vendor_ids: [7],
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
      vendor_ids: [7],
      percentage: 5,
    });
    const specificRule = baseRule({
      id: 3,
      vendor_ids: [7],
      brand_ids: [12],
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
    expect(calculateManagedPrice(50, matched!.percentage, matched!.adjustment_type)).toBe(58);
  });

  it('supports more_than price condition', () => {
    const rule = baseRule({
      id: 4,
      price_condition: 'more_than',
      min_product_price: 40,
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

  it('matches all products when price condition is null', () => {
    const rule = baseRule({
      id: 5,
      price_condition: null,
      min_product_price: null,
      max_product_price: null,
      percentage: 8,
    });

    const matched = findBestMatchingProductPriceRule([rule], {
      vendorId: 99,
      brandId: 88,
      categoryIds: [1],
      originalPrice: 500,
    });

    expect(matched?.id).toBe(5);
  });

  it('treats legacy any condition as any product price', () => {
    const rule = baseRule({
      id: 6,
      price_condition: 'any',
      percentage: 8,
    });

    const matched = findBestMatchingProductPriceRule([rule], {
      vendorId: null,
      brandId: null,
      categoryIds: [],
      originalPrice: 12,
    });

    expect(matched?.id).toBe(6);
    expect(matched?.price_condition).toBeNull();
  });

  it('adds 1 and settles on .00 when any fractional point exists', () => {
    expect(roundManagedProductPrice(0.000001)).toBe(1);
    expect(roundManagedProductPrice(0.01)).toBe(1);
    expect(roundManagedProductPrice(0.5)).toBe(1);
    expect(roundManagedProductPrice(0.999)).toBe(1);
    expect(roundManagedProductPrice(1)).toBe(1);
    expect(roundManagedProductPrice(100)).toBe(100);
    expect(roundManagedProductPrice(100.000001)).toBe(101);
    expect(roundManagedProductPrice(100.21)).toBe(101);
    expect(roundManagedProductPrice(100.42)).toBe(101);
    expect(roundManagedProductPrice(100.5)).toBe(101);
    expect(roundManagedProductPrice(100.52)).toBe(101);
    expect(roundManagedProductPrice(100.99)).toBe(101);
    expect(calculateManagedPrice(0.001, 10, 'increase')).toBe(1);
    expect(calculateManagedPrice(100.21, 10, 'increase')).toBe(111);
  });
});
