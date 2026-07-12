import { normalizeArabic, normalizeSearchQuery } from '../../typesense/utils/text-normalize';

const ARABIC_SCRIPT =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export type SearchLocale = 'ar' | 'en';

/** Bump when concept expansion query ordering changes (visible on GET /health). */
export const SEARCH_EXPANSION_VERSION = '2026-07-12-query-first-refinement';

export type ConceptSynonymSource = {
  terms_en?: string[] | null;
  terms_ar?: string[] | null;
  concept_label_en?: string | null;
  concept_label_ar?: string | null;
};

export function isArabicToken(token: string): boolean {
  return ARABIC_SCRIPT.test(token.trim());
}

export function normalizeConceptTermKey(term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return '';
  return normalizeSearchQuery(trimmed).toLowerCase();
}

/** Query words in left-to-right appearance order, minus excluded tokens (brand/category/concept). */
export function extractQueryWordsInAppearanceOrder(
  tokens: string[],
  excludedTokens: ReadonlySet<string> = new Set(),
): string[] {
  const unique = new Set<string>();
  const ordered: string[] = [];

  tokens.forEach((token) => {
    const trimmed = token.trim();
    if (!trimmed || excludedTokens.has(trimmed) || unique.has(trimmed)) {
      return;
    }
    unique.add(trimmed);
    ordered.push(trimmed);
  });

  return ordered;
}

/**
 * Arabic-first queries read words right-to-left; English-first queries read left-to-right.
 */
export function orderWordsByQueryDirection(
  wordsInAppearanceOrder: string[],
  queryTokens: string[],
): string[] {
  const words = wordsInAppearanceOrder.filter(Boolean);
  if (words.length <= 1) {
    return words;
  }

  const firstToken = queryTokens.find((token) => token.trim())?.trim() ?? '';
  const readRightToLeft = isArabicToken(firstToken);

  return readRightToLeft ? [...words].reverse() : words;
}

function combinationsOfIndices(n: number, size: number): number[][] {
  const result: number[][] = [];

  const backtrack = (start: number, current: number[]) => {
    if (current.length === size) {
      result.push([...current]);
      return;
    }

    for (let index = start; index <= n - (size - current.length); index += 1) {
      current.push(index);
      backtrack(index + 1, current);
      current.pop();
    }
  };

  backtrack(0, []);
  return result;
}

/**
 * Progressive fallback combinations from all words down to singles, preserving user order.
 */
export function buildProgressiveWordCombinations(
  orderedWords: string[],
): string[][] {
  const unique = Array.from(
    new Set(orderedWords.map((word) => word.trim()).filter(Boolean)),
  );
  if (unique.length === 0) {
    return [];
  }

  const combinations: string[][] = [];

  for (let size = unique.length; size >= 1; size -= 1) {
    combinationsOfIndices(unique.length, size).forEach((indices) => {
      combinations.push(indices.map((index) => unique[index]));
    });
  }

  return combinations;
}

export function buildProgressiveWordSearchQueries(
  baseIntentQuery: string,
  orderedWords: string[],
): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const base = baseIntentQuery.trim();

  buildProgressiveWordCombinations(orderedWords).forEach((combo) => {
    const query = [base, ...combo].filter(Boolean).join(' ').trim();
    if (!query || seen.has(query)) {
      return;
    }
    seen.add(query);
    queries.push(query);
  });

  return queries;
}

export function buildConceptSynonymVariants(
  userTerm: string,
  group: ConceptSynonymSource,
  locale: SearchLocale,
): string[] {
  const localeOrderedTerms =
    locale === 'ar'
      ? [
          ...(group.terms_ar ?? []),
          ...(group.terms_en ?? []),
          group.concept_label_ar,
          group.concept_label_en,
        ]
      : [
          ...(group.terms_en ?? []),
          ...(group.terms_ar ?? []),
          group.concept_label_en,
          group.concept_label_ar,
        ];

  const result: string[] = [];
  const seen = new Set<string>();

  const push = (term: string | null | undefined) => {
    const trimmed = term?.trim();
    if (!trimmed) return;
    const key = normalizeConceptTermKey(trimmed);
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  };

  push(userTerm);
  localeOrderedTerms.forEach((term) => push(term));

  return result;
}

/**
 * Ordered cartesian product across N concepts (user terms first, fewest substitutions next).
 */
