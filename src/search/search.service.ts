import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Category } from '../categories/entities/category.entity';
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
import { normalizeSearchQuery } from '../typesense/utils/text-normalize';

// Matches current production behavior (previously hardcoded at two call sites:
// buildTypesenseFilterBy and autocompleteWithTypesense). Change only with
// product-team sign-off — review-status visibility is a pending decision.
const SEARCHABLE_STATUSES = ['active', 'updated', 'review'];

// Field priority for relevance ranking: name (title) highest, short
// description second, long description lowest of the text fields. Order and
// weights must stay in sync with PRODUCT_QUERY_BY below.
// name_en, name_ar, short_description_en, short_description_ar,
// long_description_en, long_description_ar, sku, slug
const PRODUCT_QUERY_BY =
  'name_en,name_ar,short_description_en,short_description_ar,long_description_en,long_description_ar,sku,slug';
const PRODUCT_QUERY_BY_WEIGHTS = '5,5,3,3,1,1,4,2';

@Injectable()
export class SearchService {
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

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,
    private readonly typesenseService: TypesenseService,
    private readonly configService: ConfigService,
    @InjectRepository(Category)
    private readonly categoriesRepository: Repository<Category>,
    @InjectRepository(Brand)
    private readonly brandsRepository: Repository<Brand>,
    @InjectRepository(Vendor)
    private readonly vendorsRepository: Repository<Vendor>,
    @InjectRepository(AttributeValue)
    private readonly attributeValuesRepository: Repository<AttributeValue>,
    @InjectRepository(SpecificationValue)
    private readonly specificationValuesRepository: Repository<SpecificationValue>,
  ) {}

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
      case 'price_min:asc':
        return { sortBy: ProductSortBy.PRICE, sortOrder: SortOrder.ASC };
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
        query_by: 'name_en,name_ar,slug',
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
    const categoryIds = this.extractCategoryIds(dto);

    if (categoryIds.length === 0) {
      return dto;
    }

    const expandedCategoryIds =
      await this.expandCategoryIdsWithDescendants(categoryIds);

    return {
      ...dto,
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

    if (
      hasTextQuery &&
      (!sortBy || sortBy === 'created_at:desc')
    ) {
      return '_text_match:desc,created_at_ts:desc';
    }

    switch (sortBy) {
      case 'price_min:asc':
        return 'effective_price:asc';
      case 'price_min:desc':
        return 'effective_price:desc';
      case 'rating:desc':
        return 'average_rating:desc';
      case 'created_at:desc':
        return isAdmin ? 'created_at_ts:desc' : '_text_match:desc,created_at_ts:desc';
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
        query_by: 'name_en,name_ar,sku,slug',
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

  private async searchWithTypesense(
    dto: SearchQueryDto,
    isAdmin: boolean,
    fullResponse: boolean,
  ): Promise<any> {
    if (this.shouldUseRandomBrowseSort(dto, isAdmin)) {
      return this.searchWithTypesenseRandomBrowse(dto, isAdmin, fullResponse);
    }

    const params: SearchParams<Record<string, any>> = {
      q: normalizeSearchQuery(dto.q && dto.q !== '*' ? dto.q : '*'),
      query_by: PRODUCT_QUERY_BY,
      query_by_weights: PRODUCT_QUERY_BY_WEIGHTS,
      text_match_type: 'max_weight',
      prioritize_token_position: true,
      filter_by: this.buildTypesenseFilterBy(dto, isAdmin),
      sort_by: this.buildTypesenseSortBy(dto.sort_by, isAdmin, dto.q),
      facet_by: this.getTypesenseFacetFields(),
      max_facet_values: 100,
      page: dto.page ?? 1,
      per_page: (dto as any).per_page ?? (dto as any).limit ?? 20,
      ...(fullResponse ? { include_fields: 'id' } : {}),
    };

    const result = await this.typesenseService.search(params);
    const hits = Array.isArray(result.hits) ? result.hits : [];
    const productIds = hits
      .map((hit: any) => Number(hit?.document?.id))
      .filter((id) => Number.isInteger(id) && id > 0);

    let products: any[] = [];
    if (fullResponse) {
      const fallbackLimit = (dto as any).per_page ?? (dto as any).limit ?? 20;
      const productsResult = productIds.length
        ? await this.productsService.findAll(
            {
              page: 1,
              limit: Math.max(productIds.length, fallbackLimit),
              ids: productIds,
              visible: this.resolveAdminVisibleFilter(dto, isAdmin),
            } as any,
            isAdmin,
          )
        : { data: [] };
      products = this.mapSearchResults(
        productsResult.data ?? [],
        productIds,
        true,
      );
    } else {
      const imageUrlsByProductId =
        await this.productsService.findPrimaryImageUrlsByProductIds(productIds);
      products = hits
        .map((hit: any) => {
          const productId = Number(hit?.document?.id);
          if (!Number.isInteger(productId) || productId <= 0 || !hit?.document) {
            return null;
          }

          return this.mapTypesenseDocumentToSearchCard(
            hit.document,
            imageUrlsByProductId.get(productId),
          );
        })
        .filter((product): product is Record<string, any> => Boolean(product));
    }

    return {
      data: products,
      meta: {
        total: result.found ?? products.length,
        page: dto.page ?? 1,
        limit: (dto as any).per_page ?? (dto as any).limit ?? 20,
        totalPages:
          result.found && ((dto as any).per_page ?? (dto as any).limit ?? 20) > 0
            ? Math.ceil(result.found / ((dto as any).per_page ?? (dto as any).limit ?? 20))
            : 1,
      },
      facets: await this.enrichSearchFacets(
        this.mapTypesenseFacetCounts(result.facet_counts),
        dto,
      ),
      search_time_ms: result.search_time_ms,
    };
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
      query_by: 'name_en,name_ar,sku,slug',
      query_by_weights: '5,5,4,2',
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

  async search(
    dto: SearchQueryDto,
    isAdmin = false,
    fullResponse = false,
  ): Promise<any> {
    const preparedDto = await this.prepareSearchQuery(dto);
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
    const cacheKey = `search:${isAdmin ? 'admin' : 'public'}:${fullResponse ? 'full' : 'card'}:${JSON.stringify(cacheDto)}`;
    const cached = useRandomBrowse
      ? null
      : await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;

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
    }

    if (!useRandomBrowse) {
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
    const cacheKey = `autocomplete:${cacheQ}:${dto.per_page}`;
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
