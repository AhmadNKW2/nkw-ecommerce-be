import { normalizeSearchQuery } from '../../typesense/utils/text-normalize';
import { isArabicToken } from './spec-expansion.utils';

/** Bump when title word-index ranking changes (invalidates search caches). */
export const TITLE_RELEVANCE_VERSION = '2026-07-15-exact-title-word-index';

const EXACT_TITLE_SCORE = Number.MAX_SAFE_INTEGER;

export function tokenizeTitleWords(text: string | null | undefined): string[] {
  const normalized = normalizeSearchQuery(text ?? '')
    .toLowerCase()
    .trim();
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

export function normalizeTitleEquality(text: string | null | undefined): string {
  return tokenizeTitleWords(text).join(' ');
}

export function isExactTitleMatch(
  query: string,
  nameEn?: string | null,
  nameAr?: string | null,
): boolean {
  const q = normalizeTitleEquality(query);
  if (!q) return false;
  const en = normalizeTitleEquality(nameEn);
  const ar = normalizeTitleEquality(nameAr);
  return (en.length > 0 && en === q) || (ar.length > 0 && ar === q);
}

/**
 * Title tokens in reading order for word-index scoring.
 * Arabic-first titles are read right-to-left (storage order starts at the RTL head).
 * English-first titles are read left-to-right.
 */
export function titleTokensInReadingOrder(title: string): string[] {
  const tokens = tokenizeTitleWords(title);
  if (tokens.length === 0) return tokens;

  // Storage order already matches reading start for both scripts:
  // Arabic RTL starts at the first stored token; English LTR at the first token.
  if (isArabicToken(tokens[0])) {
    return tokens;
  }
  return tokens;
}

/**
 * Prefer the title whose first word script matches the query's first word.
 */
export function selectTitleForWordIndexScoring(
  query: string,
  nameEn?: string | null,
  nameAr?: string | null,
): string {
  const qTokens = tokenizeTitleWords(query);
  const queryArabicFirst = Boolean(qTokens[0] && isArabicToken(qTokens[0]));
  const en = (nameEn ?? '').trim();
  const ar = (nameAr ?? '').trim();

  if (queryArabicFirst) {
    return ar || en;
  }
  return en || ar;
}

/**
 * Higher score = better title word-index alignment with the query.
 * Exact normalized title equality is scored highest.
 */
export function scoreTitleByWordIndexes(query: string, title: string): number {
  const qTokens = tokenizeTitleWords(query);
  const tTokens = titleTokensInReadingOrder(title);
  if (qTokens.length === 0 || tTokens.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }

  if (qTokens.join(' ') === tTokens.join(' ')) {
    return EXACT_TITLE_SCORE;
  }

  const titlePositions = new Map<string, number[]>();
  tTokens.forEach((token, index) => {
    const list = titlePositions.get(token) ?? [];
    list.push(index);
    titlePositions.set(token, list);
  });

  let score = 0;
  let matched = 0;
  const used = new Set<number>();

  let prefixMatches = 0;
  for (let i = 0; i < Math.min(qTokens.length, tTokens.length); i += 1) {
    if (qTokens[i] !== tTokens[i]) break;
    prefixMatches += 1;
  }
  score += prefixMatches * 1_000_000;

  for (let qi = 0; qi < qTokens.length; qi += 1) {
    const positions = titlePositions.get(qTokens[qi]);
    if (!positions?.length) continue;
    const pos = positions.find((p) => !used.has(p));
    if (pos === undefined) continue;
    used.add(pos);
    matched += 1;
    // Earlier title indexes win; query/title index alignment also wins.
    score += 10_000 / (1 + pos);
    score += 1_000 / (1 + Math.abs(pos - qi));
  }

  score += matched * 100_000;
  score += (matched / Math.max(tTokens.length, 1)) * 100;
  score -= tTokens.length * 0.01;

  return score;
}

export function scoreProductByTitleWordIndexes(
  query: string,
  nameEn?: string | null,
  nameAr?: string | null,
): number {
  if (isExactTitleMatch(query, nameEn, nameAr)) {
    return EXACT_TITLE_SCORE;
  }

  const primary = selectTitleForWordIndexScoring(query, nameEn, nameAr);
  if (!primary) return Number.NEGATIVE_INFINITY;

  const primaryScore = scoreTitleByWordIndexes(query, primary);
  const en = (nameEn ?? '').trim();
  const ar = (nameAr ?? '').trim();
  const secondary = primary === ar ? en : ar;
  if (!secondary || secondary === primary) {
    return primaryScore;
  }

  return Math.max(primaryScore, scoreTitleByWordIndexes(query, secondary));
}

/**
 * Pin exact title matches first, then sort remaining IDs by title word-index score.
 * Preserves relative order on ties.
 */
export function orderIdsByTitleRelevance(params: {
  query: string;
  orderedIds: number[];
  exactTitleIds: number[];
  titlesById: Map<number, { name_en?: string | null; name_ar?: string | null }>;
}): number[] {
  const { query, orderedIds, exactTitleIds, titlesById } = params;
  const seen = new Set<number>();
  const result: number[] = [];

  const pushUnique = (id: number) => {
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) return;
    seen.add(id);
    result.push(id);
  };

  for (const id of exactTitleIds) {
    pushUnique(id);
  }

  const rest = orderedIds.filter((id) => !seen.has(id));
  const originalIndex = new Map(orderedIds.map((id, index) => [id, index]));

  rest.sort((a, b) => {
    const scoreA = scoreProductByTitleWordIndexes(
      query,
      titlesById.get(a)?.name_en,
      titlesById.get(a)?.name_ar,
    );
    const scoreB = scoreProductByTitleWordIndexes(
      query,
      titlesById.get(b)?.name_en,
      titlesById.get(b)?.name_ar,
    );
    if (scoreB !== scoreA) return scoreB - scoreA;
    return (originalIndex.get(a) ?? 0) - (originalIndex.get(b) ?? 0);
  });

  for (const id of rest) {
    pushUnique(id);
  }

  return result;
}
