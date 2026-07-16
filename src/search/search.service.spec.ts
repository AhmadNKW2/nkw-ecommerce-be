import { SearchService } from './search.service';
import { SearchQueryDto, AutocompleteQueryDto } from './dto/search-query.dto';
import { PRODUCT_SEARCH_QUERY_BY, PRODUCT_SEARCH_QUERY_BY_WEIGHTS } from '../typesense/product-search-fields';

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
    multiSearch: jest.fn().mockResolvedValue({ results: [] }),
  };
  const configService = {
    get: jest.fn().mockReturnValue('typesense'),
  };
  const searchCacheService = {
    getGeneration: jest.fn().mockResolvedValue(1),
    invalidateSearchCache: jest.fn().mockResolvedValue(2),
    buildCacheKey: jest.fn((prefix: string, payload: string) =>
      Promise.resolve(`${prefix}:${payload}`),
    ),
  };
  const emptyRepo = {
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(() => ({
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    })),
  };
  const categoriesRepository = {
    find: jest.fn().mockResolvedValue(categoryRows),
  };
  const attributeValuesRepository = {
    find: jest.fn((options: any) => {
      const requestedIds = options?.where?.id?._value ?? [];
      const values = [
        { id: 7, attribute_id: 2 },
        { id: 15, attribute_id: 1 },
        { id: 17, attribute_id: 3 },
        { id: 18, attribute_id: 3 },
      ];
      return Promise.resolve(values.filter((value) => requestedIds.includes(value.id)));
    }),
  };
  const specificationValuesRepository = {
    find: jest.fn((options: any) => {
      const requestedIds = options?.where?.id?._value ?? [];
      const values = [
        { id: 23, specification_id: 4 },
        { id: 24, specification_id: 4 },
      ];
      return Promise.resolve(values.filter((value) => requestedIds.includes(value.id)));
    }),
  };

  const termConceptLexicon = {
    resolveAllConceptsInQuery: jest.fn().mockResolvedValue([]),
    getConceptTokensFromMatches: jest.fn().mockReturnValue(new Set()),
    segmentQueryWithVariants: jest
      .fn()
      .mockResolvedValue({ segments: [], allSegmentsMatchedByTerms: false }),
  };

  const service = new SearchService(
    cacheManager as any,
    productsService as any,
    typesenseService as any,
    searchCacheService as any,
    configService as any,
    termConceptLexicon as any,
    categoriesRepository as any,
    emptyRepo as any,
    emptyRepo as any,
    emptyRepo as any,
    emptyRepo as any,
    attributeValuesRepository as any,
    specificationValuesRepository as any,
  );

  return { service, typesenseSearch, productsService, categoriesRepository };
}

