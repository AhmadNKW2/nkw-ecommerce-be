export const BATTERY_CHARGERS_VENDOR_CATEGORY_ID = 65;
export const LAPTOP_BATTERIES_CATEGORY_ID = 143;
export const LAPTOP_CHARGERS_CATEGORY_ID = 144;

const BATTERY_KEYWORDS = [
  'battery',
  'cell',
  'replacement battery',
];

const CHARGER_KEYWORDS = [
  'charger',
  'adapter',
  'power supply',
  'ac adapter',
];

function normalizeSearchText(...parts: Array<string | null | undefined>): string {
  return parts
    .filter((part) => typeof part === 'string' && part.trim())
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
}

export function resolveBatteryChargerCategoryId(
  text: string,
  defaultCategoryId: number = LAPTOP_CHARGERS_CATEGORY_ID,
): number {
  const normalized = normalizeSearchText(text);

  if (
    BATTERY_KEYWORDS.some((keyword) => normalized.includes(keyword))
  ) {
    return LAPTOP_BATTERIES_CATEGORY_ID;
  }

  if (
    CHARGER_KEYWORDS.some((keyword) => normalized.includes(keyword))
  ) {
    return LAPTOP_CHARGERS_CATEGORY_ID;
  }

  return defaultCategoryId;
}

export function applyBatteryChargerCategorySplit(
  categoryIds: number[],
  vendorCategoryId: number | null | undefined,
  searchableText: string,
): number[] {
  if (
    vendorCategoryId !== BATTERY_CHARGERS_VENDOR_CATEGORY_ID ||
    categoryIds.length === 0
  ) {
    return categoryIds;
  }

  const resolvedCategoryId = resolveBatteryChargerCategoryId(
    searchableText,
    categoryIds[0],
  );

  if (resolvedCategoryId === categoryIds[0]) {
    return categoryIds;
  }

  return [
    resolvedCategoryId,
    ...categoryIds.slice(1).filter((id) => id !== resolvedCategoryId),
  ];
}
