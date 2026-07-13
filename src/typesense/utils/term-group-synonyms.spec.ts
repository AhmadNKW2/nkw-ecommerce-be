import { buildTermGroupSynonymGroups } from './term-group-synonyms';

describe('buildTermGroupSynonymGroups', () => {
  it('builds a synonym group from concept labels and terms', () => {
    const groups = buildTermGroupSynonymGroups([
      {
        id: 12,
        concept_key: 'gaming-grip',
        concept_label_en: 'grip',
        concept_label_ar: 'قبضة',
        terms_en: ['handle', 'grip'],
        terms_ar: ['مقبض', 'قبضه'],
      },
    ]);

    expect(groups['concept-gaming-grip']).toEqual(
      expect.arrayContaining(['gaming-grip', 'grip', 'قبضة', 'handle', 'مقبض', 'قبضه']),
    );
    expect(groups['concept-gaming-grip'].length).toBeGreaterThanOrEqual(2);
  });

  it('skips groups with fewer than two distinct terms', () => {
    const groups = buildTermGroupSynonymGroups([
      {
        id: 3,
        concept_key: 'solo',
        concept_label_en: 'solo',
        concept_label_ar: null,
        terms_en: [],
        terms_ar: [],
      },
    ]);

    expect(groups).toEqual({});
  });

  it('deduplicates case-insensitive English terms', () => {
    const groups = buildTermGroupSynonymGroups([
      {
        id: 4,
        concept_key: 'mouse',
        concept_label_en: 'Mouse',
        concept_label_ar: 'ماوس',
        terms_en: ['mouse', 'MOUSE'],
        terms_ar: ['ماوس'],
      },
    ]);

    expect(groups['concept-mouse']).toEqual(['mouse', 'ماوس']);
  });
});
