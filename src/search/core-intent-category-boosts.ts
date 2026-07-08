// Maps whole-query English hardware abbreviations to stable category slugs.
// Slugs are resolved to numeric IDs at query time (cached in SearchService) so
// the mapping survives DB reseeds where category IDs differ per environment.
//
// Only applied when the user's entire query is exactly one of these terms
// (e.g. "cpu", "cpus") — multi-word queries like "cpu cooler" are untouched.
//
// When adding a new abbreviation gap, also add the matching synonym group in
// src/typesense/config/synonyms.ts so Typesense can find the products at all.
export const CORE_INTENT_CATEGORY_BOOSTS: Record<string, string[]> = {
  cpu: ['desktop-cpu', 'server-cpu'],
  gpu: ['graphic-cards'],
  psu: ['power-supplies'],
  hdd: ['hdd'],
};

/** Returns the boost config key when `rawQuery` is a single known intent term. */
export function getCoreIntentBoostKey(rawQuery?: string): string | undefined {
  if (!rawQuery) return undefined;

  const trimmed = rawQuery.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return undefined;

  const singular =
    trimmed.endsWith('s') && trimmed.length > 3 ? trimmed.slice(0, -1) : trimmed;

  return singular in CORE_INTENT_CATEGORY_BOOSTS ? singular : undefined;
}
