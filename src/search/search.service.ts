import { Injectable, Inject, forwardRef } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { ProductsService } from '../products/products.service';
import {
  FilterProductDto,
  ProductSortBy,
  SortOrder,
} from '../products/dto/filter-product.dto';
import { SearchQueryDto, AutocompleteQueryDto } from './dto/search-query.dto';
import { AutocompleteResponseDto } from './dto/search-response.dto';

@Injectable()
export class SearchService {
  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,
  ) {}

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

  private buildFilterDto(dto: SearchQueryDto): FilterProductDto {
    const { sortBy, sortOrder } = this.mapSort(dto.sort_by);
    const categoryIds = [
      ...(dto.category_id != null ? [dto.category_id] : []),
      ...(dto.category_ids ?? []),
    ];

    return {
      page: dto.page ?? 1,
      limit: dto.per_page ?? 20,
      search: dto.q && dto.q !== '*' ? dto.q : undefined,
      category_ids: categoryIds.length > 0 ? categoryIds : undefined,
      brand_ids: dto.brand_id != null ? [dto.brand_id] : undefined,
      vendor_ids: dto.vendor_id != null ? [dto.vendor_id] : undefined,
      minPrice: dto.min_price,
      maxPrice: dto.max_price,
      in_stock: dto.in_stock,
      minRating: dto.rating_min,
      sortBy,
      sortOrder,
      visible: true,
    };
  }

  async search(dto: SearchQueryDto): Promise<any> {
    const cacheKey = `search:${JSON.stringify(dto)}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;

    const start = Date.now();
    const result = await this.productsService.findAll(this.buildFilterDto(dto));

    const response = {
      data: result.data,
      meta: result.meta,
      facets: [],
      search_time_ms: Date.now() - start,
    };

    await this.cacheManager.set(cacheKey, response, 300 * 1000);
    return response;
  }

  async autocomplete(
    dto: AutocompleteQueryDto,
  ): Promise<AutocompleteResponseDto> {
    const cacheKey = `autocomplete:${dto.q}:${dto.per_page}`;
    const cached =
      await this.cacheManager.get<AutocompleteResponseDto>(cacheKey);
    if (cached) return cached;

    const perPage = dto.per_page ?? 8;
    const result = await this.productsService.findAll({
      page: 1,
      limit: perPage,
      search: dto.q,
      in_stock: true,
      visible: true,
      sortBy: ProductSortBy.CREATED_AT,
      sortOrder: SortOrder.DESC,
    });

    const response: AutocompleteResponseDto = {
      suggestions: (result.data ?? []).map((product: any) => {
        const primaryImage = (product.media ?? product.images ?? []).find(
          (item: any) => item?.is_primary,
        );
        const imageUrl =
          primaryImage?.url ??
          product.media?.[0]?.url ??
          product.images?.[0] ??
          undefined;

        return {
          id: String(product.id),
          slug: product.slug,
          name_en: product.name_en,
          name_ar: product.name_ar,
          image: imageUrl,
          price_min: product.sale_price ?? product.price,
        };
      }),
    };

    await this.cacheManager.set(cacheKey, response, 60 * 1000);
    return response;
  }
}
