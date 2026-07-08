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

export function normalizeArabic(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[\u064B-\u0652\u0670]/g, '')
    .replace(/\u0640/g, '');
}

export function isArabicQuery(q: string): boolean {
  return /[\u0600-\u06FF]/.test(q);
}
