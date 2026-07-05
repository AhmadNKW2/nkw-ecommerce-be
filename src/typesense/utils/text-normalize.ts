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

// Minimum total word length (including the leading "ال" itself) required
// before we strip the definite article. This avoids mangling short words that
// merely start with these two letters as part of their root rather than as
// the definite article — e.g. "الله" (Allah, 4 chars total) is deliberately
// left untouched, while "المعالج" (7 chars total) is correctly reduced to
// "معالج".
const MIN_WORD_LENGTH_FOR_ARTICLE_STRIP = 5;

function stripLeadingDefiniteArticle(word: string): string {
  if (word.length >= MIN_WORD_LENGTH_FOR_ARTICLE_STRIP && word.startsWith('ال')) {
    return word.slice(2);
  }
  return word;
}

export function normalizeArabic(text: string | null | undefined): string {
  if (!text) return '';
  const charNormalized = text
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .replace(/\u0640/g, '');

  // Strip the definite article per word (not as a whole-string regex) so a
  // mid-phrase occurrence that isn't at a word boundary is never touched,
  // and the original whitespace layout is preserved.
  return charNormalized
    .split(' ')
    .map(stripLeadingDefiniteArticle)
    .join(' ');
}

export function isArabicQuery(q: string): boolean {
  return /[\u0600-\u06FF]/.test(q);
}
