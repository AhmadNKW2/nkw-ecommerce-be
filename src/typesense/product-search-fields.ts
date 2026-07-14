/**
 * Typesense text-search field configuration for products.
 *
 * Arabic matching uses *_norm fields (normalized at index time; queries are
 * normalized the same way). Plain Arabic fields (name_ar, …) keep the original
 * database text for display and are included at lower weight so legacy index
 * documents still match until a full reindex completes.
 */

// SKU is intentionally omitted from fuzzy text search — exact SKU/ID lookup
// is handled separately so only a full-query exact match can return a product.
export const PRODUCT_SEARCH_QUERY_BY =
  'name_en,name_ar_norm,name_ar,brand_name_en,brand_name_ar_norm,brand_name_ar,category_names_en,category_names_ar_norm,category_names_ar,short_description_en,short_description_ar_norm,short_description_ar,long_description_en,long_description_ar_norm,long_description_ar,slug';

export const PRODUCT_SEARCH_QUERY_BY_WEIGHTS =
  '5,5,2,4,4,2,3,3,2,3,3,2,1,1,1,2';

/** Expansion bucket queries (strict levels) — product title only. */
export const PRODUCT_NAME_SEARCH_QUERY_BY = 'name_en,name_ar_norm,name_ar';

export const PRODUCT_NAME_SEARCH_QUERY_BY_WEIGHTS = '5,5,2';

export type ProductSearchScope = 'name' | 'full';

export function resolveProductSearchFields(
  scope: ProductSearchScope = 'full',
): { query_by: string; query_by_weights: string } {
  if (scope === 'name') {
    return {
      query_by: PRODUCT_NAME_SEARCH_QUERY_BY,
      query_by_weights: PRODUCT_NAME_SEARCH_QUERY_BY_WEIGHTS,
    };
  }

  return {
    query_by: PRODUCT_SEARCH_QUERY_BY,
    query_by_weights: PRODUCT_SEARCH_QUERY_BY_WEIGHTS,
  };
}

/** Autocomplete reuses the same Typesense fields/weights as full search. */
export const AUTOCOMPLETE_SEARCH_QUERY_BY = PRODUCT_SEARCH_QUERY_BY;

export const AUTOCOMPLETE_SEARCH_QUERY_BY_WEIGHTS = PRODUCT_SEARCH_QUERY_BY_WEIGHTS;

/** Card hydration by id — display fields only (no *_norm). */
export const PRODUCT_CARD_QUERY_BY = 'name_en,name_ar,sku,slug';

export const PRODUCT_ID_LOOKUP_QUERY_BY = 'name_en,name_ar_norm,name_ar,slug';
