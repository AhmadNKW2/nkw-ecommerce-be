import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, DataSource, EntityManager } from 'typeorm';
import { Product, ProductStatus } from './entities/product.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import {
  FilterProductDto,
  getCategoryIds,
  getOriginalVendorCategoryId,
  getSingleVendorId,
} from './dto/filter-product.dto';
import { ProductNamesQueryDto } from './dto/product-names-query.dto';
import {
  Category,
  CategoryStatus,
} from '../categories/entities/category.entity';
import { ProductCategory } from './entities/product-category.entity';
import { Vendor, VendorStatus } from '../vendors/entities/vendor.entity';
import { Brand, BrandStatus } from '../brands/entities/brand.entity';
import { Media } from '../media/entities/media.entity';
import { ProductAttribute } from './entities/product-attribute.entity';
import { ProductAttributeValue } from './entities/product-attribute-value.entity';
import { ProductMedia } from './entities/product-media.entity';
import { ProductSpecificationValue } from './entities/product-specification-value.entity';
import { AttributeValue } from '../attributes/entities/attribute-value.entity';
import { SpecificationValue } from '../specifications/entities/specification-value.entity';
import { CartItem } from '../cart/entities/cart-item.entity';
import { IndexingService, IndexableProduct } from '../search/indexing.service';
import { SynonymConceptService } from '../search/synonym-concept.service';
import { TagsService } from '../search/tags.service';
import { Tag } from '../search/entities/tag.entity';
import { isStorefrontAvailableProduct } from './utils/storefront-product-availability.util';
import { SettingsService } from '../settings/settings.service';

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

  // ─── In-memory background job tracker ─────────────────────────────────────
  // Kept for the lifetime of the process (survives restarts via a fresh Map).
  // Auto-cleaned after 24 h to avoid memory bloat.
  private readonly jobs = new Map<
    string,
    {
      type: 'reindex' | 'generate-concepts';
      status: 'running' | 'done' | 'failed';
      startedAt: Date;
      finishedAt?: Date;
      result?: Record<string, unknown>;
      error?: string;
    }
  >();

  private createJob(type: 'reindex' | 'generate-concepts'): string {
    const id = `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.jobs.set(id, { type, status: 'running', startedAt: new Date() });
    // Auto-evict after 24 h
    setTimeout(() => this.jobs.delete(id), 24 * 60 * 60 * 1000).unref?.();
    return id;
  }

  getJobStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      job_id: jobId,
      type: job.type,
      status: job.status,
      started_at: job.startedAt,
      finished_at: job.finishedAt ?? null,
      duration_seconds: job.finishedAt
        ? Math.round(
            (job.finishedAt.getTime() - job.startedAt.getTime()) / 1000,
          )
        : Math.round((Date.now() - job.startedAt.getTime()) / 1000),
      result: job.result ?? null,
      error: job.error ?? null,
    };
  }

  /** Kick off reindexAll in background and return a job_id immediately. */
  startReindexJob(opts: { dropFirst?: boolean } = {}): string {
    const jobId = this.createJob('reindex');
    this.reindexAll(opts)
      .then((result) => {
        const job = this.jobs.get(jobId);
        if (job) {
          job.status = 'done';
          job.finishedAt = new Date();
          job.result = result as unknown as Record<string, unknown>;
        }
      })
      .catch((err: Error) => {
        const job = this.jobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.finishedAt = new Date();
          job.error = err?.message ?? String(err);
        }
      });
    return jobId;
  }

  /** Kick off generateAiConceptsForAll in background and return a job_id immediately. */
  startGenerateConceptsJob(): string {
    const jobId = this.createJob('generate-concepts');
    this.generateAiConceptsForAll()
      .then((result) => {
        const job = this.jobs.get(jobId);
        if (job) {
          job.status = 'done';
          job.finishedAt = new Date();
          job.result = result as unknown as Record<string, unknown>;
        }
      })
      .catch((err: Error) => {
        const job = this.jobs.get(jobId);
        if (job) {
          job.status = 'failed';
          job.finishedAt = new Date();
          job.error = err?.message ?? String(err);
        }
      });
    return jobId;
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
    private readonly indexingService: IndexingService,
    private readonly synonymConceptService: SynonymConceptService,
    private readonly tagsService: TagsService,
    private readonly settingsService: SettingsService,
  ) {}

  private async shouldShowSalePricing(): Promise<boolean> {
    try {
      const settings = await this.settingsService.getSeoSettings();
      return settings.show_sale_pricing !== false;
    } catch {
      return true;
    }
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

  private async ensureProductsExist(
    productIds: number[],
    manager: EntityManager = this.dataSource.manager,
  ): Promise<void> {
    if (!productIds.length) {
      return;
    }

    const existingProducts = await manager.find(Product, {
      where: { id: In(productIds) },
      select: ['id'],
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
      relations: ['group', 'group.groupProducts', 'group.groupProducts.product'],
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
        select: ['id', 'name_en', 'name_ar', 'slug', 'sku'],
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
    const product = await this.productsRepository.findOne({
      where: { id: productId },
      select: ['id'],
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

  /**
   * Public proxy used by SearchProcessor to reindex a product from a BullMQ job.
   */
  async syncToIndexPublic(productId: number): Promise<void> {
    return this.syncProductToIndex(productId, true);
  }

  // ─── Product tag management ────────────────────────────────────────────────

  /**
   * Get all tags attached to a product (with their linked concepts).
   */
  async getProductTags(productId: number): Promise<Tag[]> {
    const product = await this.productsRepository.findOne({
      where: { id: productId },
      relations: ['tags', 'tags.concepts'],
    } as any);
    if (!product) throw new NotFoundException('Product not found');
    return (product as any).tags ?? [];
  }

  /**
   * Replace the complete tag list for a product.
   * Fires a Typesense reindex after the update.
   */
  async syncProductTags(productId: number, tagNames: string[]): Promise<Tag[]> {
    const exists = await this.productsRepository.count({
      where: { id: productId },
    });
    if (!exists) throw new NotFoundException('Product not found');
    await this.applyTagsToProduct(productId, tagNames);
    void this.syncProductToIndex(productId);
    return this.getProductTags(productId);
  }

  /**
   * Add a single tag by name to a product.
   * Creates the tag (and a background AI concept) if it doesn't exist yet.
   */
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
    void this.syncProductToIndex(productId);
    return tag;
  }

  /**
   * Remove a single tag (by its numeric ID) from a product.
   */
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
    void this.syncProductToIndex(productId);
  }

  /**
   * Replace the product's tag list with the provided tag names.
   * Creates missing tags (and fires background AI concept generation).
   * Uses addAndRemove to update the junction table atomically.
   */
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
      relations: ['tags'],
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

  // ─── Search indexing helpers ───────────────────────────────────────────────

  /**
   * Tokenize a string into lowercase words for tag generation.
   * Splits on whitespace, hyphens, slashes, commas, and dots.
   */
  private tokenizeForTags(text?: string | null): string[] {
    if (!text) return [];
    return text
      .toLowerCase()
      .split(/[\s\-_/,\.\(\)\[\]]+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1);
  }

  /**
   * Build a deduplicated tag array from all searchable signal fields.
   * This is the key to making synonyms work: the synonym "mobile" → "smartphone"
   * only fires if "smartphone" actually appears somewhere in the document.
   * By adding the category name as a tag, the product becomes findable via synonyms
   * even if the product name itself doesn't contain those words.
   */
  private buildSearchTags(
    nameEn: string,
    nameAr: string,
    categoryNames: string[],
    brandEn?: string,
    brandAr?: string,
  ): string[] {
    const parts: string[] = [
      ...this.tokenizeForTags(nameEn),
      ...this.tokenizeForTags(nameAr),
      ...(brandEn ? this.tokenizeForTags(brandEn) : []),
      ...(brandAr ? this.tokenizeForTags(brandAr) : []),
      ...categoryNames.flatMap((n) => this.tokenizeForTags(n)),
    ];
    return [...new Set(parts)];
  }

  /**
   * Load all data needed for Typesense and upsert the document.
   * Fire-and-forget safe — errors are logged but never bubble up to the caller.
   */
  private async syncProductToIndex(
    productId: number,
    throwOnError = false,
    generateAiConcepts = false,
  ): Promise<void> {
    try {
      const showSalePricing = await this.shouldShowSalePricing();
      const [
        product,
        productCategories,
        productMediaRows,
        productWithTags,
      ] = await Promise.all([
        this.productsRepository.findOne({
          where: { id: productId },
          relations: ['brand', 'category', 'vendor'],
        }),
        this.productCategoriesRepository.find({
          where: { product_id: productId },
          relations: ['category'],
        }),
        this.dataSource.getRepository(ProductMedia).find({
          where: { product_id: productId },
          relations: ['media'],
          order: { is_primary: 'DESC', sort_order: 'ASC', media_id: 'ASC' },
        }),
        this.productsRepository.findOne({
          where: { id: productId },
          relations: ['tags', 'tags.concepts'],
        } as any),
      ]);

      if (!product) return;

      // ── Tags: collect all search terms from APPROVED concepts ─────────────
      const tagIds: number[] = ((productWithTags as any)?.tags ?? []).map(
        (t: any) => t.id,
      );
      const searchTags = await this.tagsService.getSearchTermsForTags(tagIds);

      // ── Pricing: direct from product ────────────────────────────────────
      const storefrontPricing = this.resolveStorefrontPricing(
        product,
        showSalePricing,
      );
      const effectivePrice = storefrontPricing.effectivePrice;

      // ── Stock ────────────────────────────────────────────────────────────
      const totalStock = product.quantity ?? 0;
      const inStock = !product.is_out_of_stock;

      // ── Media ────────────────────────────────────────────────────────────
      const images = productMediaRows
        .map((productMedia) => productMedia.media?.url)
        .filter((url): url is string => Boolean(url));

      // ── Category resolution ───────────────────────────────────────────────
      const allCategories = productCategories
        .map((pc) => pc.category)
        .filter(Boolean);

      if (allCategories.length === 0 && (product as any).category) {
        allCategories.push((product as any).category);
      }

      const primaryCategory: Category | null =
        allCategories[0] ?? (product as any).category ?? null;
      const subCategory = allCategories.find((c) => c.level > 0) ?? null;

      const categoryIds = [
        ...new Set([
          ...(product.category_id ? [product.category_id] : []),
          ...allCategories.map((c) => c.id),
        ]),
      ];

      const categoryNamesEn = [
        ...new Set(allCategories.map((c) => c.name_en).filter(Boolean)),
      ];
      const categoryNamesAr = [
        ...new Set(allCategories.map((c) => c.name_ar).filter(Boolean)),
      ];

      // ── Brand data ────────────────────────────────────────────────────────
      const brand = (product as any).brand as {
        id?: number;
        name_en: string;
        name_ar?: string;
      } | null;

      // ── Vendor data ───────────────────────────────────────────────────────
      const vendor = (product as any).vendor as {
        name_en?: string;
        name_ar?: string;
      } | null;

      // ── Attribute pairs — no longer variant-based ───────────────────────
      const attrPairs: string[] | undefined = undefined;

      // ── Descriptions ─────────────────────────────────────────────────────
      const descriptionEn =
        [product.short_description_en, product.long_description_en]
          .filter(Boolean)
          .join(' ')
          .trim() || undefined;

      const descriptionAr =
        [product.short_description_ar, product.long_description_ar]
          .filter(Boolean)
          .join(' ')
          .trim() || undefined;

      // ── Tags ─────────────────────────────────────────────────────────────
      // searchTags contains: tag names + all terms from APPROVED concepts.
      // Fall back to the legacy tokenized approach if no tags are assigned yet.
      const categoryNamesForTags = allCategories.flatMap((c) =>
        [c.name_en, c.name_ar].filter(Boolean),
      );
      const legacyTags = this.buildSearchTags(
        product.name_en,
        product.name_ar,
        categoryNamesForTags,
        brand?.name_en,
        brand?.name_ar,
      );
      const tags = searchTags.length > 0 ? searchTags : legacyTags;

      const isAvailable = isStorefrontAvailableProduct(product);

      const doc: IndexableProduct = {
        // ── Identity ────────────────────────────────────────────────────
        id: String(product.id),
        slug: product.slug ?? undefined,
        sku: product.sku ?? undefined,

        // ── Search text ─────────────────────────────────────────────────
        name_en: product.name_en,
        name_ar: product.name_ar,
        description_en: descriptionEn,
        description_ar: descriptionAr,

        // ── Relational labels ────────────────────────────────────────────
        brand: brand?.name_en ?? 'Unknown',
        category: primaryCategory?.name_en ?? 'Uncategorized',
        subcategory: subCategory?.name_en ?? undefined,
        category_names_en: categoryNamesEn.length ? categoryNamesEn : undefined,
        category_names_ar: categoryNamesAr.length ? categoryNamesAr : undefined,
        tags: tags.length ? tags : undefined,

        // ── Relational IDs (facets) ──────────────────────────────────────
        brand_id: brand?.id ?? product.brand_id ?? undefined,
        vendor_id: product.vendor_id ?? undefined,
        seller_id: product.vendor_id ? String(product.vendor_id) : undefined,
        category_ids: categoryIds.length ? categoryIds : undefined,

        // ── Pricing ─────────────────────────────────────────────────────
        price: storefrontPricing.price,
        sale_price:
          storefrontPricing.salePrice != null
            ? storefrontPricing.salePrice
            : undefined,
        price_min: effectivePrice,
        price_max: effectivePrice,

        // ── Availability ─────────────────────────────────────────────────
        stock_quantity: totalStock,
        in_stock: inStock,
        is_available: isAvailable,

        // ── Attributes ──────────────────────────────────────────────────
        attr_pairs: attrPairs,

        // ── Rating ──────────────────────────────────────────────────────
        rating: Number(product.average_rating) || 0,
        rating_count: product.total_ratings ?? 0,

        // ── Media ────────────────────────────────────────────────────────
        images: images.length ? images : undefined,

        // ── Sort signals ─────────────────────────────────────────────────
        created_at: product.created_at
          ? Math.floor(new Date(product.created_at).getTime() / 1000)
          : Math.floor(Date.now() / 1000),
        popularity_score: this.indexingService.calculatePopularityScore(
          0,
          Number(product.average_rating) || 0,
          product.total_ratings ?? 0,
          product.created_at ?? new Date(),
        ),
        sales_count: undefined,
      };

      await this.indexingService.upsertProduct(doc);

      // ── Fire-and-forget: generate AI synonym concepts (new products only) ──
      if (generateAiConcepts)
        void this.synonymConceptService.generateAndSaveConceptsForProduct({
          name_en: product.name_en,
          name_ar: product.name_ar,
          category_names_en: categoryNamesEn,
          category_names_ar: categoryNamesAr,
          brand_en: brand?.name_en,
          brand_ar: brand?.name_ar,
          vendor_en: vendor?.name_en,
          vendor_ar: vendor?.name_ar,
          short_description_en: product.short_description_en ?? undefined,
          short_description_ar: product.short_description_ar ?? undefined,
          long_description_en: product.long_description_en ?? undefined,
          long_description_ar: product.long_description_ar ?? undefined,
        });
    } catch (err) {
      this.logger.warn(
        `Failed to sync product ${productId} to search index: ${getErrorMessage(err)}`,
      );
      if (throwOnError) throw err;
    }
  }

  /**
   * Public: reindex a single product by ID.
   * Useful for debugging via the admin reindex endpoint.
   */
  async reindexOne(
    productId: number,
  ): Promise<{ success: boolean; message: string }> {
    try {
      await this.syncProductToIndex(productId, true);
      return { success: true, message: `Product ${productId} reindexed` };
    } catch (err: any) {
      return { success: false, message: err?.message ?? 'Unknown error' };
    }
  }

  /**
   * Run AI concept generation for ALL active + visible products.
   * Processes in small sequential batches to respect AI rate limits.
   * Already-existing concept_keys are skipped (safe to run multiple times).
   */
  async generateAiConceptsForAll(): Promise<{
    processed: number;
    failed: number;
    errors: string[];
  }> {
    const products = await this.productsRepository.find({
      relations: ['brand', 'category', 'vendor'],
    });

    this.logger.log(
      `Generating AI concepts for ${products.length} products (all statuses)…`,
    );

    let processed = 0;
    const errors: string[] = [];
    const BATCH = 5; // small batches to avoid AI rate limits
    const DELAY_MS = 1000;

    for (let i = 0; i < products.length; i += BATCH) {
      const batch = products.slice(i, i + BATCH);

      for (const product of batch) {
        try {
          const productCategories = await this.productCategoriesRepository.find(
            {
              where: { product_id: product.id },
              relations: ['category'],
            },
          );

          const allCategories = productCategories
            .map((pc) => pc.category)
            .filter(Boolean);

          if (allCategories.length === 0 && (product as any).category) {
            allCategories.push((product as any).category);
          }

          const categoryNamesEn = [
            ...new Set(allCategories.map((c) => c.name_en).filter(Boolean)),
          ];
          const categoryNamesAr = [
            ...new Set(allCategories.map((c) => c.name_ar).filter(Boolean)),
          ];

          const brand = (product as any).brand as {
            name_en: string;
            name_ar?: string;
          } | null;

          const vendorData = (product as any).vendor as {
            name_en?: string;
            name_ar?: string;
          } | null;

          await this.synonymConceptService.generateAndSaveConceptsForProduct({
            name_en: product.name_en,
            name_ar: product.name_ar,
            category_names_en: categoryNamesEn,
            category_names_ar: categoryNamesAr,
            brand_en: brand?.name_en,
            brand_ar: brand?.name_ar,
            vendor_en: vendorData?.name_en,
            vendor_ar: vendorData?.name_ar,
            short_description_en: product.short_description_en ?? undefined,
            short_description_ar: product.short_description_ar ?? undefined,
            long_description_en: product.long_description_en ?? undefined,
            long_description_ar: product.long_description_ar ?? undefined,
          });

          processed++;
        } catch (err: any) {
          errors.push(`Product ${product.id}: ${err?.message ?? String(err)}`);
        }
      }

      // Delay between batches to respect AI rate limits
      if (i + BATCH < products.length) {
        await new Promise((r) => setTimeout(r, DELAY_MS));
      }
    }

    this.logger.log(
      `✅ AI concept generation done — ${processed}/${products.length} processed, ${errors.length} failed`,
    );

    return { processed, failed: errors.length, errors: errors.slice(0, 20) };
  }

  /**
   * Bulk re-index all ACTIVE + visible products.
   * Called by the admin reindex endpoint.
   * Pass { dropFirst: true } to drop+recreate the Typesense collection first.
   */
  async reindexAll(
    opts: { dropFirst?: boolean } = {},
  ): Promise<{ indexed: number; failed: number; errors: string[] }> {
    if (opts.dropFirst) {
      await this.indexingService.dropAndRecreateCollection();
    }

    const products = await this.productsRepository.find({
      relations: ['brand', 'category'],
    });

    const ids = products.map((p) => p.id);
    this.logger.log(`Reindexing ${ids.length} products (all statuses)…`);

    let indexed = 0;
    const errors: string[] = [];

    // Process concurrently in small batches to avoid DB overload
    const BATCH = 10;
    for (let i = 0; i < ids.length; i += BATCH) {
      const results = await Promise.allSettled(
        ids.slice(i, i + BATCH).map((id) => this.syncProductToIndex(id, true)),
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          indexed++;
        } else {
          errors.push(r.reason?.message ?? String(r.reason));
        }
      }
    }

    this.logger.log(
      `✅ Reindex complete — ${indexed}/${ids.length} products indexed, ${errors.length} failed`,
    );
    if (errors.length) {
      this.logger.warn(`Reindex errors: ${errors.slice(0, 5).join(' | ')}`);
    }
    return { indexed, failed: errors.length, errors: errors.slice(0, 10) };
  }

  /** Runs every night at 03:00 to heal any drift between PostgreSQL and Typesense. */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async scheduledReindex(): Promise<void> {
    this.logger.log('Scheduled nightly reindex started…');
    const { indexed, failed } = await this.reindexAll();
    this.logger.log(
      `Scheduled nightly reindex done — ${indexed} synced, ${failed} failed`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────────

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
      select: ['slug', 'id'],
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
        relations: ['attribute'],
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
        relations: ['specification'],
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

  async create(dto: CreateProductDto, userId?: number): Promise<any> {
    try {
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
        reference_link: dto.reference_link ?? null,
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
        price: dto.price ?? 0,
        sale_price: dto.sale_price ?? null,
        original_vendor_price: dto.original_vendor_price ?? dto.price ?? null,
        original_vendor_sale_price:
          dto.original_vendor_sale_price ?? dto.sale_price ?? null,
        weight: dto.weight ?? null,
        length: dto.length ?? null,
        width: dto.width ?? null,
        height: dto.height ?? null,
        quantity: initialQuantity,
        low_stock_threshold: dto.low_stock_threshold ?? 10,
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

      // Return the complete product
      const result = await this.findOne(savedProduct.id);

      // Sync to Typesense (fire-and-forget — never blocks the response)
      // Pass generateAiConcepts=true so AI runs only on the first index (creation).
      void this.syncProductToIndex(savedProduct.id, false, true);

      return {
        product: result,
        message: 'Product created successfully.',
      };
    } catch (error) {
      throw new BadRequestException(
        `Failed to create product: ${getErrorMessage(error)}`,
      );
    }
  }

  async findAll(filterDto: FilterProductDto, isAdmin = false) {
    const {
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'DESC',
      categoryId,
      vendorId,
      vendor_ids,
      brandId,
      brand_ids,
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
      start_date,
      end_date,
      ids: filterIds,
    } = filterDto;
    const normalizedCategoryIds = getCategoryIds(filterDto);
    const normalizedVendorId = getSingleVendorId(filterDto);
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

    // Filter by visible
    if (visible !== undefined) {
      baseQuery.andWhere('product.visible = :visible', { visible });
    }

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

    // Filter by single vendor (backward compat)
    if (normalizedVendorId !== undefined) {
      baseQuery.andWhere('product.vendor_id = :vendorId', {
        vendorId: normalizedVendorId,
      });
    }

    // Filter by multiple vendors
    if (vendor_ids && vendor_ids.length > 0) {
      baseQuery.andWhere('product.vendor_id IN (:...vendor_ids)', {
        vendor_ids,
      });
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

    // Filter by single brand (backward compat)
    if (brandId) {
      baseQuery.andWhere('product.brand_id = :brandId', { brandId });
    }

    // Filter by multiple brands
    if (brand_ids && brand_ids.length > 0) {
      baseQuery.andWhere('product.brand_id IN (:...brand_ids)', { brand_ids });
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

    // Search by name, sku, or descriptions
    if (search) {
      baseQuery.andWhere(
        '(product.name_en ILIKE :search OR product.name_ar ILIKE :search OR product.sku ILIKE :search OR product.short_description_en ILIKE :search OR product.long_description_en ILIKE :search OR product.original_vendor_category_name ILIKE :search OR CAST(product.original_vendor_categories AS text) ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    // Count (fast because there are no row-exploding joins)
    const total = await baseQuery.getCount();

    // Fetch page IDs (fast)
    const pageQuery = baseQuery.clone().select('product.id', 'id');

    if (sortBy === 'price') {
      // Sort by the effective price (sale_price if present, else price)
      pageQuery.addSelect(
        'COALESCE(product.sale_price, product.price)',
        'effective_price',
      );
      pageQuery.orderBy('effective_price', sortOrder);
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
    const [
      data,
      productCategories,
      productMediaRows,
      attributes,
      attributeValues,
      specifications,
    ] = await Promise.all([
      this.productsRepository
        .createQueryBuilder('product')
        .leftJoinAndSelect('product.category', 'category')
        .leftJoinAndSelect('product.brand', 'brand')
        .leftJoinAndSelect('product.vendor', 'vendor')
        .leftJoinAndSelect('product.createdByUser', 'createdByUser')
        .where('product.id IN (:...ids)', { ids })
        .orderBy(`product.${sortBy}`, sortOrder)
        .getMany(),
      this.productCategoriesRepository.find({
        where: { product_id: In(ids) },
        relations: ['category'],
      }),
      this.dataSource.getRepository(ProductMedia).find({
        where: { product_id: In(ids) },
        relations: ['media'],
      }),
      this.dataSource.getRepository(ProductAttribute).find({
        where: { product_id: In(ids) },
        relations: ['attribute'],
      }),
      this.dataSource.getRepository(ProductAttributeValue).find({
        where: { product_id: In(ids) },
        relations: ['attribute_value', 'attribute_value.attribute'],
      }),
      this.dataSource.getRepository(ProductSpecificationValue).find({
        where: { product_id: In(ids) },
        relations: [
          'specification_value',
          'specification_value.specification',
          'specification_value.parent_value',
          'specification_value.parent_value.specification',
          'specification_value.parent_value.parent_value',
          'specification_value.parent_value.parent_value.specification',
        ],
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
    const transformedData = data.map((product) =>
      this.transformProductDetail(product, isAdmin, showSalePricing),
    );

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

    const {
      media,
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
      attributes,
      attributeValues,
      specifications,
      linkedProductsState,
    ] = await Promise.all([
      this.productsRepository.findOne({
        where: { id },
        relations: ['category', 'vendor', 'brand', 'createdByUser'],
      }),
      this.dataSource.getRepository(ProductCategory).find({
        where: { product_id: id },
        relations: ['category'],
      }),
      this.dataSource.getRepository(ProductMedia).find({
        where: { product_id: id },
        relations: ['media'],
      }),
      this.dataSource.getRepository(ProductAttribute).find({
        where: { product_id: id },
        relations: ['attribute'],
      }),
      this.dataSource.getRepository(ProductAttributeValue).find({
        where: { product_id: id },
        relations: ['attribute_value', 'attribute_value.attribute'],
      }),
      this.dataSource.getRepository(ProductSpecificationValue).find({
        where: { product_id: id },
        relations: [
          'specification_value',
          'specification_value.specification',
          'specification_value.parent_value',
          'specification_value.parent_value.specification',
          'specification_value.parent_value.parent_value',
          'specification_value.parent_value.parent_value.specification',
        ],
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
    productBase.attributes = attributes;
    (productBase as any).attribute_values = attributeValues;
    productBase.specifications = specifications;
    const showSalePricing = isAdmin ? true : await this.shouldShowSalePricing();

    // Return detailed product structure
    return {
      ...this.transformProductDetail(productBase, isAdmin, showSalePricing),
      ...linkedProductsState,
    };
  }

  async findOneBySlug(slug: string, isAdmin = false): Promise<any> {
    const product = await this.productsRepository.findOne({
      where: { slug },
      select: ['id'],
    });

    if (!product) {
      throw new NotFoundException(`Product with slug ${slug} not found`);
    }

    return this.findOne(product.id, isAdmin);
  }

  async findOneByReferenceLink(
    referenceLink: string,
    isAdmin = false,
  ): Promise<any> {
    const normalizedReferenceLink = referenceLink?.trim();

    if (!normalizedReferenceLink) {
      throw new BadRequestException('reference_link query parameter is required');
    }

    const product = await this.productsRepository.findOne({
      where: { reference_link: normalizedReferenceLink },
      select: ['id'],
    });

    if (!product) {
      throw new NotFoundException(
        `Product with reference link ${normalizedReferenceLink} not found`,
      );
    }

    return this.findOne(product.id, isAdmin);
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

    return {
      ...rest,
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
  async update(id: number, dto: UpdateProductDto): Promise<any> {
    // Lightweight check for existence
    const existingProduct = await this.productsRepository.findOne({
      where: { id },
      select: ['id', 'slug', 'quantity', 'is_out_of_stock'],
    });
    if (!existingProduct) {
      throw new NotFoundException('Product not found');
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
        'reference_link',
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
        'length',
        'width',
        'height',
        'quantity',
        'low_stock_threshold',
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

      // Return updated product
      const updatedProduct = await this.findOne(id);

      // Sync to Typesense (fire-and-forget)
      void this.syncProductToIndex(id);

      return {
        product: updatedProduct,
        message: 'Product updated successfully',
      };
    } catch (error) {
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

    // Remove from search index (fire-and-forget)
    void this.indexingService
      .deleteProduct(String(id))
      .catch((err) =>
        this.logger.warn(
          `Failed to remove product ${id} from index: ${err?.message}`,
        ),
      );

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
      relations: ['category', 'vendor'],
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

    // Re-add to search index (fire-and-forget)
    void this.syncProductToIndex(id).catch((err) =>
      this.logger.warn(
        `Failed to re-index restored product ${id}: ${err?.message}`,
      ),
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

    // Search by name, sku, or descriptions
    if (search) {
      queryBuilder.andWhere(
        '(product.name_en ILIKE :search OR product.name_ar ILIKE :search OR product.sku ILIKE :search)',
        { search: `%${search}%` },
      );
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
  async permanentDelete(id: number): Promise<{ message: string }> {
    const product = await this.productsRepository.findOne({
      where: { id },
    });

    if (
      !product ||
      (product.status !== ProductStatus.ARCHIVED &&
        product.status !== ProductStatus.REVIEW)
    ) {
      throw new NotFoundException(
        'Product not found or cannot be permanently deleted. Only archived or in-review products can be permanently deleted.',
      );
    }

    // Remove all cart items referencing this product before deletion
    await this.cartItemsRepository.delete({ product_id: id });

    await this.productsRepository.remove(product);

    return { message: `Product "${product.name_en}" permanently deleted` };
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
}
