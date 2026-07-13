import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource, EntityManager } from 'typeorm';
import { Product, ProductStatus } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  FilterProductDto,
  FindAllProductsOptions,
  getCategoryIds,
  getOriginalVendorCategoryId,
  getSingleVendorId,
} from './dto/filter-product.dto';
import { ProductNamesQueryDto } from './dto/product-names-query.dto';
import { MergeDuplicateReferenceSlugsDto } from './dto/merge-duplicate-reference-slugs.dto';
import {
  Category,
  CategoryStatus,
} from '../categories/entities/category.entity';
import { ProductCategory } from './entities/product-category.entity';
import { Vendor, VendorStatus } from '../vendors/entities/vendor.entity';
import { Brand, BrandStatus } from '../brands/entities/brand.entity';
import { Media, MediaType } from '../media/entities/media.entity';
import { ProductAttribute } from './entities/product-attribute.entity';
import { ProductAttributeValue } from './entities/product-attribute-value.entity';
import { ProductMedia } from './entities/product-media.entity';
import { ProductAttachment } from './entities/product-attachment.entity';
import { ProductSpecificationValue } from './entities/product-specification-value.entity';
import { AttributeValue } from '../attributes/entities/attribute-value.entity';
import { SpecificationValue } from '../specifications/entities/specification-value.entity';
import { CartItem } from '../cart/entities/cart-item.entity';
import { TagsService } from '../search/tags.service';
import { Tag } from '../search/entities/tag.entity';
import { isStorefrontAvailableProduct } from './utils/storefront-product-availability.util';
import { SettingsService } from '../settings/settings.service';
import { TypesenseService } from '../typesense/typesense.service';
import { SearchCacheService } from '../search/search-cache.service';
import {
  hasAdminAccess,
  stripProductPricingFields,
} from '../users/utils/admin-access.util';
import {
  isSimplifiedProductCreator,
  validateAndNormalizeSimplifiedCreateDto,
} from './utils/simplified-product-creator.util';

import { ProductSpecificationInputDto } from './dto/product-specification.dto';
import { ProductAttributeInputDto } from './dto/product-attribute.dto';
import { ProductGroup } from './entities/product-group.entity';
import { GroupProduct } from './entities/group-product.entity';
import { ProductSlugRedirect } from './entities/product-slug-redirect.entity';
import {
  getPrimaryMediaUrl,
  hydrateProductMedia,
  hydrateProductsMedia,
} from './utils/product-media.util';
import {
  hydrateProductAttachments,
  hydrateProductsAttachments,
} from './utils/product-attachment.util';
import { mapProductToTypesenseDoc } from '../typesense/mappers/product.mapper';

import { Like, Not } from 'typeorm';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

type OriginalVendorCategoryReference = {
  id?: number;
  name?: string;
};

