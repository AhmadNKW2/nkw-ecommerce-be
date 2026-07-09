import {
  AUTOCOMPLETE_SEARCH_QUERY_BY,
  AUTOCOMPLETE_SEARCH_QUERY_BY_WEIGHTS,
  PRODUCT_SEARCH_QUERY_BY,
  PRODUCT_SEARCH_QUERY_BY_WEIGHTS,
} from './product-search-fields';

describe('product-search-fields', () => {
  it('keeps query_by and query_by_weights aligned for main search', () => {
    const fields = PRODUCT_SEARCH_QUERY_BY.split(',');
    const weights = PRODUCT_SEARCH_QUERY_BY_WEIGHTS.split(',');
    expect(fields.length).toBe(weights.length);
    expect(fields).toContain('name_ar');
    expect(fields).toContain('name_ar_norm');
    expect(fields.indexOf('name_ar_norm')).toBeLessThan(fields.indexOf('name_ar'));
  });

  it('keeps query_by and query_by_weights aligned for autocomplete', () => {
    const fields = AUTOCOMPLETE_SEARCH_QUERY_BY.split(',');
    const weights = AUTOCOMPLETE_SEARCH_QUERY_BY_WEIGHTS.split(',');
    expect(fields.length).toBe(weights.length);
  });

  it('gives *_norm Arabic fields higher weight than display Arabic fields', () => {
    const fields = PRODUCT_SEARCH_QUERY_BY.split(',');
    const weights = PRODUCT_SEARCH_QUERY_BY_WEIGHTS.split(',').map(Number);
    const weightOf = (field: string) => weights[fields.indexOf(field)];

    expect(weightOf('name_ar_norm')).toBeGreaterThan(weightOf('name_ar'));
    expect(weightOf('brand_name_ar_norm')).toBeGreaterThan(weightOf('brand_name_ar'));
    expect(weightOf('short_description_ar_norm')).toBeGreaterThan(
      weightOf('short_description_ar'),
    );
  });
});
