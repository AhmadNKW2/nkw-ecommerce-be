import { Brand } from '../../brands/entities/brand.entity';
import { Category } from '../../categories/entities/category.entity';

export interface Stage1CategoryNode {
  id: number;
  name_en: string;
  name_ar: string;
  parent_id: number | null;
  level: number;
}

export interface Stage1PromptInput {
  brands: Pick<Brand, 'id' | 'name_en'>[];
  categories: Stage1CategoryNode[];
}

/**
 * Flatten the active category tree into a compact list the model can reason
 * about cheaply (id, name, parent). Keeps Stage 1 tokens small.
 */
export function flattenCategoryTree(categories: Category[]): Stage1CategoryNode[] {
  const nodes: Stage1CategoryNode[] = [];
  const visit = (category: Category) => {
    nodes.push({
      id: category.id,
      name_en: category.name_en,
      name_ar: category.name_ar,
      parent_id: category.parent_id ?? null,
      level: category.level ?? 0,
    });
    (category.children ?? []).forEach(visit);
  };
  categories.forEach(visit);
  return nodes;
}

export function buildStage1SystemPrompt(input: Stage1PromptInput): string {
  const brandCatalog = input.brands
    .map((brand) => brand.name_en?.trim())
    .filter((name): name is string => !!name);

  return [
    'You are an ecommerce catalog classifier.',
    'You receive a raw vendor product (title, description) and must decide two things:',
    '1) which existing brand it belongs to, and 2) which existing leaf category it best fits.',
    '',
    'DATABASE BRANDS (exact English names):',
    JSON.stringify(brandCatalog, null, 2),
    '',
    'DATABASE CATEGORIES (id, name, parent_id, level; level 0 = root):',
    JSON.stringify(input.categories, null, 2),
    '',
    'BRAND RULES:',
    '    - Detect the true manufacturer brand from the product title and description only.',
    '    - Ignore vendor names, seller names, shop domains, and marketing noise.',
    '    - If the detected brand matches a DATABASE BRAND, return its exact English name in brand_match.',
    '    - If a clear manufacturer brand exists but is NOT in DATABASE BRANDS, set brand_match to null and put the detected English brand name in suggested_brand.name_en plus an Arabic transliteration in suggested_brand.name_ar.',
    '    - NEVER use a generic fallback brand such as "Others". If no reliable brand can be determined, set BOTH brand_match and suggested_brand to null.',
    '',
    'CATEGORY RULES:',
    '    - Choose the single most specific existing category that the product PERFECTLY fits (prefer the deepest matching leaf).',
    '    - If a perfect fit exists, return its id in category_match.',
    '    - If no existing category is a good fit, set category_match to null and propose a new category in suggested_category: name_en, name_ar, and parent_id (the id of the best existing parent to place it under, or null to place it at the root). Add a short reason.',
    '',
    'STRICT OUTPUT RULES:',
    '    1. Output JSON ONLY. No markdown. No comments. No code fences.',
    '    2. Never invent brand or category ids that are not in the provided catalogs.',
    '',
    'Respond ONLY with a JSON object in this exact format:',
    '{',
    '"brand_match": "<exact DATABASE BRAND english name>" | null,',
    '"suggested_brand": { "name_en": "<detected brand>", "name_ar": "<arabic>" } | null,',
    '"category_match": <existing category id> | null,',
    '"suggested_category": { "name_en": "<new category>", "name_ar": "<arabic>", "parent_id": <existing id> | null, "reason": "<short>" } | null',
    '}',
  ].join('\n');
}
