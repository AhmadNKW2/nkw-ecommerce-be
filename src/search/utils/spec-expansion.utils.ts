import { normalizeArabic, normalizeSearchQuery } from '../../typesense/utils/text-normalize';

const ARABIC_SCRIPT =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

export type SearchLocale = 'ar' | 'en';

/** Bump when concept expansion query ordering changes (visible on GET /health). */
export const SEARCH_EXPANSION_VERSION = '2026-07-13-per-level-brand-buckets';

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

export type QueryVariantSegmentInput = {
  text: string;
  orderedVariants: string[];
};

export type VariantQueryLevel = {
  segmentTexts: string[];
  queries: string[];
};

export function buildVariantLevelQueries(
  segments: QueryVariantSegmentInput[],
  maxConceptCombos = 50,
): VariantQueryLevel[] {
  const cleanedSegments = segments
    .map((segment) => ({
      text: segment.text.trim(),
      orderedVariants: segment.orderedVariants
        .map((variant) => variant.trim())
        .filter(Boolean),
    }))
    .filter((segment) => segment.text && segment.orderedVariants.length > 0);

  if (cleanedSegments.length === 0) {
    return [];
  }

  const levels: VariantQueryLevel[] = [];
  const seenQueries = new Set<string>();

  for (let size = cleanedSegments.length; size >= 1; size -= 1) {
    const levelQueries: string[] = [];
    const levelSegmentTexts: string[] = [];

    combinationsOfIndices(cleanedSegments.length, size).forEach((indexCombo) => {
      const selectedSegments = indexCombo.map((index) => cleanedSegments[index]);
      const combos = buildMultiConceptVariantCombinations(
        selectedSegments.map((segment) => ({
          orderedVariants: segment.orderedVariants,
        })),
        maxConceptCombos,
      );

      selectedSegments.forEach((segment) => levelSegmentTexts.push(segment.text));
      combos.forEach((combo) => {
        const query = combo.join(' ').trim();
        const key = normalizeConceptTermKey(query);
        if (!key || seenQueries.has(key)) {
          return;
        }
        seenQueries.add(key);
        levelQueries.push(query);
      });
    });

    if (levelQueries.length > 0) {
      levels.push({
        segmentTexts: Array.from(new Set(levelSegmentTexts)),
        queries: levelQueries,
      });
    }
  }

  return levels;
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
