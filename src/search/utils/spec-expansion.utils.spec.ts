import {
  applyConceptCategoryRefinement,
  buildConceptSynonymThenProgressiveQueries,
  buildConceptSynonymVariants,
  buildLayeredConceptExpansionQueries,
  buildMultiConceptVariantCombinations,
  buildProgressiveConceptSearchQueries,
  buildProgressiveWordCombinations,
  buildProgressiveWordSearchQueries,
  extractQueryWordsInAppearanceOrder,
  isArabicToken,
  normalizeSearchLocale,
  orderWordsByQueryDirection,
} from './spec-expansion.utils';

describe('spec-expansion.utils', () => {
  describe('isArabicToken', () => {
    it('detects Arabic script', () => {
      expect(isArabicToken('لابتوب')).toBe(true);
      expect(isArabicToken('5070')).toBe(false);
      expect(isArabicToken('i7')).toBe(false);
    });
  });

  describe('normalizeSearchLocale', () => {
    it('prefers explicit locale when provided', () => {
      expect(normalizeSearchLocale('ar', ['laptop'])).toBe('ar');
      expect(normalizeSearchLocale('en', ['لابتوب'])).toBe('en');
    });

    it('falls back to first query token script', () => {
      expect(normalizeSearchLocale(undefined, ['لابتوب', '5070'])).toBe('ar');
      expect(normalizeSearchLocale(undefined, ['laptop', '5070'])).toBe('en');
    });
  });

  describe('extractQueryWordsInAppearanceOrder', () => {
    it('keeps normal query words and excludes brand/category tokens', () => {
      expect(
        extractQueryWordsInAppearanceOrder(
          ['لابتوب', 'اسس', 'i7', '5070'],
          new Set(['اسس', 'لابتوب']),
        ),
      ).toEqual(['i7', '5070']);
    });
  });

  describe('orderWordsByQueryDirection', () => {
    it('reverses words for Arabic-first queries (RTL)', () => {
      expect(
        orderWordsByQueryDirection(['i7', '5070'], ['لابتوب', 'اسس', 'i7', '5070']),
      ).toEqual(['5070', 'i7']);
    });
  });

  describe('buildConceptSynonymVariants', () => {
    const group = {
      terms_en: ['laptop', 'notebook'],
      terms_ar: ['حاسب محمول', 'لابتوب', 'كمبيوتر محمول'],
      concept_label_en: 'laptop',
      concept_label_ar: 'حاسب محمول',
    };

    it('puts the user term first', () => {
      expect(buildConceptSynonymVariants('لابتوب', group, 'ar')[0]).toBe('لابتوب');
    });

    it('orders Arabic terms before English terms for Arabic search', () => {
      const variants = buildConceptSynonymVariants('لابتوب', group, 'ar');
      const laptopIndex = variants.indexOf('laptop');
      const arabicIndex = variants.indexOf('كمبيوتر محمول');
      expect(laptopIndex).toBeGreaterThan(arabicIndex);
    });

    it('orders English terms before Arabic terms for English search', () => {
      const variants = buildConceptSynonymVariants('laptop', group, 'en');
      const notebookIndex = variants.indexOf('notebook');
      const arabicIndex = variants.indexOf('حاسب محمول');
      expect(notebookIndex).toBeGreaterThan(-1);
      expect(arabicIndex).toBeGreaterThan(notebookIndex);
    });
  });

  describe('buildMultiConceptVariantCombinations', () => {
    it('prioritizes user terms then single substitutions', () => {
      expect(
        buildMultiConceptVariantCombinations([
          { orderedVariants: ['ذاكرة مؤقتة', 'ram'] },
          { orderedVariants: ['حاسب محمول', 'لابتوب'] },
        ]),
      ).toEqual([
        ['ذاكرة مؤقتة', 'حاسب محمول'],
        ['ram', 'حاسب محمول'],
        ['ذاكرة مؤقتة', 'لابتوب'],
        ['ram', 'لابتوب'],
      ]);
    });
  });

  describe('buildLayeredConceptExpansionQueries', () => {
    it('expands full phrase concepts then each token layer', () => {
      expect(
        buildLayeredConceptExpansionQueries({
          fullPhraseConcepts: [
            {
              orderedVariants: ['كرت ذاكرة', 'ram card', 'كرت رام'],
            },
          ],
          combinedConcepts: [],
          tokenConceptLayers: [
            [{ orderedVariants: ['كرت', 'gpu card', 'graphics card'] }],
            [{ orderedVariants: ['ذاكرة', 'ram', 'ذاكرة مؤقتة'] }],
          ],
          fallbackWordsAppearanceOrder: [],
          fallbackWordsProgressiveOrder: [],
        }),
      ).toEqual([
        'كرت ذاكرة',
        'ram card',
        'كرت رام',
        'كرت',
        'gpu card',
        'graphics card',
        'ذاكرة',
        'ram',
        'ذاكرة مؤقتة',
      ]);
    });

    it('uses combined multi-concept layer when two phrase concepts are present', () => {
      expect(
        buildLayeredConceptExpansionQueries({
          fullPhraseConcepts: [],
          combinedConcepts: [
            { orderedVariants: ['ذاكرة مؤقتة', 'ram'] },
            { orderedVariants: ['حاسب محمول', 'لابتوب'] },
          ],
          tokenConceptLayers: [],
          fallbackWordsAppearanceOrder: [],
          fallbackWordsProgressiveOrder: [],
        }),
      ).toEqual([
        'ذاكرة مؤقتة حاسب محمول',
        'ram حاسب محمول',
        'ذاكرة مؤقتة لابتوب',
        'ram لابتوب',
      ]);
    });
  });

  describe('buildConceptSynonymThenProgressiveQueries', () => {
    it('runs exact query, synonym with unchanged tail, then progressive fallback', () => {
      expect(
        buildConceptSynonymThenProgressiveQueries({
          exactQuery: 'دفتريه اسس 5070 i7',
          matchedConcepts: [{ orderedVariants: ['دفتريه', 'لابتوب', 'حاسب محمول'] }],
          fallbackWordsAppearanceOrder: ['اسس', '5070', 'i7'],
          fallbackWordsProgressiveOrder: ['i7', '5070', 'اسس'],
        }),
      ).toEqual([
        'دفتريه اسس 5070 i7',
        'لابتوب اسس 5070 i7',
        'حاسب محمول اسس 5070 i7',
        'دفتريه i7 5070 اسس',
        'دفتريه i7 5070',
        'دفتريه i7 اسس',
        'دفتريه 5070 اسس',
        'دفتريه i7',
        'دفتريه 5070',
        'دفتريه اسس',
        'لابتوب i7 5070 اسس',
        'لابتوب i7 5070',
        'لابتوب i7 اسس',
        'لابتوب 5070 اسس',
        'لابتوب i7',
        'لابتوب 5070',
        'لابتوب اسس',
        'حاسب محمول i7 5070 اسس',
        'حاسب محمول i7 5070',
        'حاسب محمول i7 اسس',
        'حاسب محمول 5070 اسس',
        'حاسب محمول i7',
        'حاسب محمول 5070',
        'حاسب محمول اسس',
      ]);
    });
  });

  describe('buildProgressiveConceptSearchQueries', () => {
    it('builds single-concept queries with fallback words', () => {
      expect(
        buildProgressiveConceptSearchQueries(
          [{ orderedVariants: ['لابتوب', 'حاسب محمول'] }],
          ['5070', 'i7'],
          ['5070', 'i7'],
          50,
          'لابتوب 5070 i7',
        ),
      ).toEqual([
        'لابتوب 5070 i7',
        'حاسب محمول 5070 i7',
        'لابتوب 5070',
        'لابتوب i7',
        'حاسب محمول 5070',
        'حاسب محمول i7',
      ]);
    });

    it('builds multi-concept queries without fallback words', () => {
      expect(
        buildProgressiveConceptSearchQueries(
          [
            { orderedVariants: ['ذاكرة مؤقتة', 'ram'] },
            { orderedVariants: ['حاسب محمول', 'لابتوب'] },
          ],
          [],
          [],
        ),
      ).toEqual([
        'ذاكرة مؤقتة حاسب محمول',
        'ram حاسب محمول',
        'ذاكرة مؤقتة لابتوب',
        'ram لابتوب',
      ]);
    });
  });

  describe('applyConceptCategoryRefinement', () => {
    it('reorders mixed concept-tier hits to prefer matching categories', () => {
      const categoryIdsByProductId = new Map<number, number[]>([
        [1, [63]],
        [2, [78]],
        [3, [87]],
        [4, [88]],
      ]);

      expect(
        applyConceptCategoryRefinement([2, 1, 4, 3], categoryIdsByProductId, [63, 87]),
      ).toEqual({
        ids: [1, 3, 2, 4],
        applied: true,
        preferredCount: 2,
        otherCount: 2,
      });
    });

    it('keeps original order when all hits already match the concept categories', () => {
      const categoryIdsByProductId = new Map<number, number[]>([
        [1, [63]],
        [2, [87]],
      ]);

      expect(
        applyConceptCategoryRefinement([1, 2], categoryIdsByProductId, [63, 87]),
      ).toEqual({
        ids: [1, 2],
        applied: false,
        preferredCount: 2,
        otherCount: 0,
      });
    });
  });

  describe('buildProgressiveWordCombinations', () => {
    it('supports four or more words', () => {
      expect(buildProgressiveWordCombinations(['5070', 'i7', '64gb', '1tb']).length).toBe(15);
    });
  });

  describe('buildProgressiveWordSearchQueries', () => {
    it('prefixes each combination with the category intent query', () => {
      expect(
        buildProgressiveWordSearchQueries('لابتوب', ['5070', 'i7', '64gb']),
      ).toEqual([
        'لابتوب 5070 i7 64gb',
        'لابتوب 5070 i7',
        'لابتوب 5070 64gb',
        'لابتوب i7 64gb',
        'لابتوب 5070',
        'لابتوب i7',
        'لابتوب 64gb',
      ]);
    });
  });
});
