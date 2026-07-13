import {
  Injectable,
  Inject,
  forwardRef,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { TermGroup } from '../terms/entities/term-group.entity';
import { Brand } from '../brands/entities/brand.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { AttributeValue } from '../attributes/entities/attribute-value.entity';
import { SpecificationValue } from '../specifications/entities/specification-value.entity';
import { ProductsService } from '../products/products.service';
import {
  FilterProductDto,
  FindAllProductsOptions,
  ProductSortBy,
  SortOrder,
} from '../products/dto/filter-product.dto';
import { SearchQueryDto, AutocompleteQueryDto } from './dto/search-query.dto';
import { AutocompleteResponseDto } from './dto/search-response.dto';
import type { SearchParams } from 'typesense/lib/Typesense/Documents';
import { TypesenseService } from '../typesense/typesense.service';
import {
  AUTOCOMPLETE_SEARCH_QUERY_BY,
  AUTOCOMPLETE_SEARCH_QUERY_BY_WEIGHTS,
  PRODUCT_CARD_QUERY_BY,
  PRODUCT_ID_LOOKUP_QUERY_BY,
  PRODUCT_SEARCH_QUERY_BY,
  PRODUCT_SEARCH_QUERY_BY_WEIGHTS,
} from '../typesense/product-search-fields';
import { normalizeSearchQuery } from '../typesense/utils/text-normalize';
import { parsePriceFromQuery } from './utils/parse-price-from-query';
import {
  buildVariantLevelQueries,
  normalizeConceptTermKey,
  normalizeSearchLocale,
  SEARCH_EXPANSION_VERSION,
} from './utils/spec-expansion.utils';
import { SearchCacheService } from './search-cache.service';
import {
  TermConceptLexiconService,
  type QueryVariantSegment,
} from './term-concept-lexicon.service';

// Matches current production behavior (previously hardcoded at two call sites:
// buildTypesenseFilterBy and autocompleteWithTypesense). Change only with
// product-team sign-off — review-status visibility is a pending decision.
const SEARCHABLE_STATUSES = ['active', 'updated', 'review'];

// Field priority for relevance ranking: name (title) highest, short
// description second, long description lowest. Arabic matching uses *_norm
// fields at full weight; plain Arabic display fields stay at lower weight for
// legacy documents until reindex. See product-search-fields.ts.
const PRODUCT_QUERY_BY = PRODUCT_SEARCH_QUERY_BY;
const PRODUCT_QUERY_BY_WEIGHTS = PRODUCT_SEARCH_QUERY_BY_WEIGHTS;
const AUTOCOMPLETE_QUERY_BY = AUTOCOMPLETE_SEARCH_QUERY_BY;
const AUTOCOMPLETE_QUERY_BY_WEIGHTS = AUTOCOMPLETE_SEARCH_QUERY_BY_WEIGHTS;
const SEARCH_TYPO_TOKENS_MIN_LENGTH = 4;

type ExpansionTierKey =
  | 'primary'
  | 'same_brand_spec'
  | 'category_brand'
  | 'cross_brand_spec'
  | 'category'
  | 'brand'
  | 'specification'
  | 'keyword';

@Injectable()
export class SearchService implements OnModuleInit {
  private readonly logger = new Logger(SearchService.name);
  private readonly randomBrowseMaxResults = 2000;
  private readonly typesenseIdPageSize = 250;
  private readonly unsupportedTypesenseFilterKeys = new Set([
    'attributes_ids',
    'specifications_ids',
    'created_by',
    'has_no_vendor',
    'has_no_brand',
    'has_duplicate_reference_link',
    'start_date',
    'end_date',
    'ids',
    'sku',
  ]);
  private readonly expansionTierOrder: ExpansionTierKey[] = [
    'same_brand_spec',
    'cross_brand_spec',
    'specification',
    'primary',
    'category_brand',
    'category',
    'brand',
    'keyword',
  ];
  private readonly defaultEnabledExpansionLevels = new Set<ExpansionTierKey>([
    'same_brand_spec',
    'category_brand',
    'cross_brand_spec',
    'category',
    'brand',
    'specification',
    'keyword',
  ]);
  private brandLexiconCache:
    | {
        loadedAt: number;
        entries: Array<{ id: number; normalizedTokens: string[] }>;
      }
    | null = null;
  private categoryLexiconCache:
    | {
        loadedAt: number;
        entries: Array<{ id: number; normalizedTokens: string[] }>;
      }
    | null = null;
  private readonly entityLexiconCacheTtlMs = 5 * 60 * 1000;
  private lastQueryPreparationDebug: {
    originalQuery?: string;
    normalizedQuery?: string;
    tokens?: string[];
    priceParse?: ReturnType<typeof parsePriceFromQuery>;
  } | null = null;

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,
    private readonly typesenseService: TypesenseService,
    private readonly searchCacheService: SearchCacheService,
    private readonly configService: ConfigService,
    private readonly termConceptLexicon: TermConceptLexiconService,
    @InjectRepository(Category)
    private readonly categoriesRepository: Repository<Category>,
    @InjectRepository(TermGroup)
    private readonly termGroupsRepository: Repository<TermGroup>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(Brand)
    private readonly brandsRepository: Repository<Brand>,
    @InjectRepository(Vendor)
    private readonly vendorsRepository: Repository<Vendor>,
    @InjectRepository(AttributeValue)
    private readonly attributeValuesRepository: Repository<AttributeValue>,
    @InjectRepository(SpecificationValue)
    private readonly specificationValuesRepository: Repository<SpecificationValue>,
  ) {}

  onModuleInit() {
    if (!this.isSearchDebugEnabledByEnv()) {
      return;
    }

    this.logger.log(
      '[search-debug] SEARCH_DEBUG_ENABLED=true — each search writes a full report (filter logs by "[search-debug]")',
    );
  }

  private get searchProvider(): string {
    return this.configService.get<string>('SEARCH_PROVIDER', 'db').toLowerCase();
  }

  private getPrimaryImageUrl(product: any): string | undefined {
    const media = Array.isArray(product?.media) ? product.media : [];
    const primary = media.find((item: any) => item?.is_primary);
    const first = media[0];
    return primary?.url ?? first?.url ?? undefined;
  }

  private mapTypesenseDocumentToSearchCard(
    document: Record<string, any>,
    imageUrl?: string,
  ): any {
    const price = Number(document.price);
    const normalizedPrice = Number.isFinite(price) ? price : 0;
    const salePrice = Number(document.sale_price);
    const normalizedSalePrice =
      Number.isFinite(salePrice) && salePrice > 0 && salePrice < normalizedPrice
        ? salePrice
        : undefined;
    const isOutOfStock = Boolean(document.is_out_of_stock);

    // Display Arabic from name_ar only — never use *_norm fields in responses.
    return {
      id: String(document.id ?? ''),
      slug: typeof document.slug === 'string' ? document.slug : undefined,
      name_en: typeof document.name_en === 'string' ? document.name_en : '',
      name_ar:
        typeof document.name_ar === 'string'
          ? document.name_ar
          : typeof document.name_en === 'string'
            ? document.name_en
            : '',
      price: normalizedPrice,
      sale_price: normalizedSalePrice,
      is_available: !isOutOfStock,
      stock: isOutOfStock ? 0 : 1,
      images: imageUrl ? [imageUrl] : [],
    };
  }

  private mapProductToSearchCard(product: any): any {
    const quantity = Number(product?.quantity);
    const isOutOfStock =
      typeof product?.is_out_of_stock === 'boolean'
        ? product.is_out_of_stock
        : !(Number.isFinite(quantity) && quantity > 0);
    const imageUrl = this.getPrimaryImageUrl(product);
    const salePrice = Number(product?.sale_price);
    const price = Number(product?.price);
    const normalizedPrice = Number.isFinite(price) ? price : 0;
    const normalizedSalePrice =
      Number.isFinite(salePrice) && salePrice > 0 && salePrice < normalizedPrice
        ? salePrice
        : undefined;

    return {
      id: String(product?.id ?? ''),
      slug: product?.slug,
      name_en: product?.name_en ?? '',
      name_ar: product?.name_ar ?? product?.name_en ?? '',
      price: normalizedPrice,
      sale_price: normalizedSalePrice,
      is_available: !isOutOfStock,
      stock: Number.isFinite(quantity) ? quantity : 0,
      images: imageUrl ? [imageUrl] : [],
    };
  }

  private mapProductsToSearchCards(products: any[], orderedIds?: number[]): any[] {
    const mapped = products.map((product) => this.mapProductToSearchCard(product));
    if (!orderedIds || orderedIds.length === 0) {
      return mapped;
    }

    const byId = new Map<string, any>(mapped.map((item) => [String(item.id), item]));
    const ordered: any[] = [];
    for (const id of orderedIds) {
      const card = byId.get(String(id));
      if (card) {
        ordered.push(card);
      }
    }
    return ordered;
  }

  private orderProductsByIds(products: any[], orderedIds?: number[]): any[] {
    if (!orderedIds || orderedIds.length === 0) {
      return products;
    }

    const byId = new Map<number, any>(
      products.map((product) => [Number(product.id), product]),
    );
    const ordered: any[] = [];
    for (const id of orderedIds) {
      const product = byId.get(id);
      if (product) {
        ordered.push(product);
      }
    }
    return ordered;
  }

  private mapSearchResults(
    products: any[],
    orderedIds: number[] | undefined,
    fullResponse: boolean,
  ): any[] {
    if (fullResponse) {
      return this.orderProductsByIds(products, orderedIds);
    }

    return this.mapProductsToSearchCards(products, orderedIds);
  }

  private mapSort(sortBy?: string): {
    sortBy: ProductSortBy;
    sortOrder: SortOrder;
  } {
    switch (sortBy) {
      case 'price:asc':
      case 'price_min:asc':
        return { sortBy: ProductSortBy.PRICE, sortOrder: SortOrder.ASC };
      case 'price:desc':
      case 'price_min:desc':
        return { sortBy: ProductSortBy.PRICE, sortOrder: SortOrder.DESC };
      case 'rating:desc':
        return {
          sortBy: ProductSortBy.AVERAGE_RATING,
          sortOrder: SortOrder.DESC,
        };
      case 'created_at:desc':
        return { sortBy: ProductSortBy.CREATED_AT, sortOrder: SortOrder.DESC };
      default:
        return { sortBy: ProductSortBy.CREATED_AT, sortOrder: SortOrder.DESC };
    }
  }

  private isWildcardBrowseQuery(dto: SearchQueryDto): boolean {
    const q = typeof dto.q === 'string' ? dto.q.trim() : '';
    return !q || q === '*';
  }

  private shouldUseRandomBrowseSort(dto: SearchQueryDto, isAdmin = false): boolean {
    if (isAdmin) {
      return false;
    }

    if (!this.isWildcardBrowseQuery(dto)) {
      return false;
    }

    const sortBy = (dto.sort_by ?? (dto as any).sortBy)?.trim();
    if (!sortBy || sortBy === 'popularity_score:desc') {
      return true;
    }

    return false;
  }

  private shuffleArray<T>(items: T[]): T[] {
    const shuffled = [...items];

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [
        shuffled[swapIndex],
        shuffled[index],
      ];
    }

    return shuffled;
  }

  private getTypesenseFacetFields(): string {
    return 'brand_id,vendor_id,category_ids,attributes_values_ids,specifications_values_ids';
  }

  private async fetchTypesenseMatchingProductIds(
    filterBy: string | undefined,
    maxResults: number,
  ): Promise<number[]> {
    const ids: number[] = [];
    let page = 1;

    while (ids.length < maxResults) {
      const remaining = maxResults - ids.length;
      const batchSize = Math.min(this.typesenseIdPageSize, remaining);
      const result = await this.typesenseService.search({
        q: '*',
        query_by: PRODUCT_ID_LOOKUP_QUERY_BY,
        filter_by: filterBy,
        page,
        per_page: batchSize,
        include_fields: 'id',
      });
      const hits = Array.isArray(result.hits) ? result.hits : [];
      if (hits.length === 0) {
        break;
      }

      hits.forEach((hit: any) => {
        const id = Number(hit?.document?.id);
        if (Number.isInteger(id) && id > 0) {
          ids.push(id);
        }
      });

      const totalFound = Number(result.found ?? 0);
      if (hits.length < batchSize || ids.length >= totalFound) {
        break;
      }

      page += 1;
    }

    return [...new Set(ids)];
  }

  private async buildSearchResultsFromProductIds(
    productIds: number[],
    isAdmin: boolean,
    fullResponse: boolean,
    dto?: SearchQueryDto,
  ): Promise<any[]> {
    if (productIds.length === 0) {
      return [];
    }

    const productsResult = await this.productsService.findAll(
      {
        page: 1,
        limit: productIds.length,
        ids: productIds,
        visible: this.resolveAdminVisibleFilter(dto ?? ({} as SearchQueryDto), isAdmin),
      } as any,
      isAdmin,
    );

    return this.mapSearchResults(
      productsResult.data ?? [],
      productIds,
      fullResponse,
    );
  }

  private parseCsvNumbers(value?: unknown): number[] | undefined {
    if (Array.isArray(value)) {
      const parsed = value
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0);
      return parsed.length > 0 ? parsed : undefined;
    }

    if (typeof value !== 'string') {
      return undefined;
    }

    const parsed = value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item > 0);

    return parsed.length > 0 ? parsed : undefined;
  }

  private getLatencyBudgetMs(): number {
    const configured = Number(
      this.configService.get<string>('SEARCH_LATENCY_BUDGET_MS', '350'),
    );
    return Number.isFinite(configured) && configured > 0 ? configured : 350;
  }

  private isProgressiveExpansionEnabled(): boolean {
    const value = this.configService.get<string>('SEARCH_EXPANSION_ENABLED', 'true');
    return value.toLowerCase() === 'true';
  }

  private getMaxExpansionCandidates(): number {
    const configured = Number(
      this.configService.get<string>('SEARCH_EXPANSION_MAX_CANDIDATES', '240'),
    );
    if (!Number.isInteger(configured) || configured <= 0) {
      return 240;
    }
    return Math.min(500, configured);
  }

  private getMinTextMatchRatioForExpansion(): number {
    const configured = Number(
      this.configService.get<string>('SEARCH_EXPANSION_MIN_TEXT_MATCH_RATIO', '0.4'),
    );
    if (!Number.isFinite(configured)) return 0.4;
    return Math.max(0, Math.min(1, configured));
  }

  private getEnabledExpansionLevels(): Set<ExpansionTierKey> {
    const configured = this.configService.get<string>(
      'SEARCH_EXPANSION_LEVELS',
      '',
    );
    if (!configured.trim()) {
      return new Set(this.defaultEnabledExpansionLevels);
    }

    const enabled = configured
      .split(',')
      .map((item) => item.trim() as ExpansionTierKey)
      .filter((item) => this.defaultEnabledExpansionLevels.has(item));

    return new Set(enabled);
  }

  private getMaxConceptVariantCombos(): number {
    const configured = Number(
      this.configService.get<string>(
        'SEARCH_EXPANSION_MAX_CONCEPT_VARIANT_COMBOS',
        '50',
      ),
    );
    if (!Number.isInteger(configured) || configured <= 0) {
      return 50;
    }
    return Math.min(200, configured);
  }

  private getPrimaryEnoughCount(): number {
    const configured = Number(
      this.configService.get<string>('SEARCH_EXPANSION_PRIMARY_ENOUGH_COUNT', '125'),
    );
    if (!Number.isInteger(configured) || configured <= 0) {
      return 125;
    }
    return configured;
  }

  private getExpansionExtraWhenLow(): number {
    const configured = Number(
      this.configService.get<string>('SEARCH_EXPANSION_EXTRA_WHEN_LOW', '100'),
    );
    if (!Number.isInteger(configured) || configured <= 0) {
      return 100;
    }
    return configured;
  }

  private getConceptExpansionMultiSearchBatchSize(): number {
    const configured = Number(
      this.configService.get<string>(
        'SEARCH_EXPANSION_CONCEPT_MULTI_SEARCH_BATCH',
        '25',
      ),
    );
    if (!Number.isInteger(configured) || configured <= 0) {
      return 25;
    }
    return Math.min(50, configured);
  }

  private dedupeConceptExpansionQueries(queries: string[]): string[] {
    const seen = new Set<string>();
    const deduped: string[] = [];

    queries.forEach((query) => {
      const trimmed = query.trim();
      if (!trimmed) {
        return;
      }
      const key = normalizeConceptTermKey(trimmed);
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      deduped.push(trimmed);
    });

    return deduped;
  }

  private async runConceptExpansionQueries(
    queries: string[],
    params: {
      baseFilterBy?: string;
      perQueryLimit: number;
      maxCandidates: number;
      maxHitsPerQuery?: number;
    },
    shouldStop?: () => boolean,
  ): Promise<
    Array<{
      query: string;
      hits: Array<{ id: number; categoryIds: number[] }>;
    }>
  > {
    const batchSize = this.getConceptExpansionMultiSearchBatchSize();
    const results: Array<{
      query: string;
      hits: Array<{ id: number; categoryIds: number[] }>;
    }> = [];
    const uniqueQueries = this.dedupeConceptExpansionQueries(queries);
    const perPage = Math.min(params.perQueryLimit, this.typesenseIdPageSize);
    const maxHitsPerQuery = Math.min(
      params.maxHitsPerQuery ?? this.typesenseIdPageSize,
      params.maxCandidates,
    );

    for (let index = 0; index < uniqueQueries.length; index += batchSize) {
      if (shouldStop?.()) {
        break;
      }

      const chunk = uniqueQueries.slice(index, index + batchSize);
      const queryStates = chunk.map((conceptQuery) => ({
        conceptQuery,
        page: 1,
        hits: [] as Array<{ id: number; categoryIds: number[] }>,
        done: false,
      }));

      while (queryStates.some((entry) => !entry.done)) {
        if (shouldStop?.()) {
          break;
        }

        const pending = queryStates.filter(
          (entry) => !entry.done && entry.hits.length < maxHitsPerQuery,
        );
        if (pending.length === 0) {
          break;
        }

        const multiResult = await this.typesenseService.multiSearch(
          pending.map((entry) =>
            this.buildConceptExpansionSearchParams(entry.conceptQuery, {
              baseFilterBy: params.baseFilterBy,
              perPage,
              typoTokens: this.tokenizeQueryForExpansion(entry.conceptQuery),
              page: entry.page,
            }),
          ),
        );

        pending.forEach((entry, resultIndex) => {
          const searchResult = multiResult.results?.[resultIndex] ?? { hits: [] };
          const mapped = this.mapTypesenseProductHits(searchResult);
          if (mapped.length === 0) {
            entry.done = true;
            return;
          }

          const seen = new Set(entry.hits.map((hit) => hit.id));
          mapped.forEach((hit) => {
            if (!seen.has(hit.id)) {
              seen.add(hit.id);
              entry.hits.push(hit);
            }
          });

          const totalFound = Number((searchResult as { found?: number }).found ?? 0);
          if (
            mapped.length < perPage ||
            entry.hits.length >= totalFound ||
            entry.hits.length >= maxHitsPerQuery
          ) {
            entry.done = true;
            return;
          }

          entry.page += 1;
        });
      }

      queryStates.forEach((entry) => {
        results.push({
          query: entry.conceptQuery,
          hits: entry.hits,
        });
      });
    }

    return results;
  }

  private isSearchDebugEnabledByEnv(): boolean {
    const raw = this.configService.get<string>('SEARCH_DEBUG_ENABLED', 'false');
    if (raw == null) {
      return false;
    }

    const normalized = String(raw)
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();

    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  private formatSearchDebugReport(payload: Record<string, unknown>): string {
    const line = '═'.repeat(62);
    const thin = '─'.repeat(62);
    const lines: string[] = [
      line,
      '  SEARCH DEBUG  (latest request — file is overwritten each time)',
      line,
      '',
      '▶ WHAT YOU SEARCHED',
      `  Query:        "${String(payload.query ?? '')}"`,
      `  Page:         ${payload.page ?? 1}     Results per page: ${payload.limit ?? 20}`,
      `  Engine:       ${payload.provider ?? 'unknown'}`,
    ];

    if (payload.cache_hit) {
      lines.push('  Note:         Returned from cache (no new search run)');
    }
    if (payload.reason) {
      lines.push(`  Note:         ${payload.reason}`);
    }

    lines.push('', '▶ WHAT WE UNDERSTOOD');
    if (payload.normalized_query != null) {
      lines.push(`  Clean query:  "${payload.normalized_query}"`);
    }
    if (Array.isArray(payload.tokens) && payload.tokens.length > 0) {
      lines.push(`  Words:        ${(payload.tokens as string[]).join(' · ')}`);
    }
    if (payload.detected_brand_labels) {
      lines.push(`  Brand:        ${payload.detected_brand_labels}`);
    } else if (payload.detected_brand_ids) {
      lines.push(`  Brand id(s):  ${payload.detected_brand_ids}`);
    }
    if (payload.detected_category_labels) {
      lines.push(`  Category:     ${payload.detected_category_labels}`);
    } else if (payload.detected_category_ids) {
      lines.push(`  Category id(s): ${payload.detected_category_ids}`);
    }
    if (Array.isArray(payload.matched_concepts) && payload.matched_concepts.length > 0) {
      lines.push(
        `  Concepts:     ${(payload.matched_concepts as string[]).join(' · ')}`,
      );
    }
    if (payload.concept_category_ids) {
      lines.push(`  Concept refinement categories: ${payload.concept_category_ids}`);
    }
    if (payload.category_refinement_applied != null) {
      lines.push(
        `  Category refinement: ${payload.category_refinement_applied ? 'applied (mixed types reordered)' : 'not needed'}`,
      );
    }
    if (Array.isArray(payload.expansion_queries) && payload.expansion_queries.length > 0) {
      lines.push('', '▶ CONCEPT EXPANSION QUERIES (sample)');
      (payload.expansion_queries as string[]).forEach((query, index) => {
        lines.push(`  ${index + 1}. ${query}`);
      });
    }
    if (
      Array.isArray(payload.concept_query_debug) &&
      payload.concept_query_debug.length > 0
    ) {
      lines.push('', '▶ CONCEPT QUERY HITS (per synonym, in order)');
      (
        payload.concept_query_debug as Array<{
          query: string;
          added: number;
          categoryFiltered: boolean;
        }>
      ).forEach((entry, index) => {
        const filterNote = entry.categoryFiltered ? ' [user category filter]' : '';
        lines.push(
          `  ${index + 1}. "${entry.query}" → +${entry.added} new${filterNote}`,
        );
      });
    }

    if (
      payload.price_stripped_phrases ||
      payload.price_min != null ||
      payload.price_max != null
    ) {
      lines.push('', '▶ PRICE FROM QUERY');
      if (Array.isArray(payload.price_stripped_phrases) && payload.price_stripped_phrases.length > 0) {
        lines.push(`  Removed text: "${(payload.price_stripped_phrases as string[]).join('" | "')}"`);
      }
      if (payload.price_min != null) {
        lines.push(`  Min price:    ${payload.price_min}`);
      }
      if (payload.price_max != null) {
        lines.push(`  Max price:    ${payload.price_max}`);
      }
      if (!payload.price_min && !payload.price_max) {
        lines.push('  No price filter detected in query');
      }
    }

    lines.push('', thin);
    lines.push('▶ STEP 1 — Primary text search (best matches first)');
    lines.push(`  Found:        ${payload.primary_found ?? '—'} products`);
    lines.push(`  Skip expansion when ≥ ${payload.primary_enough_threshold ?? '—'}`);
    lines.push(
      `  Decision:     ${
        payload.primary_enough === true
          ? payload.expansion_applied
            ? 'Enough matches, but concept layer leads → expansion runs'
            : 'Enough matches → expansion skipped'
          : payload.primary_enough === false
            ? 'Not enough → expansion runs'
            : '—'
      }`,
    );

    if (payload.expansion_applied != null) {
      lines.push('', thin);
      lines.push('▶ STEP 2 — Expansion (adds more products in this order)');
      const tiers = payload.expansion_tier_details as
        | Array<{ tier: string; added: number; total: number; note?: string }>
        | undefined;

      if (tiers && tiers.length > 0) {
        let startingListEmitted = false;
        tiers.forEach((entry) => {
          const label = entry.tier.padEnd(20);
          if (entry.added > 0 && !startingListEmitted) {
            startingListEmitted = true;
            lines.push(
              `  ${label} ${entry.added} products  (starting list)${entry.note ? `  ${entry.note}` : ''}`,
            );
            return;
          }
          if (entry.added > 0) {
            lines.push(
              `  ${label} +${entry.added} → ${entry.total} total${entry.note ? `  ${entry.note}` : ''}`,
            );
            return;
          }
          lines.push(
            `  ${label} skipped${entry.note ? `  (${entry.note})` : ''}`,
          );
        });
      }

      lines.push(
        `  Expansion:    ${payload.expansion_applied ? 'YES' : 'NO'}`,
      );
    }

    lines.push('', thin);
    lines.push('▶ STEP 3 — Final response');
    lines.push(`  Pool size:    ${payload.final_candidates ?? '—'} products`);
    lines.push(`  Total shown:  ${payload.response_total ?? '—'}`);
    lines.push(`  This page:    ${payload.response_count ?? '—'} products`);
    if (payload.search_time_ms != null) {
      lines.push(`  Time:         ${payload.search_time_ms} ms`);
    }
    lines.push(line);

    return `${lines.join('\n')}\n`;
  }

  private async writeSearchDebugLog(payload: Record<string, unknown>): Promise<void> {
    const report = this.formatSearchDebugReport({
      ts: new Date().toISOString(),
      ...payload,
    });

    // One log line per row so Railway/Docker log viewers show the full report.
    this.logger.log('[search-debug] ===== SEARCH DEBUG REPORT START =====');
    report.split('\n').forEach((line) => {
      if (line.length === 0) {
        this.logger.log('[search-debug]');
        return;
      }
      this.logger.log(`[search-debug] ${line}`);
    });
    this.logger.log('[search-debug] ===== SEARCH DEBUG REPORT END =====');

    try {
      const logDir = join(process.cwd(), 'logs');
      await mkdir(logDir, { recursive: true });
      await writeFile(join(logDir, 'search-debug.log'), report, 'utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to write search debug log file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private tokenizeQueryForExpansion(query?: string): string[] {
    const normalized = normalizeSearchQuery(query).toLowerCase();
    if (!normalized) return [];

    return normalized
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private getTypoBudget(tokens: string[]): 0 | 1 | 2 {
    if (this.queryRequiresExactTokenMatch(tokens)) {
      return 0;
    }

    const longest = tokens.reduce((max, token) => Math.max(max, token.length), 0);
    if (longest < SEARCH_TYPO_TOKENS_MIN_LENGTH) return 0;
    if (longest >= 7) return 2;
    return 1;
  }

  /** Spec/model tokens (5060, i7, rtx5070) must not fuzzy-match neighbours like 5050. */
  private queryRequiresExactTokenMatch(tokens: string[]): boolean {
    return tokens.some((token) => {
      const trimmed = token.trim();
      if (!trimmed) return false;
      if (/^\d+$/.test(trimmed)) return true;
      return /^[a-z]{0,3}\d+[a-z0-9]*$/i.test(trimmed);
    });
  }

  private async getCategoryTokensForIds(
    categoryIds: number[],
  ): Promise<Set<string>> {
    if (categoryIds.length === 0) {
      return new Set();
    }

    const lexicon = await this.getCategoryLexicon();
    const tokens = new Set<string>();
    const idSet = new Set(categoryIds);

    lexicon.forEach((entry) => {
      if (!idSet.has(entry.id)) return;
      entry.normalizedTokens.forEach((token) => tokens.add(token));
    });

    return tokens;
  }

  private async getBrandTokensForIds(brandIds: number[]): Promise<Set<string>> {
    if (brandIds.length === 0) {
      return new Set();
    }

    const lexicon = await this.getBrandLexicon();
    const tokens = new Set<string>();
    const idSet = new Set(brandIds);

    lexicon.forEach((entry) => {
      if (!idSet.has(entry.id)) return;
      entry.normalizedTokens.forEach((token) => tokens.add(token));
    });

    return tokens;
  }

  private buildExpansionTierDebugDetails(
    tiers: Record<ExpansionTierKey, number[]>,
    notes: Partial<Record<ExpansionTierKey, string>>,
  ): Array<{ tier: string; added: number; total: number; note?: string }> {
    let runningTotal = 0;

    return this.expansionTierOrder.map((tier) => {
      const added = tiers[tier]?.length ?? 0;
      runningTotal += added;
      return {
        tier,
        added,
        total: runningTotal,
        note: notes[tier],
      };
    });
  }

  private async getBrandLexicon(): Promise<
    Array<{ id: number; normalizedTokens: string[] }>
  > {
    const now = Date.now();
    if (
      this.brandLexiconCache &&
      now - this.brandLexiconCache.loadedAt < this.entityLexiconCacheTtlMs
    ) {
      return this.brandLexiconCache.entries;
    }

    const brands = await this.brandsRepository.find({
      select: { id: true, name_en: true, name_ar: true },
    });
    const entries = brands
      .map((brand) => {
        const tokens = [
          ...this.tokenizeQueryForExpansion(brand.name_en ?? ''),
          ...this.tokenizeQueryForExpansion(brand.name_ar ?? ''),
        ];
        return {
          id: brand.id,
          normalizedTokens: Array.from(new Set(tokens)),
        };
      })
      .filter((entry) => entry.normalizedTokens.length > 0);

    this.brandLexiconCache = { loadedAt: now, entries };
    return entries;
  }

  private async getCategoryLexicon(): Promise<
    Array<{ id: number; normalizedTokens: string[] }>
  > {
    const now = Date.now();
    if (
      this.categoryLexiconCache &&
      now - this.categoryLexiconCache.loadedAt < this.entityLexiconCacheTtlMs
    ) {
      return this.categoryLexiconCache.entries;
    }

    const categories = await this.categoriesRepository.find({
      select: { id: true, name_en: true, name_ar: true },
    });
    const entries = categories
      .map((category) => {
        const tokens = [
          ...this.tokenizeQueryForExpansion(category.name_en ?? ''),
          ...this.tokenizeQueryForExpansion(category.name_ar ?? ''),
        ];
        return {
          id: category.id,
          normalizedTokens: Array.from(new Set(tokens)),
        };
      })
      .filter((entry) => entry.normalizedTokens.length > 0);

    this.categoryLexiconCache = { loadedAt: now, entries };
    return entries;
  }

  static getSearchExpansionVersion(): string {
    return SEARCH_EXPANSION_VERSION;
  }

  private async detectEntityIdsFromTokens(
    tokens: string[],
    normalizedQuery: string,
  ): Promise<{ brandIds: number[]; categoryIds: number[] }> {
    if (tokens.length === 0) {
      return { brandIds: [], categoryIds: [] };
    }

    const tokenSet = new Set(tokens);
    const brandLexicon = await this.getBrandLexicon();

    const normalizedQueryWithSpaces = ` ${normalizedQuery.trim()} `;
    const hasPhraseMatch = (entryTokens: string[]) =>
      entryTokens.some((token) => {
        const normalizedToken = token.trim();
        if (!normalizedToken) return false;
        return normalizedQueryWithSpaces.includes(` ${normalizedToken} `);
      });

    const brandIds = brandLexicon
      .filter(
        (entry) =>
          entry.normalizedTokens.some((token) => tokenSet.has(token)) ||
          hasPhraseMatch(entry.normalizedTokens),
      )
      .map((entry) => entry.id);

    // Query-time category detection is intentionally disabled.
    // Category IDs should come only from explicit request filters.
    return { brandIds, categoryIds: [] };
  }

  private hasUnsupportedTypesenseFilters(dto: SearchQueryDto): boolean {
    return Object.keys(dto).some((key) => {
      if (!this.unsupportedTypesenseFilterKeys.has(key)) {
        return false;
      }

      const value = (dto as any)[key];
      return value !== undefined && value !== null && value !== '';
    });
  }

  private buildFilterDto(dto: SearchQueryDto, isAdmin = false): FilterProductDto {
    const normalizedSortBy = (dto as any).sortBy ?? dto.sort_by;
    const { sortBy, sortOrder } = this.mapSort(normalizedSortBy);
    const categoryIdsFromDto =
      this.parseCsvNumbers((dto as any).category_ids) ??
      this.parseCsvNumbers((dto as any).categories_ids) ??
      dto.category_ids;
    const categoryIds = [
      ...(dto.category_id != null ? [dto.category_id] : []),
      ...(categoryIdsFromDto ?? []),
    ];
    const vendorIds =
      this.parseCsvNumbers((dto as any).vendor_ids) ??
      (dto.vendor_id != null ? [dto.vendor_id] : undefined);
    const brandIds =
      this.parseCsvNumbers((dto as any).brand_ids) ??
      (dto.brand_id != null ? [dto.brand_id] : undefined);
    const filterIds = this.parseCsvNumbers((dto as any).ids);
    const createdBy = this.parseCsvNumbers((dto as any).created_by);
    const attributesIds = this.parseCsvNumbers((dto as any).attributes_ids);
    const attributesValuesIds =
      this.parseCsvNumbers((dto as any).attributes_values_ids);
    const specificationsIds = this.parseCsvNumbers((dto as any).specifications_ids);
    const specificationsValuesIds =
      this.parseCsvNumbers((dto as any).specifications_values_ids);
    const normalizedSearch = (dto as any).search ?? dto.q;
    const minPrice = (dto as any).minPrice ?? dto.min_price;
    const maxPrice = (dto as any).maxPrice ?? dto.max_price;
    const minRating = (dto as any).minRating ?? dto.rating_min ?? (dto as any).average_rating_min;

    const inStock =
      isAdmin && dto.in_stock !== undefined
        ? dto.in_stock
        : isAdmin && (dto as any).is_out_of_stock !== undefined
          ? !(dto as any).is_out_of_stock
          : isAdmin
            ? undefined
            : true;

    return {
      page: dto.page ?? 1,
      limit: (dto as any).limit ?? dto.per_page ?? 20,
      search:
        typeof normalizedSearch === 'string' && normalizedSearch !== '*'
          ? normalizedSearch
          : undefined,
      category_ids: categoryIds.length > 0 ? categoryIds : undefined,
      brand_ids: brandIds,
      vendor_ids: vendorIds,
      minPrice,
      maxPrice,
      in_stock: inStock,
      minRating,
      sortBy,
      sortOrder,
      randomBrowse: this.shouldUseRandomBrowseSort(dto, isAdmin),
      visible: this.resolveAdminVisibleFilter(dto, isAdmin),
      status: Array.isArray((dto as any).status)
        ? (dto as any).status[0]
        : (dto as any).status,
      ids: filterIds,
      sku: (dto as any).sku,
      has_no_vendor: (dto as any).has_no_vendor,
      has_no_brand: (dto as any).has_no_brand,
      has_duplicate_reference_link: (dto as any).has_duplicate_reference_link,
      created_by: createdBy,
      attributes_ids: attributesIds,
      attributes_values_ids: attributesValuesIds,
      specifications_ids: specificationsIds,
      specifications_values_ids: specificationsValuesIds,
      start_date: (dto as any).start_date,
      end_date: (dto as any).end_date,
    };
  }

  private extractCategoryIds(dto: SearchQueryDto): number[] {
    const categoryIdsFromDto =
      this.parseCsvNumbers((dto as any).category_ids) ??
      this.parseCsvNumbers((dto as any).categories_ids) ??
      dto.category_ids;

    return [
      ...new Set(
        [
          ...(dto.category_id != null ? [dto.category_id] : []),
          ...(categoryIdsFromDto ?? []),
        ].filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
  }

  private categoryChildrenCache:
    | { loadedAt: number; childrenByParent: Map<number, number[]> }
    | null = null;

  private readonly categoryChildrenCacheTtlMs = 5 * 60 * 1000;

  private async getCategoryChildrenByParent(): Promise<Map<number, number[]>> {
    const now = Date.now();
    if (
      this.categoryChildrenCache &&
      now - this.categoryChildrenCache.loadedAt < this.categoryChildrenCacheTtlMs
    ) {
      return this.categoryChildrenCache.childrenByParent;
    }

    const allCategories = await this.categoriesRepository.find({
      select: { id: true, parent_id: true },
    });

    const childrenByParent = new Map<number, number[]>();
    for (const category of allCategories) {
      const parentId = category.parent_id ?? 0;
      const siblings = childrenByParent.get(parentId) ?? [];
      siblings.push(category.id);
      childrenByParent.set(parentId, siblings);
    }

    this.categoryChildrenCache = { loadedAt: now, childrenByParent };
    return childrenByParent;
  }

  private async expandCategoryIdsWithDescendants(
    categoryIds: number[],
  ): Promise<number[]> {
    const normalizedIds = [
      ...new Set(
        categoryIds.filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];

    if (normalizedIds.length === 0) {
      return [];
    }

    const childrenByParent = await this.getCategoryChildrenByParent();
    const expanded = new Set<number>(normalizedIds);
    const queue = [...normalizedIds];

    while (queue.length > 0) {
      const categoryId = queue.shift()!;
      const children = childrenByParent.get(categoryId) ?? [];

      for (const childId of children) {
        if (!expanded.has(childId)) {
          expanded.add(childId);
          queue.push(childId);
        }
      }
    }

    return Array.from(expanded);
  }

  private async prepareSearchQuery(dto: SearchQueryDto): Promise<SearchQueryDto> {
    let next: SearchQueryDto = { ...dto };
    const originalQuery = dto.q;

    if (next.q && next.q !== '*') {
      const priceParse = parsePriceFromQuery(next.q, {
        minPrice: next.min_price,
        maxPrice: next.max_price,
      });
      const normalizedQuery = normalizeSearchQuery(priceParse.cleanedQuery);
      const tokens = this.tokenizeQueryForExpansion(normalizedQuery);

      this.lastQueryPreparationDebug = {
        originalQuery,
        normalizedQuery,
        tokens,
        priceParse,
      };

      next = {
        ...next,
        q: priceParse.cleanedQuery,
        ...(priceParse.minPrice !== undefined ? { min_price: priceParse.minPrice } : {}),
        ...(priceParse.maxPrice !== undefined ? { max_price: priceParse.maxPrice } : {}),
      };
    } else {
      this.lastQueryPreparationDebug = {
        originalQuery,
        normalizedQuery: next.q,
        tokens: [],
      };
    }

    const categoryIds = this.extractCategoryIds(next);

    if (categoryIds.length === 0) {
      return next;
    }

    const expandedCategoryIds =
      await this.expandCategoryIdsWithDescendants(categoryIds);

    return {
      ...next,
      category_id: undefined,
      category_ids: expandedCategoryIds,
    };
  }

  /**
   * Resolves the effective `visible` filter: customers always get visible-only
   * results, while admins default to visible-only too but can explicitly
   * request hidden products via `?visible=false`.
   */
  private resolveAdminVisibleFilter(dto: SearchQueryDto, isAdmin: boolean): boolean {
    if (!isAdmin) return true;
    const visibleOverride = (dto as any).visible as boolean | undefined;
    return visibleOverride !== undefined ? visibleOverride : true;
  }

  private buildTypesenseFilterBy(dto: SearchQueryDto, isAdmin = false): string | undefined {
    const filters: string[] = [];

    const brandIds =
      this.parseCsvNumbers((dto as any).brand_ids) ??
      (dto.brand_id != null ? [dto.brand_id] : undefined);
    if (brandIds && brandIds.length > 0) {
      filters.push(`brand_id:=[${brandIds.join(',')}]`);
    }

    const vendorIds =
      this.parseCsvNumbers((dto as any).vendor_ids) ??
      (dto.vendor_id != null ? [dto.vendor_id] : undefined);
    if (vendorIds && vendorIds.length > 0) {
      filters.push(`vendor_id:=[${vendorIds.join(',')}]`);
    }

    const categoryIds = this.extractCategoryIds(dto);
    if (categoryIds.length > 0) {
      filters.push(`category_ids:=[${categoryIds.join(',')}]`);
    }

    const attributeValueIds = this.parseCsvNumbers(
      (dto as any).attributes_values_ids,
    );
    if (attributeValueIds && attributeValueIds.length > 0) {
      filters.push(`attributes_values_ids:=[${attributeValueIds.join(',')}]`);
    }

    const specificationValueIds = this.parseCsvNumbers(
      (dto as any).specifications_values_ids,
    );
    if (specificationValueIds && specificationValueIds.length > 0) {
      filters.push(
        `specifications_values_ids:=[${specificationValueIds.join(',')}]`,
      );
    }

    const inStock =
      isAdmin && dto.in_stock !== undefined
        ? dto.in_stock
        : isAdmin && dto.is_out_of_stock !== undefined
          ? !dto.is_out_of_stock
          : undefined;

    if (inStock !== undefined) {
      filters.push(`is_out_of_stock:=${!inStock}`);
    }

    if (dto.min_price !== undefined) {
      filters.push(`effective_price:>=${dto.min_price}`);
    }

    if (dto.max_price !== undefined) {
      filters.push(`effective_price:<=${dto.max_price}`);
    }

    if (dto.rating_min !== undefined) {
      filters.push(`average_rating:>=${dto.rating_min}`);
    }

    if (!isAdmin) {
      filters.push('visible:=true');
      filters.push(`status:=[${SEARCHABLE_STATUSES.join(',')}]`);
      filters.push('is_out_of_stock:=false');
    } else {
      // Admin defaults mirror the storefront's default catalog (active/updated/review,
      // visible only), but can be overridden via explicit `status`/`visible` params.
      const statusOverride = (dto as any).status as string[] | undefined;
      filters.push(
        `status:=[${(statusOverride && statusOverride.length > 0 ? statusOverride : SEARCHABLE_STATUSES).join(',')}]`,
      );

      filters.push(`visible:=${this.resolveAdminVisibleFilter(dto, isAdmin)}`);
    }

    return filters.length > 0 ? filters.join(' && ') : undefined;
  }

  private buildTypesenseSortBy(
    sortBy?: string,
    isAdmin = false,
    q?: string,
  ): string {
    const normalizedQuery = typeof q === 'string' ? q.trim() : '';
    const hasTextQuery =
      normalizedQuery.length > 0 && normalizedQuery !== '*';

    if (hasTextQuery && !sortBy) {
      return '_text_match:desc,created_at_ts:desc';
    }

    switch (sortBy) {
      case 'price:asc':
      case 'price_min:asc':
        return 'effective_price:asc';
      case 'price:desc':
      case 'price_min:desc':
        return 'effective_price:desc';
      case 'rating:desc':
        return 'average_rating:desc';
      case 'created_at:desc':
        return 'created_at_ts:desc';
      default:
        return isAdmin ? 'created_at_ts:desc' : '_text_match:desc,created_at_ts:desc';
    }
  }

  private mapTypesenseFacetCounts(facetCounts: unknown): Array<{
    field_name: string;
    counts: Array<{ value: string; count: number; label?: string }>;
  }> {
    if (!Array.isArray(facetCounts)) {
      return [];
    }

    const fieldNameMap: Record<string, string> = {
      brand_id: 'brand_ids',
      vendor_id: 'vendor_ids',
      category_ids: 'categories_ids',
      attributes_values_ids: 'attributes_values_ids',
      specifications_values_ids: 'specifications_values_ids',
    };

    return facetCounts
      .map((facet: any) => ({
        field_name: fieldNameMap[facet?.field_name] ?? facet?.field_name ?? '',
        counts: Array.isArray(facet?.counts)
          ? facet.counts
              .map((count: any) => ({
                value: String(count?.value ?? ''),
                count: Number(count?.count ?? 0),
              }))
              .filter(
                (count: { value: string; count: number }) =>
                  count.value.length > 0 && count.count > 0,
              )
          : [],
      }))
      .filter((facet) => facet.field_name && facet.counts.length > 0);
  }

  private resolveFacetLocaleLabel(
    locale: string | undefined,
    nameEn?: string | null,
    nameAr?: string | null,
    fallback = '',
  ): string {
    const english = typeof nameEn === 'string' ? nameEn.trim() : '';
    const arabic = typeof nameAr === 'string' ? nameAr.trim() : '';

    if (locale === 'ar') {
      return arabic || english || fallback;
    }

    return english || arabic || fallback;
  }

  private collectFacetValueIds(
    facets: Array<{ field_name: string; counts: Array<{ value: string }> }>,
    fieldNames: string[],
  ): number[] {
    const ids = new Set<number>();

    facets.forEach((facet) => {
      if (!fieldNames.includes(facet.field_name)) {
        return;
      }

      facet.counts.forEach((count) => {
        const id = Number(count.value);
        if (Number.isInteger(id) && id > 0) {
          ids.add(id);
        }
      });
    });

    return Array.from(ids);
  }

  private async enrichSearchFacets(
    facets: Array<{
      field_name: string;
      counts: Array<{
        value: string;
        count: number;
        label?: string;
        slug?: string;
        group_key?: string;
        group_label?: string;
      }>;
    }>,
    dto: SearchQueryDto,
  ): Promise<
    Array<{
      field_name: string;
      counts: Array<{
        value: string;
        count: number;
        label?: string;
        slug?: string;
        group_key?: string;
        group_label?: string;
      }>;
    }>
  > {
    const brandFieldNames = ['brand_ids', 'brand_id'];
    const vendorFieldNames = ['vendor_ids', 'vendor_id'];
    const categoryFieldNames = ['categories_ids', 'category_ids', 'category_id'];
    const attributeFieldNames = ['attributes_values_ids'];
    const specificationFieldNames = ['specifications_values_ids'];

    const brandIds = new Set<number>([
      ...this.collectFacetValueIds(facets, brandFieldNames),
      ...(this.parseCsvNumbers((dto as any).brand_ids) ?? []),
      ...(dto.brand_id != null ? [dto.brand_id] : []),
    ]);
    const vendorIds = new Set<number>([
      ...this.collectFacetValueIds(facets, vendorFieldNames),
      ...(this.parseCsvNumbers((dto as any).vendor_ids) ?? []),
      ...(dto.vendor_id != null ? [dto.vendor_id] : []),
    ]);
    const categoryIds = new Set<number>([
      ...this.collectFacetValueIds(facets, categoryFieldNames),
      ...this.extractCategoryIds(dto),
    ]);
    const attributeValueIds = new Set<number>([
      ...this.collectFacetValueIds(facets, attributeFieldNames),
      ...(this.parseCsvNumbers((dto as any).attributes_values_ids) ?? []),
    ]);
    const specificationValueIds = new Set<number>([
      ...this.collectFacetValueIds(facets, specificationFieldNames),
      ...(this.parseCsvNumbers((dto as any).specifications_values_ids) ?? []),
    ]);

    const [brands, vendors, categories, attributeValues, specificationValues] =
      await Promise.all([
        brandIds.size > 0
          ? this.brandsRepository.find({
              where: { id: In(Array.from(brandIds)) },
              select: { id: true, name_en: true, name_ar: true, slug: true },
            })
          : Promise.resolve([]),
        vendorIds.size > 0
          ? this.vendorsRepository.find({
              where: { id: In(Array.from(vendorIds)) },
              select: { id: true, name_en: true, name_ar: true, slug: true },
            })
          : Promise.resolve([]),
        categoryIds.size > 0
          ? this.categoriesRepository.find({
              where: { id: In(Array.from(categoryIds)) },
              select: { id: true, name_en: true, name_ar: true, slug: true },
            })
          : Promise.resolve([]),
        attributeValueIds.size > 0
          ? this.attributeValuesRepository.find({
              where: { id: In(Array.from(attributeValueIds)) },
              relations: { attribute: true },
            })
          : Promise.resolve([]),
        specificationValueIds.size > 0
          ? this.specificationValuesRepository.find({
              where: { id: In(Array.from(specificationValueIds)) },
              relations: { specification: true },
            })
          : Promise.resolve([]),
      ]);

    type EntityMeta = {
      label: string;
      slug?: string;
      group_key?: string;
      group_label?: string;
    };

    const brandMeta = new Map<string, EntityMeta>(
      brands.map((brand) => [
        String(brand.id),
        {
          label: this.resolveFacetLocaleLabel(
            dto.locale,
            brand.name_en,
            brand.name_ar,
            String(brand.id),
          ),
          slug: brand.slug ?? undefined,
        },
      ]),
    );
    const vendorMeta = new Map<string, EntityMeta>(
      vendors.map((vendor) => [
        String(vendor.id),
        {
          label: this.resolveFacetLocaleLabel(
            dto.locale,
            vendor.name_en,
            vendor.name_ar,
            String(vendor.id),
          ),
          slug: vendor.slug ?? undefined,
        },
      ]),
    );
    const categoryMeta = new Map<string, EntityMeta>(
      categories.map((category) => [
        String(category.id),
        {
          label: this.resolveFacetLocaleLabel(
            dto.locale,
            category.name_en,
            category.name_ar,
            String(category.id),
          ),
          slug: category.slug ?? undefined,
        },
      ]),
    );
    const attributeMeta = new Map<string, EntityMeta>(
      attributeValues.map((attributeValue) => [
        String(attributeValue.id),
        {
          label: this.resolveFacetLocaleLabel(
            dto.locale,
            attributeValue.value_en,
            attributeValue.value_ar,
            String(attributeValue.id),
          ),
          group_key: attributeValue.attribute
            ? String(attributeValue.attribute.id)
            : undefined,
          group_label: attributeValue.attribute
            ? this.resolveFacetLocaleLabel(
                dto.locale,
                attributeValue.attribute.name_en,
                attributeValue.attribute.name_ar,
                String(attributeValue.attribute.id),
              )
            : undefined,
        },
      ]),
    );
    const specificationMeta = new Map<string, EntityMeta>(
      specificationValues.map((specificationValue) => [
        String(specificationValue.id),
        {
          label: this.resolveFacetLocaleLabel(
            dto.locale,
            specificationValue.value_en,
            specificationValue.value_ar,
            String(specificationValue.id),
          ),
          group_key: specificationValue.specification
            ? String(specificationValue.specification.id)
            : undefined,
          group_label: specificationValue.specification
            ? this.resolveFacetLocaleLabel(
                dto.locale,
                specificationValue.specification.name_en,
                specificationValue.specification.name_ar,
                String(specificationValue.specification.id),
              )
            : undefined,
        },
      ]),
    );

    const resolveMeta = (
      fieldName: string,
      value: string,
    ): EntityMeta | undefined => {
      if (brandFieldNames.includes(fieldName)) {
        return brandMeta.get(value);
      }

      if (vendorFieldNames.includes(fieldName)) {
        return vendorMeta.get(value);
      }

      if (categoryFieldNames.includes(fieldName)) {
        return categoryMeta.get(value);
      }

      if (attributeFieldNames.includes(fieldName)) {
        return attributeMeta.get(value);
      }

      if (specificationFieldNames.includes(fieldName)) {
        return specificationMeta.get(value);
      }

      return undefined;
    };

    const enrichedFacets = facets.map((facet) => ({
      ...facet,
      counts: facet.counts.map((count) => {
        const meta = resolveMeta(facet.field_name, count.value);
        return meta
          ? {
              ...count,
              label: meta.label,
              ...(meta.slug ? { slug: meta.slug } : {}),
              ...(meta.group_key ? { group_key: meta.group_key } : {}),
              ...(meta.group_label ? { group_label: meta.group_label } : {}),
            }
          : count;
      }),
    }));

    const injectSelected = (
      fieldNames: string[],
      selectedIds: number[],
    ) => {
      if (selectedIds.length === 0) return;

      let facet = enrichedFacets.find((entry) =>
        fieldNames.includes(entry.field_name),
      );

      if (!facet) {
        facet = { field_name: fieldNames[0], counts: [] };
        enrichedFacets.push(facet);
      }

      const existingValues = new Set(facet.counts.map((count) => count.value));

      selectedIds.forEach((rawId) => {
        const value = String(rawId);
        if (existingValues.has(value)) return;

        const meta = resolveMeta(facet!.field_name, value);
        if (!meta?.label) return;

        facet!.counts.push({
          value,
          count: 0,
          label: meta.label,
          ...(meta.slug ? { slug: meta.slug } : {}),
          ...(meta.group_key ? { group_key: meta.group_key } : {}),
          ...(meta.group_label ? { group_label: meta.group_label } : {}),
        });
        existingValues.add(value);
      });
    };

    injectSelected(brandFieldNames, Array.from(brandIds));
    injectSelected(vendorFieldNames, Array.from(vendorIds));
    injectSelected(categoryFieldNames, Array.from(categoryIds));
    injectSelected(attributeFieldNames, Array.from(attributeValueIds));
    injectSelected(specificationFieldNames, Array.from(specificationValueIds));

    return enrichedFacets;
  }

  private async buildSearchCardsFromTypesenseIds(
    productIds: number[],
    isAdmin: boolean,
  ): Promise<any[]> {
    if (productIds.length === 0) {
      return [];
    }

    const filterBy = `id:=[${productIds.join(',')}]${
      isAdmin ? '' : ' && is_out_of_stock:=false'
    }`;

    const [result, imageUrlsByProductId] = await Promise.all([
      this.typesenseService.search({
        q: '*',
        query_by: PRODUCT_CARD_QUERY_BY,
        filter_by: filterBy,
        per_page: productIds.length,
        page: 1,
      }),
      this.productsService.findPrimaryImageUrlsByProductIds(productIds),
    ]);

    const hits = Array.isArray(result.hits) ? result.hits : [];
    const cardsById = new Map<string, any>();

    hits.forEach((hit: any) => {
      const productId = Number(hit?.document?.id);
      if (!Number.isInteger(productId) || productId <= 0 || !hit?.document) {
        return;
      }

      cardsById.set(
        String(productId),
        this.mapTypesenseDocumentToSearchCard(
          hit.document,
          imageUrlsByProductId.get(productId),
        ),
      );
    });

    return productIds
      .map((id) => cardsById.get(String(id)))
      .filter((card): card is NonNullable<typeof card> => Boolean(card));
  }

  private async searchWithTypesenseRandomBrowse(
    dto: SearchQueryDto,
    isAdmin: boolean,
    fullResponse: boolean,
  ): Promise<any> {
    const filterBy = this.buildTypesenseFilterBy(dto, isAdmin);
    const filterDto = this.buildFilterDto(dto, isAdmin);
    const perPage = filterDto.limit ?? 20;
    const page = filterDto.page ?? 1;
    const facetFields = this.getTypesenseFacetFields();

    const [facetResult, idsResult] = await Promise.all([
      this.typesenseService.search({
        q: '*',
        query_by: PRODUCT_QUERY_BY,
        query_by_weights: PRODUCT_QUERY_BY_WEIGHTS,
        text_match_type: 'max_weight',
        prioritize_token_position: true,
        filter_by: filterBy,
        facet_by: facetFields,
        max_facet_values: 100,
        page: 1,
        per_page: 1,
      }),
      this.productsService.findAll(
        { ...filterDto, skipCount: true, idsOnly: true },
        isAdmin,
      ),
    ]);

    const totalFound = Number(facetResult.found ?? 0);
    const productIds = (idsResult.data ?? [])
      .map((item: any) => Number(item.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    const [products, facets] = await Promise.all([
      fullResponse
        ? this.buildSearchResultsFromProductIds(productIds, isAdmin, true, dto)
        : this.buildSearchCardsFromTypesenseIds(productIds, isAdmin),
      this.enrichSearchFacets(
        this.mapTypesenseFacetCounts(facetResult.facet_counts),
        dto,
      ),
    ]);

    return {
      data: products,
      meta: {
        total: totalFound,
        page,
        limit: perPage,
        totalPages: totalFound > 0 ? Math.ceil(totalFound / perPage) : 1,
      },
      facets,
      search_time_ms: facetResult.search_time_ms,
    };
  }

  private async searchTypesenseIds(params: {
    q: string;
    filterBy?: string;
    sortBy?: string;
    limit: number;
  }): Promise<number[]> {
    const hits = await this.searchTypesenseProductHits(params);
    return hits.map((hit) => hit.id);
  }

  private buildConceptExpansionSearchParams(
    conceptQuery: string,
    params: {
      baseFilterBy?: string;
      perPage: number;
      typoTokens: string[];
      page?: number;
    },
  ): SearchParams<Record<string, any>> {
    // Bucket queries are intentional spec layers — disable typos so 5060 does not match 5050.
    return {
      q: normalizeSearchQuery(conceptQuery || '*') || '*',
      query_by: PRODUCT_QUERY_BY,
      query_by_weights: PRODUCT_QUERY_BY_WEIGHTS,
      text_match_type: 'max_weight',
      prioritize_token_position: true,
      drop_tokens_threshold: 0,
      ...(params.baseFilterBy ? { filter_by: params.baseFilterBy } : {}),
      sort_by: '_text_match:desc,created_at_ts:desc',
      include_fields: 'id,category_ids',
      page: params.page ?? 1,
      per_page: params.perPage,
      num_typos: 0,
    };
  }

  /** Categories shared by anchor-concept reference products (e.g. Laptops for "laptop"). */
  private async resolveConceptAnchorCategoryIds(
    segments: QueryVariantSegment[],
  ): Promise<number[]> {
    const anchorSegment = segments[0];
    const referenceIds = anchorSegment?.referenceProductIds ?? [];
    if (referenceIds.length > 0) {
      const products = await this.productsRepository.find({
        where: { id: In(referenceIds.slice(0, 50)) },
        relations: { productCategories: true },
        select: {
          id: true,
          category_id: true,
          productCategories: {
            id: true,
            category_id: true,
          },
        },
      });
      if (products.length > 0) {
        const categoryIdSets = products.map((product) => {
          const ids = new Set<number>();
          if (product.category_id != null && product.category_id > 0) {
            ids.add(product.category_id);
          }
          (product.productCategories ?? []).forEach((entry) => {
            if (entry.category_id > 0) {
              ids.add(entry.category_id);
            }
          });
          return ids;
        });

        const [firstSet, ...restSets] = categoryIdSets;
        const intersection = [...firstSet].filter((categoryId) =>
          restSets.every((set) => set.has(categoryId)),
        );
        if (intersection.length > 0) {
          return intersection;
        }

        const union = new Set<number>();
        categoryIdSets.forEach((set) => set.forEach((id) => union.add(id)));
        return [...union];
      }
    }

    if (!anchorSegment) {
      return [];
    }

    const anchorTokens = new Set(
      anchorSegment.orderedVariants
        .map((variant) => normalizeConceptTermKey(variant))
        .filter(Boolean),
    );
    if (anchorTokens.size === 0) {
      return [];
    }

    const categoryLexicon = await this.getCategoryLexicon();
    return categoryLexicon
      .filter((entry) =>
        entry.normalizedTokens.some((token) =>
          [...anchorTokens].some(
            (anchor) =>
              token === anchor ||
              token.startsWith(anchor) ||
              anchor.startsWith(token),
          ),
        ),
      )
      .map((entry) => entry.id);
  }

  private mapTypesenseProductHits(result: {
    hits?: Array<{ document?: Record<string, any> }>;
  }): Array<{ id: number; categoryIds: number[] }> {
    const hits = Array.isArray(result.hits) ? result.hits : [];
    return hits
      .map((hit: any) => {
        const id = Number(hit?.document?.id);
        if (!Number.isInteger(id) || id <= 0) {
          return null;
        }

        const rawCategoryIds = hit?.document?.category_ids;
        const categoryIds = Array.isArray(rawCategoryIds)
          ? rawCategoryIds
              .map((value) => Number(value))
              .filter((value) => Number.isInteger(value) && value > 0)
          : [];

        return { id, categoryIds };
      })
      .filter((hit): hit is { id: number; categoryIds: number[] } => hit != null);
  }

  private async searchTypesenseProductHits(params: {
    q: string;
    filterBy?: string;
    sortBy?: string;
    limit: number;
  }): Promise<Array<{ id: number; categoryIds: number[] }>> {
    const result = await this.typesenseService.search({
      q: normalizeSearchQuery(params.q || '*') || '*',
      query_by: PRODUCT_QUERY_BY,
      query_by_weights: PRODUCT_QUERY_BY_WEIGHTS,
      text_match_type: 'max_weight',
      prioritize_token_position: true,
      ...(params.filterBy ? { filter_by: params.filterBy } : {}),
      sort_by: params.sortBy ?? '_text_match:desc,created_at_ts:desc',
      include_fields: 'id,category_ids',
      page: 1,
      per_page: params.limit,
      num_typos: this.getTypoBudget(this.tokenizeQueryForExpansion(params.q)),
    } as SearchParams<Record<string, any>>);

    return this.mapTypesenseProductHits(result);
  }

  private mergeFilterByClauses(...clauses: Array<string | undefined>): string | undefined {
    const items = clauses
      .map((item) => item?.trim())
      .filter((item): item is string => Boolean(item));
    if (items.length === 0) return undefined;
    return items.join(' && ');
  }

  private async resolveDebugEntityLabels(
    brandIds?: number[],
    categoryIds?: number[],
  ): Promise<{ brands?: string; categories?: string }> {
    const [brands, categories] = await Promise.all([
      brandIds && brandIds.length > 0
        ? this.brandsRepository.find({
            where: { id: In(brandIds) },
            select: { id: true, name_en: true, name_ar: true },
          })
        : Promise.resolve([]),
      categoryIds && categoryIds.length > 0
        ? this.categoriesRepository.find({
            where: { id: In(categoryIds) },
            select: { id: true, name_en: true, name_ar: true },
          })
        : Promise.resolve([]),
    ]);

    return {
      brands:
        brands.length > 0
          ? brands
              .map((brand) => `${brand.name_en || brand.name_ar} (id ${brand.id})`)
              .join(', ')
          : undefined,
      categories:
        categories.length > 0
          ? categories
              .map(
                (category) =>
                  `${category.name_en || category.name_ar} (id ${category.id})`,
              )
              .join(', ')
          : undefined,
    };
  }

  private async collectExpandedTypesenseIds(params: {
    dto: SearchQueryDto;
    isAdmin: boolean;
    baseFilterBy?: string;
    primaryIds: number[];
    requestedLimit: number;
    debug: boolean;
  }): Promise<{
    idsByTier: Record<ExpansionTierKey, number[]>;
    orderedIds: number[];
    primaryFoundCount: number;
    detectedBrandIds: number[];
    detectedCategoryIds: number[];
    tierNotes: Partial<Record<ExpansionTierKey, string>>;
    segments: QueryVariantSegment[];
    expansionQueries: string[];
    conceptQueryDebug?: Array<{
      query: string;
      added: number;
      categoryFiltered: boolean;
    }>;
  }> {
    const maxCandidates = Math.max(
      params.requestedLimit,
      this.getMaxExpansionCandidates(),
    );
    const enabledLevels = this.getEnabledExpansionLevels();
    const normalizedQ = normalizeSearchQuery(params.dto.q);
    const tokens = this.tokenizeQueryForExpansion(normalizedQ);
    const idsByTier: Record<ExpansionTierKey, number[]> = {
      primary: [],
      same_brand_spec: [],
      category_brand: [],
      cross_brand_spec: [],
      category: [],
      brand: [],
      specification: [],
      keyword: [],
    };
    const tierNotes: Partial<Record<ExpansionTierKey, string>> = {};
    const uniqueIds = new Set<number>();
    const layeredOrderedIds: number[] = [];
    const conceptQueryDebug: Array<{
      query: string;
      added: number;
      categoryFiltered: boolean;
    }> = [];
    const primaryFoundCount = params.primaryIds.length;
    const addIds = (tier: ExpansionTierKey, ids: number[]) => {
      ids.forEach((id) => {
        if (uniqueIds.size >= maxCandidates || uniqueIds.has(id)) return;
        uniqueIds.add(id);
        idsByTier[tier].push(id);
      });
    };
    const addBucketIds = (tier: ExpansionTierKey, ids: number[]) => {
      ids.forEach((id) => {
        if (uniqueIds.size >= maxCandidates || uniqueIds.has(id)) return;
        uniqueIds.add(id);
        idsByTier[tier].push(id);
        layeredOrderedIds.push(id);
      });
    };

    const detected = await this.detectEntityIdsFromTokens(tokens, normalizedQ);
    const categoryIdsFromFilters = this.extractCategoryIds(params.dto);
    const brandIdsFromFilters =
      this.parseCsvNumbers((params.dto as any).brand_ids) ??
      (params.dto.brand_id != null ? [params.dto.brand_id] : []);
    const effectiveCategoryIds = Array.from(new Set(categoryIdsFromFilters));
    const effectiveBrandIds = Array.from(
      new Set([...detected.brandIds, ...brandIdsFromFilters]),
    );
    const brandIdsFromQueryOnly = detected.brandIds;
    const hasBrandInQuery = brandIdsFromQueryOnly.length > 0;
    const brandTokensFromQuery = hasBrandInQuery
      ? await this.getBrandTokensForIds(brandIdsFromQueryOnly)
      : new Set<string>();
    const searchLocale = normalizeSearchLocale(params.dto.locale, tokens);
    const expansionTokens = hasBrandInQuery
      ? tokens.filter((token) => !brandTokensFromQuery.has(token))
      : tokens;
    const segmented = await this.termConceptLexicon.segmentQueryWithVariants(
      normalizedQ,
      expansionTokens,
      searchLocale,
    );
    const conceptCategoryIds =
      effectiveCategoryIds.length === 0
        ? await this.resolveConceptAnchorCategoryIds(segmented.segments)
        : [];
    const bucketCategoryIds =
      effectiveCategoryIds.length > 0 ? effectiveCategoryIds : conceptCategoryIds;
    const runBucketQueries = async (
      queries: string[],
      tier: ExpansionTierKey,
      baseFilterBy?: string,
    ) => {
      if (!enabledLevels.has(tier) || queries.length === 0) {
        return;
      }

      const batchResults = await this.runConceptExpansionQueries(
        queries,
        {
          baseFilterBy,
          perQueryLimit: this.typesenseIdPageSize,
          maxCandidates,
          maxHitsPerQuery: maxCandidates,
        },
        () => uniqueIds.size >= maxCandidates,
      );

      for (const { query, hits } of batchResults) {
        const beforeSize = uniqueIds.size;
        addBucketIds(
          tier,
          hits.map((hit) => hit.id),
        );
        if (params.debug) {
          conceptQueryDebug.push({
            query,
            added: uniqueIds.size - beforeSize,
            categoryFiltered: bucketCategoryIds.length > 0,
          });
        }
      }
    };
    const variantLevels = buildVariantLevelQueries(
      segmented.segments.map((segment) => ({
        text: segment.text,
        orderedVariants: segment.orderedVariants,
      })),
      this.getMaxConceptVariantCombos(),
    );
    const levelQueries = variantLevels.map((level) => level.queries);
    const expansionQueries = levelQueries.flat();
    const hasExpansionQueries = expansionQueries.length > 0;
    const referenceProductIds = segmented.allSegmentsMatchedByTerms
      ? [
          ...new Set(
            segmented.segments.flatMap((segment) => segment.referenceProductIds),
          ),
        ]
      : [];
    if (referenceProductIds.length > 0) {
      const beforeSize = uniqueIds.size;
      addIds('specification', referenceProductIds);
      if (params.debug) {
        conceptQueryDebug.push({
          query: '[reference_product_ids]',
          added: uniqueIds.size - beforeSize,
          categoryFiltered: categoryIdsFromFilters.length > 0,
        });
      }
      if (idsByTier.specification.length > 0) {
        tierNotes.specification = 'reference products from matched terms';
      }
    }

    if (hasBrandInQuery && uniqueIds.size < maxCandidates && hasExpansionQueries) {
      const sameBrandFilters = [params.baseFilterBy];
      if (bucketCategoryIds.length > 0) {
        sameBrandFilters.push(
          `category_ids:=[${bucketCategoryIds.join(',')}]`,
        );
      }
      sameBrandFilters.push(
        `brand_id:=[${brandIdsFromQueryOnly.join(',')}]`,
      );

      const crossBrandFilters = [params.baseFilterBy];
      if (bucketCategoryIds.length > 0) {
        crossBrandFilters.push(
          `category_ids:=[${bucketCategoryIds.join(',')}]`,
        );
      }
      crossBrandFilters.push(
        `brand_id:!=[${brandIdsFromQueryOnly.join(',')}]`,
      );

      // Per level: requested brand first, then all other brands (complete each bucket).
      for (const queries of levelQueries) {
        if (uniqueIds.size >= maxCandidates) {
          break;
        }
        await runBucketQueries(
          queries,
          'same_brand_spec',
          this.mergeFilterByClauses(...sameBrandFilters),
        );
        if (uniqueIds.size >= maxCandidates) {
          break;
        }
        await runBucketQueries(
          queries,
          'cross_brand_spec',
          this.mergeFilterByClauses(...crossBrandFilters),
        );
      }

      if (idsByTier.same_brand_spec.length > 0) {
        tierNotes.same_brand_spec =
          'requested brand + progressive word/term variants (per level)';
      }
      if (idsByTier.cross_brand_spec.length > 0) {
        tierNotes.cross_brand_spec =
          'progressive word/term variants, other brands (per level)';
      }
    }

    if (!hasBrandInQuery && enabledLevels.has('specification') && hasExpansionQueries) {
      for (const queries of levelQueries) {
        if (uniqueIds.size >= maxCandidates) break;
        const batchResults = await this.runConceptExpansionQueries(
          queries,
          {
            baseFilterBy: params.baseFilterBy,
            perQueryLimit: this.typesenseIdPageSize,
            maxCandidates,
            maxHitsPerQuery: maxCandidates,
          },
          () => uniqueIds.size >= maxCandidates,
        );
        for (const { query, hits } of batchResults) {
          const beforeSize = uniqueIds.size;
          addIds(
            'specification',
            hits.map((hit) => hit.id),
          );
          if (params.debug) {
            conceptQueryDebug.push({
              query,
              added: uniqueIds.size - beforeSize,
              categoryFiltered: categoryIdsFromFilters.length > 0,
            });
          }
        }
      }
      if (idsByTier.specification.length > 0 && !tierNotes.specification) {
        tierNotes.specification = 'progressive word/term variants';
      }
    }

    if (
      enabledLevels.has('category_brand') &&
      uniqueIds.size < params.requestedLimit &&
      effectiveCategoryIds.length > 0 &&
      effectiveBrandIds.length > 0
    ) {
      const ids = await this.searchTypesenseIds({
        q: '*',
        filterBy: this.mergeFilterByClauses(
          params.baseFilterBy,
          `category_ids:=[${effectiveCategoryIds.join(',')}]`,
          `brand_id:=[${effectiveBrandIds.join(',')}]`,
        ),
        sortBy: 'average_rating:desc,_text_match:desc,created_at_ts:desc',
        limit: Math.min(40, maxCandidates - uniqueIds.size),
      });
      addIds('category_brand', ids);
      if (ids.length > 0) {
        tierNotes.category_brand = 'same brand + category';
      }
    }

    if (
      enabledLevels.has('category') &&
      uniqueIds.size < params.requestedLimit &&
      effectiveCategoryIds.length > 0
    ) {
      const ids = await this.searchTypesenseIds({
        q: '*',
        filterBy: this.mergeFilterByClauses(
          params.baseFilterBy,
          `category_ids:=[${effectiveCategoryIds.join(',')}]`,
        ),
        sortBy: 'average_rating:desc,_text_match:desc,created_at_ts:desc',
        limit: Math.min(50, maxCandidates - uniqueIds.size),
      });
      addIds('category', ids);
    }

    if (
      enabledLevels.has('brand') &&
      uniqueIds.size < params.requestedLimit &&
      effectiveBrandIds.length > 0 &&
      !hasBrandInQuery
    ) {
      const ids = await this.searchTypesenseIds({
        q: '*',
        filterBy: this.mergeFilterByClauses(
          params.baseFilterBy,
          `brand_id:=[${effectiveBrandIds.join(',')}]`,
        ),
        sortBy: 'average_rating:desc,_text_match:desc,created_at_ts:desc',
        limit: Math.min(50, maxCandidates - uniqueIds.size),
      });
      addIds('brand', ids);
    } else if (hasBrandInQuery) {
      tierNotes.brand = 'skipped to avoid weak same-brand matches (e.g. i5)';
    }

    // Loose primary text-match results fill in after all layered buckets.
    addIds('primary', params.primaryIds);

    if (
      enabledLevels.has('keyword') &&
      uniqueIds.size < params.requestedLimit &&
      tokens.length > 0
    ) {
      const keywordTokens = (hasBrandInQuery
        ? tokens.filter((token) => !brandTokensFromQuery.has(token))
        : tokens
      ).filter((token) => token.length > 2);
      const fallbackQuery = (
        keywordTokens.length > 0 ? keywordTokens : tokens
      ).join(' ');
      const keywordFilters = [params.baseFilterBy];
      if (hasBrandInQuery) {
        keywordFilters.push(
          `brand_id:!=[${brandIdsFromQueryOnly.join(',')}]`,
        );
      }
      const ids = await this.searchTypesenseIds({
        q: fallbackQuery,
        filterBy: this.mergeFilterByClauses(...keywordFilters),
        sortBy: '_text_match:desc,created_at_ts:desc',
        limit: Math.min(80, maxCandidates - uniqueIds.size),
      });
      addIds('keyword', ids);
      if (hasBrandInQuery && ids.length > 0) {
        tierNotes.keyword = 'brand words removed, other brands only';
      }
    }

    const orderedIds: number[] = [];
    const seenOrderedIds = new Set<number>();
    const appendUnique = (ids: number[]) => {
      ids.forEach((id) => {
        if (seenOrderedIds.has(id)) {
          return;
        }
        seenOrderedIds.add(id);
        orderedIds.push(id);
      });
    };

    appendUnique(layeredOrderedIds);
    appendUnique(idsByTier.specification);
    appendUnique(
      (['category_brand', 'category', 'brand', 'primary', 'keyword'] as const).flatMap(
        (tier) => idsByTier[tier],
      ),
    );
    if (params.debug) {
      this.logger.log(
        `[search-expansion] q="${params.dto.q ?? ''}" primary=${primaryFoundCount} requested=${params.requestedLimit} concept_categories=${conceptCategoryIds.join(',') || 'none'} final=${orderedIds.length} tiers=${JSON.stringify(
          Object.fromEntries(
            this.expansionTierOrder.map((tier) => [tier, idsByTier[tier].length]),
          ),
        )}`,
      );
    }

    return {
      idsByTier,
      orderedIds,
      primaryFoundCount,
      detectedBrandIds: effectiveBrandIds,
      detectedCategoryIds: effectiveCategoryIds,
      tierNotes,
      segments: segmented.segments,
      conceptQueryDebug: params.debug ? conceptQueryDebug : undefined,
      expansionQueries: expansionQueries.slice(0, 12),
    };
  }

  private async searchWithTypesense(
    dto: SearchQueryDto,
    isAdmin: boolean,
    fullResponse: boolean,
  ): Promise<any> {
    if (this.shouldUseRandomBrowseSort(dto, isAdmin)) {
      return this.searchWithTypesenseRandomBrowse(dto, isAdmin, fullResponse);
    }

    const perPage = (dto as any).per_page ?? (dto as any).limit ?? 20;
    const page = dto.page ?? 1;
    const debugSearchEnabled = this.isDebugSearchEnabled();
    const startOffset = (page - 1) * perPage;
    const maxCandidates = this.getMaxExpansionCandidates();
    const expansionEnabled = this.isProgressiveExpansionEnabled();
    const primaryEnoughCount = this.getPrimaryEnoughCount();
    const filterBy = this.buildTypesenseFilterBy(dto, isAdmin);
    const normalizedQuery = normalizeSearchQuery(dto.q && dto.q !== '*' ? dto.q : '*');
    const conceptDetectionTokens = this.tokenizeQueryForExpansion(normalizedQuery);
    const expansionPrepPromise =
      expansionEnabled && normalizedQuery && normalizedQuery !== '*'
        ? this.detectEntityIdsFromTokens(conceptDetectionTokens, normalizedQuery)
        : Promise.resolve({ brandIds: [], categoryIds: [] });
    const primaryFetchLimit = Math.min(
      maxCandidates,
      Math.max(startOffset + perPage, primaryEnoughCount),
    );
    const params: SearchParams<Record<string, any>> = {
      q: normalizedQuery,
      query_by: PRODUCT_QUERY_BY,
      query_by_weights: PRODUCT_QUERY_BY_WEIGHTS,
      text_match_type: 'max_weight',
      prioritize_token_position: true,
      drop_tokens_threshold: 0,
      filter_by: filterBy,
      sort_by: this.buildTypesenseSortBy(dto.sort_by, isAdmin, dto.q),
      facet_by: this.getTypesenseFacetFields(),
      max_facet_values: 100,
      page: 1,
      per_page: primaryFetchLimit,
      num_typos: this.getTypoBudget(this.tokenizeQueryForExpansion(normalizedQuery)),
      ...(fullResponse ? { include_fields: 'id' } : {}),
    };

    const [result, detectedEntities] = await Promise.all([
      this.typesenseService.search(params),
      expansionPrepPromise,
    ]);
    const hits = Array.isArray(result.hits) ? result.hits : [];
    let orderedProductIds = hits
      .map((hit: any) => Number(hit?.document?.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const primaryCount = orderedProductIds.length;
    const primaryIsEnough = primaryCount >= primaryEnoughCount;
    const hasStructuredQueryIntent =
      conceptDetectionTokens.length > 1 ||
      detectedEntities.brandIds.length > 0;

    const shouldExpand =
      expansionEnabled &&
      (!primaryIsEnough || hasStructuredQueryIntent) &&
      perPage > 0 &&
      startOffset + perPage <= maxCandidates;
    let expansionMeta:
      | {
          tiers: Record<ExpansionTierKey, number[]>;
          primaryFoundCount: number;
          detectedBrandIds: number[];
          detectedCategoryIds: number[];
          tierNotes: Partial<Record<ExpansionTierKey, string>>;
          segments?: QueryVariantSegment[];
          expansionQueries?: string[];
          conceptQueryDebug?: Array<{
            query: string;
            added: number;
            categoryFiltered: boolean;
          }>;
        }
      | undefined;

    if (shouldExpand) {
      const requestedExpansionCount = Math.max(
        startOffset + perPage,
        primaryCount + this.getExpansionExtraWhenLow(),
      );
      const expanded = await this.collectExpandedTypesenseIds({
        dto,
        isAdmin,
        baseFilterBy: filterBy,
        primaryIds: orderedProductIds,
        requestedLimit: requestedExpansionCount,
        debug: debugSearchEnabled,
      });
      orderedProductIds = expanded.orderedIds;
      expansionMeta = {
        tiers: expanded.idsByTier,
        primaryFoundCount: expanded.primaryFoundCount,
        detectedBrandIds: expanded.detectedBrandIds,
        detectedCategoryIds: expanded.detectedCategoryIds,
        tierNotes: expanded.tierNotes,
        segments: expanded.segments,
        expansionQueries: expanded.expansionQueries,
        conceptQueryDebug: expanded.conceptQueryDebug,
      };
    }
    const pageProductIds = orderedProductIds.slice(startOffset, startOffset + perPage);

    let products: any[] = [];
    if (fullResponse) {
      const productsResult = pageProductIds.length
        ? await this.productsService.findAll(
            {
              page: 1,
              limit: Math.max(pageProductIds.length, perPage),
              ids: pageProductIds,
              visible: this.resolveAdminVisibleFilter(dto, isAdmin),
            } as any,
            isAdmin,
          )
        : { data: [] };
      products = this.mapSearchResults(
        productsResult.data ?? [],
        pageProductIds,
        true,
      );
    } else {
      const imageUrlsByProductId =
        await this.productsService.findPrimaryImageUrlsByProductIds(pageProductIds);
      const hitsById = new Map<number, any>();
      hits.forEach((hit: any) => {
        const id = Number(hit?.document?.id);
        if (Number.isInteger(id) && id > 0) {
          hitsById.set(id, hit);
        }
      });

      const mappedFromHits = pageProductIds
        .map((productId) => {
          const sourceHit = hitsById.get(productId);
          if (!sourceHit?.document) {
            return undefined;
          }

          return this.mapTypesenseDocumentToSearchCard(
            sourceHit.document,
            imageUrlsByProductId.get(productId),
          );
        })
        .filter((product): product is Record<string, any> => Boolean(product));

      const missingIds = pageProductIds.filter((id) => !hitsById.has(id));
      const missingCards =
        missingIds.length > 0
          ? await this.buildSearchCardsFromTypesenseIds(missingIds, isAdmin)
          : [];

      const cardsById = new Map<string, any>(
        [...mappedFromHits, ...missingCards].map((card) => [String(card.id), card]),
      );
      products = pageProductIds
        .map((id) => cardsById.get(String(id)))
        .filter((card): card is NonNullable<typeof card> => Boolean(card));
    }

    let facetCountsSource = result.facet_counts;
    if (shouldExpand && orderedProductIds.length > 0) {
      const facetsFromExpandedPool = await this.typesenseService.search({
        q: '*',
        query_by: PRODUCT_CARD_QUERY_BY,
        filter_by: `id:=[${orderedProductIds.join(',')}]`,
        facet_by: this.getTypesenseFacetFields(),
        max_facet_values: 100,
        page: 1,
        per_page: 1,
      });
      facetCountsSource = facetsFromExpandedPool.facet_counts;
    }

    const totalCount = shouldExpand
      ? Math.max(Number(result.found ?? 0), orderedProductIds.length)
      : Number(result.found ?? products.length);
    const response = {
      data: products,
      meta: {
        total: totalCount,
        page,
        limit: perPage,
        totalPages:
          totalCount && perPage > 0
            ? Math.ceil(totalCount / perPage)
            : 1,
      },
      facets: await this.enrichSearchFacets(
        this.mapTypesenseFacetCounts(facetCountsSource),
        dto,
      ),
      search_time_ms: result.search_time_ms,
    };

    if (debugSearchEnabled) {
      const prep = this.lastQueryPreparationDebug;
      const queryTokens =
        prep?.tokens ?? this.tokenizeQueryForExpansion(normalizedQuery);
      let detectedBrandIds = expansionMeta?.detectedBrandIds;
      let detectedCategoryIds = expansionMeta?.detectedCategoryIds;
      if (!expansionMeta && queryTokens.length > 0) {
        const detected = await this.detectEntityIdsFromTokens(
          queryTokens,
          normalizedQuery,
        );
        detectedBrandIds = detected.brandIds;
        detectedCategoryIds = detected.categoryIds;
      }

      const entityLabels = await this.resolveDebugEntityLabels(
        detectedBrandIds,
        detectedCategoryIds,
      );
      const tierCounts: Record<ExpansionTierKey, number[]> = expansionMeta?.tiers ?? {
        primary: Array.from({ length: primaryCount }),
        same_brand_spec: [],
        category_brand: [],
        cross_brand_spec: [],
        category: [],
        brand: [],
        specification: [],
        keyword: [],
      };

      await this.writeSearchDebugLog({
        kind: 'search',
        provider: 'typesense',
        query: prep?.originalQuery ?? dto.q ?? '',
        normalized_query: prep?.normalizedQuery ?? normalizedQuery,
        tokens: queryTokens,
        price_stripped_phrases: prep?.priceParse?.strippedPhrases,
        price_min: dto.min_price,
        price_max: dto.max_price,
        page,
        limit: perPage,
        expansion_applied: shouldExpand,
        expansion_tier_details: this.buildExpansionTierDebugDetails(
          tierCounts,
          expansionMeta?.tierNotes ?? {},
        ),
        detected_brand_ids:
          detectedBrandIds && detectedBrandIds.length
            ? detectedBrandIds.join(', ')
            : undefined,
        detected_brand_labels: entityLabels.brands,
        detected_category_ids:
          detectedCategoryIds && detectedCategoryIds.length
            ? detectedCategoryIds.join(', ')
            : undefined,
        detected_category_labels: entityLabels.categories,
        matched_concepts:
          expansionMeta?.segments && expansionMeta.segments.length
            ? expansionMeta.segments
                .filter((segment) => segment.matchedGroupIds.length > 0)
                .map(
                  (segment) =>
                    `${segment.text} (${segment.matchedGroupIds.join(',')})`,
                )
            : undefined,
        expansion_queries: expansionMeta?.expansionQueries,
        concept_query_debug: expansionMeta?.conceptQueryDebug,
        primary_found: expansionMeta?.primaryFoundCount ?? primaryCount,
        final_candidates: orderedProductIds.length,
        primary_enough_threshold: primaryEnoughCount,
        primary_enough: primaryIsEnough,
        response_total: response.meta.total,
        response_count: response.data.length,
        search_time_ms: result.search_time_ms,
      });
    }

    return response;
  }

  private async autocompleteWithTypesense(
    dto: AutocompleteQueryDto,
    isAdmin: boolean,
  ): Promise<AutocompleteResponseDto> {
    const filterBy = isAdmin
      ? undefined
      : `visible:=true && status:=[${SEARCHABLE_STATUSES.join(',')}] && is_out_of_stock:=false`;

    const result = await this.typesenseService.search({
      q: normalizeSearchQuery(dto.q),
      query_by: AUTOCOMPLETE_QUERY_BY,
      query_by_weights: AUTOCOMPLETE_QUERY_BY_WEIGHTS,
      text_match_type: 'max_weight',
      prioritize_token_position: true,
      ...(filterBy ? { filter_by: filterBy } : {}),
      // Must lead with relevance, same as the main search path — sorting by
      // created_at_ts alone (as this used to) ignores how well the query
      // actually matched and surfaces recently-added, loosely-matching
      // products ahead of exact/early-position matches.
      sort_by: '_text_match:desc,created_at_ts:desc',
      page: 1,
      per_page: dto.per_page ?? 8,
    });

    const hits = Array.isArray(result.hits) ? result.hits : [];
    const productIds = hits
      .map((hit: any) => Number(hit?.document?.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const imageUrlsByProductId =
      await this.productsService.findPrimaryImageUrlsByProductIds(productIds);

    return {
      suggestions: hits
        .map((hit: any) => {
          const productId = Number(hit?.document?.id);
          if (!Number.isInteger(productId) || productId <= 0 || !hit?.document) {
            return null;
          }

          const card = this.mapTypesenseDocumentToSearchCard(
            hit.document,
            imageUrlsByProductId.get(productId),
          );

          return {
            id: String(card.id),
            slug: card.slug,
            name_en: card.name_en,
            name_ar: card.name_ar,
            image: card.images?.[0],
            price_min: card.sale_price ?? card.price,
          };
        })
        .filter((suggestion): suggestion is NonNullable<typeof suggestion> =>
          Boolean(suggestion),
        ),
    };
  }

  private logTypesenseFallback(params: {
    path: 'search' | 'autocomplete';
    error: unknown;
    query?: string;
  }) {
    const errorMessage =
      params.error instanceof Error ? params.error.message : String(params.error);
    const errorName = params.error instanceof Error ? params.error.name : 'UnknownError';

    this.logger.warn(
      `[typesense-fallback] path=${params.path} provider=${this.searchProvider} query="${
        params.query ?? ''
      }" error_name=${errorName} reason="${errorMessage}"`,
    );
  }

  private isDebugSearchEnabled(): boolean {
    return this.isSearchDebugEnabledByEnv();
  }

  async search(
    dto: SearchQueryDto,
    isAdmin = false,
    fullResponse = false,
  ): Promise<any> {
    const preparedDto = await this.prepareSearchQuery(dto);
    const debugSearchEnabled = this.isDebugSearchEnabled();
    const useRandomBrowse = this.shouldUseRandomBrowseSort(preparedDto, isAdmin);
    const hasUnsupportedFilters = this.hasUnsupportedTypesenseFilters(preparedDto);
    const canUseTypesense =
      this.searchProvider === 'typesense' &&
      this.typesenseService.isEnabled() &&
      !hasUnsupportedFilters;

    // The cache key's query text must match what will actually be searched.
    // This only matters for the non-random-browse Typesense path, since
    // that's the only path where `q` is matched against normalized indexed
    // text — the random-browse path always searches '*' regardless of `q`,
    // and the DB fallback searches raw, unnormalized column text (two raw
    // queries that only look equal after normalization can legitimately
    // produce different ILIKE results there).
    const willNormalizeQueryForCacheKey = canUseTypesense && !useRandomBrowse;
    const cacheDto = willNormalizeQueryForCacheKey
      ? { ...preparedDto, q: normalizeSearchQuery(preparedDto.q) }
      : preparedDto;
    const cacheKey = await this.searchCacheService.buildCacheKey(
      `search:${isAdmin ? 'admin' : 'public'}:${fullResponse ? 'full' : 'card'}`,
      JSON.stringify(cacheDto),
    );
    const skipResponseCache = dto.is_admin === true || debugSearchEnabled;
    const cached =
      useRandomBrowse || skipResponseCache
        ? null
        : await this.cacheManager.get<any>(cacheKey);
    const bypassCacheForEmptyResults = canUseTypesense && Boolean(
      preparedDto.q &&
        this.tokenizeQueryForExpansion(preparedDto.q).length > 0 &&
        (cached?.meta?.total ?? 0) === 0,
    );
    if (cached && !bypassCacheForEmptyResults) {
      if (debugSearchEnabled) {
        await this.writeSearchDebugLog({
          kind: 'search',
          provider: 'cache',
          query: preparedDto.q ?? '',
          page: preparedDto.page ?? 1,
          limit: (preparedDto as any).per_page ?? (preparedDto as any).limit ?? 20,
          cache_hit: true,
          response_total: cached?.meta?.total,
          response_count: Array.isArray(cached?.data) ? cached.data.length : 0,
        });
      }
      return cached;
    }

    let response: any;
    const start = Date.now();

    if (canUseTypesense) {
      try {
        response = await this.searchWithTypesense(
          preparedDto,
          isAdmin,
          fullResponse,
        );
      } catch (error) {
        this.logTypesenseFallback({
          path: 'search',
          error,
          query: preparedDto.q,
        });
      }
    }

    if (!response) {
      const result = await this.productsService.findAll(
        this.buildFilterDto(preparedDto, isAdmin),
        isAdmin,
      );
      response = {
        data: this.mapSearchResults(result.data ?? [], undefined, fullResponse),
        meta: result.meta,
        facets: [],
        search_time_ms: Date.now() - start,
      };

      if (debugSearchEnabled) {
        await this.writeSearchDebugLog({
          kind: 'search',
          provider: 'db',
          query: preparedDto.q ?? '',
          page: preparedDto.page ?? 1,
          limit: (preparedDto as any).per_page ?? (preparedDto as any).limit ?? 20,
          expansion_applied: false,
          reason:
            canUseTypesense
              ? 'typesense_runtime_fallback'
              : this.searchProvider !== 'typesense'
                ? 'provider_not_typesense'
                : !this.typesenseService.isEnabled()
                  ? 'typesense_disabled'
                  : hasUnsupportedFilters
                    ? 'unsupported_filters'
                    : 'db_path',
          response_total: response.meta?.total,
          response_count: Array.isArray(response.data) ? response.data.length : 0,
        });
      }
    }

    const elapsedMs = Date.now() - start;
    if (elapsedMs > this.getLatencyBudgetMs()) {
      this.logger.warn(
        `[search-latency] q="${preparedDto.q ?? ''}" provider=${canUseTypesense ? 'typesense' : 'db'} elapsed_ms=${elapsedMs} budget_ms=${this.getLatencyBudgetMs()}`,
      );
    }

    if (!useRandomBrowse && !skipResponseCache) {
      await this.cacheManager.set(cacheKey, response, 300 * 1000);
    }
    return response;
  }

  async autocomplete(
    dto: AutocompleteQueryDto,
    isAdmin = false,
  ): Promise<AutocompleteResponseDto> {
    const willUseTypesense =
      this.searchProvider === 'typesense' && this.typesenseService.isEnabled();
    // Same reasoning as search(): only normalize the cache key's query text
    // when Typesense (whose index is normalized) is what will actually run.
    const cacheQ = willUseTypesense ? normalizeSearchQuery(dto.q) : dto.q;
    const cacheKey = await this.searchCacheService.buildCacheKey(
      'autocomplete',
      `${cacheQ}:${dto.per_page}`,
    );
    const cached =
      await this.cacheManager.get<AutocompleteResponseDto>(cacheKey);
    if (cached) return cached;

    let response: AutocompleteResponseDto | null = null;

    if (willUseTypesense) {
      try {
        response = await this.autocompleteWithTypesense(dto, isAdmin);
      } catch (error) {
        this.logTypesenseFallback({
          path: 'autocomplete',
          error,
          query: dto.q,
        });
      }
    }

    if (!response) {
      const perPage = dto.per_page ?? 8;
      const result = await this.productsService.findAll({
        page: 1,
        limit: perPage,
        search: dto.q,
        in_stock: isAdmin ? undefined : true,
        visible: isAdmin ? undefined : true,
        sortBy: ProductSortBy.CREATED_AT,
        sortOrder: SortOrder.DESC,
      }, isAdmin);

      response = {
        suggestions: this.mapProductsToSearchCards(result.data ?? []).map((product: any) => {
          return {
            id: String(product.id),
            slug: product.slug,
            name_en: product.name_en,
            name_ar: product.name_ar,
            image: product.images?.[0],
            price_min: product.sale_price ?? product.price,
          };
        }),
      };
    }

    await this.cacheManager.set(cacheKey, response, 60 * 1000);
    return response;
  }
}
