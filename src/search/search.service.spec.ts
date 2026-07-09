import { SearchService } from './search.service';
import { SearchQueryDto, AutocompleteQueryDto } from './dto/search-query.dto';
import { PRODUCT_SEARCH_QUERY_BY_WEIGHTS } from '../typesense/product-search-fields';

function makeService(searchResult: any = { hits: [], found: 0 }, categoryRows: Array<{ id: number; slug: string }> = []) {
  const typesenseSearch = jest.fn().mockResolvedValue(searchResult);
  const cacheManager = {
    get: jest.fn().mockResolvedValue(undefined),
    set: jest.fn().mockResolvedValue(undefined),
  };
  const productsService = {
    findAll: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    findPrimaryImageUrlsByProductIds: jest.fn().mockResolvedValue(new Map()),
  };
  const typesenseService = {
    isEnabled: jest.fn().mockReturnValue(true),
    search: typesenseSearch,
  };
  const configService = {
    get: jest.fn().mockReturnValue('typesense'),
  };
  const emptyRepo = { find: jest.fn().mockResolvedValue([]) };
  const categoriesRepository = {
    find: jest.fn().mockResolvedValue(categoryRows),
  };

  const service = new SearchService(
    cacheManager as any,
    productsService as any,
    typesenseService as any,
    configService as any,
    categoriesRepository as any,
    emptyRepo as any,
    emptyRepo as any,
    emptyRepo as any,
    emptyRepo as any,
  );

  return { service, typesenseSearch, productsService, categoriesRepository };
}

describe('SearchService — SEARCHABLE_STATUSES and query_by wiring', () => {
  it('uses the SEARCHABLE_STATUSES constant (active, updated, review) in the main search filter_by', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    expect(typesenseSearch).toHaveBeenCalledTimes(1);
    const params = typesenseSearch.mock.calls[0][0];
    expect(params.filter_by).toContain('status:=[active,updated,review]');
  });

  it('includes the new Arabic description fields in the main search query_by', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.query_by).toContain('short_description_ar');
    expect(params.query_by).toContain('long_description_ar');
    expect(params.query_by).toContain('short_description_ar_norm');
    expect(params.query_by).toContain('long_description_ar_norm');
    expect(params.query_by).toContain('name_ar_norm');
    // Existing fields must still be present (no regression).
    expect(params.query_by).toContain('short_description_en');
    expect(params.query_by).toContain('long_description_en');
    expect(params.query_by).toContain('name_ar');
    expect(params.query_by).toContain('name_en');
    expect(params.query_by).toContain('sku');
  });

  it('does not apply the SEARCHABLE_STATUSES filter for admin search', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, true, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.filter_by ?? '').not.toContain('status:=');
  });

  it('normalizes Arabic variants in the query sent to Typesense for main search', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'أحمد' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.q).toBe('احمد');
  });

  it('collapses whitespace in the query sent to Typesense', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: '   tab   a6   ' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.q).toBe('tab a6');
  });

  it('uses the SEARCHABLE_STATUSES constant in the autocomplete filter_by', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'tab' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.filter_by).toContain('status:=[active,updated,review]');
  });

  it('normalizes Arabic variants in the autocomplete query sent to Typesense', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'أحمد' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.q).toBe('احمد');
  });
});