export function buildMultiConceptVariantCombinations(
  concepts: Array<{ orderedVariants: string[] }>,
  maxCombos = 50,
): string[][] {
  if (concepts.length === 0) {
    return [];
  }

  const variantLists = concepts.map((concept) =>
    concept.orderedVariants.map((variant) => variant.trim()).filter(Boolean),
  );
  if (variantLists.some((variants) => variants.length === 0)) {
    return [];
  }

  const allIndexCombos: number[][] = [];

  const cartesian = (position: number, current: number[]) => {
    if (position === variantLists.length) {
      allIndexCombos.push([...current]);
      return;
    }

    for (let index = 0; index < variantLists[position].length; index += 1) {
      current.push(index);
      cartesian(position + 1, current);
      current.pop();
    }
  };

  cartesian(0, []);

  allIndexCombos.sort((left, right) => {
    const leftScore = left.reduce((sum, value) => sum + value, 0);
    const rightScore = right.reduce((sum, value) => sum + value, 0);
    if (leftScore !== rightScore) {
      return leftScore - rightScore;
    }

    const leftFirstSubstitution = left.findIndex((value) => value > 0);
    const rightFirstSubstitution = right.findIndex((value) => value > 0);
    if (leftFirstSubstitution !== rightFirstSubstitution) {
      if (leftFirstSubstitution === -1) return -1;
      if (rightFirstSubstitution === -1) return 1;
      return leftFirstSubstitution - rightFirstSubstitution;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) {
        return left[index] - right[index];
      }
    }

    return 0;
  });

  const result: string[][] = [];
  const seen = new Set<string>();

  allIndexCombos.forEach((indexCombo) => {
    if (result.length >= maxCombos) {
      return;
    }

    const combo = indexCombo.map((variantIndex, conceptIndex) =>
      variantLists[conceptIndex][variantIndex],
    );
    const key = combo.map((value) => normalizeConceptTermKey(value)).join('\0');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    result.push(combo);
  });

  return result;
}

export function collectConceptVariantQueries(
  concepts: Array<{ orderedVariants: string[] }>,
): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();

  concepts.forEach((concept) => {
    concept.orderedVariants.forEach((variant) => {
      const trimmed = variant.trim();
      if (!trimmed) {
        return;
      }
      const key = normalizeConceptTermKey(trimmed);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      queries.push(trimmed);
    });
  });

  return queries;
}

function pushUniqueConceptQuery(
  query: string,
  seen: Set<string>,
  output: string[],
): void {
  const trimmed = query.trim();
  if (!trimmed) {
    return;
  }
  const key = normalizeConceptTermKey(trimmed);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  output.push(trimmed);
}

export type ConceptExpansionQueryParams = {
  exactQuery?: string;
  matchedConcepts: Array<{ orderedVariants: string[] }>;
  fallbackWordsAppearanceOrder: string[];
  fallbackWordsProgressiveOrder: string[];
  maxConceptCombos?: number;
};

/**
 * Concept expansion query order:
 * 1) exact user query
 * 2) each concept synonym + remaining words in appearance order (unchanged)
 * 3) each concept synonym + progressive word subsets (RTL/LTR fallback order)
 */
export function buildConceptSynonymThenProgressiveQueries(
  params: ConceptExpansionQueryParams,
): string[] {
  const {
    exactQuery,
    matchedConcepts,
    fallbackWordsAppearanceOrder,
    fallbackWordsProgressiveOrder,
    maxConceptCombos = 50,
  } = params;

  const queries: string[] = [];
  const seen = new Set<string>();

  if (exactQuery?.trim()) {
    pushUniqueConceptQuery(exactQuery.trim(), seen, queries);
  }

  const conceptCombos = buildMultiConceptVariantCombinations(
    matchedConcepts,
    maxConceptCombos,
  );
  if (conceptCombos.length === 0) {
    return queries;
  }

  const appearanceTail = fallbackWordsAppearanceOrder
    .map((word) => word.trim())
    .filter(Boolean)
    .join(' ');

  conceptCombos.forEach((conceptCombo) => {
    const prefix = conceptCombo.join(' ').trim();
    const query = [prefix, appearanceTail].filter(Boolean).join(' ').trim();
    pushUniqueConceptQuery(query, seen, queries);
  });

  const progressiveCombos =
    fallbackWordsProgressiveOrder.length > 0
      ? buildProgressiveWordCombinations(fallbackWordsProgressiveOrder)
      : [];

  conceptCombos.forEach((conceptCombo) => {
    const prefix = conceptCombo.join(' ').trim();
    progressiveCombos.forEach((fallbackCombo) => {
      const fallbackTail = fallbackCombo.join(' ').trim();
      const query = [prefix, fallbackTail].filter(Boolean).join(' ').trim();
      pushUniqueConceptQuery(query, seen, queries);
    });
  });

  return queries;
}

export type ConceptExpansionLayer = {
  queries: string[];
  /** Max new hits per synonym query (prevents one loose match from dominating). */
  perQueryLimit: number;
};

/**
 * When concept-tier results mix product types, prefer items whose categories
 * align with the detected concept — without dropping the rest.
 */
