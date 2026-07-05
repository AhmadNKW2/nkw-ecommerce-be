import { stripHtml, normalizeArabic, normalizeSearchQuery, isArabicQuery } from './text-normalize';

describe('text-normalize', () => {
  describe('stripHtml', () => {
    it('removes tags and collapses whitespace', () => {
      expect(stripHtml('<p>Hello   <b>world</b></p>')).toBe('Hello world');
    });

    it('returns empty string for null/undefined/empty input', () => {
      expect(stripHtml(null)).toBe('');
      expect(stripHtml(undefined)).toBe('');
      expect(stripHtml('')).toBe('');
    });

    it('does not leave HTML entities/tags as matchable tokens', () => {
      expect(stripHtml('<script>alert(1)</script>Safe text')).not.toContain('<script>');
    });
  });

  describe('normalizeArabic', () => {
    it('normalizes alef variants to bare alef', () => {
      expect(normalizeArabic('أحمد')).toBe(normalizeArabic('احمد'));
      expect(normalizeArabic('إحمد')).toBe(normalizeArabic('احمد'));
      expect(normalizeArabic('آحمد')).toBe(normalizeArabic('احمد'));
    });

    it('normalizes alef maksura to ya', () => {
      expect(normalizeArabic('مصطفى')).toBe('مصطفي');
    });

    it('normalizes ta marbuta to ha', () => {
      expect(normalizeArabic('مدرسة')).toBe('مدرسه');
    });

    it('strips diacritics (tashkeel)', () => {
      expect(normalizeArabic('مُعَالِج')).toBe('معالج');
    });

    it('strips tatweel', () => {
      expect(normalizeArabic('مـعالج')).toBe('معالج');
    });

    it('produces identical results for known alef-variant pairs (QA table cases)', () => {
      expect(normalizeArabic('احمد')).toBe(normalizeArabic('أحمد'));
    });

    it('strips the leading definite article so معالج = المعالج (QA table case)', () => {
      expect(normalizeArabic('المعالج')).toBe(normalizeArabic('معالج'));
      expect(normalizeArabic('المعالج')).toBe('معالج');
    });

    it('strips the definite article per word in a multi-word phrase', () => {
      // Ta-marbuta normalization (ة -> ه) applies before article stripping,
      // so both words end in ه rather than ة in the final output.
      expect(normalizeArabic('اللغة العربية')).toBe('لغه عربيه');
    });

    it('does not strip short words that merely start with the same two letters as the article', () => {
      // "الله" (Allah) must not become "له" — stripping would change the word's meaning.
      expect(normalizeArabic('الله')).toBe('الله');
    });

    it('does not strip "ال" when it is not at the very start of the word', () => {
      // "بالون" (balloon) contains "ال" starting at the second letter, not
      // as a word-initial definite article — must be left untouched.
      expect(normalizeArabic('بالون')).toBe('بالون');
    });

    it('returns empty string for null/undefined', () => {
      expect(normalizeArabic(null)).toBe('');
      expect(normalizeArabic(undefined)).toBe('');
    });

    it('leaves English text unaffected', () => {
      expect(normalizeArabic('BlackView Tab A6')).toBe('BlackView Tab A6');
    });
  });

  describe('normalizeSearchQuery', () => {
    it('trims and collapses internal whitespace', () => {
      expect(normalizeSearchQuery('   tab   a6   ')).toBe('tab a6');
    });

    it('applies Arabic normalization', () => {
      expect(normalizeSearchQuery('أحمد')).toBe('احمد');
    });

    it('returns empty string for falsy input', () => {
      expect(normalizeSearchQuery('')).toBe('');
      expect(normalizeSearchQuery(null)).toBe('');
      expect(normalizeSearchQuery(undefined)).toBe('');
    });

    it('passes through wildcard query unchanged', () => {
      expect(normalizeSearchQuery('*')).toBe('*');
    });
  });

  describe('isArabicQuery', () => {
    it('detects Arabic text', () => {
      expect(isArabicQuery('معالج')).toBe(true);
    });

    it('returns false for English text', () => {
      expect(isArabicQuery('processor')).toBe(false);
    });
  });
});
