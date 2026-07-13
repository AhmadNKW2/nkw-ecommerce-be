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

  it('resolves all concept groups for an exact segment match', async () => {
    const cardGroup: TermGroup = {
      id: 9,
      terms_en: ['graphics card', 'gpu card'],
      terms_ar: ['كرت', 'كرت شاشة'],
      reference_product_ids: [],
      concept_key: 'graphics_card',
      concept_label_en: 'graphics card',
      concept_label_ar: 'كرت',
      source_product_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const memoryCardGroup: TermGroup = {
      id: 10,
      terms_en: ['ram card', 'memory card'],
      terms_ar: ['كرت ذاكرة', 'كرت رام'],
      reference_product_ids: [],
      concept_key: 'memory_card',
      concept_label_en: 'memory card',
      concept_label_ar: 'كرت ذاكرة',
      source_product_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const segmentedService = makeService([cardGroup, memoryCardGroup, ramGroup]);

    const fullPhraseMatches =
      await segmentedService.resolveAllConceptGroupsMatchingSegment(
        'كرت ذاكرة',
        'ar',
      );
    expect(fullPhraseMatches.map((match) => match.groupId)).toEqual([10]);

    const cardMatches =
      await segmentedService.resolveAllConceptGroupsMatchingSegment('كرت', 'ar');
    expect(cardMatches.map((match) => match.groupId)).toEqual([9]);

    const ramMatches =
      await segmentedService.resolveAllConceptGroupsMatchingSegment('ذاكرة', 'ar');
    expect(ramMatches.some((match) => match.groupId === 3)).toBe(true);
  });

  it('resolves every concept group that shares the same single token', async () => {
    const gamepadGroup: TermGroup = {
      id: 276,
      terms_en: ['gamepad', 'controller'],
      terms_ar: ['قبضة', 'يد تحكم'],
      reference_product_ids: [1608],
      concept_key: 'gamepad',
      concept_label_en: 'gamepad',
      concept_label_ar: 'يد تحكم',
      source_product_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const gripGroup: TermGroup = {
      id: 277,
      terms_en: ['grip', 'controller grip'],
      terms_ar: ['قبضة', 'مقبض'],
      reference_product_ids: [1607],
      concept_key: 'controllergrip',
      concept_label_en: 'grip',
      concept_label_ar: 'مقبض',
      source_product_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const service = makeService([gamepadGroup, gripGroup]);

    const matches = await service.resolveAllConceptsInQuery('قبضة', ['قبضة'], 'ar');

    expect(matches.map((match) => match.groupId).sort()).toEqual([276, 277]);
  });

  it('segments query into word-variant buckets with merged variants', async () => {
    const service = makeService([laptopGroup]);

    const segmented = await service.segmentQueryWithVariants(
      'laptop lenovo 5070 i7',
      ['laptop', 'lenovo', '5070', 'i7'],
      'en',
    );

    expect(segmented.segments).toHaveLength(4);
    expect(segmented.segments[0].orderedVariants.slice(0, 2)).toEqual([
      'laptop',
      'notebook',
    ]);
    expect(segmented.segments[1].orderedVariants).toEqual(['lenovo']);
    expect(segmented.allSegmentsMatchedByTerms).toBe(false);
  });

  it('marks allSegmentsMatchedByTerms and collects reference IDs for قبضة', async () => {
    const gamepadGroup: TermGroup = {
      id: 276,
      terms_en: ['gamepad', 'controller'],
      terms_ar: ['قبضة', 'يد تحكم'],
      reference_product_ids: [1608],
      concept_key: 'gamepad',
      concept_label_en: 'gamepad',
      concept_label_ar: 'يد تحكم',
      source_product_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const gripGroup: TermGroup = {
      id: 277,
      terms_en: ['grip', 'controller grip'],
      terms_ar: ['قبضة', 'مقبض'],
      reference_product_ids: [1607],
      concept_key: 'controllergrip',
      concept_label_en: 'grip',
      concept_label_ar: 'مقبض',
      source_product_id: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
    const service = makeService([gamepadGroup, gripGroup]);

    const segmented = await service.segmentQueryWithVariants('قبضة', ['قبضة'], 'ar');

    expect(segmented.allSegmentsMatchedByTerms).toBe(true);
    expect(segmented.segments[0].referenceProductIds.sort((a, b) => a - b)).toEqual([
      1607, 1608,
    ]);
  });
});