type ProductPricingComputationContext = {
  vendor_id: number | null;
  brand_id: number | null;
  categoryIds: number[];
  original_vendor_price: number | null;
  original_vendor_sale_price: number | null;
};

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  async findProductNames(
    queryDto: ProductNamesQueryDto,
    isAdmin = false,
  ): Promise<Array<{ id: number; name_en: string; name_ar: string }>> {
    const { vendor_id, category_ids, search } = queryDto;
    const queryBuilder = this.productsRepository
      .createQueryBuilder('product')
      .select(['product.id', 'product.name_en', 'product.name_ar'])
      .orderBy('product.name_en', 'ASC')
      .addOrderBy('product.id', 'ASC');

    let hasWhereClause = false;

    const addCondition = (
      condition: string,
      parameters?: Record<string, unknown>,
    ) => {
      if (hasWhereClause) {
        queryBuilder.andWhere(condition, parameters);
      } else {
        queryBuilder.where(condition, parameters);
        hasWhereClause = true;
      }
    };

    if (!isAdmin) {
      addCondition('product.status = :status', {
        status: ProductStatus.ACTIVE,
      });
    }

    if (vendor_id !== undefined) {
      addCondition('product.vendor_id = :vendorId', {
        vendorId: vendor_id,
      });
    }

    if (category_ids && category_ids.length > 0) {
      addCondition(
        'EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = product.id AND pc.category_id IN (:...categoryIds))',
        {
          categoryIds: category_ids,
        },
      );
    }

    if (search) {
      addCondition(
        '(product.name_en ILIKE :search OR product.name_ar ILIKE :search)',
        {
          search: `%${search}%`,
        },
      );
    }

    const products = await queryBuilder.getMany();

    return products.map((product) => ({
      id: product.id,
      name_en: product.name_en,
      name_ar: product.name_ar,
    }));
  }

  async findProductContent(filterDto: FilterProductDto, isAdmin = false) {
    const result = await this.findAll(filterDto, isAdmin);

    return {
      data: (result.data ?? []).map((product) => ({
        id: product.id,
        name_en: product.name_en,
        name_ar: product.name_ar,
        long_description_en: product.long_description_en,
        long_description_ar: product.long_description_ar,
        images: this.getProductImageUrls(product.media),
      })),
      meta: result.meta,
    };
  }

  private getProductImageUrls(
    media: Array<Media & { is_primary?: boolean; sort_order?: number }> = [],
  ): string[] {
    const imageMedia = media
      .filter((item) => item?.type === MediaType.IMAGE && typeof item.url === 'string')
      .sort((left, right) => {
        const primaryDelta = Number(Boolean(right?.is_primary)) - Number(Boolean(left?.is_primary));
        if (primaryDelta !== 0) {
          return primaryDelta;
        }

        return (left?.sort_order ?? 0) - (right?.sort_order ?? 0);
      });

    return imageMedia.map((item) => item.url);
  }

  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(ProductSlugRedirect)
    private readonly slugRedirectRepository: Repository<ProductSlugRedirect>,
    @InjectRepository(ProductGroup)
    private productGroupsRepository: Repository<ProductGroup>,
    @InjectRepository(GroupProduct)
    private groupProductsRepository: Repository<GroupProduct>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @InjectRepository(ProductCategory)
    private productCategoriesRepository: Repository<ProductCategory>,
    @InjectRepository(Brand)
    private brandsRepository: Repository<Brand>,
    @InjectRepository(CartItem)
    private cartItemsRepository: Repository<CartItem>,
    private dataSource: DataSource,
    private readonly tagsService: TagsService,
    private readonly settingsService: SettingsService,
    private readonly typesenseService: TypesenseService,
    private readonly searchCacheService: SearchCacheService,
  ) {}

  private async syncProductToTypesense(productId: number): Promise<void> {
    try {
      const product = await this.productsRepository.findOne({
        where: { id: productId },
        relations: {
          productCategories: {
            category: true,
          },
          specifications: true,
          brand: true,
          category: true,
        },
      });

      if (!product) {
        await this.typesenseService.deleteProduct(String(productId));
        return;
      }

      const attributeValues = await this.dataSource
        .getRepository(ProductAttributeValue)
        .find({
          where: { product_id: productId },
          select: { attribute_value_id: true },
        });

      await this.typesenseService.upsertProduct(
        mapProductToTypesenseDoc(product, {
          attributeValueIds: attributeValues.map(
            (entry) => entry.attribute_value_id,
          ),
          specificationValueIds: (product.specifications ?? []).map(
            (entry) => entry.specification_value_id,
          ),
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to sync product ${productId} to Typesense: ${getErrorMessage(error)}`,
      );
    }
  }

  private async deleteProductFromTypesense(productId: number): Promise<void> {
    try {
      await this.typesenseService.deleteProduct(String(productId));
    } catch (error) {
      this.logger.warn(
        `Failed to delete product ${productId} from Typesense: ${getErrorMessage(error)}`,
      );
    }
  }

  async syncProductsToTypesense(productIds: number[]): Promise<void> {
    if (!this.typesenseService.isEnabled()) {
      return;
    }

    const normalizedIds = [
      ...new Set(
        productIds.filter((id) => Number.isInteger(id) && id > 0),
      ),
    ];
    if (normalizedIds.length === 0) {
      return;
    }

    const concurrency = 20;
    for (let index = 0; index < normalizedIds.length; index += concurrency) {
      const chunk = normalizedIds.slice(index, index + concurrency);
      await Promise.all(chunk.map((id) => this.syncProductToTypesense(id)));
    }

    await this.searchCacheService.invalidateSearchCache(
      `typesense sync (${normalizedIds.length} products)`,
    );
  }

  async syncProductsByBrandToTypesense(brandId: number): Promise<void> {
    if (!this.typesenseService.isEnabled()) {
      return;
    }

    const rows = await this.productsRepository.find({
      where: { brand_id: brandId },
      select: { id: true },
    });
    await this.syncProductsToTypesense(rows.map((row) => row.id));
  }

  async syncProductsByCategoryToTypesense(categoryId: number): Promise<void> {
    if (!this.typesenseService.isEnabled()) {
      return;
    }

    const rows = await this.productCategoriesRepository.find({
      where: { category_id: categoryId },
      select: { product_id: true },
    });
    await this.syncProductsToTypesense(rows.map((row) => row.product_id));
  }

  private async shouldShowSalePricing(): Promise<boolean> {
    try {
      const settings = await this.settingsService.getSeoSettings();
      return settings.show_sale_pricing !== false;
    } catch {
      return true;
    }
  }

  private async getLowStockThreshold(): Promise<number> {
    try {
      const settings = await this.settingsService.getSeoSettings();
      return settings.low_stock_threshold ?? 10;
    } catch {
      return 10;
    }
  }

  private async stripDisabledProductFieldsFromDto<T extends {
    vendor_id?: unknown;
    attributes?: unknown;
    specifications?: unknown;
    attachments?: unknown;
    linked_product_ids?: unknown;
    original_vendor_price?: unknown;
    original_vendor_sale_price?: unknown;
    original_price?: unknown;
    original_sale_price?: unknown;
    weight?: unknown;
    weight_unit?: unknown;
    length?: unknown;
    width?: unknown;
    height?: unknown;
    dimension_unit?: unknown;
  }>(dto: T): Promise<T> {
    try {
      const toggles = await this.settingsService.getProductFieldToggles();

      if (toggles.vendors_enabled === false) {
        dto.vendor_id = undefined;
        dto.linked_product_ids = undefined;
        dto.original_vendor_price = undefined;
        dto.original_vendor_sale_price = undefined;
        dto.original_price = undefined;
        dto.original_sale_price = undefined;
      }
      if (toggles.attributes_enabled === false) {
        dto.attributes = undefined;
      }
      if (toggles.specifications_enabled === false) {
        dto.specifications = undefined;
      }
      if (toggles.product_files_enabled === false) {
        dto.attachments = undefined;
      }
      if (
        toggles.linked_products_enabled === false ||
        toggles.vendors_enabled === false
      ) {
        dto.linked_product_ids = undefined;
      }
      if (toggles.weight_and_dimensions_enabled === false) {
        dto.weight = undefined;
        dto.weight_unit = undefined;
        dto.length = undefined;
        dto.width = undefined;
        dto.height = undefined;
        dto.dimension_unit = undefined;
      }
    } catch {
      // If toggles can't be read, preserve existing behavior (all enabled).
    }

    return dto;
  }

  private async stripDisabledProductFieldsFromResponse<T extends {
    attachments?: unknown;
  }>(product: T, isAdmin: boolean): Promise<T> {
    if (isAdmin) {
      return product;
    }

    try {
      const toggles = await this.settingsService.getProductFieldToggles();
      if (toggles.product_files_enabled === false) {
        product.attachments = [];
      }
    } catch {
      // If toggles can't be read, preserve existing behavior.
    }

    return product;
  }

  private resolveStorefrontPricing(
    product: Pick<Product, 'price' | 'sale_price'>,
    showSalePricing: boolean,
  ): {
    price: number;
    salePrice: number | null;
    effectivePrice: number;
  } {
    const parsedBasePrice = Number(product.price ?? 0);
    const basePrice = Number.isFinite(parsedBasePrice) ? parsedBasePrice : 0;
    const parsedSalePrice =
      product.sale_price != null ? Number(product.sale_price) : null;
    const salePrice =
      parsedSalePrice != null && Number.isFinite(parsedSalePrice)
        ? parsedSalePrice
        : null;
    const hasValidSalePrice =
      salePrice != null && salePrice > 0 && salePrice < basePrice;
    const effectivePrice = hasValidSalePrice ? salePrice : basePrice;

    if (!showSalePricing) {
      return {
        price: effectivePrice,
        salePrice: null,
        effectivePrice,
      };
    }

    return {
      price: basePrice,
      salePrice: hasValidSalePrice ? salePrice : null,
      effectivePrice,
    };
  }

  private transformStorefrontPriceGroups(
    priceGroups: Record<
      string,
      {
        price?: number | string | null;
        sale_price?: number | string | null;
      }
    > | null | undefined,
    showSalePricing: boolean,
  ) {
    if (!priceGroups) {
      return priceGroups;
    }

    return Object.fromEntries(
      Object.entries(priceGroups).map(([groupId, priceGroup]) => {
        const storefrontPricing = this.resolveStorefrontPricing(
          priceGroup as Pick<Product, 'price' | 'sale_price'>,
          showSalePricing,
        );

        return [
          groupId,
          {
            ...priceGroup,
            price: storefrontPricing.price,
            sale_price: storefrontPricing.salePrice,
          },
        ];
      }),
    );
  }

  private normalizeProductIds(productIds: number[] | undefined): number[] {
    return [
      ...new Set(
        (productIds ?? [])
          .map((productId) => Number(productId))
          .filter(
            (productId) => Number.isInteger(productId) && productId > 0,
          ),
      ),
    ];
  }

  private normalizeOriginalVendorCategoryIds(
    categories?: Array<OriginalVendorCategoryReference | null | undefined>,
  ): number[] {
    return [
      ...new Set(
        (categories ?? [])
          .map((category) => Number(category?.id))
          .filter(
            (categoryId) => Number.isInteger(categoryId) && categoryId > 0,
          ),
      ),
    ];
  }

  private normalizeOriginalVendorCategories(params: {
    categoryIds?: number[] | null;
    categories?: Array<OriginalVendorCategoryReference | null | undefined> | null;
    legacyId?: number | null;
    legacyName?: string | null;
  }): OriginalVendorCategoryReference[] {
    const orderedKeys: string[] = [];
    const categoriesByKey = new Map<string, OriginalVendorCategoryReference>();
    const sourceCategories: Array<
      OriginalVendorCategoryReference | null | undefined
    > = [
      ...(params.legacyId || params.legacyName
        ? [
            {
              ...(params.legacyId ? { id: Number(params.legacyId) } : {}),
              ...(params.legacyName ? { name: params.legacyName.trim() } : {}),
            },
          ]
        : []),
      ...this.normalizeProductIds(params.categoryIds ?? undefined).map(
        (id): OriginalVendorCategoryReference => ({ id }),
      ),
      ...(params.categories ?? []),
    ];

    for (const sourceCategory of sourceCategories) {
      const id =
        typeof sourceCategory?.id === 'number' &&
        Number.isInteger(sourceCategory.id) &&
        sourceCategory.id > 0
          ? sourceCategory.id
          : null;
      const name =
        typeof sourceCategory?.name === 'string' && sourceCategory.name.trim()
          ? sourceCategory.name.trim()
          : null;

      if (!id && !name) {
        continue;
      }

      const key = id ? `id:${id}` : `name:${name?.toLocaleLowerCase()}`;

      if (!categoriesByKey.has(key)) {
        orderedKeys.push(key);
        categoriesByKey.set(key, {
          ...(id ? { id } : {}),
          ...(name ? { name } : {}),
        });
        continue;
      }

      const existingCategory = categoriesByKey.get(key) ?? {};
      categoriesByKey.set(key, {
        ...(existingCategory.id ? { id: existingCategory.id } : {}),
        ...(id && !existingCategory.id ? { id } : {}),
        ...(existingCategory.name ? { name: existingCategory.name } : {}),
        ...(name && !existingCategory.name ? { name } : {}),
      });
    }

    return orderedKeys.map((key) => categoriesByKey.get(key) ?? {});
  }

  private normalizeReferenceLink(referenceLink?: string | null): string | null {
    const normalizedReferenceLink = referenceLink?.trim();
    return normalizedReferenceLink ? normalizedReferenceLink : null;
  }

  private normalizeReferenceLinks(
    links?: Array<string | null | undefined> | null,
    legacyLink?: string | null,
  ): string[] {
    const orderedKeys: string[] = [];
    const linksByKey = new Map<string, string>();

    for (const candidate of [...(links ?? []), legacyLink]) {
      const normalizedLink = this.normalizeReferenceLink(candidate);
      if (!normalizedLink) {
        continue;
      }

      const key = normalizedLink.toLowerCase();
      if (!linksByKey.has(key)) {
        orderedKeys.push(key);
        linksByKey.set(key, normalizedLink);
      }
    }

    return orderedKeys.map((key) => linksByKey.get(key) ?? key);
  }

  private resolveReferenceLinksForProduct(
    product: Pick<Product, 'reference_link' | 'reference_links'>,
  ): string[] {
    return this.normalizeReferenceLinks(
      product.reference_links,
      product.reference_link,
    );
  }

  private async findProductIdByReference(params: {
    referenceLink?: string | null;
    referenceSlug?: string | null;
  }): Promise<number | null> {
    const normalizedReferenceLink = this.normalizeReferenceLink(
      params.referenceLink,
    );
    const normalizedReferenceSlug = this.normalizeReferenceSlug(
      params.referenceSlug,
    );

    if (!normalizedReferenceLink && !normalizedReferenceSlug) {
      return null;
    }

    const query = this.productsRepository
      .createQueryBuilder('product')
      .select(['product.id']);

    const conditions: string[] = [];
    const queryParams: Record<string, string> = {};

    if (normalizedReferenceLink) {
      conditions.push(
        `(
          btrim(product.reference_link) = :referenceLink
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(product.reference_links, '[]'::jsonb)) AS reference_links(value)
            WHERE btrim(reference_links.value) = :referenceLink
          )
        )`,
      );
      queryParams.referenceLink = normalizedReferenceLink;
    }

    if (normalizedReferenceSlug) {
      conditions.push('btrim(product.reference_slug) = :referenceSlug');
      queryParams.referenceSlug = normalizedReferenceSlug;
    }

    query.where(conditions.join(' AND '), queryParams);

    const product = await query.getOne();
    return product?.id ?? null;
  }

  private async findProductIdByReferenceLink(
    referenceLink: string,
  ): Promise<number | null> {
    return this.findProductIdByReference({ referenceLink });
  }

  private async ensureReferenceLinksAreUnique(
    referenceLinks: string[],
    excludeProductId?: number,
  ): Promise<string[]> {
    const normalizedReferenceLinks =
      this.normalizeReferenceLinks(referenceLinks);

    for (const referenceLink of normalizedReferenceLinks) {
      await this.ensureReferenceLinkIsUnique(referenceLink, excludeProductId);
    }

    return normalizedReferenceLinks;
  }

  private normalizeReferenceSlug(referenceSlug?: string | null): string | null {
    const normalizedReferenceSlug = referenceSlug?.trim();
    return normalizedReferenceSlug ? normalizedReferenceSlug : null;
  }

  private async ensureReferenceLinkIsUnique(
    referenceLink?: string | null,
    excludeProductId?: number,
  ): Promise<string | null> {
    const normalizedReferenceLink =
      this.normalizeReferenceLink(referenceLink);

    if (!normalizedReferenceLink) {
      return null;
    }

    const existingProductQuery = this.productsRepository
      .createQueryBuilder('product')
      .select(['product.id'])
      .where(
        `(
          btrim(product.reference_link) = :referenceLink
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(COALESCE(product.reference_links, '[]'::jsonb)) AS reference_links(value)
            WHERE btrim(reference_links.value) = :referenceLink
          )
        )`,
        { referenceLink: normalizedReferenceLink },
      );

    if (excludeProductId !== undefined) {
      existingProductQuery.andWhere('product.id != :excludeProductId', {
        excludeProductId,
      });
    }

    const existingProduct = await existingProductQuery.getOne();

    if (existingProduct) {
      throw new BadRequestException('reference link existed');
    }

    return normalizedReferenceLink;
  }

  private resolveIsOutOfStock(params: {
    quantity: number;
    requestedState?: boolean;
    currentState?: boolean;
    fallbackState?: boolean;
  }): boolean {
    const {
      quantity,
      requestedState,
      currentState,
      fallbackState = false,
    } = params;

    if (quantity <= 0) {
      return true;
    }

    if (requestedState !== undefined) {
      return requestedState;
    }

    if (currentState !== undefined) {
      return currentState;
    }

    return fallbackState;
  }

  private toOptionalFiniteNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') {
      return null;
    }

    const numericValue =
      typeof value === 'number' ? value : Number(String(value).trim());

    return Number.isFinite(numericValue) ? numericValue : null;
  }

  private resolveCategoryIdsForPricing(params: {
    dtoCategoryIds?: number[];
    existingCategoryId?: number | null;
    existingProductCategories?: Array<{ category_id?: number | null }>;
  }): number[] {
    if (Array.isArray(params.dtoCategoryIds)) {
      return [
        ...new Set(
          params.dtoCategoryIds.filter(
            (categoryId): categoryId is number =>
              Number.isInteger(categoryId) && categoryId > 0,
          ),
        ),
      ];
    }

    const categoryIds = new Set<number>();
    if (
      typeof params.existingCategoryId === 'number' &&
      params.existingCategoryId > 0
    ) {
      categoryIds.add(params.existingCategoryId);
    }

    for (const productCategory of params.existingProductCategories ?? []) {
      if (
        typeof productCategory?.category_id === 'number' &&
        productCategory.category_id > 0
      ) {
        categoryIds.add(productCategory.category_id);
      }
    }

    return Array.from(categoryIds);
  }

  private async computeManagedPricingFromOriginalInput(
    context: ProductPricingComputationContext,
  ): Promise<{ price: number; sale_price: number | null } | null> {
    const originalVendorPrice = this.toOptionalFiniteNumber(
      context.original_vendor_price,
    );

    if (originalVendorPrice === null || originalVendorPrice <= 0) {
      return null;
    }

    const originalVendorSalePrice = this.toOptionalFiniteNumber(
      context.original_vendor_sale_price,
    );

    const managedPricing = await this.settingsService.calculateManagedProductPrices(
      {
        originalVendorPrice,
        originalVendorSalePrice,
        vendorId: context.vendor_id ?? null,
        brandId: context.brand_id ?? null,
        categoryIds: context.categoryIds,
      },
    );

    return {
      price: managedPricing.price,
      sale_price: managedPricing.salePrice,
    };
  }

  private async ensureProductsExist(
    productIds: number[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    if (!productIds.length) {
      return;
    }

    const existingProducts = await manager.find(Product, {
      where: { id: In(productIds) },
      select: {
        id: true
      },
    });

    const existingIds = new Set(existingProducts.map((product) => product.id));
    const missingProductIds = productIds.filter(
      (productId) => !existingIds.has(productId),
    );

    if (missingProductIds.length > 0) {
      throw new BadRequestException(
        `Linked products not found: ${missingProductIds.join(', ')}`,
      );
    }
  }

  private toLinkedProductSummary(product: Product) {
    return {
      id: product.id,
      name_en: product.name_en,
      name_ar: product.name_ar,
      slug: product.slug,
      sku: product.sku,
    };
  }

  private async getLinkedProductsState(productId: number): Promise<{
    linked_group_id: number | null;
    linked_product_ids: number[];
    linked_products: Array<{
      id: number;
      name_en: string;
      name_ar: string;
      slug: string;
      sku: string;
    }>;
  }> {
    const membership = await this.groupProductsRepository.findOne({
      where: { product_id: productId },
      relations: {
        group: {
          groupProducts: {
            product: true
          }
        }
      },
    });

    if (!membership?.group) {
      return {
        linked_group_id: null,
        linked_product_ids: [],
        linked_products: [],
      };
    }

    const linkedProducts = (membership.group.groupProducts ?? [])
      .map((groupProduct) => groupProduct.product)
      .filter((product): product is Product => !!product && product.id !== productId)
      .sort((left, right) => left.id - right.id)
      .map((product) => this.toLinkedProductSummary(product));

    return {
      linked_group_id: membership.group_id,
      linked_product_ids: linkedProducts.map((product) => product.id),
      linked_products: linkedProducts,
    };
  }

  private async cleanupOrphanedProductGroups(
    manager: EntityManager,
    groupIds: number[],
  ): Promise<void> {
    const uniqueGroupIds = [...new Set(groupIds)].filter(Boolean);

    if (!uniqueGroupIds.length) {
      return;
    }

    const existingGroupProducts = await manager.find(GroupProduct, {
      where: { group_id: In(uniqueGroupIds) },
    });

    const groupProductsByGroupId = new Map<number, GroupProduct[]>();
    uniqueGroupIds.forEach((groupId) => groupProductsByGroupId.set(groupId, []));

    existingGroupProducts.forEach((groupProduct) => {
      const memberships = groupProductsByGroupId.get(groupProduct.group_id) ?? [];
      memberships.push(groupProduct);
      groupProductsByGroupId.set(groupProduct.group_id, memberships);
    });

    const groupProductIdsToDelete: number[] = [];
    const groupIdsToDelete: number[] = [];

    groupProductsByGroupId.forEach((memberships, groupId) => {
      if (memberships.length < 2) {
        groupProductIdsToDelete.push(...memberships.map((membership) => membership.id));
        groupIdsToDelete.push(groupId);
      }
    });

    if (groupProductIdsToDelete.length > 0) {
      await manager.delete(GroupProduct, groupProductIdsToDelete);
    }

    if (groupIdsToDelete.length > 0) {
      await manager.delete(ProductGroup, groupIdsToDelete);
    }
  }

  private async syncProductGroupMemberships(
    productIds: number[],
  ): Promise<number | null> {
    const normalizedProductIds = this.normalizeProductIds(productIds);

    if (!normalizedProductIds.length) {
      return null;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const existingMemberships = await queryRunner.manager.find(GroupProduct, {
        where: { product_id: In(normalizedProductIds) },
      });
      const touchedGroupIds = existingMemberships.map(
        (membership) => membership.group_id,
      );

      await queryRunner.manager.delete(GroupProduct, {
        product_id: In(normalizedProductIds),
      });

      let linkedGroupId: number | null = null;

      if (normalizedProductIds.length > 1) {
        const createdGroup = await queryRunner.manager.save(
          ProductGroup,
          queryRunner.manager.create(ProductGroup, { name: null }),
        );

        linkedGroupId = createdGroup.id;

        const groupProducts = normalizedProductIds.map((currentProductId) =>
          queryRunner.manager.create(GroupProduct, {
            group_id: createdGroup.id,
            product_id: currentProductId,
          }),
        );

        await queryRunner.manager.save(GroupProduct, groupProducts);
      }

      await this.cleanupOrphanedProductGroups(
        queryRunner.manager,
        touchedGroupIds,
      );

      await queryRunner.commitTransaction();
      return linkedGroupId;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async syncProductsGroup(productIds: number[]): Promise<{
    linked_group_id: number | null;
    product_ids: number[];
    products: Array<{
      id: number;
      name_en: string;
      name_ar: string;
      slug: string;
      sku: string;
    }>;
    message: string;
  }> {
    const normalizedProductIds = this.normalizeProductIds(productIds);

    if (!normalizedProductIds.length) {
      throw new BadRequestException(
        'product_ids must contain at least one valid product id',
      );
    }

    await this.ensureProductsExist(normalizedProductIds);

    try {
      const linkedGroupId = await this.syncProductGroupMemberships(
        normalizedProductIds,
      );
      const products = await this.productsRepository.find({
        where: { id: In(normalizedProductIds) },
        select: {
          id: true,
          name_en: true,
          name_ar: true,
          slug: true,
          sku: true
        },
      });
      const sortedProducts = products
        .sort((left, right) => left.id - right.id)
        .map((product) => this.toLinkedProductSummary(product));

      return {
        linked_group_id: linkedGroupId,
        product_ids: sortedProducts.map((product) => product.id),
        products: sortedProducts,
        message:
          sortedProducts.length > 1
            ? 'Product links synced successfully.'
            : 'Product links cleared successfully.',
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to sync linked products group: ${getErrorMessage(error)}`,
      );
    }
  }

  async syncLinkedProducts(
    productId: number,
    linkedProductIds: number[],
  ): Promise<{
    product_id: number;
    linked_group_id: number | null;
    linked_product_ids: number[];
    linked_products: Array<{
      id: number;
      name_en: string;
      name_ar: string;
      slug: string;
      sku: string;
    }>;
    message: string;
  }> {
    const toggles = await this.settingsService.getProductFieldToggles();
    if (
      toggles.linked_products_enabled === false ||
      toggles.vendors_enabled === false
    ) {
      throw new BadRequestException('Linked products are disabled');
    }

    const product = await this.productsRepository.findOne({
      where: { id: productId },
      select: {
        id: true
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const normalizedLinkedProductIds = this.normalizeProductIds(
      linkedProductIds,
    ).filter((linkedProductId) => linkedProductId !== productId);

    const targetProductIds = [productId, ...normalizedLinkedProductIds];
    await this.ensureProductsExist(targetProductIds);

    try {
      await this.syncProductGroupMemberships(targetProductIds);
    } catch (error) {
      throw new BadRequestException(
        `Failed to sync linked products: ${getErrorMessage(error)}`,
      );
    }

    const linkedProductsState = await this.getLinkedProductsState(productId);

    return {
      product_id: productId,
      ...linkedProductsState,
      message:
        linkedProductsState.linked_product_ids.length > 0
          ? 'Linked products synced successfully.'
          : 'Linked products cleared successfully.',
    };
  }

  async getProductTags(productId: number): Promise<Tag[]> {
    const product = await this.productsRepository.findOne({
      where: { id: productId },
      relations: {
        tags: true
      },
    } as any);
    if (!product) throw new NotFoundException('Product not found');
    return (product as any).tags ?? [];
  }

  async syncProductTags(productId: number, tagNames: string[]): Promise<Tag[]> {
    const exists = await this.productsRepository.count({
      where: { id: productId },
    });
    if (!exists) throw new NotFoundException('Product not found');
    await this.applyTagsToProduct(productId, tagNames);
    return this.getProductTags(productId);
  }

  async addProductTagByName(productId: number, tagName: string): Promise<Tag> {
    const exists = await this.productsRepository.count({
      where: { id: productId },
    });
    if (!exists) throw new NotFoundException('Product not found');
    const tag = await this.tagsService.findOrCreate(tagName);
    await this.productsRepository
      .createQueryBuilder()
      .relation(Product, 'tags')
      .of(productId)
      .add(tag.id);
    return tag;
  }

  async removeProductTag(productId: number, tagId: number): Promise<void> {
    const exists = await this.productsRepository.count({
      where: { id: productId },
    });
    if (!exists) throw new NotFoundException('Product not found');
    await this.productsRepository
      .createQueryBuilder()
      .relation(Product, 'tags')
      .of(productId)
      .remove(tagId);
  }

  private async applyTagsToProduct(
    productId: number,
    tagNames: string[],
  ): Promise<void> {
    const normalizedNames = [
      ...new Set(tagNames.map((n) => n.toLowerCase().trim()).filter(Boolean)),
    ];

    // Resolve (or create) tags sequentially — findOrCreate uses upsert logic
    const resolvedTags: Tag[] = [];
    for (const name of normalizedNames) {
      const tag = await this.tagsService.findOrCreate(name);
      resolvedTags.push(tag);
    }

    // Load existing tags so we can compute what to remove
    const current = await this.productsRepository.findOne({
      where: { id: productId },
      relations: {
        tags: true
      },
    } as any);

    const currentIds: number[] = ((current as any)?.tags ?? []).map(
      (t: any) => t.id,
    );
    const newIds = resolvedTags.map((t) => t.id);

    await this.productsRepository
      .createQueryBuilder()
      .relation(Product, 'tags')
      .of(productId)
      .addAndRemove(newIds, currentIds);
  }


  private slugify(text: string): string {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-') // Replace spaces with -
      .replace(/[^\w\-]+/g, '') // Remove all non-word chars
      .replace(/\-\-+/g, '-') // Replace multiple - with single -
      .replace(/^-+/, '') // Trim - from start of text
      .replace(/-+$/, ''); // Trim - from end of text
  }

  private async generateUniqueSlug(
    name: string,
    currentId?: number,
  ): Promise<string> {
    const baseSlug = this.slugify(name);
    let finalSlug = baseSlug;
    let counter = 1;

    // Find all slugs that start with the baseSlug
    const existingProducts = await this.productsRepository.find({
      select: {
        slug: true,
        id: true
      },
      where: {
        slug: Like(`${baseSlug}%`),
      },
    });

    // Check availability
    const isAvailable = (slug: string) => {
      const match = existingProducts.find((p) => p.slug === slug);
      if (!match) return true; // No product has this slug
      if (currentId && match.id === currentId) return true; // It's the current product's slug
      return false; // Taken by someone else
    };

    while (!isAvailable(finalSlug)) {
      counter++;
      finalSlug = `${baseSlug}-${counter}`;
    }

    return finalSlug;
  }

  private normalizeProductSpecifications(
    specifications: ProductSpecificationInputDto[],
  ): ProductSpecificationInputDto[] {
    const seenSpecificationIds = new Set<number>();

    return specifications.map((specification) => {
      if (seenSpecificationIds.has(specification.specification_id)) {
        throw new BadRequestException(
          `Duplicate specification_id ${specification.specification_id} in payload`,
        );
      }

      seenSpecificationIds.add(specification.specification_id);

      return {
        specification_id: specification.specification_id,
        specification_value_ids: [
          ...new Set(specification.specification_value_ids.map(Number)),
        ],
      };
    });
  }

  private normalizeProductAttributes(
    attributes: ProductAttributeInputDto[],
  ): ProductAttributeInputDto[] {
    const seenAttributeIds = new Set<number>();

    return attributes.map((attribute) => {
      if (seenAttributeIds.has(attribute.attribute_id)) {
        throw new BadRequestException(
          `Duplicate attribute_id ${attribute.attribute_id} in payload`,
        );
      }

      seenAttributeIds.add(attribute.attribute_id);

      const attributeValueIds = [
        ...new Set((attribute.attribute_value_ids ?? []).map(Number)),
      ];

      if (attributeValueIds.length !== 1) {
        throw new BadRequestException(
          `Attribute ${attribute.attribute_id} must have exactly one attribute value`,
        );
      }

      return {
        attribute_id: attribute.attribute_id,
        attribute_value_ids: attributeValueIds,
      };
    });
  }

  private async resolveProductAttributeValueIds(
    attributes: ProductAttributeInputDto[],
  ): Promise<number[]> {
    const normalizedAttributes = this.normalizeProductAttributes(attributes);
    const requestedValueIds = normalizedAttributes.map(
      (attribute) => attribute.attribute_value_ids[0],
    );

    if (requestedValueIds.length === 0) {
      return [];
    }

    const attributeValues = await this.dataSource
      .getRepository(AttributeValue)
      .find({
        where: { id: In(requestedValueIds) },
        relations: {
          attribute: true
        },
      });

    if (attributeValues.length !== requestedValueIds.length) {
      throw new BadRequestException(
        'One or more attribute values were not found',
      );
    }

    const attributeValueMap = new Map(
      attributeValues.map((attributeValue) => [attributeValue.id, attributeValue]),
    );

    for (const attribute of normalizedAttributes) {
      const attributeValueId = attribute.attribute_value_ids[0];
      const attributeValue = attributeValueMap.get(attributeValueId);

      if (!attributeValue) {
        throw new BadRequestException(
          `Attribute value ${attributeValueId} was not found`,
        );
      }

      if (!attributeValue.is_active) {
        throw new BadRequestException(
          `Attribute value ${attributeValueId} is inactive`,
        );
      }

      if (!attributeValue.attribute?.is_active) {
        throw new BadRequestException(
          `Attribute ${attribute.attribute_id} is inactive`,
        );
      }

      if (attributeValue.attribute_id !== attribute.attribute_id) {
        throw new BadRequestException(
          `Attribute value ${attributeValueId} does not belong to attribute ${attribute.attribute_id}`,
        );
      }
    }

    return requestedValueIds;
  }

  private async resolveProductSpecificationValueIds(
    specifications: ProductSpecificationInputDto[],
  ): Promise<number[]> {
    const normalizedSpecifications = this.normalizeProductSpecifications(
      specifications,
    );
    const requestedValueIds = [
      ...new Set(
        normalizedSpecifications.flatMap(
          (specification) => specification.specification_value_ids,
        ),
      ),
    ];

    if (requestedValueIds.length === 0) {
      return [];
    }

    const specificationValues = await this.dataSource
      .getRepository(SpecificationValue)
      .find({
        where: { id: In(requestedValueIds) },
        relations: {
          specification: true
        },
      });

    if (specificationValues.length !== requestedValueIds.length) {
      throw new BadRequestException(
        'One or more specification values were not found',
      );
    }

    const specificationValueMap = new Map(
      specificationValues.map((value) => [value.id, value]),
    );

    for (const specification of normalizedSpecifications) {
      for (const valueId of specification.specification_value_ids) {
        const specificationValue = specificationValueMap.get(valueId);

        if (!specificationValue) {
          throw new BadRequestException(
            `Specification value ${valueId} was not found`,
          );
        }

        if (!specificationValue.is_active) {
          throw new BadRequestException(
            `Specification value ${valueId} is inactive`,
          );
        }

        if (!specificationValue.specification?.is_active) {
          throw new BadRequestException(
            `Specification ${specification.specification_id} is inactive`,
          );
        }

        if (
          specificationValue.specification_id !==
          specification.specification_id
        ) {
          throw new BadRequestException(
            `Specification value ${valueId} does not belong to specification ${specification.specification_id}`,
          );
        }
      }
    }

    return requestedValueIds;
  }

  private async syncProductMedia(
    productId: number,
    mediaItems: { media_id: number; is_primary?: boolean; sort_order?: number }[],
  ): Promise<void> {
    const productMediaRepo = this.dataSource.getRepository(ProductMedia);
    const mediaRepo = this.dataSource.getRepository(Media);

    // Validate: only one primary image allowed
    const primaryCount = mediaItems.filter((m) => m.is_primary).length;
    if (primaryCount > 1) {
      throw new BadRequestException(
        `Product can only have one primary image. Found ${primaryCount} items marked as primary.`,
      );
    }

    const mediaIds = mediaItems.map((item) => item.media_id);
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new BadRequestException(
        'Duplicate media IDs are not allowed in a product payload.',
      );
    }

    const existingLinks = await productMediaRepo.find({
      where: { product_id: productId },
    });
    const existingMap = new Map(
      existingLinks.map((productMedia) => [productMedia.media_id, productMedia]),
    );
    const payloadIds = new Set<number>();

    if (mediaIds.length > 0) {
      const uniqueMediaIds = [...new Set(mediaIds)];
      const existingMedia = await mediaRepo.find({
        where: { id: In(uniqueMediaIds) },
      });
      const existingIds = new Set(existingMedia.map((media) => media.id));
      const missingIds = uniqueMediaIds.filter((mediaId) => !existingIds.has(mediaId));

      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Media with ID ${missingIds.join(', ')} not found`,
        );
      }
    }

    // Link / update media in payload
    const linksToSave = mediaItems.map((item, index) => {
      payloadIds.add(item.media_id);

      const existing = existingMap.get(item.media_id);
      if (existing) {
        existing.is_primary = item.is_primary ?? false;
        existing.sort_order = item.sort_order ?? index;
        return existing;
      }

      return productMediaRepo.create({
        product_id: productId,
        media_id: item.media_id,
        is_primary: item.is_primary ?? false,
        sort_order: item.sort_order ?? index,
      });
    });

    if (linksToSave.length > 0) {
      await productMediaRepo.save(linksToSave);
    }

    // Unlink media not in payload
    const linkIdsToDelete = existingLinks
      .filter((productMedia) => !payloadIds.has(productMedia.media_id))
      .map((productMedia) => productMedia.id);

    if (linkIdsToDelete.length > 0) {
      await productMediaRepo.delete(linkIdsToDelete);
    }
  }

  private async syncProductAttachments(
    productId: number,
    attachmentItems: { media_id: number; sort_order?: number }[],
  ): Promise<void> {
    if (attachmentItems.length > 3) {
      throw new BadRequestException(
        'A product can have at most 3 downloadable attachments.',
      );
    }

    const productAttachmentRepo =
      this.dataSource.getRepository(ProductAttachment);
    const mediaRepo = this.dataSource.getRepository(Media);

    const mediaIds = attachmentItems.map((item) => item.media_id);
    if (new Set(mediaIds).size !== mediaIds.length) {
      throw new BadRequestException(
        'Duplicate attachment media IDs are not allowed in a product payload.',
      );
    }

    const existingLinks = await productAttachmentRepo.find({
      where: { product_id: productId },
    });
    const existingMap = new Map(
      existingLinks.map((productAttachment) => [
        productAttachment.media_id,
        productAttachment,
      ]),
    );
    const payloadIds = new Set<number>();

    if (mediaIds.length > 0) {
      const uniqueMediaIds = [...new Set(mediaIds)];
      const existingMedia = await mediaRepo.find({
        where: { id: In(uniqueMediaIds) },
      });
      const existingIds = new Set(existingMedia.map((media) => media.id));
      const missingIds = uniqueMediaIds.filter(
        (mediaId) => !existingIds.has(mediaId),
      );

      if (missingIds.length > 0) {
        throw new NotFoundException(
          `Attachment media with ID ${missingIds.join(', ')} not found`,
        );
      }

      const invalidTypeIds = existingMedia
        .filter((media) => media.type !== MediaType.DOCUMENT)
        .map((media) => media.id);

      if (invalidTypeIds.length > 0) {
        throw new BadRequestException(
          `Media IDs ${invalidTypeIds.join(', ')} are not document attachments.`,
        );
      }
    }

    const linksToSave = attachmentItems.map((item, index) => {
      payloadIds.add(item.media_id);

      const existing = existingMap.get(item.media_id);
      if (existing) {
        existing.sort_order = item.sort_order ?? index;
        return existing;
      }

      return productAttachmentRepo.create({
        product_id: productId,
        media_id: item.media_id,
        sort_order: item.sort_order ?? index,
      });
    });

    if (linksToSave.length > 0) {
      await productAttachmentRepo.save(linksToSave);
    }

    const linkIdsToDelete = existingLinks
      .filter((productAttachment) => !payloadIds.has(productAttachment.media_id))
      .map((productAttachment) => productAttachment.id);

    if (linkIdsToDelete.length > 0) {
      await productAttachmentRepo.delete(linkIdsToDelete);
    }
  }

  private async syncProductAttributes(
    productId: number,
    attributes: ProductAttributeInputDto[],
  ): Promise<void> {
    const productAttributeRepository = this.dataSource.getRepository(ProductAttribute);
    const productAttributeValueRepository = this.dataSource.getRepository(ProductAttributeValue);

    await productAttributeRepository.delete({ product_id: productId });
    await productAttributeValueRepository.delete({ product_id: productId });

    if (!attributes.length) {
      return;
    }

    const normalizedAttributes = this.normalizeProductAttributes(attributes);
    const uniqueAttributeIds = normalizedAttributes.map(
      (attribute) => attribute.attribute_id,
    );
    await productAttributeRepository.save(
      uniqueAttributeIds.map(attribute_id =>
        productAttributeRepository.create({
          product_id: productId,
          attribute_id,
        })
      )
    );

    const uniqueAttributeValueIds =
      await this.resolveProductAttributeValueIds(normalizedAttributes);

    if (uniqueAttributeValueIds.length > 0) {
      await productAttributeValueRepository.save(
        uniqueAttributeValueIds.map(attribute_value_id =>
          productAttributeValueRepository.create({
            product_id: productId,
            attribute_value_id,
          })
        )
      );
    }
  }

  private async syncProductSpecifications(
    productId: number,
    specifications: ProductSpecificationInputDto[],
  ): Promise<void> {
    const productSpecificationRepository = this.dataSource.getRepository(
      ProductSpecificationValue,
    );

    await productSpecificationRepository.delete({ product_id: productId });

    if (!specifications.length) {
      return;
    }

    const specificationValueIds =
      await this.resolveProductSpecificationValueIds(specifications);

    if (!specificationValueIds.length) {
      return;
    }

    await productSpecificationRepository.save(
      specificationValueIds.map((specificationValueId) =>
        productSpecificationRepository.create({
          product_id: productId,
          specification_value_id: specificationValueId,
        }),
      ),
    );
  }

  async create(dto: CreateProductDto, userId?: number, user?: { role: string; adminAccess?: unknown; vendorId?: number | null; authSource?: 'user' | 'vendor' }): Promise<any> {
    try {
      const creatorContext = {
        role: user?.role,
        authSource: user?.authSource,
        vendorId: user?.vendorId ?? null,
      };

      if (isSimplifiedProductCreator(creatorContext)) {
        dto = validateAndNormalizeSimplifiedCreateDto(dto, creatorContext);
      } else {
        if (!dto.category_ids?.length) {
          throw new BadRequestException('At least one category is required');
        }
        if (!dto.short_description_en?.trim() || !dto.short_description_ar?.trim()) {
          throw new BadRequestException('Short descriptions in English and Arabic are required');
        }
      }

      if (user && !hasAdminAccess(user as any, 'product_pricing') && !isSimplifiedProductCreator(creatorContext)) {
        dto = stripProductPricingFields(dto);
      }
      // Validate categories exist and are active
      if (dto.category_ids && dto.category_ids.length > 0) {
        const categories = await this.categoriesRepository.find({
          where: { id: In(dto.category_ids), status: CategoryStatus.ACTIVE },
        });
        if (categories.length !== dto.category_ids.length) {
          throw new BadRequestException(
            'One or more categories not found or are archived',
          );
        }
      }

      // Validate brand exists and is active if provided
      if (dto.brand_id !== undefined) {
        const brand = await this.brandsRepository.findOne({
          where: { id: dto.brand_id, status: BrandStatus.ACTIVE },
        });
        if (!brand) {
          throw new BadRequestException('Brand not found or inactive');
        }
      }

      // Enforce product field toggles — silently drop disabled fields before persisting.
      // Existing rows keep their data; only the incoming change is dropped.
      dto = await this.stripDisabledProductFieldsFromDto(dto);

      if (dto.attributes && dto.attributes.length > 0) {
        await this.resolveProductAttributeValueIds(dto.attributes);
      }

      if (dto.specifications && dto.specifications.length > 0) {
        await this.resolveProductSpecificationValueIds(dto.specifications);
      }

      const slug = await this.generateUniqueSlug(dto.name_en);
      const initialQuantity = dto.quantity ?? 0;
      const initialIsOutOfStock = this.resolveIsOutOfStock({
        quantity: initialQuantity,
        requestedState: dto.is_out_of_stock,
      });
      const originalVendorCategories = this.normalizeOriginalVendorCategories({
        categoryIds: dto.original_vendor_categories_ids,
        categories: dto.original_vendor_categories,
        legacyId: dto.original_vendor_category_id ?? null,
        legacyName: dto.original_vendor_category_name ?? null,
      });
      const primaryOriginalVendorCategory = originalVendorCategories[0] ?? null;
      const normalizedReferenceLinks = await this.ensureReferenceLinksAreUnique(
        this.normalizeReferenceLinks(dto.reference_links, dto.reference_link),
      );
      const normalizedReferenceLink = normalizedReferenceLinks[0] ?? null;
      const lowStockThreshold = await this.getLowStockThreshold();
      const originalVendorPriceForRule =
        dto.original_vendor_price ??
        dto.original_price ??
        dto.price ??
        null;
      const originalVendorSalePriceForRule =
        dto.original_vendor_sale_price ??
        dto.original_sale_price ??
        dto.sale_price ??
        null;
      const managedPricingFromRule = isSimplifiedProductCreator(creatorContext)
        ? null
        : await this.computeManagedPricingFromOriginalInput({
          vendor_id: dto.vendor_id ?? null,
          brand_id: dto.brand_id ?? null,
          categoryIds: dto.category_ids ?? [],
          original_vendor_price: originalVendorPriceForRule,
          original_vendor_sale_price: originalVendorSalePriceForRule,
        });

      // 1. Create basic product (primary category is first in the list)
      const product = this.productsRepository.create({
        name_en: dto.name_en,
        name_ar: dto.name_ar,
        slug: slug,
        sku: dto.sku,
        record: dto.record ?? null,
        short_description_en: dto.short_description_en,
        short_description_ar: dto.short_description_ar,
        long_description_en: dto.long_description_en,
        long_description_ar: dto.long_description_ar,
        reference_link: normalizedReferenceLink,
        reference_links: normalizedReferenceLinks,
        reference_slug: this.normalizeReferenceSlug(dto.reference_slug),
        category_id: dto.category_ids?.[0],
        vendor_id: dto.vendor_id,
        original_vendor_categories: originalVendorCategories,
        original_vendor_category_id:
          primaryOriginalVendorCategory?.id ?? null,
        original_vendor_category_name:
          primaryOriginalVendorCategory?.name ?? null,
        brand_id: dto.brand_id,
        status: dto.status ?? ProductStatus.ACTIVE,
        visible: dto.visible ?? true,
        created_by: userId ?? null,
        cost: dto.cost ?? 0,
        price: managedPricingFromRule?.price ?? dto.price ?? 0,
        sale_price: managedPricingFromRule?.sale_price ?? dto.sale_price ?? null,
        original_vendor_price:
          dto.original_vendor_price ??
          dto.original_price ??
          dto.price ??
          null,
        original_vendor_sale_price:
          dto.original_vendor_sale_price ??
          dto.original_sale_price ??
          dto.sale_price ??
          null,
        weight: dto.weight ?? null,
        length: dto.length ?? null,
        width: dto.width ?? null,
        height: dto.height ?? null,
        quantity: initialQuantity,
        low_stock_threshold: lowStockThreshold,
        is_out_of_stock: initialIsOutOfStock,
        meta_title_en: dto.meta_title_en ?? null,
        meta_title_ar: dto.meta_title_ar ?? null,
        meta_description_en: dto.meta_description_en ?? null,
        meta_description_ar: dto.meta_description_ar ?? null,
      });
      const savedProduct = await this.productsRepository.save(product);

      // 2. Create product-category relationships
      if (dto.category_ids && dto.category_ids.length > 0) {
        const productCategories = dto.category_ids.map((categoryId) =>
          this.productCategoriesRepository.create({
            product_id: savedProduct.id,
            category_id: categoryId,
          }),
        );
        await this.productCategoriesRepository.save(productCategories);
      }

      // 4. Parallel Creation of Children
      const creationTasks: Promise<any>[] = [];
      const id = savedProduct.id;

      // 3. Add attributes if provided
      if (dto.attributes && dto.attributes.length > 0) {
        creationTasks.push(this.syncProductAttributes(id, dto.attributes));
      }

      // Handle Media
      if (dto.media && dto.media.length > 0) {
        creationTasks.push(this.syncProductMedia(id, dto.media));
      }

      // Handle Attachments
      if (dto.attachments && dto.attachments.length > 0) {
        creationTasks.push(this.syncProductAttachments(id, dto.attachments));
      }

      // Handle Specifications
      if (dto.specifications && dto.specifications.length > 0) {
        creationTasks.push(
          this.syncProductSpecifications(id, dto.specifications),
        );
      }

      await Promise.all(creationTasks);

      // Apply tags if provided in the DTO
      if (dto.tags?.length) {
        await this.applyTagsToProduct(savedProduct.id, dto.tags);
      }

      if (dto.linked_product_ids !== undefined) {
        await this.syncLinkedProducts(savedProduct.id, dto.linked_product_ids);
      }

      // Return the complete product (admin context — include out-of-stock rows)
      const result = await this.findOne(savedProduct.id, true);
      await this.syncProductToTypesense(savedProduct.id);

      return {
        product: result,
        message: 'Product created successfully.',
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to create product: ${getErrorMessage(error)}`,
      );
    }
  }

  async findAll(filterDto: FindAllProductsOptions, isAdmin = false) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      categoryId,
      vendorId,
      vendor_ids,
      has_no_vendor,
      brandId,
      brand_ids,
      has_no_brand,
      attributes_ids,
      attributes_values_ids,
      specifications_ids,
      specifications_values_ids,
      created_by,
      minPrice,
      maxPrice,
      has_sale,
      minRating,
      maxRating,
      status,
      visible,
      search,
      sku,
      in_stock,
      has_duplicate_reference_link,
      start_date,
      end_date,
      ids: filterIds,
    } = filterDto;
    const normalizedCategoryIds = getCategoryIds(filterDto);
    const normalizedVendorId = getSingleVendorId(filterDto);
    const normalizedVendorIds = [
      ...new Set(
        [normalizedVendorId, ...(vendor_ids ?? [])].filter(
          (candidate): candidate is number =>
            typeof candidate === 'number' &&
            Number.isInteger(candidate) &&
            candidate > 0,
        ),
      ),
    ];
    const normalizedBrandIds = [
      ...new Set(
        [brandId, ...(brand_ids ?? [])].filter(
          (candidate): candidate is number =>
            typeof candidate === 'number' &&
            Number.isInteger(candidate) &&
            candidate > 0,
        ),
      ),
    ];
    const normalizedOriginalVendorCategoryId =
      getOriginalVendorCategoryId(filterDto);

    // NOTE: The list view previously did a huge multi-join + getManyAndCount.
    // With relations like media/variants/stock/groups, this causes row explosion and slow COUNT.
    // We optimize by:
    // 1) Building a lightweight base query for filters + count + paginated IDs
    // 2) Fetching full relations only for the page of product IDs

    const baseQuery = this.productsRepository.createQueryBuilder('product');

    // Filter by status (override default ACTIVE if specified)
    if (status !== undefined) {
      baseQuery.where('product.status = :status', { status });
    } else if (isAdmin) {
      baseQuery.where('product.status IN (:...defaultStatuses)', {
        defaultStatuses: [
          ProductStatus.ACTIVE,
          ProductStatus.REVIEW,
          ProductStatus.UPDATED,
        ],
      });
    } else {
      baseQuery.where('product.status IN (:...defaultStatuses)', {
        defaultStatuses: [
          ProductStatus.ACTIVE,
          ProductStatus.REVIEW,
          ProductStatus.UPDATED,
        ],
      });
    }

    // Filter by IDs
    if (filterIds && filterIds.length > 0) {
      baseQuery.andWhere('product.id IN (:...filterIds)', { filterIds });
    }

    // Filter by visible (default to visible-only; an explicit query param overrides this)
    baseQuery.andWhere('product.visible = :visible', {
      visible: visible !== undefined ? visible : true,
    });

    // Filter by single category (backward compat or "none")
    if (categoryId) {
      if (categoryId === 'none') {
        baseQuery.andWhere(
          'NOT EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = product.id)'
        );
      } else {
        baseQuery.andWhere(
          'EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = product.id AND pc.category_id = :categoryId)',
          { categoryId },
        );
      }
    }

    // Filter by multiple categories (OR logic — product must belong to at least one)
    if (normalizedCategoryIds.length > 0) {
      baseQuery.andWhere(
        'EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = product.id AND pc.category_id IN (:...category_ids))',
        { category_ids: normalizedCategoryIds },
      );
    }

    if (attributes_ids && attributes_ids.length > 0) {
      baseQuery.andWhere(
        'EXISTS (SELECT 1 FROM product_attributes pa WHERE pa.product_id = product.id AND pa.attribute_id IN (:...attributes_ids))',
        { attributes_ids },
      );
    }

    if (attributes_values_ids && attributes_values_ids.length > 0) {
      baseQuery.andWhere(
        'EXISTS (SELECT 1 FROM product_attribute_values pav WHERE pav.product_id = product.id AND pav.attribute_value_id IN (:...attributes_values_ids))',
        { attributes_values_ids },
      );
    }

    if (specifications_ids && specifications_ids.length > 0) {
      baseQuery.andWhere(
        'EXISTS (SELECT 1 FROM product_specification_values psv INNER JOIN specification_values sv ON sv.id = psv.specification_value_id WHERE psv.product_id = product.id AND sv.specification_id IN (:...specifications_ids))',
        { specifications_ids },
      );
    }

    if (specifications_values_ids && specifications_values_ids.length > 0) {
      baseQuery.andWhere(
        'EXISTS (SELECT 1 FROM product_specification_values psv WHERE psv.product_id = product.id AND psv.specification_value_id IN (:...specifications_values_ids))',
        { specifications_values_ids },
      );
    }

    if (normalizedVendorIds.length > 0 && has_no_vendor) {
      baseQuery.andWhere(
        '(product.vendor_id IN (:...vendor_ids) OR product.vendor_id IS NULL)',
        {
          vendor_ids: normalizedVendorIds,
        },
      );
    } else if (normalizedVendorIds.length > 0) {
      baseQuery.andWhere('product.vendor_id IN (:...vendor_ids)', {
        vendor_ids: normalizedVendorIds,
      });
    } else if (has_no_vendor) {
      baseQuery.andWhere('product.vendor_id IS NULL');
    }

    if (normalizedOriginalVendorCategoryId !== undefined) {
      baseQuery.andWhere(
        `(
          product.original_vendor_category_id = :originalVendorCategoryId
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(product.original_vendor_categories, '[]'::jsonb)) AS original_vendor_category
            WHERE (original_vendor_category->>'id') ~ '^[0-9]+$'
              AND CAST(original_vendor_category->>'id' AS integer) = :originalVendorCategoryId
          )
        )`,
        {
          originalVendorCategoryId: normalizedOriginalVendorCategoryId,
        },
      );
    }

    if (normalizedBrandIds.length > 0 && has_no_brand) {
      baseQuery.andWhere(
        '(product.brand_id IN (:...brand_ids) OR product.brand_id IS NULL)',
        {
          brand_ids: normalizedBrandIds,
        },
      );
    } else if (normalizedBrandIds.length > 0) {
      baseQuery.andWhere('product.brand_id IN (:...brand_ids)', {
        brand_ids: normalizedBrandIds,
      });
    } else if (has_no_brand) {
      baseQuery.andWhere('product.brand_id IS NULL');
    }

    // Filter by creator
    if (created_by && created_by.length > 0) {
      baseQuery.andWhere('product.created_by IN (:...created_by)', {
        created_by,
      });
    }

    // Filter by price range (against product columns directly)
    if (minPrice !== undefined) {
      baseQuery.andWhere(
        'COALESCE(product.sale_price, product.price) >= :minPrice',
        { minPrice },
      );
    }
    if (maxPrice !== undefined) {
      baseQuery.andWhere(
        'COALESCE(product.sale_price, product.price) <= :maxPrice',
        { maxPrice },
      );
    }

    // Filter by sale
    if (has_sale !== undefined) {
      if (has_sale) {
        baseQuery.andWhere('product.sale_price IS NOT NULL');
      } else {
        baseQuery.andWhere('product.sale_price IS NULL');
      }
    }

    // Filter by rating range
    if (minRating !== undefined) {
      baseQuery.andWhere('product.average_rating >= :minRating', { minRating });
    }
    if (maxRating !== undefined) {
      baseQuery.andWhere('product.average_rating <= :maxRating', { maxRating });
    }

    // Filter by stock
    if (isAdmin) {
      if (in_stock !== undefined) {
        if (in_stock) {
          baseQuery.andWhere('product.is_out_of_stock = false');
        } else {
          baseQuery.andWhere('product.is_out_of_stock = true');
        }
      }
    } else {
      baseQuery.andWhere('product.is_out_of_stock = false');
    }

    if (has_duplicate_reference_link !== undefined) {
      if (has_duplicate_reference_link) {
        baseQuery.andWhere(
          `product.reference_link IS NOT NULL
           AND btrim(product.reference_link) <> ''
           AND EXISTS (
             SELECT 1
             FROM products duplicate_product
             WHERE duplicate_product.id != product.id
               AND duplicate_product.reference_link IS NOT NULL
               AND btrim(duplicate_product.reference_link) <> ''
               AND btrim(duplicate_product.reference_link) = btrim(product.reference_link)
           )`,
        );
      } else {
        baseQuery.andWhere(
          `(product.reference_link IS NULL
            OR btrim(product.reference_link) = ''
            OR NOT EXISTS (
              SELECT 1
              FROM products duplicate_product
              WHERE duplicate_product.id != product.id
                AND duplicate_product.reference_link IS NOT NULL
                AND btrim(duplicate_product.reference_link) <> ''
                AND btrim(duplicate_product.reference_link) = btrim(product.reference_link)
            ))`,
        );
      }
    }

    // Filter by date range — dates from the client are in Amman local time (UTC+3).
    // We subtract 3 h from the boundaries so the DB comparison is in UTC,
    // matching the UTC-stored timestamps. Dates are passed as ISO strings to
    // prevent the pg driver from re-applying the Windows system timezone offset
    // when serialising a JS Date object.
    const AMMAN_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC+3 in milliseconds
    if (start_date) {
      const startUtc = new Date(
        new Date(start_date).getTime() - AMMAN_OFFSET_MS,
      ).toISOString();
      baseQuery.andWhere('product.created_at >= :start_date', {
        start_date: startUtc,
      });
    }
    if (end_date) {
      // End of the selected Amman day = next day midnight UTC+3 minus 1 ms, converted to UTC
      const endUtc = new Date(
        new Date(end_date).getTime() + 86400000 - 1 - AMMAN_OFFSET_MS,
      ).toISOString();
      baseQuery.andWhere('product.created_at <= :end_date', {
        end_date: endUtc,
      });
    }

    // Exact SKU match
    if (sku) {
      baseQuery.andWhere('product.sku = :sku', { sku });
    }

    // Search by id (numeric), name, sku, or descriptions
    if (search) {
      const trimmedSearch = search.trim();
      const numericSearch = /^\d+$/.test(trimmedSearch)
        ? Number(trimmedSearch)
        : null;

      if (numericSearch !== null && Number.isSafeInteger(numericSearch)) {
        baseQuery.andWhere(
          '(product.id = :exactId OR product.name_en ILIKE :search OR product.name_ar ILIKE :search OR product.sku ILIKE :search OR product.short_description_en ILIKE :search OR product.long_description_en ILIKE :search OR product.original_vendor_category_name ILIKE :search OR CAST(product.original_vendor_categories AS text) ILIKE :search)',
          { search: `%${search}%`, exactId: numericSearch },
        );
      } else {
        baseQuery.andWhere(
          '(product.name_en ILIKE :search OR product.name_ar ILIKE :search OR product.sku ILIKE :search OR product.short_description_en ILIKE :search OR product.long_description_en ILIKE :search OR product.original_vendor_category_name ILIKE :search OR CAST(product.original_vendor_categories AS text) ILIKE :search)',
          { search: `%${search}%` },
        );
      }
    }

    // Count (fast because there are no row-exploding joins)
    const total = filterDto.skipCount
      ? (filterDto.knownTotal ?? 0)
      : await baseQuery.getCount();

    // Fetch page IDs (fast)
    const pageQuery = baseQuery.clone().select('product.id', 'id');

    if (sortBy === 'price') {
      // Sort by the effective price (sale_price if present, else price)
      pageQuery.addSelect(
        'COALESCE(product.sale_price, product.price)',
        'effective_price',
      );
      pageQuery.orderBy('effective_price', sortOrder);
    } else if (filterDto.randomBrowse) {
      pageQuery.orderBy('RANDOM()');
    } else {
      pageQuery.orderBy(`product.${sortBy}`, sortOrder);
    }

    const idRows = await pageQuery
      .skip((page - 1) * limit)
      .take(limit)
      .getRawMany<{ id: number }>();

    const ids = idRows
      .map((r) => Number(r.id))
      .filter((id) => !Number.isNaN(id));

    if (filterDto.idsOnly) {
      return {
        data: ids.map((id) => ({ id })),
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    if (ids.length === 0) {
      return {
        data: [],
        meta: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    }

    // Load full relations only for products in this page
    const randomBrowse = Boolean(filterDto.randomBrowse);
    const productQuery = this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.brand', 'brand')
      .leftJoinAndSelect('product.vendor', 'vendor')
      .leftJoinAndSelect('product.createdByUser', 'createdByUser')
      .where('product.id IN (:...ids)', { ids });

    if (!randomBrowse) {
      productQuery.orderBy(`product.${sortBy}`, sortOrder);
    }

    const [
      data,
      productCategories,
      productMediaRows,
      productAttachmentRows,
      attributes,
      attributeValues,
      specifications,
    ] = await Promise.all([
      productQuery.getMany(),
      this.productCategoriesRepository.find({
        where: { product_id: In(ids) },
        relations: {
          category: true
        },
      }),
      this.dataSource.getRepository(ProductMedia).find({
        where: { product_id: In(ids) },
        relations: {
          media: true
        },
      }),
      this.dataSource.getRepository(ProductAttachment).find({
        where: { product_id: In(ids) },
        relations: {
          media: true
        },
      }),
      this.dataSource.getRepository(ProductAttribute).find({
        where: { product_id: In(ids) },
        relations: {
          attribute: true
        },
      }),
      this.dataSource.getRepository(ProductAttributeValue).find({
        where: { product_id: In(ids) },
        relations: {
          attribute_value: {
            attribute: true
          }
        },
      }),
      this.dataSource.getRepository(ProductSpecificationValue).find({
        where: { product_id: In(ids) },
        relations: {
          specification_value: {
            specification: true,

            parent_value: {
              specification: true,

              parent_value: {
                specification: true
              }
            }
          }
        },
      }),
    ]);

    // Attach relations to products
    data.forEach((product) => {
      (product as any).productCategories = productCategories.filter(
        (pc) => pc.product_id === product.id,
      );
      (product as any).productMedia = productMediaRows.filter(
        (productMedia) => productMedia.product_id === product.id,
      );
      (product as any).productAttachments = productAttachmentRows.filter(
        (productAttachment) => productAttachment.product_id === product.id,
      );
      (product as any).attributes = attributes.filter(
        (a) => a.product_id === product.id,
      );
      (product as any).attribute_values = attributeValues.filter(
        (av) => av.product_id === product.id,
      );
      (product as any).specifications = specifications.filter(
        (s) => s.product_id === product.id,
      );
    });

    // Transform each product using the detailed view structure
    const showSalePricing = isAdmin ? true : await this.shouldShowSalePricing();
    let transformedData = data.map((product) =>
      this.transformProductDetail(product, isAdmin, showSalePricing),
    );

    if (randomBrowse) {
      const byId = new Map(
        transformedData.map((product) => [Number(product.id), product]),
      );
      transformedData = ids
        .map((id) => byId.get(id))
        .filter((product): product is NonNullable<typeof product> =>
          Boolean(product),
        );
    }

    return {
      data: transformedData,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findPrimaryImageUrlsByProductIds(
    productIds: number[],
  ): Promise<Map<number, string>> {
    if (productIds.length === 0) {
      return new Map();
    }

    const rows = await this.dataSource
      .getRepository(ProductMedia)
      .createQueryBuilder('product_media')
      .innerJoin('product_media.media', 'media')
      .select([
        'product_media.product_id AS product_id',
        'media.url AS url',
        'product_media.is_primary AS is_primary',
        'product_media.sort_order AS sort_order',
      ])
      .where('product_media.product_id IN (:...productIds)', { productIds })
      .orderBy('product_media.is_primary', 'DESC')
      .addOrderBy('product_media.sort_order', 'ASC')
      .addOrderBy('media.id', 'ASC')
      .getRawMany<{
        product_id: number | string;
        url: string;
        is_primary: boolean | string | number;
        sort_order: number | string;
      }>();

    const imageUrlsByProductId = new Map<number, string>();
    for (const row of rows) {
      const productId = Number(row.product_id);
      const imageUrl = typeof row.url === 'string' ? row.url.trim() : '';
      if (!Number.isInteger(productId) || productId <= 0 || !imageUrl) {
        continue;
      }

      if (!imageUrlsByProductId.has(productId)) {
        imageUrlsByProductId.set(productId, imageUrl);
      }
    }

    return imageUrlsByProductId;
  }

  /**
   * Transform product for detailed view (GET /products/:id)
   */
  private buildProductRelationIds(product: Product) {
    const {
      productCategories,
      category,
      category_id,
      attributes: productAttributes,
      attribute_values: productAttributeValues,
      specifications: productSpecifications,
    } = product as any;

    return {
      categories_ids: this.normalizeProductIds([
        ...(productCategories ?? []).map(
          (productCategory: any) =>
            productCategory.category_id ?? productCategory.category?.id,
        ),
        category_id,
        category?.id,
      ]),
      attributes_ids: this.normalizeProductIds(
        (productAttributes ?? []).map(
          (productAttribute: any) =>
            productAttribute.attribute_id ?? productAttribute.attribute?.id,
        ),
      ),
      attributes_values_ids: this.normalizeProductIds(
        (productAttributeValues ?? []).map(
          (productAttributeValue: any) =>
            productAttributeValue.attribute_value_id ??
            productAttributeValue.attribute_value?.id,
        ),
      ),
      specifications_ids: this.normalizeProductIds(
        (productSpecifications ?? []).map(
          (productSpecification: any) =>
            productSpecification.specification_value?.specification_id ??
            productSpecification.specification_value?.specification?.id,
        ),
      ),
      specifications_values_ids: this.normalizeProductIds(
        (productSpecifications ?? []).map(
          (productSpecification: any) =>
            productSpecification.specification_value_id ??
            productSpecification.specification_value?.id,
        ),
      ),
      original_vendor_categories_ids: this.normalizeOriginalVendorCategoryIds(
        product.original_vendor_categories,
      ),
    };
  }

  private transformProductDetail(
    product: Product,
    isAdmin = false,
    showSalePricing = true,
  ): any {
    hydrateProductMedia(product, true);
    hydrateProductAttachments(product, true);

    const {
      media,
      attachments,
      brand,
      productCategories,
      category,
      attributes: productAttributes,
      attribute_values: productAttributeValues,
      specifications: productSpecifications,
      createdByUser,
      ...rest
    } = product as any;

    const creatorInfo = createdByUser
      ? {
          id: createdByUser.id,
          firstName: createdByUser.firstName,
          lastName: createdByUser.lastName,
          email: createdByUser.email,
        }
      : null;

    const brandInfo = brand
      ? {
          id: brand.id,
          name_en: brand.name_en,
          name_ar: brand.name_ar,
          logo: brand.logo,
          status: brand.status,
        }
      : null;

    let categories: any[] = [];
    if (productCategories && productCategories.length > 0) {
      categories = productCategories
        .map((pc: any) => pc.category)
        .filter(Boolean);
    } else if (category) {
      categories = [category];
    }

    // --- Attributes Map ---
    const attributesMap: Record<string, any> = {};

    productAttributes?.forEach((pa: any) => {
      if (pa.attribute) {
        const attrId = String(pa.attribute.id);
        if (!attributesMap[attrId]) {
          attributesMap[attrId] = {
            name_en: pa.attribute.name_en,
            name_ar: pa.attribute.name_ar,
            unit_en: pa.attribute.unit_en,
            unit_ar: pa.attribute.unit_ar,
            is_color: pa.attribute.is_color,
            list_separately: pa.attribute.list_separately,
            values: {},
          };
        }
      }
    });

    productAttributeValues?.forEach((pav: any) => {
      if (pav.attribute_value && pav.attribute_value.attribute) {
        const attrId = String(pav.attribute_value.attribute.id);
        if (attributesMap[attrId]) {
          attributesMap[attrId].values[String(pav.attribute_value.id)] = {
            name_en: pav.attribute_value.value_en,
            name_ar: pav.attribute_value.value_ar,
            color_code: pav.attribute_value.color_code,
          };
        }
      }
    });

    // --- Specifications Map ---
    const specificationsMap: Record<string, any> = {};

    const addSpecificationValue = (spec: any, val: any) => {
      if (!spec || !val) return;

      const specId = String(spec.id);
      if (!specificationsMap[specId]) {
        specificationsMap[specId] = {
          name_en: spec.name_en,
          name_ar: spec.name_ar,
          unit_en: spec.unit_en,
          unit_ar: spec.unit_ar,
          list_separately: spec.list_separately,
          values: {},
        };
      }

      const valId = String(val.id);
      if (!specificationsMap[specId].values[valId]) {
        specificationsMap[specId].values[valId] = {
          name_en: val.value_en,
          name_ar: val.value_ar,
        };
      }
    };

    const processSpecificationRecursive = (val: any) => {
      if (!val) return;

      if (val.specification) {
        addSpecificationValue(val.specification, val);
      }

      if (val.parent_value) {
        processSpecificationRecursive(val.parent_value);
      }
    };

    productSpecifications?.forEach((ps: any) => {
      if (ps.specification_value) {
        processSpecificationRecursive(ps.specification_value);
      }
    });

    // --- Media (flat sorted array) ---
    const mediaList = (media || [])
      .sort((a: any, b: any) => {
        if (
          a.sort_order !== undefined &&
          b.sort_order !== undefined &&
          a.sort_order !== b.sort_order
        ) {
          return a.sort_order - b.sort_order;
        }
        if (a.is_primary) return -1;
        if (b.is_primary) return 1;
        return a.id - b.id;
      })
      .map((m: any) => ({
        id: m.id,
        url: m.url,
        type: m.type,
        alt_text: m.alt_text,
        is_primary: m.is_primary,
        sort_order: m.sort_order,
      }));

    const attachmentsList = (attachments || [])
      .sort((a: any, b: any) => {
        if (
          a.sort_order !== undefined &&
          b.sort_order !== undefined &&
          a.sort_order !== b.sort_order
        ) {
          return a.sort_order - b.sort_order;
        }
        return a.id - b.id;
      })
      .map((attachment: any) => ({
        id: attachment.id,
        url: attachment.url,
        type: attachment.type,
        original_name: attachment.original_name,
        mime_type: attachment.mime_type,
        size: attachment.size,
        sort_order: attachment.sort_order,
      }));

    const relationIds = this.buildProductRelationIds(product);

    const {
      category_id,
      vendor_id,
      brand_id,
      original_vendor_categories: rawOriginalVendorCategories,
      original_vendor_category_id,
      original_vendor_category_name,
      original_vendor_price,
      original_vendor_sale_price,
      archived_at,
      archived_by,
      deleted_at,
      created_by,
      ...cleanRest
    } = rest;

    const originalVendorCategories = Array.isArray(rawOriginalVendorCategories)
      ? rawOriginalVendorCategories
      : [];
    const storefrontPricing = this.resolveStorefrontPricing(
      cleanRest,
      showSalePricing,
    );

    return {
      ...cleanRest,
      ...(isAdmin
        ? {}
        : {
            price: storefrontPricing.price,
            sale_price: storefrontPricing.salePrice,
            price_groups: this.transformStorefrontPriceGroups(
              (cleanRest as any).price_groups,
              showSalePricing,
            ),
          }),
      original_vendor_categories: originalVendorCategories,
      ...relationIds,
      brand: brandInfo,
      categories,
      attributes: attributesMap,
      specifications: specificationsMap,
      media: mediaList,
      attachments: attachmentsList,
      ...(isAdmin && { original_vendor_price }),
      ...(isAdmin && { original_vendor_sale_price }),
      ...(isAdmin && { cost: cleanRest.cost }),
      ...(isAdmin && { quantity: cleanRest.quantity }),
      is_out_of_stock: cleanRest.is_out_of_stock,
      ...(isAdmin && { created_by: creatorInfo }),
    };
  }

  async findOne(id: number, isAdmin = false): Promise<any> {
    const [
      productBase,
      productCategories,
      productMedia,
      productAttachments,
      attributes,
      attributeValues,
      specifications,
      linkedProductsState,
    ] = await Promise.all([
      this.productsRepository.findOne({
        where: { id },
        relations: {
          category: true,
          vendor: true,
          brand: true,
          createdByUser: true
        },
      }),
      this.dataSource.getRepository(ProductCategory).find({
        where: { product_id: id },
        relations: {
          category: true
        },
      }),
      this.dataSource.getRepository(ProductMedia).find({
        where: { product_id: id },
        relations: {
          media: true
        },
      }),
      this.dataSource.getRepository(ProductAttachment).find({
        where: { product_id: id },
        relations: {
          media: true
        },
      }),
      this.dataSource.getRepository(ProductAttribute).find({
        where: { product_id: id },
        relations: {
          attribute: true
        },
      }),
      this.dataSource.getRepository(ProductAttributeValue).find({
        where: { product_id: id },
        relations: {
          attribute_value: {
            attribute: true
          }
        },
      }),
      this.dataSource.getRepository(ProductSpecificationValue).find({
        where: { product_id: id },
        relations: {
          specification_value: {
            specification: true,

            parent_value: {
              specification: true,

              parent_value: {
                specification: true
              }
            }
          }
        },
      }),
      this.getLinkedProductsState(id),
    ]);

    if (!productBase) {
      throw new NotFoundException('Product not found');
    }

    if (!isAdmin && productBase.is_out_of_stock) {
      throw new NotFoundException('Product not found');
    }

    productBase.productCategories = productCategories;
    productBase.productMedia = productMedia;
    productBase.productAttachments = productAttachments;
    productBase.attributes = attributes;
    (productBase as any).attribute_values = attributeValues;
    productBase.specifications = specifications;
    const showSalePricing = isAdmin ? true : await this.shouldShowSalePricing();

    // Return detailed product structure
    const product = {
      ...this.transformProductDetail(productBase, isAdmin, showSalePricing),
      ...linkedProductsState,
    };

    return this.stripDisabledProductFieldsFromResponse(product, isAdmin);
  }

  async findOneBySlug(slug: string, isAdmin = false): Promise<any> {
    const product = await this.productsRepository.findOne({
      where: { slug },
      select: {
        id: true
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with slug ${slug} not found`);
    }

    return this.findOne(product.id, isAdmin);
  }

  async findOneByReferenceLink(
    referenceLink: string | undefined,
    isAdmin = false,
    referenceSlug?: string,
  ): Promise<any> {
    const normalizedReferenceLink = referenceLink?.trim() || undefined;
    const normalizedReferenceSlug = referenceSlug?.trim() || undefined;

    if (!normalizedReferenceLink && !normalizedReferenceSlug) {
      throw new BadRequestException(
        'At least one of reference_link or reference_slug query parameter is required',
      );
    }

    const productId = await this.findProductIdByReference({
      referenceLink: normalizedReferenceLink,
      referenceSlug: normalizedReferenceSlug,
    });

    if (!productId) {
      const searchParts = [
        normalizedReferenceLink
          ? `reference link ${normalizedReferenceLink}`
          : null,
        normalizedReferenceSlug
          ? `reference slug ${normalizedReferenceSlug}`
          : null,
      ].filter(Boolean);

      throw new NotFoundException(
        `Product with ${searchParts.join(' and ')} not found`,
      );
    }

    return this.findOne(productId, isAdmin);
  }

  /**
   * Transform product response:
   * - Rename priceGroups to prices
   * - Rename weightGroups to weights
   * - Include mediaGroup object in each media item (remove media_group_id)
   * - Transform productCategories to categories array
   */
  private transformProductResponse(product: Product, isAdmin = false): any {
    hydrateProductMedia(product, true);

    const {
      media,
      productCategories,
      category,
      brand,
      original_vendor_categories: rawOriginalVendorCategories,
      original_vendor_category_id,
      original_vendor_category_name,
      original_vendor_price,
      original_vendor_sale_price,
      ...rest
    } = product as any;

    const originalVendorCategories = Array.isArray(rawOriginalVendorCategories)
      ? rawOriginalVendorCategories
      : [];

    // Transform media — flat sorted array
    const transformedMedia =
      media
        ?.sort((a: any, b: any) => {
          if (
            a.sort_order !== undefined &&
            b.sort_order !== undefined &&
            a.sort_order !== b.sort_order
          ) {
            return a.sort_order - b.sort_order;
          }
          if (a.is_primary) return -1;
          if (b.is_primary) return 1;
          return a.id - b.id;
        })
        .map((m: any) => ({
          id: m.id,
          url: m.url,
          type: m.type,
          alt_text: m.alt_text,
          is_primary: m.is_primary,
          sort_order: m.sort_order,
        })) || [];

    // Transform productCategories to a clean categories array
    let categories: any[] = [];
    if (productCategories && productCategories.length > 0) {
      categories = productCategories
        .map((pc: any) => pc.category)
        .filter(Boolean);
    } else if (category) {
      categories = [category];
    }

    const brandInfo = brand
      ? {
          id: brand.id,
          name_en: brand.name_en,
          name_ar: brand.name_ar,
          logo: brand.logo,
          status: brand.status,
        }
      : null;

    const referenceLinks = this.resolveReferenceLinksForProduct({
      reference_link: rest.reference_link ?? null,
      reference_links: rest.reference_links ?? [],
    });

    return {
      ...rest,
      reference_link: referenceLinks[0] ?? null,
      reference_links: referenceLinks,
      original_vendor_categories: originalVendorCategories,
      original_vendor_categories_ids: this.normalizeOriginalVendorCategoryIds(
        originalVendorCategories,
      ),
      ...(isAdmin && { original_vendor_price }),
      ...(isAdmin && { original_vendor_sale_price }),
      brand: brandInfo,
      categories,
      media: transformedMedia,
    };
  }

  /**
   * Comprehensive update method for products
   * The payload represents the COMPLETE state of the product.
   * Anything not in the payload will be deleted.
   */
  async update(
    id: number,
    dto: UpdateProductDto,
    user?: { role: string; adminAccess?: unknown },
  ): Promise<any> {
    if (user && !hasAdminAccess(user as any, 'product_pricing')) {
      dto = stripProductPricingFields(dto);
    }

    // Lightweight check for existence
    const existingProduct = await this.productsRepository.findOne({
      where: { id },
      relations: {
        productCategories: true,
      },
      select: {
        id: true,
        slug: true,
        quantity: true,
        is_out_of_stock: true,
        vendor_id: true,
        brand_id: true,
        category_id: true,
        original_vendor_price: true,
        original_vendor_sale_price: true,
        productCategories: {
          category_id: true,
        },
      },
    });
    if (!existingProduct) {
      throw new NotFoundException('Product not found');
    }

    // Enforce product field toggles — silently drop disabled fields before persisting.
    // Setting a field to undefined makes the per-field guards below skip it, so existing
    // rows keep their data; only the incoming change is dropped.
    dto = await this.stripDisabledProductFieldsFromDto(dto);

    if (dto.original_price !== undefined && dto.original_vendor_price === undefined) {
      dto.original_vendor_price = dto.original_price as any;
    }

    if (
      dto.original_sale_price !== undefined &&
      dto.original_vendor_sale_price === undefined
    ) {
      dto.original_vendor_sale_price = dto.original_sale_price as any;
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // 1. Validate and update categories
      if (dto.category_ids !== undefined) {
        if (dto.category_ids.length > 0) {
          const categories = await this.categoriesRepository.find({
            where: { id: In(dto.category_ids), status: CategoryStatus.ACTIVE },
          });
          if (categories.length !== dto.category_ids.length) {
            throw new BadRequestException(
              'One or more categories not found or are archived',
            );
          }
        }

        // Delete existing product-category relationships
        await queryRunner.manager.delete(ProductCategory, { product_id: id });

        if (dto.category_ids.length > 0) {
          // Create new product-category relationships
          const productCategories = dto.category_ids.map((categoryId) =>
            this.productCategoriesRepository.create({
              product_id: id,
              category_id: categoryId,
            }),
          );
          await queryRunner.manager.save(ProductCategory, productCategories);
        }

        // Update primary category (first in the list)
        await queryRunner.manager.update(Product, id, {
          category_id: dto.category_ids.length > 0 ? dto.category_ids[0] : null,
        });
      }

      // Validate brand if provided
      if (dto.brand_id !== undefined) {
        if (dto.brand_id === (null as any)) {
          // noop - DTO type doesn't allow null, but guard for safety
        } else {
          const brand = await this.brandsRepository.findOne({
            where: { id: dto.brand_id, status: BrandStatus.ACTIVE },
          });
          if (!brand) {
            throw new BadRequestException('Brand not found or inactive');
          }
        }
      }

      if (dto.attributes !== undefined && dto.attributes.length > 0) {
        await this.resolveProductAttributeValueIds(dto.attributes);
      }

      if (
        dto.specifications !== undefined &&
        dto.specifications.length > 0
      ) {
        await this.resolveProductSpecificationValueIds(dto.specifications);
      }

      // 2. Update basic product information
      const basicInfoFields = [
        'name_en',
        'name_ar',
        'sku',
        'record',
        'short_description_en',
        'short_description_ar',
        'long_description_en',
        'long_description_ar',
        'vendor_id',
        'brand_id',
        'status',
        'visible',
        'cost',
        'price',
        'sale_price',
        'original_vendor_price',
        'original_vendor_sale_price',
        'weight',
        'weight_unit',
        'length',
        'width',
        'height',
        'dimension_unit',
        'quantity',
        'meta_title_en',
        'meta_title_ar',
        'meta_description_en',
        'meta_description_ar',
      ];
      const basicInfoChanges: any = {};

      // Auto-update slug if name changes
      if (dto.name_en) {
        const newSlug = await this.generateUniqueSlug(dto.name_en, id);
        basicInfoChanges.slug = newSlug;

        if (existingProduct.slug && existingProduct.slug !== newSlug) {
          await queryRunner.manager
            .getRepository(ProductSlugRedirect)
            .upsert(
              {
                old_slug: existingProduct.slug,
                new_slug: newSlug,
                product_id: id,
              },
              ['old_slug'],
            );
        }
      }

      basicInfoFields.forEach((field) => {
        if (dto[field] !== undefined) {
          basicInfoChanges[field] = dto[field];
        }
      });

      if (dto.reference_links !== undefined || dto.reference_link !== undefined) {
        const existingReferenceState = await queryRunner.manager.findOne(Product, {
          where: { id },
          select: {
            id: true,
            reference_link: true,
            reference_links: true,
          },
        });
        const nextReferenceLinks = await this.ensureReferenceLinksAreUnique(
          this.normalizeReferenceLinks(
            dto.reference_links !== undefined
              ? dto.reference_links
              : existingReferenceState?.reference_links,
            dto.reference_link !== undefined
              ? dto.reference_link
              : existingReferenceState?.reference_link,
          ),
          id,
        );

        basicInfoChanges.reference_links = nextReferenceLinks;
        basicInfoChanges.reference_link = nextReferenceLinks[0] ?? null;
      }

      if (dto.reference_slug !== undefined) {
        basicInfoChanges.reference_slug = this.normalizeReferenceSlug(
          dto.reference_slug,
        );
      }

      if (
        dto.quantity !== undefined ||
        dto.is_out_of_stock !== undefined
      ) {
        const nextQuantity = dto.quantity ?? existingProduct.quantity;
        basicInfoChanges.is_out_of_stock = this.resolveIsOutOfStock({
          quantity: nextQuantity,
          requestedState: dto.is_out_of_stock,
          currentState: existingProduct.is_out_of_stock,
        });
      }

      if (
        dto.original_vendor_categories_ids !== undefined ||
        dto.original_vendor_categories !== undefined ||
        dto.original_vendor_category_id !== undefined ||
        dto.original_vendor_category_name !== undefined
      ) {
        const originalVendorCategories = this.normalizeOriginalVendorCategories({
          categoryIds: dto.original_vendor_categories_ids,
          categories: dto.original_vendor_categories,
          legacyId: dto.original_vendor_category_id ?? null,
          legacyName: dto.original_vendor_category_name ?? null,
        });
        const primaryOriginalVendorCategory =
          originalVendorCategories[0] ?? null;

        basicInfoChanges.original_vendor_categories = originalVendorCategories;
        basicInfoChanges.original_vendor_category_id =
          primaryOriginalVendorCategory?.id ?? null;
        basicInfoChanges.original_vendor_category_name =
          primaryOriginalVendorCategory?.name ?? null;
      }

      const shouldRecomputeManagedPricing =
        dto.original_vendor_price !== undefined ||
        dto.original_vendor_sale_price !== undefined ||
        dto.original_price !== undefined ||
        dto.original_sale_price !== undefined ||
        dto.vendor_id !== undefined ||
        dto.brand_id !== undefined ||
        dto.category_ids !== undefined;

      if (shouldRecomputeManagedPricing) {
        const categoryIdsForPricing = this.resolveCategoryIdsForPricing({
          dtoCategoryIds: dto.category_ids,
          existingCategoryId: existingProduct.category_id ?? null,
          existingProductCategories: existingProduct.productCategories,
        });
        const nextVendorId =
          basicInfoChanges.vendor_id !== undefined
            ? basicInfoChanges.vendor_id
            : existingProduct.vendor_id ?? null;
        const nextBrandId =
          basicInfoChanges.brand_id !== undefined
            ? basicInfoChanges.brand_id
            : existingProduct.brand_id ?? null;
        const nextOriginalVendorPrice =
          basicInfoChanges.original_vendor_price !== undefined
            ? basicInfoChanges.original_vendor_price
            : existingProduct.original_vendor_price ?? null;
        const nextOriginalVendorSalePrice =
          basicInfoChanges.original_vendor_sale_price !== undefined
            ? basicInfoChanges.original_vendor_sale_price
            : existingProduct.original_vendor_sale_price ?? null;
        const managedPricingFromRule =
          await this.computeManagedPricingFromOriginalInput({
            vendor_id: nextVendorId as number | null,
            brand_id: nextBrandId as number | null,
            categoryIds: categoryIdsForPricing,
            original_vendor_price: nextOriginalVendorPrice,
            original_vendor_sale_price: nextOriginalVendorSalePrice,
          });

        if (managedPricingFromRule) {
          basicInfoChanges.price = managedPricingFromRule.price;
          basicInfoChanges.sale_price = managedPricingFromRule.sale_price;
        } else if (
          basicInfoChanges.original_vendor_sale_price === null
        ) {
          // Clearing the original sale price also removes the managed sale price.
          basicInfoChanges.sale_price = null;
        }
      }

      if (Object.keys(basicInfoChanges).length > 0) {
        await queryRunner.manager.update(Product, id, basicInfoChanges);
      }

      // Commit transaction for basic info before calling other services
      // Note: Ideally, other services should accept queryRunner to participate in the transaction
      // For now, we commit here to ensure basic info is saved, but this is a partial optimization
      // To fully optimize, we would need to refactor all child services to accept a transaction manager
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to update product: ${getErrorMessage(error)}`,
      );
    } finally {
      await queryRunner.release();
    }

    // Continue with other updates (outside transaction)
    try {
      const syncTasks: Promise<any>[] = [];

      // Sync Media
      if (dto.media !== undefined) {
        syncTasks.push(this.syncProductMedia(id, dto.media || []));
      }

      // Sync Attachments
      if (dto.attachments !== undefined) {
        syncTasks.push(this.syncProductAttachments(id, dto.attachments || []));
      }

      // Sync Specifications
      if (dto.specifications !== undefined) {
        syncTasks.push(
          this.syncProductSpecifications(id, dto.specifications || []),
        );
      }

      // Sync Attributes
      if (dto.attributes !== undefined) {
        syncTasks.push(this.syncProductAttributes(id, dto.attributes || []));
      }

      await Promise.all(syncTasks);

      // Update tags if explicitly provided in the DTO (pass [] to clear all tags)
      if (dto.tags !== undefined) {
        await this.applyTagsToProduct(id, dto.tags);
      }

      if (dto.linked_product_ids !== undefined) {
        await this.syncLinkedProducts(id, dto.linked_product_ids);
      }

      // Return updated product (admin context — out-of-stock products are hidden from public findOne)
      const updatedProduct = await this.findOne(id, true);
      await this.syncProductToTypesense(id);

      return {
        product: updatedProduct,
        message: 'Product updated successfully',
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }

      throw new BadRequestException(
        `Failed to update product: ${getErrorMessage(error)}`,
      );
    }
  }

  async findSlugRedirect(oldSlug: string): Promise<ProductSlugRedirect | null> {
    return this.slugRedirectRepository.findOne({
      where: { old_slug: oldSlug },
    });
  }

  // Update average rating (called when rating is added/updated)
  async updateAverageRating(product_id: number): Promise<void> {
    const result = await this.productsRepository
      .createQueryBuilder('product')
      .leftJoin('product.ratings', 'rating')
      .where('product.id = :product_id', { product_id })
      .andWhere('rating.status = :status', { status: 'approved' })
      .select('AVG(rating.rating)', 'avg')
      .addSelect('COUNT(rating.id)', 'count')
      .getRawOne();

    await this.productsRepository.update(product_id, {
      average_rating: parseFloat(result.avg) || 0,
      total_ratings: parseInt(result.count) || 0,
    });
  }

  // ========== LIFECYCLE MANAGEMENT ==========

  /**
   * Archive a product (soft delete)
   * Sets status to ARCHIVED, preserves visible flag for when restored
   */
  async archive(id: number, userId: number): Promise<{ message: string }> {
    const product = await this.productsRepository.findOne({
      where: { id, status: ProductStatus.ACTIVE },
    });

    if (!product) {
      throw new NotFoundException('Product not found or already archived');
    }

    await this.productsRepository.update(id, {
      status: ProductStatus.ARCHIVED,
      archived_at: new Date(),
      archived_by: userId,
    });

    return { message: `Product "${product.name_en}" archived successfully` };
  }

  /**
   * Restore an archived product
   * - If the product's vendor is archived, restoration is blocked
   * - If the product's category is archived, a new category_id must be provided
   */
  async restore(
    id: number,
    newCategoryId?: number,
  ): Promise<{ message: string }> {
    const product = await this.productsRepository.findOne({
      where: { id, status: ProductStatus.ARCHIVED },
      relations: {
        category: true,
        vendor: true
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found or not archived');
    }

    // Check if vendor is archived - block restoration if so
    if (product.vendor && product.vendor.status === VendorStatus.ARCHIVED) {
      throw new BadRequestException(
        `Cannot restore product because its vendor "${product.vendor.name_en}" is archived. ` +
          'Please restore the vendor first before restoring this product.',
      );
    }

    // Check if category is still active
    if (
      product.category &&
      product.category.status === CategoryStatus.ARCHIVED
    ) {
      if (!newCategoryId) {
        throw new BadRequestException(
          'Product category is archived. Please provide a new category_id to restore the product.',
        );
      }

      // Validate the new category exists and is active
      const newCategory = await this.categoriesRepository.findOne({
        where: { id: newCategoryId, status: CategoryStatus.ACTIVE },
      });

      if (!newCategory) {
        throw new BadRequestException(
          'The specified category does not exist or is archived',
        );
      }

      product.category_id = newCategoryId;
    }

    await this.productsRepository
      .createQueryBuilder()
      .update(Product)
      .set({
        status: ProductStatus.ACTIVE,
        category_id: product.category_id,
      })
      .where('id = :id', { id })
      .execute();

    // Set archived fields to null using raw query
    await this.productsRepository.query(
      'UPDATE products SET archived_at = NULL, archived_by = NULL WHERE id = $1',
      [id],
    );

    return { message: `Product "${product.name_en}" restored successfully` };
  }

  /**
   * Find all archived products with image and vendor details
   */
  async findArchived(filterDto: FilterProductDto) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'archived_at',
      sortOrder = 'DESC',
      categoryId,
      search,
    } = filterDto;

    const queryBuilder = this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.vendor', 'vendor')
      .leftJoinAndSelect('product.productMedia', 'productMedia')
      .leftJoinAndSelect('productMedia.media', 'media')
      .where('product.status = :status', { status: ProductStatus.ARCHIVED });

    // Filter by category
    if (categoryId) {
      queryBuilder.andWhere('product.category_id = :categoryId', {
        categoryId,
      });
    }

    // Search by id (numeric), name, sku
    if (search) {
      const trimmedSearch = search.trim();
      const numericSearch = /^\d+$/.test(trimmedSearch)
        ? Number(trimmedSearch)
        : null;

      if (numericSearch !== null && Number.isSafeInteger(numericSearch)) {
        queryBuilder.andWhere(
          '(product.id = :exactId OR product.name_en ILIKE :search OR product.name_ar ILIKE :search OR product.sku ILIKE :search)',
          { search: `%${search}%`, exactId: numericSearch },
        );
      } else {
        queryBuilder.andWhere(
          '(product.name_en ILIKE :search OR product.name_ar ILIKE :search OR product.sku ILIKE :search)',
          { search: `%${search}%` },
        );
      }
    }

    // Sorting
    const validSortColumn = [
      'archived_at',
      'created_at',
      'name_en',
      'name_ar',
    ].includes(sortBy)
      ? sortBy
      : 'archived_at';
    queryBuilder.orderBy(`product.${validSortColumn}`, sortOrder);

    // Pagination
    queryBuilder.skip((page - 1) * limit).take(limit);

    const [rawData, total] = await queryBuilder.getManyAndCount();

    // Map products to include image from primary media or first media
    const data = rawData.map((product) => {
      const image = getPrimaryMediaUrl(product);

      // Extract vendor info with status
      const vendorInfo = product.vendor
        ? {
            id: product.vendor.id,
            name_en: product.vendor.name_en,
            name_ar: product.vendor.name_ar,
            status: product.vendor.status,
            logo: product.vendor.logo,
          }
        : null;

      const { media, productMedia, vendor, ...productData } =
        hydrateProductMedia(product, true) as any;
      return {
        ...productData,
        image,
        vendor: vendorInfo,
      };
    });

    return {
      data,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Permanently delete a product (only if archived or in review)
   * This is irreversible
   */
  async permanentDelete(
    id: number,
    options: { allowAnyStatus?: boolean } = {},
  ): Promise<{ message: string }> {
    const product = await this.productsRepository.findOne({
      where: { id },
    });

    if (
      !product ||
      (!options.allowAnyStatus &&
        product.status !== ProductStatus.ARCHIVED &&
        product.status !== ProductStatus.REVIEW)
    ) {
      throw new NotFoundException(
        'Product not found or cannot be permanently deleted. Only archived or in-review products can be permanently deleted.',
      );
    }

    // Remove all cart items referencing this product before deletion
    await this.cartItemsRepository.delete({ product_id: id });

    await this.productsRepository.remove(product);
    await this.deleteProductFromTypesense(id);

    return { message: `Product "${product.name_en}" permanently deleted` };
  }

  async mergeDuplicateReferenceSlugs(
    dto: MergeDuplicateReferenceSlugsDto = {},
  ): Promise<{
    dry_run: boolean;
    groups_found: number;
    groups_merged: number;
    products_deleted: number;
    groups: Array<{
      vendor_id: number;
      reference_slug: string;
      keeper_product_id: number;
      deleted_product_ids: number[];
      merged_reference_links: string[];
      merged_original_vendor_categories: OriginalVendorCategoryReference[];
    }>;
    skipped_groups: Array<{
      vendor_id: number | null;
      reference_slug: string;
      reason: string;
      product_ids: number[];
    }>;
  }> {
    const dryRun = dto.dry_run ?? false;
    const groupsQuery = this.productsRepository
      .createQueryBuilder('product')
      .select('product.vendor_id', 'vendor_id')
      .addSelect('product.reference_slug', 'reference_slug')
      .addSelect('array_agg(product.id ORDER BY product.id)', 'product_ids')
      .addSelect('COUNT(*)::int', 'count')
      .where('product.deleted_at IS NULL')
      .andWhere('product.reference_slug IS NOT NULL')
      .andWhere("btrim(product.reference_slug) <> ''")
      .andWhere('product.vendor_id IS NOT NULL')
      .groupBy('product.vendor_id')
      .addGroupBy('product.reference_slug')
      .having('COUNT(*) > 1')
      .orderBy('count', 'DESC')
      .addOrderBy('product.reference_slug', 'ASC');

    if (dto.vendor_id !== undefined) {
      groupsQuery.andWhere('product.vendor_id = :vendorId', {
        vendorId: dto.vendor_id,
      });
    }

    const duplicateGroups = await groupsQuery.getRawMany<{
      vendor_id: string;
      reference_slug: string;
      product_ids: number[];
      count: string;
    }>();

    const groups: Array<{
      vendor_id: number;
      reference_slug: string;
      keeper_product_id: number;
      deleted_product_ids: number[];
      merged_reference_links: string[];
      merged_original_vendor_categories: OriginalVendorCategoryReference[];
    }> = [];
    const skippedGroups: Array<{
      vendor_id: number | null;
      reference_slug: string;
      reason: string;
      product_ids: number[];
    }> = [];
    let groupsMerged = 0;
    let productsDeleted = 0;

    for (const group of duplicateGroups) {
      const rawProductIds = group.product_ids as unknown;
      const productIds = (
        Array.isArray(rawProductIds)
          ? rawProductIds
          : String(rawProductIds ?? '')
              .replace(/^\{|\}$/g, '')
              .split(',')
      )
        .map((productId) => Number(productId))
        .filter((productId) => Number.isInteger(productId) && productId > 0)
        .sort((a, b) => a - b);

      if (productIds.length < 2) {
        continue;
      }

      const keeperProductId = productIds[0];
      const duplicateProductIds = productIds.slice(1);
      const products = await this.productsRepository.find({
        where: { id: In(productIds) },
        select: {
          id: true,
          vendor_id: true,
          reference_slug: true,
          reference_link: true,
          reference_links: true,
          original_vendor_categories: true,
          original_vendor_category_id: true,
          original_vendor_category_name: true,
        },
      });

      if (products.length !== productIds.length) {
        skippedGroups.push({
          vendor_id: Number(group.vendor_id) || null,
          reference_slug: group.reference_slug,
          reason: 'One or more products in the group could not be loaded',
          product_ids: productIds,
        });
        continue;
      }

      const mergedReferenceLinks = this.normalizeReferenceLinks(
        products.flatMap((product) =>
          this.resolveReferenceLinksForProduct(product),
        ),
      );
      const mergedOriginalVendorCategories = this.normalizeOriginalVendorCategories(
        {
          categories: products.flatMap(
            (product) => product.original_vendor_categories ?? [],
          ),
        },
      );
      const primaryOriginalVendorCategory =
        mergedOriginalVendorCategories[0] ?? null;

      const groupSummary = {
        vendor_id: Number(group.vendor_id),
        reference_slug: group.reference_slug,
        keeper_product_id: keeperProductId,
        deleted_product_ids: duplicateProductIds,
        merged_reference_links: mergedReferenceLinks,
        merged_original_vendor_categories: mergedOriginalVendorCategories,
      };

      groups.push(groupSummary);

      if (dryRun) {
        continue;
      }

      await this.productsRepository.update(keeperProductId, {
        reference_links: mergedReferenceLinks,
        reference_link: mergedReferenceLinks[0] ?? null,
        original_vendor_categories: mergedOriginalVendorCategories,
        original_vendor_category_id: primaryOriginalVendorCategory?.id ?? null,
        original_vendor_category_name:
          primaryOriginalVendorCategory?.name ?? null,
      });

      for (const duplicateProductId of duplicateProductIds) {
        await this.permanentDelete(duplicateProductId, {
          allowAnyStatus: true,
        });
        productsDeleted += 1;
      }

      groupsMerged += 1;
      await this.syncProductToTypesense(keeperProductId);
    }

    return {
      dry_run: dryRun,
      groups_found: groups.length,
      groups_merged: dryRun ? 0 : groupsMerged,
      products_deleted: dryRun ? 0 : productsDeleted,
      groups,
      skipped_groups: skippedGroups,
    };
  }

  async permanentDeleteReviewProducts(
    categoryId: number,
    vendorId: number,
  ): Promise<{
    message: string;
    deleted: number;
    filters: {
      status: ProductStatus.REVIEW;
      category_id: number;
      vendor_id: number;
    };
  }> {
    const [category, vendor] = await Promise.all([
      this.categoriesRepository.findOne({ where: { id: categoryId } }),
      this.dataSource.getRepository(Vendor).findOne({ where: { id: vendorId } }),
    ]);

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const products = await queryRunner.manager
        .getRepository(Product)
        .createQueryBuilder('product')
        .where('product.status = :status', { status: ProductStatus.REVIEW })
        .andWhere('product.vendor_id = :vendorId', { vendorId })
        .andWhere(
          '(product.category_id = :categoryId OR EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = product.id AND pc.category_id = :categoryId))',
          { categoryId },
        )
        .getMany();

      const productIds = products.map((product) => product.id);

      if (productIds.length > 0) {
        await queryRunner.manager.delete(CartItem, {
          product_id: In(productIds),
        });
        await queryRunner.manager.remove(Product, products);
      }

      await queryRunner.commitTransaction();

      if (productIds.length > 0) {
        await Promise.all(
          productIds.map((productId) => this.deleteProductFromTypesense(productId)),
        );
      }

      return {
        message:
          productIds.length > 0
            ? `Deleted ${productIds.length} review product${productIds.length === 1 ? '' : 's'} for vendor "${vendor.name_en}" in category "${category.name_en}"`
            : `No review products found for vendor "${vendor.name_en}" in category "${category.name_en}"`,
        deleted: productIds.length,
        filters: {
          status: ProductStatus.REVIEW,
          category_id: categoryId,
          vendor_id: vendorId,
        },
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  // ========== BULK ASSIGNMENT ==========

  /**
   * Assign multiple products to a specific category (adds to existing categories)
   */
  async assignProductsToCategory(
    categoryId: number,
    product_ids: number[],
  ): Promise<{ message: string; assigned: number; alreadyAssigned: number }> {
    // Validate category exists and is active
    const category = await this.categoriesRepository.findOne({
      where: { id: categoryId, status: CategoryStatus.ACTIVE },
    });

    if (!category) {
      throw new NotFoundException('Category not found or is archived');
    }

    // Get active products
    const products = await this.productsRepository.find({
      where: { id: In(product_ids), status: ProductStatus.ACTIVE },
    });

    if (products.length === 0) {
      throw new BadRequestException(
        'No active products found with the given IDs',
      );
    }

    // Check existing assignments
    const existingAssignments = await this.productCategoriesRepository.find({
      where: {
        product_id: In(products.map((p) => p.id)),
        category_id: categoryId,
      },
    });

    const existingProductIds = new Set(
      existingAssignments.map((a) => a.product_id),
    );
    const productsToAssign = products.filter(
      (p) => !existingProductIds.has(p.id),
    );

    // Create new assignments
    if (productsToAssign.length > 0) {
      const newAssignments = productsToAssign.map((product) =>
        this.productCategoriesRepository.create({
          product_id: product.id,
          category_id: categoryId,
        }),
      );
      await this.productCategoriesRepository.save(newAssignments);
    }

    return {
      message: `${productsToAssign.length} products assigned to category "${category.name_en}"`,
      assigned: productsToAssign.length,
      alreadyAssigned: existingAssignments.length,
    };
  }

  /**
   * Remove multiple products from a specific category
   */
  async removeProductsFromCategory(
    categoryId: number,
    product_ids: number[],
  ): Promise<{ message: string; removed: number }> {
    // Validate category exists
    const category = await this.categoriesRepository.findOne({
      where: { id: categoryId },
    });

    if (!category) {
      throw new NotFoundException('Category not found');
    }

    // Remove assignments
    const result = await this.productCategoriesRepository.delete({
      product_id: In(product_ids),
      category_id: categoryId,
    });

    return {
      message: `${result.affected} products removed from category "${category.name_en}"`,
      removed: result.affected || 0,
    };
  }

  /**
   * Assign multiple products to a specific vendor
   */
  async assignProductsToVendor(
    vendorId: number,
    product_ids: number[],
  ): Promise<{ message: string; updated: number }> {
    // Validate vendor exists
    const vendorExists = await this.productsRepository.manager
      .getRepository('Vendor')
      .findOne({ where: { id: vendorId, status: 'active' } });

    if (!vendorExists) {
      throw new NotFoundException('Vendor not found or is archived');
    }

    // Update all products
    const result = await this.productsRepository.update(
      { id: In(product_ids), status: ProductStatus.ACTIVE },
      { vendor_id: vendorId },
    );

    return {
      message: `${result.affected} products assigned to vendor "${vendorExists.name_en}"`,
      updated: result.affected || 0,
    };
  }

  /**
   * Remove vendor from multiple products
   */
  async removeProductsFromVendor(
    vendorId: number,
    product_ids: number[],
  ): Promise<{ message: string; updated: number }> {
    // Validate vendor exists
    const vendorExists = await this.productsRepository.manager
      .getRepository('Vendor')
      .findOne({ where: { id: vendorId } });

    if (!vendorExists) {
      throw new NotFoundException('Vendor not found');
    }

    // Remove vendor from products
    const result = await this.productsRepository.update(
      { id: In(product_ids), vendor_id: vendorId },
      { vendor_id: null as any },
    );

    return {
      message: `${result.affected} products removed from vendor "${vendorExists.name_en}"`,
      updated: result.affected || 0,
    };
  }

  async bulkUpdateProductStatus(dto: {
    from_status: ProductStatus;
    to_status: ProductStatus;
    vendor_id?: number;
    category_id?: number;
  }): Promise<{
    message: string;
    updated: number;
    filters: {
      from_status: ProductStatus;
      to_status: ProductStatus;
      vendor_id?: number;
      category_id?: number;
    };
  }> {
    if (dto.from_status === dto.to_status) {
      throw new BadRequestException('from_status and to_status must be different');
    }

    const allowedStatuses = [
      ProductStatus.ACTIVE,
      ProductStatus.REVIEW,
      ProductStatus.UPDATED,
    ];

    if (
      !allowedStatuses.includes(dto.from_status) ||
      !allowedStatuses.includes(dto.to_status)
    ) {
      throw new BadRequestException(
        'Bulk status changes only support active, review, and updated statuses',
      );
    }

    if (dto.vendor_id) {
      const vendor = await this.dataSource
        .getRepository(Vendor)
        .findOne({ where: { id: dto.vendor_id } });

      if (!vendor) {
        throw new NotFoundException('Vendor not found');
      }
    }

    if (dto.category_id) {
      const category = await this.categoriesRepository.findOne({
        where: { id: dto.category_id },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }
    }

    const matchingProductsQuery = this.productsRepository
      .createQueryBuilder('product')
      .select('product.id', 'id')
      .where('product.status = :fromStatus', { fromStatus: dto.from_status });

    if (dto.vendor_id) {
      matchingProductsQuery.andWhere('product.vendor_id = :vendorId', {
        vendorId: dto.vendor_id,
      });
    }

    if (dto.category_id) {
      matchingProductsQuery.andWhere(
        '(product.category_id = :categoryId OR EXISTS (SELECT 1 FROM product_categories pc WHERE pc.product_id = product.id AND pc.category_id = :categoryId))',
        { categoryId: dto.category_id },
      );
    }

    const matchingProducts = await matchingProductsQuery.getRawMany<{ id: number }>();
    const productIds = matchingProducts.map((row) => Number(row.id));

    if (productIds.length === 0) {
      return {
        message: 'No products matched the selected filters',
        updated: 0,
        filters: {
          from_status: dto.from_status,
          to_status: dto.to_status,
          vendor_id: dto.vendor_id,
          category_id: dto.category_id,
        },
      };
    }

    const result = await this.productsRepository.update(
      { id: In(productIds), status: dto.from_status },
      { status: dto.to_status },
    );

    return {
      message: `Updated ${result.affected ?? 0} products from ${dto.from_status} to ${dto.to_status}`,
      updated: result.affected ?? 0,
      filters: {
        from_status: dto.from_status,
        to_status: dto.to_status,
        vendor_id: dto.vendor_id,
        category_id: dto.category_id,
      },
    };
  }
}
