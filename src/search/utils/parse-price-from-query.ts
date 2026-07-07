export type ParsedPriceFromQuery = {
  cleanedQuery: string;
  minPrice?: number;
  maxPrice?: number;
  strippedPhrases: string[];
};

type ExistingPriceFilters = {
  minPrice?: number;
  maxPrice?: number;
};

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const NUMBER_PATTERN = '([\\d٠-٩][\\d٠-٩.,\\s]*)';
const OPTIONAL_CURRENCY = '(?:\\s*(?:ريال|ر\\.س|sar|usd|دولار))?';

function normalizeDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(ARABIC_INDIC_DIGITS.indexOf(digit)))
    .replace(/[,\s]/g, '');
}

function parsePriceNumber(raw: string): number | undefined {
  const normalized = normalizeDigits(raw.trim());
  if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) {
    return undefined;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }

  return parsed;
}

function stripMatch(
  query: string,
  pattern: RegExp,
  strippedPhrases: string[],
): string {
  return query.replace(pattern, (match) => {
    strippedPhrases.push(match.trim());
    return ' ';
  });
}

function applyBetween(
  query: string,
  strippedPhrases: string[],
): { query: string; min?: number; max?: number } {
  const patterns = [
    new RegExp(
      `(?:^|\\s)between\\s+${NUMBER_PATTERN}\\s+(?:and|to)\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)من\\s+${NUMBER_PATTERN}\\s+(?:الى|إلى|و)\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)بين\\s+${NUMBER_PATTERN}\\s+(?:و|وال|الى|إلى)\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(query);
    if (!match) continue;

    const min = parsePriceNumber(match[1]);
    const max = parsePriceNumber(match[2]);
    if (min === undefined || max === undefined) continue;

    strippedPhrases.push(match[0].trim());
    return {
      query: query.replace(match[0], ' '),
      min: Math.min(min, max),
      max: Math.max(min, max),
    };
  }

  return { query };
}

function collectSingleConstraints(
  query: string,
  strippedPhrases: string[],
): {
  query: string;
  lessThan?: number;
  moreThan?: number;
  equal?: number;
} {
  let nextQuery = query;
  let lessThan: number | undefined;
  let moreThan: number | undefined;
  let equal: number | undefined;

  const lessPatterns = [
    new RegExp(
      `(?:^|\\s)(?:less\\s+than|under|below)\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(`<\\s*${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`, 'giu'),
    new RegExp(
      `(?:^|\\s)أقل\\s+من\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)تحت\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)أرخص\\s+من\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
  ];

  const morePatterns = [
    new RegExp(
      `(?:^|\\s)(?:more\\s+than|over|above|greater\\s+than)\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(`>\\s*${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`, 'giu'),
    new RegExp(
      `(?:^|\\s)أكثر\\s+من\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)فوق\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)أعلى\\s+من\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
  ];

  const equalPatterns = [
    new RegExp(
      `(?:^|\\s)(?:equal(?:ly)?)\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(`=\\s*${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`, 'giu'),
    new RegExp(
      `(?:^|\\s)يساوي\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
    new RegExp(
      `(?:^|\\s)بسعر\\s+${NUMBER_PATTERN}${OPTIONAL_CURRENCY}(?=\\s|$)`,
      'giu',
    ),
  ];

  for (const pattern of lessPatterns) {
    const match = pattern.exec(nextQuery);
    if (!match) continue;
    const parsed = parsePriceNumber(match[1]);
    if (parsed === undefined) continue;
    lessThan = parsed;
    nextQuery = stripMatch(nextQuery, pattern, strippedPhrases);
    break;
  }

  for (const pattern of morePatterns) {
    const match = pattern.exec(nextQuery);
    if (!match) continue;
    const parsed = parsePriceNumber(match[1]);
    if (parsed === undefined) continue;
    moreThan = parsed;
    nextQuery = stripMatch(nextQuery, pattern, strippedPhrases);
    break;
  }

  for (const pattern of equalPatterns) {
    const match = pattern.exec(nextQuery);
    if (!match) continue;
    const parsed = parsePriceNumber(match[1]);
    if (parsed === undefined) continue;
    equal = parsed;
    nextQuery = stripMatch(nextQuery, pattern, strippedPhrases);
    break;
  }

  return { query: nextQuery, lessThan, moreThan, equal };
}

export function parsePriceFromQuery(
  query: string,
  existing: ExistingPriceFilters = {},
): ParsedPriceFromQuery {
  const strippedPhrases: string[] = [];
  const trimmed = query.trim();
  if (!trimmed || trimmed === '*') {
    return { cleanedQuery: trimmed || '*', strippedPhrases };
  }

  const between = applyBetween(trimmed, strippedPhrases);
  let workingQuery = between.query;
  let minPrice = between.min;
  let maxPrice = between.max;

  if (minPrice === undefined && maxPrice === undefined) {
    const singles = collectSingleConstraints(workingQuery, strippedPhrases);
    workingQuery = singles.query;

    if (singles.equal !== undefined) {
      minPrice = singles.equal;
      maxPrice = singles.equal;
    } else if (singles.lessThan !== undefined && singles.moreThan !== undefined) {
      minPrice = Math.min(singles.moreThan, singles.lessThan);
      maxPrice = Math.max(singles.moreThan, singles.lessThan);
    } else if (singles.lessThan !== undefined) {
      maxPrice = singles.lessThan;
    } else if (singles.moreThan !== undefined) {
      minPrice = singles.moreThan;
    }
  }

  const cleanedQuery = workingQuery.replace(/\s+/g, ' ').trim();

  return {
    cleanedQuery: cleanedQuery.length > 0 ? cleanedQuery : '*',
    minPrice:
      existing.minPrice === undefined ? minPrice : undefined,
    maxPrice:
      existing.maxPrice === undefined ? maxPrice : undefined,
    strippedPhrases,
  };
}
