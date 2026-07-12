import { TermConceptLexiconService } from './term-concept-lexicon.service';
import { TermGroup } from '../terms/entities/term-group.entity';

function makeService(groups: TermGroup[]) {
  const termGroupsRepository = {
    find: jest.fn().mockResolvedValue(groups),
  };

  return new TermConceptLexiconService(termGroupsRepository as any);
}

describe('TermConceptLexiconService', () => {
  const laptopGroup: TermGroup = {
    id: 7,
    terms_en: ['laptop', 'notebook'],
    terms_ar: ['لابتوب', 'حاسب محمول', 'كمبيوتر محمول'],
    reference_product_ids: [],
    concept_key: 'laptop',
    concept_label_en: 'laptop',
    concept_label_ar: 'حاسب محمول',
    source_product_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  const ramGroup: TermGroup = {
    id: 3,
    terms_en: ['ram', 'memory'],
    terms_ar: ['ذاكرة', 'ذاكرة مؤقتة', 'رام'],
    reference_product_ids: [],
    concept_key: 'ram',
    concept_label_en: 'ram',
    concept_label_ar: 'ذاكرة',
    source_product_id: null,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('resolves a single-token concept from the query', async () => {
    const service = makeService([laptopGroup]);
    const matches = await service.resolveAllConceptsInQuery(
      'لابتوب 5070 i7',
      ['لابتوب', '5070', 'i7'],
      'ar',
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].groupId).toBe(7);
    expect(matches[0].userTerm).toBe('لابتوب');
    expect(matches[0].orderedVariants[0]).toBe('لابتوب');
    expect(matches[0].orderedVariants).toContain('حاسب محمول');
  });

  it('resolves multiple non-overlapping phrase concepts in one query', async () => {
    const service = makeService([laptopGroup, ramGroup]);
    const matches = await service.resolveAllConceptsInQuery(
      'ذاكرة مؤقتة حاسب محمول',
      ['ذاكرة', 'مؤقتة', 'حاسب', 'محمول'],
      'ar',
    );

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => match.groupId).sort()).toEqual([3, 7]);
    expect(matches[0].userTerm).toBe('ذاكره موقته');
    expect(matches[1].userTerm).toBe('حاسب محمول');
  });

  it('returns concept tokens for fallback exclusion', async () => {
    const service = makeService([laptopGroup, ramGroup]);
    const matches = await service.resolveAllConceptsInQuery(
      'ذاكرة مؤقتة حاسب محمول',
      ['ذاكرة', 'مؤقتة', 'حاسب', 'محمول'],
      'ar',
    );

    const tokens = service.getConceptTokensFromMatches(matches);
    expect(tokens.has('ذاكرة')).toBe(true);
    expect(tokens.has('مؤقتة')).toBe(true);
    expect(tokens.has('حاسب')).toBe(true);
    expect(tokens.has('محmول')).toBe(false);
    expect(tokens.has('محمول')).toBe(true);
  });

  it('matches normalized Arabic variants', async () => {
    const groupWithSpacedVariant: TermGroup = {
      ...laptopGroup,
      terms_ar: ['لاب توب', 'لابتوب', 'حاسب محمول'],
    };
    const service = makeService([groupWithSpacedVariant]);
    const matches = await service.resolveAllConceptsInQuery(
      'لاب توب 5070',
      ['لاب', 'توب', '5070'],
      'ar',
    );

    expect(matches.some((match) => match.groupId === 7)).toBe(true);
  });
});
