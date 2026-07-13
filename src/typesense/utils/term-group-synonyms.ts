import type { TermGroup } from '../../terms/entities/term-group.entity';
import { PRODUCT_CONCEPT_SYNONYM_ID_PREFIX } from '../config/synonyms';

export type TermGroupSynonymSource = Pick<
  TermGroup,
  | 'id'
  | 'concept_key'
  | 'concept_label_en'
  | 'concept_label_ar'
  | 'terms_en'
  | 'terms_ar'
>;

function normalizeSynonymKey(term: string): string {
  return term.trim().toLowerCase();
}

/**
 * Build Typesense synonym groups from term_groups rows.
 * Each group needs at least two distinct terms — Typesense requirement.
 */
export function buildTermGroupSynonymGroups(
  groups: TermGroupSynonymSource[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};

  groups.forEach((group) => {
    const conceptKey = group.concept_key?.trim();
    const synonymId = conceptKey
      ? `${PRODUCT_CONCEPT_SYNONYM_ID_PREFIX}${conceptKey}`
      : `${PRODUCT_CONCEPT_SYNONYM_ID_PREFIX}id-${group.id}`;

    const seen = new Set<string>();
    const synonyms: string[] = [];

    const push = (term: string | null | undefined) => {
      const trimmed = term?.trim();
      if (!trimmed) return;

      const key = normalizeSynonymKey(trimmed);
      if (!key || seen.has(key)) return;

      seen.add(key);
      synonyms.push(trimmed);
    };

    push(conceptKey);
    push(group.concept_label_en);
    push(group.concept_label_ar);
    (group.terms_en ?? []).forEach(push);
    (group.terms_ar ?? []).forEach(push);

    if (synonyms.length >= 2) {
      result[synonymId] = synonyms;
    }
  });

  return result;
}