export function applyConceptCategoryRefinement(
  conceptTierIds: number[],
  productCategoryIdsByProductId: ReadonlyMap<number, number[]>,
  refinementCategoryIds: number[],
): {
  ids: number[];
  applied: boolean;
  preferredCount: number;
  otherCount: number;
} {
  if (conceptTierIds.length === 0 || refinementCategoryIds.length === 0) {
    return {
      ids: conceptTierIds,
      applied: false,
      preferredCount: 0,
      otherCount: conceptTierIds.length,
    };
  }

  const categorySet = new Set(refinementCategoryIds);
  const preferred: number[] = [];
  const other: number[] = [];

  conceptTierIds.forEach((productId) => {
    const categoryIds = productCategoryIdsByProductId.get(productId) ?? [];
    if (categoryIds.some((categoryId) => categorySet.has(categoryId))) {
      preferred.push(productId);
    } else {
      other.push(productId);
    }
  });

  const applied = preferred.length > 0 && other.length > 0;
  return {
    ids: applied ? [...preferred, ...other] : conceptTierIds,
    applied,
    preferredCount: preferred.length,
    otherCount: other.length,
  };
}

/**
 * Layered concept expansion:
 * 1) all terms from concepts matching the full query phrase
 * 2) combined multi-concept synonym cartesian (e.g. RAM + laptop together)
 * 3) each query token's matching concepts in order (e.g. كرت, then ذاكرة)
 */
export function buildLayeredConceptExpansionLayers(params: {
  exactQuery?: string;
  fullPhraseConcepts: Array<{ orderedVariants: string[] }>;
  combinedConcepts: Array<{ orderedVariants: string[] }>;
  tokenConceptLayers: Array<Array<{ orderedVariants: string[] }>>;
  fallbackWordsAppearanceOrder: string[];
  fallbackWordsProgressiveOrder: string[];
  maxConceptCombos?: number;
}): ConceptExpansionLayer[] {
  const {
    exactQuery,
    fullPhraseConcepts,
    combinedConcepts,
    tokenConceptLayers,
    fallbackWordsAppearanceOrder,
    fallbackWordsProgressiveOrder,
    maxConceptCombos = 50,
  } = params;

  const layers: ConceptExpansionLayer[] = [];
  let exactQueryPending = exactQuery?.trim() ?? '';

  const takeExactQuery = (): string | undefined => {
    if (!exactQueryPending) {
      return undefined;
    }
    const value = exactQueryPending;
    exactQueryPending = '';
    return value;
  };

  const fullPhraseQueries = buildConceptSynonymThenProgressiveQueries({
    exactQuery: takeExactQuery(),
    matchedConcepts: fullPhraseConcepts,
    fallbackWordsAppearanceOrder,
    fallbackWordsProgressiveOrder,
    maxConceptCombos,
  });
  if (fullPhraseQueries.length > 0) {
    layers.push({
      queries: fullPhraseQueries,
      perQueryLimit: 25,
    });
  }

  if (combinedConcepts.length >= 2) {
    const combinedQueries = buildConceptSynonymThenProgressiveQueries({
      exactQuery: takeExactQuery(),
      matchedConcepts: combinedConcepts,
      fallbackWordsAppearanceOrder,
      fallbackWordsProgressiveOrder,
      maxConceptCombos,
    });
    if (combinedQueries.length > 0) {
      layers.push({
        queries: combinedQueries,
        perQueryLimit: 25,
      });
    }
  }

  tokenConceptLayers.forEach((layerConcepts) => {
    const tokenQueries = buildConceptSynonymThenProgressiveQueries({
      exactQuery: takeExactQuery(),
      matchedConcepts: layerConcepts,
      fallbackWordsAppearanceOrder,
      fallbackWordsProgressiveOrder,
      maxConceptCombos,
    });
    if (tokenQueries.length > 0) {
      layers.push({
        queries: tokenQueries,
        perQueryLimit: 40,
      });
    }
  });

  return layers;
}

export function buildLayeredConceptExpansionQueries(params: {
  exactQuery?: string;
  fullPhraseConcepts: Array<{ orderedVariants: string[] }>;
  combinedConcepts: Array<{ orderedVariants: string[] }>;
  tokenConceptLayers: Array<Array<{ orderedVariants: string[] }>>;
  fallbackWordsAppearanceOrder: string[];
  fallbackWordsProgressiveOrder: string[];
  maxConceptCombos?: number;
}): string[] {
  return buildLayeredConceptExpansionLayers(params).flatMap((layer) => layer.queries);
}

export function buildProgressiveConceptSearchQueries(
  matchedConcepts: Array<{ orderedVariants: string[] }>,
  fallbackWordsAppearanceOrder: string[],
  fallbackWordsProgressiveOrder: string[],
  maxConceptCombos = 50,
  exactQuery?: string,
): string[] {
  return buildConceptSynonymThenProgressiveQueries({
    exactQuery,
    matchedConcepts,
    fallbackWordsAppearanceOrder,
    fallbackWordsProgressiveOrder,
    maxConceptCombos,
  });
}

export function normalizeSearchLocale(
  locale?: string | null,
  queryTokens: string[] = [],
): SearchLocale {
  if (locale?.toLowerCase().startsWith('ar')) {
    return 'ar';
  }
  if (locale?.toLowerCase().startsWith('en')) {
    return 'en';
  }

  const firstToken = queryTokens.find((token) => token.trim())?.trim() ?? '';
  return isArabicToken(firstToken) ? 'ar' : 'en';
}