describe('SearchService — relevance ranking (sort_by, query_by_weights, prioritize_token_position)', () => {
  it('defaults to relevance-primary sort with created date only as a tie-breaker', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('_text_match:desc,created_at_ts:desc');
  });

  it('treats the explicit "created_at:desc" option the same as the default (relevance-primary)', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet', sort_by: 'created_at:desc' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('_text_match:desc,created_at_ts:desc');
  });

  it('lets an explicit price sort override relevance entirely', async () => {
    const { service, typesenseSearch } = makeService();
    const dtoAsc: SearchQueryDto = { q: 'tablet', sort_by: 'price:asc' } as SearchQueryDto;
    const dtoDesc: SearchQueryDto = { q: 'tablet', sort_by: 'price:desc' } as SearchQueryDto;

    await service.search(dtoAsc, false, false);
    await service.search(dtoDesc, false, false);

    expect(typesenseSearch.mock.calls[0][0].sort_by).toBe('effective_price:asc');
    expect(typesenseSearch.mock.calls[0][0].sort_by).not.toContain('_text_match');
    expect(typesenseSearch.mock.calls[1][0].sort_by).toBe('effective_price:desc');
    expect(typesenseSearch.mock.calls[1][0].sort_by).not.toContain('_text_match');
  });

  it('lets an explicit rating sort override relevance entirely', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet', sort_by: 'rating:desc' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('average_rating:desc');
    expect(params.sort_by).not.toContain('_text_match');
  });

  it('sends explicit query_by_weights giving name the highest priority, then short description, then long description', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    const fields = params.query_by.split(',');
    const weights = params.query_by_weights.split(',').map(Number);
    const weightOf = (fieldName: string) => weights[fields.indexOf(fieldName)];

    expect(fields.indexOf('name_en')).toBeGreaterThanOrEqual(0);
    expect(weightOf('name_en')).toBeGreaterThan(weightOf('short_description_en'));
    expect(weightOf('name_ar_norm')).toBeGreaterThan(weightOf('short_description_ar_norm'));
    expect(weightOf('name_ar_norm')).toBeGreaterThan(weightOf('name_ar'));
    expect(weightOf('short_description_en')).toBeGreaterThan(weightOf('long_description_en'));
    expect(weightOf('short_description_ar_norm')).toBeGreaterThan(
      weightOf('long_description_ar_norm'),
    );
  });

  it('enables prioritize_token_position on the main search call', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.prioritize_token_position).toBe(true);
  });

  it('enables prioritize_token_position on the autocomplete call', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'tab' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.prioritize_token_position).toBe(true);
  });

  // text_match_type must be 'max_weight' — the default 'max_score' picks
  // whichever field has the best raw match quality regardless of its
  // configured weight, and only falls back to query_by_weights as a
  // tiebreaker between documents with an *identical* score. That silently
  // defeats the "name > short description > long description" priority:
  // a document whose only match is deep in a low-weighted description field
  // can outrank a document that matches the query at the very start of its
  // (higher-weighted) name field. 'max_weight' instead always uses the score
  // from whichever *matching* field has the highest configured weight, so a
  // name_ar match is compared against another name_ar match (and
  // prioritize_token_position can then correctly decide based on position).
  it("sets text_match_type to 'max_weight' on the main search call", async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.text_match_type).toBe('max_weight');
  });

  it("sets text_match_type to 'max_weight' on the autocomplete call", async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'tab' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.text_match_type).toBe('max_weight');
  });

  // Regression test: autocomplete previously hardcoded sort_by to
  // 'created_at_ts:desc' alone, which ignored relevance entirely and
  // surfaced recently-added, loosely-matching products ahead of
  // well-matching ones — producing suggestions wildly different from the
  // main search results for the same query.
  it('sorts autocomplete results by relevance first, created date as tiebreaker (matching main search)', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'tab' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('_text_match:desc,created_at_ts:desc');
  });

  it('sends explicit query_by_weights on the autocomplete call matching the name > sku > slug priority', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'tab' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    const fields = params.query_by.split(',');
    const weights = params.query_by_weights.split(',').map(Number);
    const weightOf = (fieldName: string) => weights[fields.indexOf(fieldName)];

    expect(weightOf('name_en')).toBeGreaterThan(weightOf('sku'));
    expect(weightOf('sku')).toBeGreaterThan(weightOf('slug'));
  });

  it('still routes the random-browse (wildcard) path through Typesense, and applies the same relevance params', async () => {
    const { service, typesenseSearch } = makeService();
    // Empty q with no explicit sort triggers the random-browse path
    // (searchWithTypesenseRandomBrowse), which must still call into
    // Typesense for facet counts/total — it must not silently fall through
    // to the DB-only path.
    const dto: SearchQueryDto = {} as SearchQueryDto;

    await service.search(dto, false, false);

    expect(typesenseSearch).toHaveBeenCalledTimes(1);
    const params = typesenseSearch.mock.calls[0][0];
    expect(params.prioritize_token_position).toBe(true);
    expect(params.query_by_weights).toBe(PRODUCT_SEARCH_QUERY_BY_WEIGHTS);
    expect(params.text_match_type).toBe('max_weight');
  });
});