describe('SearchService — SEARCHABLE_STATUSES and query_by wiring', () => {
  it('uses the SEARCHABLE_STATUSES constant (active, updated, review) in the main search filter_by', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, false, false);

    expect(typesenseSearch).toHaveBeenCalled();
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
    expect(params.query_by).not.toContain('sku');
  });

  it('applies default SEARCHABLE_STATUSES filter for admin search too', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet' } as SearchQueryDto;

    await service.search(dto, true, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.filter_by).toContain('status:=[active,updated,review]');
    expect(params.filter_by).toContain('visible:=true');
  });

  it('sends every storefront facet and price filter to Typesense', async () => {
    const { service, typesenseSearch } = makeService();
    const dto = {
      q: 'tablet',
      category_ids: '11,12',
      brand_ids: '3,4',
      vendor_ids: '5,6',
      attributes_values_ids: '17,18',
      specifications_values_ids: '23,24',
      min_price: 10,
      max_price: 50,
    } as unknown as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.filter_by).toContain('category_ids:=[11,12]');
    expect(params.filter_by).toContain('brand_id:=[3,4]');
    expect(params.filter_by).toContain('vendor_id:=[5,6]');
    expect(params.filter_by).toContain('attributes_values_ids:=[17,18]');
    expect(params.filter_by).toContain('specifications_values_ids:=[23,24]');
    expect(params.filter_by).toContain('effective_price:>=10');
    expect(params.filter_by).toContain('effective_price:<=50');
    expect(params.filter_by).toContain('visible:=true');
    expect(params.filter_by).toContain('is_out_of_stock:=false');
  });

  it('requires matches across different attribute groups while allowing values within one group', async () => {
    const { service, typesenseSearch } = makeService();
    const dto = {
      q: 'tablet',
      // ID 7 is Color=White; ID 15 is RAM=16.
      attributes_values_ids: '7,15',
    } as unknown as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.filter_by).toContain('attributes_values_ids:=[7]');
    expect(params.filter_by).toContain('attributes_values_ids:=[15]');
    expect(params.filter_by).not.toContain('attributes_values_ids:=[7,15]');
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

  it('uses created_at_ts:desc when created_at:desc is explicitly requested', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: SearchQueryDto = { q: 'tablet', sort_by: 'created_at:desc' } as SearchQueryDto;

    await service.search(dto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('created_at_ts:desc');
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

  it('uses the same Typesense query fields for autocomplete as full search', async () => {
    const { service, typesenseSearch } = makeService();
    const dto: AutocompleteQueryDto = { q: 'tab' } as AutocompleteQueryDto;

    await service.autocomplete(dto, false);

    const params = typesenseSearch.mock.calls[0][0];
    const fields = params.query_by.split(',');
    const weights = params.query_by_weights.split(',').map(Number);
    const weightOf = (fieldName: string) => weights[fields.indexOf(fieldName)];

    expect(params.query_by).toBe(PRODUCT_SEARCH_QUERY_BY);
    expect(params.query_by_weights).toBe(PRODUCT_SEARCH_QUERY_BY_WEIGHTS);
    expect(fields).not.toContain('sku');
    expect(fields).toContain('short_description_en');
    expect(weightOf('name_en')).toBeGreaterThan(weightOf('slug'));
  });

  it('returns the same product ids as the first page of search', async () => {
    const hits = [
      { document: { id: 11, name_en: 'A', name_ar: 'A', price: 1, is_out_of_stock: false } },
      { document: { id: 22, name_en: 'B', name_ar: 'B', price: 2, is_out_of_stock: false } },
      { document: { id: 33, name_en: 'C', name_ar: 'C', price: 3, is_out_of_stock: false } },
    ];
    const { service } = makeService({ hits, found: 3 });

    const [searchResponse, autocompleteResponse] = await Promise.all([
      service.search({ q: 'tab', page: 1, per_page: 8 } as SearchQueryDto, false, false),
      service.autocomplete({ q: 'tab', per_page: 8 } as AutocompleteQueryDto, false),
    ]);

    expect(autocompleteResponse.suggestions.map((item) => item.id)).toEqual(
      (searchResponse.data ?? []).map((item: { id: string }) => String(item.id)),
    );
  });

  it('returns only the exact id match and skips Typesense fuzzy search', async () => {
    const { service, typesenseSearch, productsService } = makeService();
    productsService.findAll = jest
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 4899, sku: 'OTHER', name_en: 'By Id', name_ar: 'By Id' }],
        meta: { total: 1 },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 4899,
            sku: 'OTHER',
            name_en: 'By Id',
            name_ar: 'By Id',
            price: 10,
            quantity: 1,
            is_out_of_stock: false,
            media: [],
          },
        ],
        meta: { total: 1 },
      });

    const response = await service.search({ q: '4899' } as SearchQueryDto, false, false);

    expect(typesenseSearch).not.toHaveBeenCalled();
    expect(response.meta.total).toBe(1);
    expect(response.data).toHaveLength(1);
    expect(response.data[0].id).toBe('4899');
  });

  it('returns only the exact sku match and skips Typesense fuzzy search', async () => {
    const { service, typesenseSearch, productsService } = makeService();
    productsService.findAll = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 77,
            sku: 'EXACT-SKU-77',
            name_en: 'By Sku',
            name_ar: 'By Sku',
          },
        ],
        meta: { total: 1 },
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 77,
            sku: 'EXACT-SKU-77',
            name_en: 'By Sku',
            name_ar: 'By Sku',
            price: 20,
            quantity: 2,
            is_out_of_stock: false,
            media: [],
          },
        ],
        meta: { total: 1 },
      });

    const response = await service.search(
      { q: 'EXACT-SKU-77' } as SearchQueryDto,
      false,
      false,
    );

    expect(typesenseSearch).not.toHaveBeenCalled();
    expect(response.meta.total).toBe(1);
    expect(response.data).toHaveLength(1);
    expect(response.data[0].id).toBe('77');
  });

  it('does not treat partial sku-like queries as exact identifier matches', async () => {
    const { service, typesenseSearch, productsService } = makeService();
    productsService.findAll = jest.fn().mockResolvedValue({ data: [], meta: {} });

    await service.search({ q: 'EXACT-SKU' } as SearchQueryDto, false, false);

    // Exact lookup runs once (sku miss), then Typesense handles fuzzy name search.
    expect(productsService.findAll).toHaveBeenCalled();
    expect(typesenseSearch).toHaveBeenCalled();
    const params = typesenseSearch.mock.calls[0][0];
    expect(params.q).toBe('EXACT-SKU');
    expect(params.query_by).not.toContain('sku');
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

  it('does not use random browse when attribute values are selected', () => {
    const { service } = makeService();

    expect(
      (service as any).shouldUseRandomBrowseSort({
        q: '*',
        attributes_values_ids: '15,218',
      }),
    ).toBe(false);
  });

  it('reapplies the admin stock filter while hydrating Typesense result IDs', () => {
    const { service } = makeService();

    expect(
      (service as any).buildHydrationFilterDto(
        [101, 102],
        { q: '*', in_stock: false },
        true,
      ),
    ).toMatchObject({
      ids: [101, 102],
      in_stock: false,
      randomBrowse: false,
    });
  });

  it('pins an exact Arabic title match as the first result before other hits', async () => {
    const exactTitle =
      'لابتوب ألعاب Lenovo LOQ 15IRX10 AI مقاس 15.6 إنش FHD IPS 144Hz بمعالج Intel Core i7-14700HX وكرت RTX 5060 8GB';

    const typesenseSearch = jest.fn().mockImplementation(async (params: any) => {
      // Exact-title probe
      if (
        params?.include_fields === 'id,name_en,name_ar,name_ar_norm' &&
        params?.num_typos === 0
      ) {
        return {
          hits: [
            {
              document: {
                id: 99,
                name_en: '',
                name_ar: exactTitle,
                name_ar_norm: exactTitle,
              },
            },
          ],
          found: 1,
        };
      }

      // Title hydrate for ranking
      if (params?.include_fields === 'id,name_en,name_ar' && params?.q === '*') {
        return {
          hits: [
            {
              document: {
                id: 1,
                name_en: '',
                name_ar: 'لابتوب ألعاب Lenovo LOQ RTX 4050',
              },
            },
            {
              document: {
                id: 99,
                name_en: '',
                name_ar: exactTitle,
              },
            },
          ],
          found: 2,
        };
      }

      // Primary search — wrong order on purpose
      return {
        hits: [
          {
            document: {
              id: 1,
              name_en: '',
              name_ar: 'لابتوب ألعاب Lenovo LOQ RTX 4050',
              price: 100,
              is_out_of_stock: false,
            },
          },
          {
            document: {
              id: 99,
              name_en: '',
              name_ar: exactTitle,
              price: 200,
              is_out_of_stock: false,
            },
          },
        ],
        found: 2,
      };
    });

    const { service } = makeService();
    (service as any).typesenseService.search = typesenseSearch;
    (service as any).configService.get = jest.fn((key: string, fallback?: string) => {
      if (key === 'SEARCH_EXPANSION_ENABLED') return 'false';
      if (key === 'SEARCH_PROVIDER') return 'typesense';
      return fallback ?? 'typesense';
    });

    const response = await service.search(
      { q: exactTitle, page: 1, per_page: 20 } as SearchQueryDto,
      false,
      false,
    );

    expect(response.data[0].id).toBe('99');
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

    const autocompleteKeys = setKeys.filter((key) => key.startsWith('autocomplete:'));
    expect(autocompleteKeys).toHaveLength(2);
    expect(autocompleteKeys[0]).toBe(autocompleteKeys[1]);
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

    const autocompleteKeys = setKeys.filter((key) => key.startsWith('autocomplete:'));
    expect(autocompleteKeys).toHaveLength(2);
    // DB path uses raw ILIKE against unnormalized columns, so these two
    // different raw queries must NOT share a cache entry.
    expect(autocompleteKeys[0]).not.toBe(autocompleteKeys[1]);
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

  it('does not prepend category _eval boost for an exact CPU query', async () => {
    const { service, typesenseSearch } = makeService(undefined, boostCategories);
    await service.search({ q: 'CPU' } as SearchQueryDto, false, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('_text_match:desc,created_at_ts:desc');
    expect(params.sort_by).not.toContain('_eval');
  });

  it('does not prepend category _eval boost for CPU autocomplete', async () => {
    const { service, typesenseSearch } = makeService(undefined, boostCategories);
    await service.autocomplete({ q: 'cpu' } as AutocompleteQueryDto, false);

    const params = typesenseSearch.mock.calls[0][0];
    expect(params.sort_by).toBe('_text_match:desc,created_at_ts:desc');
    expect(params.sort_by).not.toContain('_eval');
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
