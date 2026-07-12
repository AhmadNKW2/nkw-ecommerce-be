import {
  buildConceptSynonymVariants,
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

  describe('buildProgressiveConceptSearchQueries', () => {
    it('builds single-concept queries with fallback words', () => {
      expect(
        buildProgressiveConceptSearchQueries(
          [{ orderedVariants: ['لابتوب', 'حاسب محمول'] }],
          ['5070', 'i7'],
        ),
      ).toEqual([
        'لابتوب 5070 i7',
        'حاسب محمول 5070 i7',
        'لابتوب 5070',
        'حاسب محمول 5070',
        'لابتوب i7',
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
        ),
      ).toEqual([
        'ذاكرة مؤقتة حاسب محمول',
        'ram حاسب محمول',
        'ذاكرة مؤقتة لابتوب',
        'ram لابتوب',
      ]);
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
