import { Inject, Injectable } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import type { Cache } from 'cache-manager';
import { Repository } from 'typeorm';
import {
  Category,
  CategoryStatus,
} from '../categories/entities/category.entity';
import { Vendor, VendorStatus } from '../vendors/entities/vendor.entity';
import { Banner } from '../banners/entities/banner.entity';
import { Brand, BrandStatus } from '../brands/entities/brand.entity';
import { ProductsService } from '../products/products.service';
import { HomeProductsQueryDto } from './dto/home-products-query.dto';
import { ProductSortBy, SortOrder } from '../products/dto/filter-product.dto';

@Injectable()
export class HomeService {
  constructor(
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(Vendor)
    private vendorsRepository: Repository<Vendor>,
    @InjectRepository(Banner)
    private bannersRepository: Repository<Banner>,
    @InjectRepository(Brand)
    private brandsRepository: Repository<Brand>,
    private productsService: ProductsService,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async getHomeData() {
    // Get active categories ordered by sortOrder
    const categories = await this.categoriesRepository.find({
      where: {
        status: CategoryStatus.ACTIVE,
        visible: true,
      },
      order: { sortOrder: 'ASC' },
      relations: {
        parent: true,
        children: true
      },
    });

    // Get active vendors ordered by sort_order
    const vendors = await this.vendorsRepository.find({
      where: {
        status: VendorStatus.ACTIVE,
        visible: true,
      },
      order: { sort_order: 'ASC', created_at: 'DESC' },
    });

    // Get active banners ordered by sort_order
    const banners = await this.bannersRepository.find({
      where: {
        visible: true,
      },
      order: { sort_order: 'ASC' },
      select: {
        id: true,
        image: true,
        language: true,
        link: true,
        sort_order: true
      },
    });

    // Get active brands ordered by sort_order
    const brands = await this.brandsRepository.find({
      where: {
        status: BrandStatus.ACTIVE,
        visible: true,
      },
      order: { sort_order: 'ASC' },
    });

    return {
      categories,
      vendors,
      banners,
      brands,
    };
  }

  async getHomeProducts(query: HomeProductsQueryDto) {
    const topRatedLimit = query.topRatedLimit ?? 8;
    const newestLimit = query.newestLimit ?? 8;
    const variantCards = query.variantCards ?? true;

    const cacheKey = `home:products:v1:top:${topRatedLimit}:new:${newestLimit}:variant:${variantCards}`;

    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    const [topRated, newest] = await Promise.all([
      this.productsService.findAll({
        page: 1,
        limit: topRatedLimit,
        sortBy: ProductSortBy.AVERAGE_RATING,
        sortOrder: SortOrder.DESC,
        visible: true,
      }),
      this.productsService.findAll({
        page: 1,
        limit: newestLimit,
        sortBy: ProductSortBy.CREATED_AT,
        sortOrder: SortOrder.DESC,
        visible: true,
      }),
    ]);

    const topRatedItems = Array.isArray((topRated as any)?.data)
      ? (topRated as any).data
      : [];
    const newestItems = Array.isArray((newest as any)?.data)
      ? (newest as any).data
      : [];

    const payload = {
      topRated: variantCards
        ? this.flattenProductsToVariantCards(topRatedItems)
        : topRatedItems,
      newest: variantCards
        ? this.flattenProductsToVariantCards(newestItems)
        : newestItems,
    };

    await this.cacheManager.set(cacheKey, payload);
    return payload;
  }

  private flattenProductsToVariantCards(products: any[]): any[] {
    const cards: any[] = [];
    for (const product of products) {
      const productVariants = Array.isArray(product?.variants)
        ? product.variants
        : [];

      if (productVariants.length === 0) {
        cards.push(this.buildSimpleProductCard(product));
        continue;
      }

      for (const variant of productVariants) {
        cards.push(this.buildVariantCard(product, variant));
      }
    }
    return cards;
  }

  private buildSimpleProductCard(product: any) {
    return {
      product_id: product?.id ?? null,
      variant_id: null,
      name_en: product?.name_en ?? null,
      name_ar: product?.name_ar ?? null,
      average_rating: product?.average_rating ?? null,
      total_ratings: product?.total_ratings ?? null,
      price: product?.price ?? null,
      sale_price: product?.sale_price ?? null,
      primary_image: product?.primary_image ?? null,
      attributes: Array.isArray(product?.attributes)
        ? product.attributes
            .map((pa: any) => ({
              attribute_id: pa?.attribute?.id ?? pa?.attribute_id ?? null,
              name_en: pa?.attribute?.name_en ?? null,
              name_ar: pa?.attribute?.name_ar ?? null,
              type: pa?.attribute?.type ?? null,
              is_color: pa?.attribute?.is_color ?? null,
            }))
            .filter((x: any) => x.attribute_id !== null)
        : [],
    };
  }

  private buildVariantCard(product: any, variant: any) {
    const variantValueIds = new Set<number>(
      (variant?.combinations || [])
        .map((c: any) =>
          Number(c?.attribute_value?.id ?? c?.attribute_value_id),
        )
        .filter((id: any) => Number.isFinite(id)),
    );

    const matchedPriceGroup = this.pickBestMatchedGroup(
      product?.prices || product?.priceGroups || [],
      variantValueIds,
      'price',
    );

    const matchedMediaGroup = this.pickBestMatchedGroup(
      this.extractMediaGroups(product?.media || []),
      variantValueIds,
      'media',
    );

    const primaryImage = this.pickVariantPrimaryImage(
      product?.media || [],
      matchedMediaGroup?.id ?? null,
    );

    const attributes = (variant?.combinations || [])
      .map((c: any) => {
        const av = c?.attribute_value;
        const attr = av?.attribute;
        if (!av || !attr) return null;
        return {
          attribute_id: attr.id,
          name_en: attr.name_en,
          name_ar: attr.name_ar,
          type: attr.type,
          is_color: attr.is_color,
          value_id: av.id,
          value_en: av.value_en,
          value_ar: av.value_ar,
          color_code: av.color_code,
          image_url: av.image_url,
        };
      })
      .filter(Boolean);

    return {
      product_id: product?.id ?? null,
      variant_id: variant?.id ?? null,
      name_en: product?.name_en ?? null,
      name_ar: product?.name_ar ?? null,
      average_rating: product?.average_rating ?? null,
      total_ratings: product?.total_ratings ?? null,
      price: matchedPriceGroup?.price ?? product?.price ?? null,
      sale_price: matchedPriceGroup?.sale_price ?? product?.sale_price ?? null,
      primary_image: primaryImage,
      attributes,
    };
  }

  private extractMediaGroups(media: any[]): any[] {
    const groups = new Map<number, any>();
    for (const m of media) {
      const g = m?.media_group || m?.mediaGroup;
      if (!g?.id) continue;
      groups.set(g.id, g);
    }
    return Array.from(groups.values());
  }

  private pickVariantPrimaryImage(media: any[], mediaGroupId: number | null) {
    const normalizedMedia = Array.isArray(media) ? media : [];

    const groupMedia = mediaGroupId
      ? normalizedMedia.filter((m: any) => {
          const g = m?.media_group || m?.mediaGroup;
          return g?.id === mediaGroupId;
        })
      : [];

    const candidateMedia = groupMedia.length > 0 ? groupMedia : normalizedMedia;
    const picked =
      candidateMedia.find((m: any) => m?.is_group_primary) ||
      candidateMedia.find((m: any) => m?.is_primary) ||
      candidateMedia[0] ||
      null;

    if (!picked) return null;

    return {
      id: picked.id,
      url: picked.url,
      type: picked.type,
      alt_text: picked.alt_text,
      media_group_id: (picked?.media_group || picked?.mediaGroup)?.id ?? null,
    };
  }

  private pickBestMatchedGroup(
    groups: any[],
    variantValueIds: Set<number>,
    kind: 'price' | 'media',
  ) {
    const normalized = Array.isArray(groups) ? groups : [];
    if (normalized.length === 0) return null;

    const matches: any[] = [];
    for (const group of normalized) {
      const values = Array.isArray(group?.groupValues)
        ? group.groupValues
        : Array.isArray(group?.group_values)
          ? group.group_values
          : [];
      const requiredValueIds = values
        .map((gv: any) =>
          Number(gv?.attribute_value_id ?? gv?.attributeValueId),
        )
        .filter((id: any) => Number.isFinite(id));

      const isMatch = requiredValueIds.every((id: number) =>
        variantValueIds.has(id),
      );
      if (!isMatch) continue;

      matches.push({ group, specificity: requiredValueIds.length });
    }

    if (matches.length > 0) {
      matches.sort((a, b) => b.specificity - a.specificity);
      return matches[0].group;
    }

    // Fallback to a simple group (no groupValues) if present
    const simple = normalized.find((g: any) => {
      const values = Array.isArray(g?.groupValues)
        ? g.groupValues
        : Array.isArray(g?.group_values)
          ? g.group_values
          : [];
      return values.length === 0;
    });

    if (simple) return simple;
    return normalized[0];
  }
}
