// Multi-way synonym groups for common English hardware abbreviation vs.
// full-word gaps, where a shopper's natural search term (e.g. "CPU") shares
// no literal token with how the matching products are actually named in our
// catalog (e.g. "... Processor ..."). Each group's words are treated as
// fully interchangeable by Typesense at query time — no reindex needed when
// this list changes, since synonyms are applied to the search query, not to
// indexed document text.
//
// To add a new gap once discovered (e.g. via a live search that returns the
// wrong products for a common abbreviation), just add another entry here.
// If the mismatch also affects ranking (the correct products appear but are
// buried below unrelated matches), also add a corresponding entry to
// CORE_INTENT_CATEGORY_BOOSTS in src/search/core-intent-category-boosts.ts.
export const PRODUCT_SYNONYM_GROUPS: Record<string, string[]> = {
  'cpu-processor': ['cpu', 'processor'],
  'gpu-graphics-card': ['gpu', 'graphics card', 'video card'],
  'psu-power-supply': ['psu', 'power supply'],
  'hdd-hard-drive': ['hdd', 'hard drive', 'hard disk'],
};

// Name of the synonym set used when the Typesense server is v30+ (new
// synonym_sets API). Must also be linked to the collection via its
// `synonym_sets` field for the synonyms to actually apply.
export const PRODUCT_SYNONYM_SET_NAME = 'products-english-abbreviations';

// Dynamic concept terms synced from `term_groups` (admin Terms / Concepts).
export const PRODUCT_CONCEPT_SYNONYM_SET_NAME = 'products-concept-terms';

export const PRODUCT_CONCEPT_SYNONYM_ID_PREFIX = 'concept-';
