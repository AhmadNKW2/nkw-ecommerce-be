import {
  buildConceptSynonymVariants,
  buildMultiConceptVariantCombinations,
  buildProgressiveWordCombinations,
  buildProgressiveWordSearchQueries,
  buildVariantLevelQueries,
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

  describe('buildVariantLevelQueries', () => {
    it('builds concept-anchored levels: full → concept+each spec → concept alone', () => {
      const levels = buildVariantLevelQueries([
        { text: 'laptop', orderedVariants: ['laptop', 'notebook'] },
        { text: '5060', orderedVariants: ['5060'] },
        { text: 'i7', orderedVariants: ['i7'] },
      ]);

      expect(levels).toHaveLength(4);
      expect(levels[0].segmentTexts).toEqual(['laptop', '5060', 'i7']);
      expect(levels[0].queries).toEqual(['laptop 5060 i7', 'notebook 5060 i7']);
      expect(levels[1].segmentTexts).toEqual(['laptop', '5060']);
      expect(levels[1].queries).toEqual(['laptop 5060', 'notebook 5060']);
      expect(levels[2].segmentTexts).toEqual(['laptop', 'i7']);
      expect(levels[2].queries).toEqual(['laptop i7', 'notebook i7']);
      expect(levels[3].segmentTexts).toEqual(['laptop']);
      expect(levels[3].queries).toEqual(['laptop', 'notebook']);
    });

    it('keeps each concept group independent for one-token multi-group matches (قبضة)', () => {
      const levels = buildVariantLevelQueries([
        { text: 'قبضة', orderedVariants: ['قبضة', 'يد تحكم', 'controller'] },
        { text: 'قبضة', orderedVariants: ['قبضة', 'مقبض', 'grip'] },
      ]);

      expect(levels[0].queries).toContain('قبضة قبضة');
      expect(levels[levels.length - 1].segmentTexts).toEqual(['قبضة']);
      expect(levels[levels.length - 1].queries).toEqual([
        'قبضة',
        'يد تحكم',
        'controller',
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
