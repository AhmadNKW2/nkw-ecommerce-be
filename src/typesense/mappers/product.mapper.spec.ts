import { mapProductToTypesenseDoc } from './product.mapper';
import { Product } from '../../products/entities/product.entity';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    name_en: 'BlackView Tab A6',
    name_ar: 'أحمد الجهاز',
    sku: 'SKU-123',
    slug: 'blackview-tab-a6',
    short_description_en: '<p>Nice <b>tablet</b></p>',
    short_description_ar: '<p>جهاز <b>لوحي</b> مُمتاز</p>',
    long_description_en: '<div>Full <script>alert(1)</script>details</div>',
    long_description_ar: '<div>تفاصيل كاملة عن الجهاز اللوحي</div>',
    status: 'active',
    visible: true,
    brand_id: 5,
    vendor_id: 7,
    category_id: 9,
    price: 100,
    sale_price: 80,
    is_out_of_stock: false,
    average_rating: 4.5,
    created_at: new Date('2024-01-01T00:00:00Z'),
    productCategories: [],
    specifications: [],
    ...overrides,
  } as unknown as Product;
}

describe('mapProductToTypesenseDoc', () => {
  it('strips HTML from English and Arabic descriptions', () => {
    const doc = mapProductToTypesenseDoc(makeProduct());
    expect(doc.short_description_en).toBe('Nice tablet');
    expect(doc.long_description_en).not.toContain('<script>');
    expect(doc.long_description_en).not.toContain('<');
    expect(doc.short_description_ar).not.toContain('<');
    expect(doc.long_description_ar).not.toContain('<');
  });

  it('normalizes Arabic name and descriptions', () => {
    const doc = mapProductToTypesenseDoc(makeProduct());
    // أحمد -> احمد (hamza-on-alef normalized to bare alef)
    // الجهاز -> جهاز (leading definite article stripped)
    expect(doc.name_ar).toBe('احمد جهاز');
    // مُمتاز -> ممتاز (diacritics stripped)
    expect(doc.short_description_ar).toBe('جهاز لوحي ممتاز');
  });

  it('still populates the pre-existing fields unchanged (no regression)', () => {
    const doc = mapProductToTypesenseDoc(makeProduct());
    expect(doc.id).toBe('1');
    expect(doc.sku).toBe('SKU-123');
    expect(doc.brand_id).toBe(5);
    expect(doc.vendor_id).toBe(7);
    expect(doc.category_ids).toEqual([9]);
    expect(doc.effective_price).toBe(80);
    expect(doc.attributes_values_ids).toEqual([]);
    expect(doc.specifications_values_ids).toEqual([]);
  });

  it('handles missing Arabic description fields gracefully', () => {
    const doc = mapProductToTypesenseDoc(
      makeProduct({ short_description_ar: undefined as any, long_description_ar: undefined as any }),
    );
    expect(doc.short_description_ar).toBe('');
    expect(doc.long_description_ar).toBe('');
  });
});
