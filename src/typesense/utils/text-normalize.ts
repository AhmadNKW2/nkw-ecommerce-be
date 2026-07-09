import sanitizeHtml from 'sanitize-html';

export function stripHtml(html: string | null | undefined): string {
  if (!html) return '';
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeSearchQuery(input: string | null | undefined): string {
  if (!input) return '';
  return normalizeArabic(input.trim().replace(/\s+/g, ' '));
}

/** Original Arabic text for Typesense display fields (name_ar, …). */
export function arabicDisplayValue(text: string | null | undefined): string {
  return (text ?? '').trim();
}

/** Normalized Arabic for Typesense search fields (*_norm). */
export function arabicSearchValue(text: string | null | undefined): string {
  return normalizeArabic(arabicDisplayValue(text));
}

// Minimum total word length (including the leading "ال" itself) required
// before we strip the definite article. This avoids mangling short words like
// "العاب" (5 chars) while still stripping "ال" from "الجهاز" (6 chars).
// "الله" (4 chars) is also left untouched.
const MIN_WORD_LENGTH_FOR_ARTICLE_STRIP = 6;

function stripLeadingDefiniteArticle(word: string): string {
  if (word.length >= MIN_WORD_LENGTH_FOR_ARTICLE_STRIP && word.startsWith('ال')) {
    return word.slice(2);
  }
  return word;
}

/**
 * Normalizes Arabic text for search matching only.
 * API responses must always use the original database values.
 *
 * Character equivalences (both sides normalized the same way):
 * - أ / إ / آ / ٱ / ا  →  ا
 * - ة  →  ه
 * - ؤ / ء  →  و,  ئ  →  ي,  ى  →  ي
 */
export function normalizeArabic(text: string | null | undefined): string {
  if (!text) return '';
  const charNormalized = text
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/[ؤء]/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .replace(/\u0640/g, '');

  return charNormalized
    .split(' ')
    .map(stripLeadingDefiniteArticle)
    .join(' ');
}

export function isArabicQuery(q: string): boolean {
  return /[\u0600-\u06FF]/.test(q);
}