describe('SearchService — cache key normalization', () => {
  it('shares one cache entry for Arabic-variant search queries when Typesense is active', async () => {
    const { service } = makeService();
    const setKeys: string[] = [];
    (service as any).cacheManager.set = jest.fn((key: string) => {
      setKeys.push(key);
      return Promise.resolve();
    });

    await service.search({ q: 'أحمد' } as SearchQueryDto, false, false);
    await service.search({ q: 'احمد' } as SearchQueryDto, false, false);
    await service.search({ q: '   tab   a6   ' } as SearchQueryDto, false, false);
    await service.search({ q: 'tab a6' } as SearchQueryDto, false, false);

    expect(setKeys[0]).toBe(setKeys[1]);
    expect(setKeys[2]).toBe(setKeys[3]);
    expect(setKeys[0]).not.toBe(setKeys[2]);
  });

  it('keeps distinct cache entries for different raw queries when falling back to DB (unnormalized ILIKE)', async () => {
    const { service } = makeService();
    (service as any).configService.get = jest.fn().mockReturnValue('db');
    (service as any).typesenseService.isEnabled = jest.fn().mockReturnValue(false);
    const setKeys: string[] = [];
    (service as any).cacheManager.set = jest.fn((key: string) => {
      setKeys.push(key);
      return Promise.resolve();
    });

    await service.search({ q: 'أحمد' } as SearchQueryDto, false, false);
    await service.search({ q: 'احمد' } as SearchQueryDto, false, false);

    // DB path uses raw ILIKE against unnormalized columns, so these two
    // different raw queries must NOT share a cache entry.
    expect(setKeys[0]).not.toBe(setKeys[1]);
  });

  it('shares one autocomplete cache entry for Arabic-variant queries when Typesense is active', async () => {
    const { service } = makeService();
    const setKeys: string[] = [];
    (service as any).cacheManager.set = jest.fn((key: string) => {
      setKeys.push(key);
      return Promise.resolve();
    });

    await service.autocomplete({ q: 'أحمد' } as AutocompleteQueryDto, false);
    await service.autocomplete({ q: 'احمد' } as AutocompleteQueryDto, false);

    expect(setKeys[0]).toBe(setKeys[1]);
  });

  it('keeps distinct autocomplete cache entries for different raw queries when falling back to DB', async () => {
    const { service } = makeService();
    (service as any).configService.get = jest.fn().mockReturnValue('db');
    (service as any).typesenseService.isEnabled = jest.fn().mockReturnValue(false);
    const setKeys: string[] = [];
    (service as any).cacheManager.set = jest.fn((key: string) => {
      setKeys.push(key);
      return Promise.resolve();
    });

    await service.autocomplete({ q: 'أحمد' } as AutocompleteQueryDto, false);
    await service.autocomplete({ q: 'احمد' } as AutocompleteQueryDto, false);

    expect(setKeys[0]).not.toBe(setKeys[1]);
  });
});

describe('SearchService — core intent category boost', () => {
  const boostCategories = [
    { id: 44, slug: 'desktop-cpu' },
    { id: 96, slug: 'server-cpu' },
    { id: 45, slug: 'graphic-cards' },
    { id: 54, slug: 'power-supplies' },
    { id: 52, slug: 'hdd' },
  ];

  it('prepends a category _eval boost for an exact CPU query on the default sort', async () => {
    const { service, typesenseSearch } = makeService(undefined, boostCategories);
    await service.search({ q: 'CPU' } as SearchQueryDto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toContain('_eval([(category_ids:=[44,96]):1]):desc');
    expect(params.sort_by).toContain('_text_match:desc,created_at_ts:desc');
  });

  it('prepends a category _eval boost for CPU autocomplete', async () => {
    const { service, typesenseSearch } = makeService(undefined, boostCategories);
    await service.autocomplete({ q: 'cpu' } as AutocompleteQueryDto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toContain('_eval([(category_ids:=[44,96]):1]):desc');
  });

  it('does not apply category boost for multi-word queries like "cpu cooler"', async () => {
    const { service, typesenseSearch } = makeService(undefined, boostCategories);
    await service.search({ q: 'cpu cooler' } as SearchQueryDto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('_text_match:desc,created_at_ts:desc');
    expect(params.sort_by).not.toContain('_eval');
  });

  it('does not apply category boost when an explicit price sort is requested', async () => {
    const { service, typesenseSearch } = makeService(undefined, boostCategories);
    await service.search(
      { q: 'CPU', sort_by: 'price:asc' } as SearchQueryDto,
      false,
      false,
    );

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('effective_price:asc');
    expect(params.sort_by).not.toContain('_eval');
  });
});
