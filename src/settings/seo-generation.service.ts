import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { Category } from '../categories/entities/category.entity';
import { Brand } from '../brands/entities/brand.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { SeoEntityType, SeoListStatus } from './dto/list-missing-seo.dto';
import { GenerateSeoDto } from './dto/generate-seo.dto';

type SeoMetaFields = {
  meta_title_en: string | null;
  meta_title_ar: string | null;
  meta_description_en: string | null;
  meta_description_ar: string | null;
};

type SeoCatalogItem = {
  id: number;
  type: SeoEntityType;
  slug: string | null;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  product_count?: number;
  brand_name?: string | null;
  category_names?: string[];
  category_names_ar?: string[];
  /** Parent category names (for subcategory title context). */
  parent_name_en?: string | null;
  parent_name_ar?: string | null;
  /** Top brands stocked in a category. */
  brand_names_en?: string[];
  brand_names_ar?: string[];
  /** Top child subcategories under a category. */
  subcategory_names_en?: string[];
  subcategory_names_ar?: string[];
  /** Vendor trust signals. */
  rating?: number | null;
  rating_count?: number | null;
  price_min?: number | null;
  price_max?: number | null;
  sku?: string | null;
  missing_fields: Array<keyof SeoMetaFields>;
} & SeoMetaFields;

/** Canonical marketplace brand strings for all generated SEO meta. */
const SITE_BRAND_EN = 'ordonsooq';
const SITE_BRAND_AR = 'أردن سوق';

const BANNED_META_CLOSERS = [
  'find the option that suits your needs',
  'shop online with ease',
  'find the right choice for your setup',
  'browse available options',
  'find the perfect match',
  'suit your needs',
  'shop with ease',
  'الخيار الذي يناسب احتياجاتك',
  'تسوق بسهولة',
  'الخيار المناسب لإعدادك',
  'تصفح الخيارات المتاحة',
] as const;

const VALUE_PROP_CLOSERS_EN = [
  'Fast delivery across Jordan.',
  'Competitive prices on authentic stock.',
  'Official warranty where offered by the brand.',
  'Wide selection updated from live catalog.',
  'Trusted Jordan marketplace for genuine products.',
  'Shop genuine products with clear product details.',
  'Reliable fulfillment for shoppers in Jordan.',
] as const;

const VALUE_PROP_CLOSERS_AR = [
  'توصيل سريع في أنحاء الأردن.',
  'أسعار تنافسية لمنتجات أصلية.',
  'ضمان رسمي عند توفره من البراند.',
  'تشكيلة واسعة محدثة من الكتالوج الحي.',
  'سوق أردني موثوق للمنتجات الأصلية.',
  'تسوّق منتجات أصلية مع تفاصيل واضحة.',
  'تنفيذ طلبات موثوق للمتسوقين في الأردن.',
] as const;

type SeoJob = {
  type: 'seo-generate';
  entityType: SeoEntityType;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  startedAt: Date;
  finishedAt?: Date;
  result?: Record<string, unknown>;
  error?: string;
  cancellationRequested?: boolean;
  progress?: number;
  total?: number;
  current_index?: number;
  current_item?: string;
};

type AiSeoResult = SeoMetaFields;

@Injectable()
export class SeoGenerationService {
  private readonly logger = new Logger(SeoGenerationService.name);
  private readonly jobs = new Map<string, SeoJob>();

  constructor(
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoriesRepository: Repository<Category>,
    @InjectRepository(Brand)
    private readonly brandsRepository: Repository<Brand>,
    @InjectRepository(Vendor)
    private readonly vendorsRepository: Repository<Vendor>,
  ) {}

  async getMissingCounts() {
    const [product, category, brand, vendor] = await Promise.all([
      this.countMissing(SeoEntityType.PRODUCT),
      this.countMissing(SeoEntityType.CATEGORY),
      this.countMissing(SeoEntityType.BRAND),
      this.countMissing(SeoEntityType.VENDOR),
    ]);

    return { product, category, brand, vendor };
  }

  async listMissing(params: {
    type?: SeoEntityType;
    seo_status?: SeoListStatus;
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const type = params.type ?? SeoEntityType.PRODUCT;
    const seoStatus = params.seo_status ?? SeoListStatus.ALL;
    const page = Math.max(1, params.page ?? 1);
    // Products stay paginated; category/brand/vendor may load the full set.
    const maxLimit =
      type === SeoEntityType.PRODUCT
        ? 100
        : 5000;
    const limit = Math.min(maxLimit, Math.max(1, params.limit ?? 25));
    const q = params.q?.trim() || undefined;

    const { items, total } = await this.queryMissingPage(type, {
      q,
      page,
      limit,
      seoStatus,
      // List UI only needs identity + missing_fields — skip enrichment joins.
      enrichCatalog: false,
    });

    const counts = await this.getMissingCounts();

    return {
      data: items,
      meta: {
        total,
        page,
        limit,
        totalPages: total > 0 ? Math.ceil(total / limit) : 0,
        counts,
        seo_status: seoStatus,
      },
    };
  }

  startGenerateInBackground(dto: GenerateSeoDto): { job_id: string } {
    if (dto.ids !== 'all_missing' && (!Array.isArray(dto.ids) || dto.ids.length === 0)) {
      throw new BadRequestException(
        'Provide entity IDs or "all_missing" for ids.',
      );
    }

    const jobId = this.createJob(dto.type);

    void this.runGenerateJob(jobId, dto).catch((error: unknown) => {
      const job = this.jobs.get(jobId);
      if (!job) {
        return;
      }

      job.status = 'failed';
      job.finishedAt = new Date();
      job.error =
        error instanceof Error ? error.message : 'SEO generation failed.';
      this.logger.error(`SEO job ${jobId} failed: ${job.error}`);
    });

    return { job_id: jobId };
  }

  getJobStatus(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    return {
      job_id: jobId,
      type: job.type,
      entity_type: job.entityType,
      status: job.status,
      started_at: job.startedAt,
      finished_at: job.finishedAt ?? null,
      progress: job.progress ?? null,
      total: job.total ?? null,
      current_index: job.current_index ?? null,
      current_item: job.current_item ?? null,
      duration_seconds: job.finishedAt
        ? Math.round(
            (job.finishedAt.getTime() - job.startedAt.getTime()) / 1000,
          )
        : Math.round((Date.now() - job.startedAt.getTime()) / 1000),
      result: job.result ?? null,
      error: job.error ?? null,
    };
  }

  private createJob(entityType: SeoEntityType): string {
    const id = `seo-generate-${entityType}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 7)}`;

    this.jobs.set(id, {
      type: 'seo-generate',
      entityType,
      status: 'running',
      startedAt: new Date(),
      cancellationRequested: false,
      progress: 0,
      total: 0,
    });

    setTimeout(() => this.jobs.delete(id), 24 * 60 * 60 * 1000).unref?.();
    return id;
  }

  private async runGenerateJob(jobId: string, dto: GenerateSeoDto) {
    const job = this.jobs.get(jobId);
    if (!job) {
      return;
    }

    const overwrite = dto.overwrite === true;
    const searchInternet = dto.search_internet === true;
    // Research mode uses identity-only prompts — skip catalog enrichment joins.
    const enrichCatalog = !searchInternet;
    const targets = await this.resolveTargets(
      dto.type,
      dto.ids,
      overwrite,
      enrichCatalog,
    );

    job.total = targets.length;
    job.progress = 0;

    if (searchInternet && targets.length > 0) {
      this.logger.warn(
        `SEO research-mode job ${jobId}: ${targets.length} ${dto.type} item(s). ` +
          'Each item requires a live web search (slower, rate-limit sensitive). ' +
          'Empty/unreliable search results use the honest name-only fallback — not catalog data.',
      );
    }

    if (targets.length === 0) {
      job.status = 'done';
      job.finishedAt = new Date();
      job.result = {
        processed: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        failures: [],
      };
      return;
    }

    let updated = 0;
    let skipped = 0;
    let failed = 0;
    const failures: Array<{ id: number; name: string; error: string }> = [];

    for (let index = 0; index < targets.length; index += 1) {
      const currentJob = this.jobs.get(jobId);
      if (!currentJob || currentJob.cancellationRequested) {
        if (currentJob) {
          currentJob.status = 'cancelled';
          currentJob.finishedAt = new Date();
          currentJob.error = 'Cancelled.';
        }
        return;
      }

      const item = targets[index];
      currentJob.current_index = index + 1;
      currentJob.current_item = item.name_en || item.name_ar || String(item.id);
      currentJob.progress = index;

      try {
        const fieldsToFill = overwrite
          ? ([
              'meta_title_en',
              'meta_title_ar',
              'meta_description_en',
              'meta_description_ar',
            ] as Array<keyof SeoMetaFields>)
          : item.missing_fields;

        if (fieldsToFill.length === 0) {
          skipped += 1;
          currentJob.progress = index + 1;
          continue;
        }

        const aiMeta = await this.generateMetaForItem(item, searchInternet);
        const patch: Partial<SeoMetaFields> = {};

        for (const field of fieldsToFill) {
          const value = this.normalizeMetaField(field, aiMeta[field]);
          if (value) {
            patch[field] = value;
          }
        }

        if (Object.keys(patch).length === 0) {
          skipped += 1;
        } else {
          await this.saveMeta(dto.type, item.id, patch);
          updated += 1;
        }
      } catch (error: unknown) {
        failed += 1;
        failures.push({
          id: item.id,
          name: item.name_en || item.name_ar || String(item.id),
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        this.logger.warn(
          `SEO generate failed for ${dto.type} #${item.id}: ${
            error instanceof Error ? error.message : 'unknown'
          }`,
        );
      }

      currentJob.progress = index + 1;
    }

    job.status = 'done';
    job.finishedAt = new Date();
    job.progress = targets.length;
    job.result = {
      processed: targets.length,
      updated,
      skipped,
      failed,
      failures: failures.slice(0, 50),
      search_internet: searchInternet,
      overwrite,
    };
  }

  private async resolveTargets(
    type: SeoEntityType,
    ids: number[] | 'all_missing',
    overwrite: boolean,
    enrichCatalog = true,
  ): Promise<SeoCatalogItem[]> {
    if (ids === 'all_missing') {
      const pageSize = 200;
      let page = 1;
      const all: SeoCatalogItem[] = [];

      while (true) {
        const { items, total } = await this.queryMissingPage(type, {
          page,
          limit: pageSize,
          seoStatus: overwrite ? SeoListStatus.ALL : SeoListStatus.MISSING,
          enrichCatalog,
        });
        all.push(...items);
        if (all.length >= total || items.length === 0) {
          break;
        }
        page += 1;
      }

      return all;
    }

    const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
    if (uniqueIds.length === 0) {
      throw new BadRequestException('No valid entity IDs provided.');
    }

    const items = await this.loadItemsByIds(type, uniqueIds, enrichCatalog);
    if (!overwrite) {
      return items.filter((item) => item.missing_fields.length > 0);
    }
    return items;
  }

  private async queryMissingPage(
    type: SeoEntityType,
    options: {
      q?: string;
      page: number;
      limit: number;
      seoStatus: SeoListStatus;
      /** When false, skip catalog enrichment joins (research-mode generation). */
      enrichCatalog?: boolean;
    },
  ): Promise<{ items: SeoCatalogItem[]; total: number }> {
    const skip = (options.page - 1) * options.limit;
    const enrichCatalog = options.enrichCatalog !== false;

    if (type === SeoEntityType.PRODUCT) {
      const qb = this.productsRepository
        .createQueryBuilder('product')
        .orderBy('product.id', 'DESC');

      if (enrichCatalog) {
        qb.leftJoinAndSelect('product.brand', 'brand')
          .leftJoinAndSelect('product.productCategories', 'productCategories')
          .leftJoinAndSelect('productCategories.category', 'category');
      }

      this.applySeoStatusWhere(qb, 'product', options.seoStatus);

      if (options.q) {
        qb.andWhere(
          new Brackets((where) => {
            where
              .where('product.name_en ILIKE :q')
              .orWhere('product.name_ar ILIKE :q')
              .orWhere('product.slug ILIKE :q')
              .orWhere('product.sku ILIKE :q');
          }),
          { q: `%${options.q}%` },
        );
      }

      const [rows, total] = await qb.skip(skip).take(options.limit).getManyAndCount();
      return {
        total,
        items: rows.map((product) =>
          this.toCatalogItem(SeoEntityType.PRODUCT, {
            id: product.id,
            slug: product.slug,
            name_en: product.name_en,
            name_ar: product.name_ar,
            description_en: enrichCatalog ? product.short_description_en : null,
            description_ar: enrichCatalog ? product.short_description_ar : null,
            meta_title_en: product.meta_title_en,
            meta_title_ar: product.meta_title_ar,
            meta_description_en: product.meta_description_en,
            meta_description_ar: product.meta_description_ar,
            brand_name: enrichCatalog ? product.brand?.name_en ?? null : null,
            category_names: enrichCatalog
              ? (product.productCategories ?? [])
                  .map((entry) => entry.category?.name_en)
                  .filter((name): name is string => Boolean(name))
              : [],
            sku: enrichCatalog ? product.sku : null,
          }),
        ),
      };
    }

    if (type === SeoEntityType.CATEGORY) {
      const qb = this.categoriesRepository
        .createQueryBuilder('category')
        .orderBy('category.id', 'DESC');

      if (enrichCatalog) {
        qb.leftJoinAndSelect('category.parent', 'parent');
      }

      this.applySeoStatusWhere(qb, 'category', options.seoStatus);

      if (options.q) {
        qb.andWhere(
          new Brackets((where) => {
            where
              .where('category.name_en ILIKE :q')
              .orWhere('category.name_ar ILIKE :q')
              .orWhere('category.slug ILIKE :q');
          }),
          { q: `%${options.q}%` },
        );
      }

      const [rows, total] = await qb.skip(skip).take(options.limit).getManyAndCount();
      const items = await this.mapCategoriesToCatalogItems(rows, enrichCatalog);
      return { total, items };
    }

    if (type === SeoEntityType.BRAND) {
      const qb = this.brandsRepository
        .createQueryBuilder('brand')
        .orderBy('brand.id', 'DESC');

      this.applySeoStatusWhere(qb, 'brand', options.seoStatus);

      if (options.q) {
        qb.andWhere(
          new Brackets((where) => {
            where
              .where('brand.name_en ILIKE :q')
              .orWhere('brand.name_ar ILIKE :q')
              .orWhere('brand.slug ILIKE :q');
          }),
          { q: `%${options.q}%` },
        );
      }

      const [rows, total] = await qb.skip(skip).take(options.limit).getManyAndCount();

      if (!enrichCatalog) {
        return {
          total,
          items: rows.map((brand) =>
            this.toCatalogItem(SeoEntityType.BRAND, {
              id: brand.id,
              slug: brand.slug,
              name_en: brand.name_en,
              name_ar: brand.name_ar,
              description_en: null,
              description_ar: null,
              meta_title_en: brand.meta_title_en,
              meta_title_ar: brand.meta_title_ar,
              meta_description_en: brand.meta_description_en,
              meta_description_ar: brand.meta_description_ar,
            }),
          ),
        };
      }

      const brandIds = rows.map((brand) => brand.id);
      const [productCounts, brandCategories] = await Promise.all([
        this.loadBrandProductCounts(brandIds),
        this.loadBrandTopCategories(brandIds),
      ]);
      return {
        total,
        items: rows.map((brand) => {
          const categories = brandCategories.get(brand.id);
          return this.toCatalogItem(SeoEntityType.BRAND, {
            id: brand.id,
            slug: brand.slug,
            name_en: brand.name_en,
            name_ar: brand.name_ar,
            description_en: brand.description_en ?? null,
            description_ar: brand.description_ar ?? null,
            meta_title_en: brand.meta_title_en,
            meta_title_ar: brand.meta_title_ar,
            meta_description_en: brand.meta_description_en,
            meta_description_ar: brand.meta_description_ar,
            product_count: productCounts.get(brand.id) ?? 0,
            category_names: categories?.names_en ?? [],
            category_names_ar: categories?.names_ar ?? [],
          });
        }),
      };
    }

    const qb = this.vendorsRepository
      .createQueryBuilder('vendor')
      .orderBy('vendor.id', 'DESC');

    this.applySeoStatusWhere(qb, 'vendor', options.seoStatus);

    if (options.q) {
      qb.andWhere(
        new Brackets((where) => {
          where
            .where('vendor.name_en ILIKE :q')
            .orWhere('vendor.name_ar ILIKE :q')
            .orWhere('vendor.slug ILIKE :q');
        }),
        { q: `%${options.q}%` },
      );
    }

    const [rows, total] = await qb.skip(skip).take(options.limit).getManyAndCount();
    const items = await this.mapVendorsToCatalogItems(rows, enrichCatalog);
    return { total, items };
  }

  private applySeoStatusWhere(
    qb: { andWhere: (condition: string) => unknown },
    alias: string,
    seoStatus: SeoListStatus,
  ) {
    if (seoStatus === SeoListStatus.ALL) {
      return;
    }

    const missingCondition = `(
      ${alias}.meta_title_en IS NULL OR TRIM(${alias}.meta_title_en) = '' OR
      ${alias}.meta_title_ar IS NULL OR TRIM(${alias}.meta_title_ar) = '' OR
      ${alias}.meta_description_en IS NULL OR TRIM(${alias}.meta_description_en) = '' OR
      ${alias}.meta_description_ar IS NULL OR TRIM(${alias}.meta_description_ar) = ''
    )`;

    if (seoStatus === SeoListStatus.MISSING) {
      qb.andWhere(missingCondition);
      return;
    }

    // complete = every meta field present
    qb.andWhere(
      `(
        ${alias}.meta_title_en IS NOT NULL AND TRIM(${alias}.meta_title_en) <> '' AND
        ${alias}.meta_title_ar IS NOT NULL AND TRIM(${alias}.meta_title_ar) <> '' AND
        ${alias}.meta_description_en IS NOT NULL AND TRIM(${alias}.meta_description_en) <> '' AND
        ${alias}.meta_description_ar IS NOT NULL AND TRIM(${alias}.meta_description_ar) <> ''
      )`,
    );
  }

  private async loadCategoryProductCounts(
    categoryIds: number[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (categoryIds.length === 0) return counts;

    const rows = await this.categoriesRepository.manager
      .createQueryBuilder()
      .select('pc.category_id', 'category_id')
      .addSelect('COUNT(*)', 'count')
      .from('product_categories', 'pc')
      .where('pc.category_id IN (:...ids)', { ids: categoryIds })
      .groupBy('pc.category_id')
      .getRawMany<{ category_id: string | number; count: string | number }>();

    for (const row of rows) {
      counts.set(Number(row.category_id), Number(row.count));
    }
    return counts;
  }

  private async loadBrandProductCounts(
    brandIds: number[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (brandIds.length === 0) return counts;

    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .select('product.brand_id', 'brand_id')
      .addSelect('COUNT(*)', 'count')
      .where('product.brand_id IN (:...ids)', { ids: brandIds })
      .groupBy('product.brand_id')
      .getRawMany<{ brand_id: string | number; count: string | number }>();

    for (const row of rows) {
      counts.set(Number(row.brand_id), Number(row.count));
    }
    return counts;
  }

  /**
   * Top product categories per brand (by product count), used to make
   * brand meta titles/descriptions factually unique.
   */
  private async loadBrandTopCategories(
    brandIds: number[],
    limitPerBrand = 3,
  ): Promise<Map<number, { names_en: string[]; names_ar: string[] }>> {
    const result = new Map<number, { names_en: string[]; names_ar: string[] }>();
    if (brandIds.length === 0) return result;

    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .innerJoin('product.productCategories', 'pc')
      .innerJoin('pc.category', 'category')
      .select('product.brand_id', 'brand_id')
      .addSelect('category.id', 'category_id')
      .addSelect('category.name_en', 'name_en')
      .addSelect('category.name_ar', 'name_ar')
      .addSelect('COUNT(*)', 'count')
      .where('product.brand_id IN (:...ids)', { ids: brandIds })
      .groupBy('product.brand_id')
      .addGroupBy('category.id')
      .addGroupBy('category.name_en')
      .addGroupBy('category.name_ar')
      .getRawMany<{
        brand_id: string | number;
        category_id: string | number;
        name_en: string | null;
        name_ar: string | null;
        count: string | number;
      }>();

    const byBrand = new Map<
      number,
      Array<{ name_en: string | null; name_ar: string | null; count: number }>
    >();

    for (const row of rows) {
      const brandId = Number(row.brand_id);
      const list = byBrand.get(brandId) ?? [];
      list.push({
        name_en: row.name_en,
        name_ar: row.name_ar,
        count: Number(row.count) || 0,
      });
      byBrand.set(brandId, list);
    }

    for (const [brandId, list] of byBrand) {
      list.sort((a, b) => b.count - a.count);
      const names_en: string[] = [];
      const names_ar: string[] = [];
      for (const entry of list.slice(0, limitPerBrand)) {
        const nameEn = entry.name_en?.trim();
        const nameAr = entry.name_ar?.trim();
        if (nameEn) names_en.push(nameEn);
        if (nameAr) names_ar.push(nameAr);
      }
      result.set(brandId, { names_en, names_ar });
    }

    return result;
  }

  private async loadCategoryTopBrands(
    categoryIds: number[],
    limitPerCategory = 3,
  ): Promise<Map<number, { names_en: string[]; names_ar: string[] }>> {
    const result = new Map<number, { names_en: string[]; names_ar: string[] }>();
    if (categoryIds.length === 0) return result;

    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .innerJoin('product.productCategories', 'pc')
      .innerJoin('product.brand', 'brand')
      .select('pc.category_id', 'category_id')
      .addSelect('brand.id', 'brand_id')
      .addSelect('brand.name_en', 'name_en')
      .addSelect('brand.name_ar', 'name_ar')
      .addSelect('COUNT(*)', 'count')
      .where('pc.category_id IN (:...ids)', { ids: categoryIds })
      .andWhere('product.brand_id IS NOT NULL')
      .groupBy('pc.category_id')
      .addGroupBy('brand.id')
      .addGroupBy('brand.name_en')
      .addGroupBy('brand.name_ar')
      .getRawMany<{
        category_id: string | number;
        brand_id: string | number;
        name_en: string | null;
        name_ar: string | null;
        count: string | number;
      }>();

    const byCategory = new Map<
      number,
      Array<{ name_en: string | null; name_ar: string | null; count: number }>
    >();

    for (const row of rows) {
      const categoryId = Number(row.category_id);
      const list = byCategory.get(categoryId) ?? [];
      list.push({
        name_en: row.name_en,
        name_ar: row.name_ar,
        count: Number(row.count) || 0,
      });
      byCategory.set(categoryId, list);
    }

    for (const [categoryId, list] of byCategory) {
      list.sort((a, b) => b.count - a.count);
      const names_en: string[] = [];
      const names_ar: string[] = [];
      for (const entry of list.slice(0, limitPerCategory)) {
        const nameEn = entry.name_en?.trim();
        const nameAr = entry.name_ar?.trim();
        if (nameEn) names_en.push(nameEn);
        if (nameAr) names_ar.push(nameAr);
      }
      result.set(categoryId, { names_en, names_ar });
    }

    return result;
  }

  private async loadCategoryTopSubcategories(
    categoryIds: number[],
    limitPerCategory = 3,
  ): Promise<Map<number, { names_en: string[]; names_ar: string[] }>> {
    const result = new Map<number, { names_en: string[]; names_ar: string[] }>();
    if (categoryIds.length === 0) return result;

    const rows = await this.categoriesRepository
      .createQueryBuilder('child')
      .select('child.parent_id', 'parent_id')
      .addSelect('child.id', 'category_id')
      .addSelect('child.name_en', 'name_en')
      .addSelect('child.name_ar', 'name_ar')
      .where('child.parent_id IN (:...ids)', { ids: categoryIds })
      .orderBy('child.sortOrder', 'ASC')
      .addOrderBy('child.id', 'ASC')
      .getRawMany<{
        parent_id: string | number;
        category_id: string | number;
        name_en: string | null;
        name_ar: string | null;
      }>();

    for (const row of rows) {
      const parentId = Number(row.parent_id);
      const entry = result.get(parentId) ?? { names_en: [], names_ar: [] };
      if (entry.names_en.length >= limitPerCategory) {
        continue;
      }
      const nameEn = row.name_en?.trim();
      const nameAr = row.name_ar?.trim();
      if (nameEn) entry.names_en.push(nameEn);
      if (nameAr) entry.names_ar.push(nameAr);
      result.set(parentId, entry);
    }

    return result;
  }

  private async loadCategoryPriceRanges(
    categoryIds: number[],
  ): Promise<Map<number, { min: number; max: number }>> {
    const result = new Map<number, { min: number; max: number }>();
    if (categoryIds.length === 0) return result;

    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .innerJoin('product.productCategories', 'pc')
      .select('pc.category_id', 'category_id')
      .addSelect('MIN(product.price)', 'price_min')
      .addSelect('MAX(product.price)', 'price_max')
      .where('pc.category_id IN (:...ids)', { ids: categoryIds })
      .andWhere('product.price IS NOT NULL')
      .andWhere('product.price > 0')
      .groupBy('pc.category_id')
      .getRawMany<{
        category_id: string | number;
        price_min: string | number | null;
        price_max: string | number | null;
      }>();

    for (const row of rows) {
      const min = Number(row.price_min);
      const max = Number(row.price_max);
      if (Number.isFinite(min) && Number.isFinite(max)) {
        result.set(Number(row.category_id), { min, max });
      }
    }

    return result;
  }

  private async loadVendorProductCounts(
    vendorIds: number[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    if (vendorIds.length === 0) return counts;

    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .select('product.vendor_id', 'vendor_id')
      .addSelect('COUNT(*)', 'count')
      .where('product.vendor_id IN (:...ids)', { ids: vendorIds })
      .groupBy('product.vendor_id')
      .getRawMany<{ vendor_id: string | number; count: string | number }>();

    for (const row of rows) {
      counts.set(Number(row.vendor_id), Number(row.count));
    }
    return counts;
  }

  private async loadVendorTopCategories(
    vendorIds: number[],
    limitPerVendor = 3,
  ): Promise<Map<number, { names_en: string[]; names_ar: string[] }>> {
    const result = new Map<number, { names_en: string[]; names_ar: string[] }>();
    if (vendorIds.length === 0) return result;

    const rows = await this.productsRepository
      .createQueryBuilder('product')
      .innerJoin('product.productCategories', 'pc')
      .innerJoin('pc.category', 'category')
      .select('product.vendor_id', 'vendor_id')
      .addSelect('category.id', 'category_id')
      .addSelect('category.name_en', 'name_en')
      .addSelect('category.name_ar', 'name_ar')
      .addSelect('COUNT(*)', 'count')
      .where('product.vendor_id IN (:...ids)', { ids: vendorIds })
      .groupBy('product.vendor_id')
      .addGroupBy('category.id')
      .addGroupBy('category.name_en')
      .addGroupBy('category.name_ar')
      .getRawMany<{
        vendor_id: string | number;
        category_id: string | number;
        name_en: string | null;
        name_ar: string | null;
        count: string | number;
      }>();

    const byVendor = new Map<
      number,
      Array<{ name_en: string | null; name_ar: string | null; count: number }>
    >();

    for (const row of rows) {
      const vendorId = Number(row.vendor_id);
      const list = byVendor.get(vendorId) ?? [];
      list.push({
        name_en: row.name_en,
        name_ar: row.name_ar,
        count: Number(row.count) || 0,
      });
      byVendor.set(vendorId, list);
    }

    for (const [vendorId, list] of byVendor) {
      list.sort((a, b) => b.count - a.count);
      const names_en: string[] = [];
      const names_ar: string[] = [];
      for (const entry of list.slice(0, limitPerVendor)) {
        const nameEn = entry.name_en?.trim();
        const nameAr = entry.name_ar?.trim();
        if (nameEn) names_en.push(nameEn);
        if (nameAr) names_ar.push(nameAr);
      }
      result.set(vendorId, { names_en, names_ar });
    }

    return result;
  }

  private async countMissing(type: SeoEntityType): Promise<number> {
    const { total } = await this.queryMissingPage(type, {
      page: 1,
      limit: 1,
      seoStatus: SeoListStatus.MISSING,
    });
    return total;
  }

  private async loadItemsByIds(
    type: SeoEntityType,
    ids: number[],
    enrichCatalog = true,
  ): Promise<SeoCatalogItem[]> {
    if (type === SeoEntityType.PRODUCT) {
      const rows = await this.productsRepository.find({
        where: { id: In(ids) },
        relations: enrichCatalog
          ? {
              brand: true,
              productCategories: {
                category: true,
              },
            }
          : undefined,
      });
      return rows.map((product) =>
        this.toCatalogItem(SeoEntityType.PRODUCT, {
          id: product.id,
          slug: product.slug,
          name_en: product.name_en,
          name_ar: product.name_ar,
          description_en: enrichCatalog ? product.short_description_en : null,
          description_ar: enrichCatalog ? product.short_description_ar : null,
          meta_title_en: product.meta_title_en,
          meta_title_ar: product.meta_title_ar,
          meta_description_en: product.meta_description_en,
          meta_description_ar: product.meta_description_ar,
          brand_name: enrichCatalog ? product.brand?.name_en ?? null : null,
          category_names: enrichCatalog
            ? (product.productCategories ?? [])
                .map((entry) => entry.category?.name_en)
                .filter((name): name is string => Boolean(name))
            : [],
          sku: enrichCatalog ? product.sku : null,
        }),
      );
    }

    if (type === SeoEntityType.CATEGORY) {
      const rows = await this.categoriesRepository.find({
        where: { id: In(ids) },
        relations: enrichCatalog ? { parent: true } : undefined,
      });
      return this.mapCategoriesToCatalogItems(rows, enrichCatalog);
    }

    if (type === SeoEntityType.BRAND) {
      const rows = await this.brandsRepository.find({
        where: { id: In(ids) },
      });

      if (!enrichCatalog) {
        return rows.map((brand) =>
          this.toCatalogItem(SeoEntityType.BRAND, {
            id: brand.id,
            slug: brand.slug,
            name_en: brand.name_en,
            name_ar: brand.name_ar,
            description_en: null,
            description_ar: null,
            meta_title_en: brand.meta_title_en,
            meta_title_ar: brand.meta_title_ar,
            meta_description_en: brand.meta_description_en,
            meta_description_ar: brand.meta_description_ar,
          }),
        );
      }

      const brandIds = rows.map((brand) => brand.id);
      const [productCounts, brandCategories] = await Promise.all([
        this.loadBrandProductCounts(brandIds),
        this.loadBrandTopCategories(brandIds),
      ]);
      return rows.map((brand) => {
        const categories = brandCategories.get(brand.id);
        return this.toCatalogItem(SeoEntityType.BRAND, {
          id: brand.id,
          slug: brand.slug,
          name_en: brand.name_en,
          name_ar: brand.name_ar,
          description_en: brand.description_en ?? null,
          description_ar: brand.description_ar ?? null,
          meta_title_en: brand.meta_title_en,
          meta_title_ar: brand.meta_title_ar,
          meta_description_en: brand.meta_description_en,
          meta_description_ar: brand.meta_description_ar,
          product_count: productCounts.get(brand.id) ?? 0,
          category_names: categories?.names_en ?? [],
          category_names_ar: categories?.names_ar ?? [],
        });
      });
    }

    const rows = await this.vendorsRepository.find({
      where: { id: In(ids) },
    });
    return this.mapVendorsToCatalogItems(rows, enrichCatalog);
  }

  private async mapCategoriesToCatalogItems(
    rows: Category[],
    enrichCatalog = true,
  ): Promise<SeoCatalogItem[]> {
    if (!enrichCatalog) {
      return rows.map((category) =>
        this.toCatalogItem(SeoEntityType.CATEGORY, {
          id: category.id,
          slug: category.slug,
          name_en: category.name_en,
          name_ar: category.name_ar,
          description_en: null,
          description_ar: null,
          meta_title_en: category.meta_title_en,
          meta_title_ar: category.meta_title_ar,
          meta_description_en: category.meta_description_en,
          meta_description_ar: category.meta_description_ar,
        }),
      );
    }

    const categoryIds = rows.map((category) => category.id);
    const [productCounts, topBrands, topSubcategories, priceRanges] =
      await Promise.all([
        this.loadCategoryProductCounts(categoryIds),
        this.loadCategoryTopBrands(categoryIds),
        this.loadCategoryTopSubcategories(categoryIds),
        this.loadCategoryPriceRanges(categoryIds),
      ]);

    return rows.map((category) => {
      const brands = topBrands.get(category.id);
      const subcategories = topSubcategories.get(category.id);
      const prices = priceRanges.get(category.id);
      return this.toCatalogItem(SeoEntityType.CATEGORY, {
        id: category.id,
        slug: category.slug,
        name_en: category.name_en,
        name_ar: category.name_ar,
        description_en: category.description_en,
        description_ar: category.description_ar,
        meta_title_en: category.meta_title_en,
        meta_title_ar: category.meta_title_ar,
        meta_description_en: category.meta_description_en,
        meta_description_ar: category.meta_description_ar,
        product_count: productCounts.get(category.id) ?? 0,
        parent_name_en: category.parent?.name_en ?? null,
        parent_name_ar: category.parent?.name_ar ?? null,
        brand_names_en: brands?.names_en ?? [],
        brand_names_ar: brands?.names_ar ?? [],
        subcategory_names_en: subcategories?.names_en ?? [],
        subcategory_names_ar: subcategories?.names_ar ?? [],
        price_min: prices?.min ?? null,
        price_max: prices?.max ?? null,
      });
    });
  }

  private async mapVendorsToCatalogItems(
    rows: Vendor[],
    enrichCatalog = true,
  ): Promise<SeoCatalogItem[]> {
    if (!enrichCatalog) {
      return rows.map((vendor) =>
        this.toCatalogItem(SeoEntityType.VENDOR, {
          id: vendor.id,
          slug: vendor.slug,
          name_en: vendor.name_en,
          name_ar: vendor.name_ar,
          description_en: null,
          description_ar: null,
          meta_title_en: vendor.meta_title_en,
          meta_title_ar: vendor.meta_title_ar,
          meta_description_en: vendor.meta_description_en,
          meta_description_ar: vendor.meta_description_ar,
        }),
      );
    }

    const vendorIds = rows.map((vendor) => vendor.id);
    const [productCounts, vendorCategories] = await Promise.all([
      this.loadVendorProductCounts(vendorIds),
      this.loadVendorTopCategories(vendorIds),
    ]);

    return rows.map((vendor) => {
      const categories = vendorCategories.get(vendor.id);
      return this.toCatalogItem(SeoEntityType.VENDOR, {
        id: vendor.id,
        slug: vendor.slug,
        name_en: vendor.name_en,
        name_ar: vendor.name_ar,
        description_en: vendor.description_en,
        description_ar: vendor.description_ar,
        meta_title_en: vendor.meta_title_en,
        meta_title_ar: vendor.meta_title_ar,
        meta_description_en: vendor.meta_description_en,
        meta_description_ar: vendor.meta_description_ar,
        product_count: productCounts.get(vendor.id) ?? 0,
        category_names: categories?.names_en ?? [],
        category_names_ar: categories?.names_ar ?? [],
        rating: Number(vendor.rating) || 0,
        rating_count: vendor.rating_count ?? 0,
      });
    });
  }

  private toCatalogItem(
    type: SeoEntityType,
    input: {
      id: number;
      slug: string | null;
      name_en: string;
      name_ar: string;
      description_en: string | null;
      description_ar: string | null;
      meta_title_en: string | null;
      meta_title_ar: string | null;
      meta_description_en: string | null;
      meta_description_ar: string | null;
      product_count?: number;
      brand_name?: string | null;
      category_names?: string[];
      category_names_ar?: string[];
      parent_name_en?: string | null;
      parent_name_ar?: string | null;
      brand_names_en?: string[];
      brand_names_ar?: string[];
      subcategory_names_en?: string[];
      subcategory_names_ar?: string[];
      rating?: number | null;
      rating_count?: number | null;
      price_min?: number | null;
      price_max?: number | null;
      sku?: string | null;
    },
  ): SeoCatalogItem {
    const meta: SeoMetaFields = {
      meta_title_en: input.meta_title_en,
      meta_title_ar: input.meta_title_ar,
      meta_description_en: input.meta_description_en,
      meta_description_ar: input.meta_description_ar,
    };

    const missing_fields = (
      Object.keys(meta) as Array<keyof SeoMetaFields>
    ).filter((key) => !meta[key]?.trim());

    return {
      id: input.id,
      type,
      slug: input.slug,
      name_en: input.name_en,
      name_ar: input.name_ar,
      description_en: input.description_en,
      description_ar: input.description_ar,
      product_count: input.product_count,
      brand_name: input.brand_name,
      category_names: input.category_names,
      category_names_ar: input.category_names_ar,
      parent_name_en: input.parent_name_en,
      parent_name_ar: input.parent_name_ar,
      brand_names_en: input.brand_names_en,
      brand_names_ar: input.brand_names_ar,
      subcategory_names_en: input.subcategory_names_en,
      subcategory_names_ar: input.subcategory_names_ar,
      rating: input.rating,
      rating_count: input.rating_count,
      price_min: input.price_min,
      price_max: input.price_max,
      sku: input.sku,
      missing_fields,
      ...meta,
    };
  }

  private async saveMeta(
    type: SeoEntityType,
    id: number,
    patch: Partial<SeoMetaFields>,
  ) {
    if (type === SeoEntityType.PRODUCT) {
      const result = await this.productsRepository.update(id, patch);
      if (!result.affected) {
        throw new NotFoundException(`Product #${id} not found`);
      }
      return;
    }

    if (type === SeoEntityType.CATEGORY) {
      const result = await this.categoriesRepository.update(id, patch);
      if (!result.affected) {
        throw new NotFoundException(`Category #${id} not found`);
      }
      return;
    }

    if (type === SeoEntityType.BRAND) {
      const result = await this.brandsRepository.update(id, patch);
      if (!result.affected) {
        throw new NotFoundException(`Brand #${id} not found`);
      }
      return;
    }

    const result = await this.vendorsRepository.update(id, patch);
    if (!result.affected) {
      throw new NotFoundException(`Vendor #${id} not found`);
    }
  }

  private async generateMetaForItem(
    item: SeoCatalogItem,
    searchInternet: boolean,
  ): Promise<AiSeoResult> {
    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    if (!openAiKey) {
      throw new BadRequestException('Missing OPENAI_API_KEY environment variable.');
    }

    const model =
      process.env.SEO_OPENAI_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-5.6-terra';

    const systemPrompt = searchInternet
      ? this.buildResearchSystemPrompt(item.type)
      : this.buildCatalogSystemPrompt(item.type);
    const userPrompt = JSON.stringify(
      this.buildUserPayload(item, searchInternet),
      null,
      2,
    );

    const body: Record<string, unknown> = {
      model,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    if (searchInternet) {
      body.tools = [{ type: 'web_search' }];
    }

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    const responseBody = this.tryParseJson(responseText) ?? responseText;

    if (!response.ok) {
      const message =
        typeof responseBody === 'object' &&
        responseBody &&
        'error' in responseBody &&
        typeof (responseBody as { error?: { message?: string } }).error
          ?.message === 'string'
          ? (responseBody as { error: { message: string } }).error.message
          : `OpenAI request failed (${response.status})`;
      throw new BadRequestException(message);
    }

    const rawText = this.stripCodeFences(this.extractOpenAiText(responseBody));
    const parsed = this.tryParseJson(rawText);
    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException('OpenAI returned invalid SEO JSON.');
    }

    const record = parsed as Record<string, unknown>;
    return {
      meta_title_en: this.asTrimmedString(record.meta_title_en),
      meta_title_ar: this.asTrimmedString(record.meta_title_ar),
      meta_description_en: this.asTrimmedString(record.meta_description_en),
      meta_description_ar: this.asTrimmedString(record.meta_description_ar),
    };
  }

  /**
   * Catalog mode: full DB-derived facts.
   * Research mode: identity-only — catalog facts must not appear in the JSON at all.
   */
  private buildUserPayload(
    item: SeoCatalogItem,
    searchInternet: boolean,
  ): Record<string, unknown> {
    if (searchInternet) {
      return {
        mode: 'research',
        entity_type: item.type,
        name_en: item.name_en,
        name_ar: item.name_ar,
        site_brand_en: SITE_BRAND_EN,
        site_brand_ar: SITE_BRAND_AR,
        market: 'Jordan',
        location_qualifier_en: 'in Jordan',
        location_qualifier_ar: 'في الأردن',
      };
    }

    return {
      mode: 'catalog',
      entity_type: item.type,
      name_en: item.name_en,
      name_ar: item.name_ar,
      slug: item.slug,
      description_en: item.description_en,
      description_ar: item.description_ar,
      product_count: item.product_count ?? null,
      brand_name: item.brand_name ?? null,
      category_names_en: item.category_names ?? [],
      category_names_ar: item.category_names_ar ?? [],
      parent_name_en: item.parent_name_en ?? null,
      parent_name_ar: item.parent_name_ar ?? null,
      brand_names_en: item.brand_names_en ?? [],
      brand_names_ar: item.brand_names_ar ?? [],
      subcategory_names_en: item.subcategory_names_en ?? [],
      subcategory_names_ar: item.subcategory_names_ar ?? [],
      rating: item.rating ?? null,
      rating_count: item.rating_count ?? null,
      price_min: item.price_min ?? null,
      price_max: item.price_max ?? null,
      sku: item.sku ?? null,
      site_brand_en: SITE_BRAND_EN,
      site_brand_ar: SITE_BRAND_AR,
      market: 'Jordan',
      location_qualifier_en: 'in Jordan',
      location_qualifier_ar: 'في الأردن',
      value_prop_closers_en: VALUE_PROP_CLOSERS_EN,
      value_prop_closers_ar: VALUE_PROP_CLOSERS_AR,
    };
  }

  /** Formatting rules shared by catalog and research modes (not catalog facts). */
  private buildSharedFormattingRules(): string[] {
    return [
      'You write professional ecommerce SEO metadata for the Jordan marketplace ordonsooq.',
      'Return ONLY valid JSON with exactly these keys:',
      'meta_title_en, meta_title_ar, meta_description_en, meta_description_ar.',
      '',
      '## Canonical marketplace brand naming (hard rules — never break)',
      `- English site brand MUST always be exactly "${SITE_BRAND_EN}" (lowercase, one word).`,
      `- Arabic site brand MUST always be exactly "${SITE_BRAND_AR}".`,
      `- NEVER write: OrdonSooq, Ordon Sooq, ORDONSOOQ, أوردن سوق, أوردرن سوق, or any other spelling/variant.`,
      `- In EVERY meta_title_en and meta_description_en, the marketplace name appears only as "${SITE_BRAND_EN}".`,
      `- In EVERY meta_title_ar and meta_description_ar, the marketplace name appears only as "${SITE_BRAND_AR}".`,
      '- Never retype or invent a different trailing site-brand suffix. Treat it as a locked constant.',
      '',
      '## Global meta formatting rules',
      '- meta_title_en / meta_title_ar: target 50–60 characters (hard max 70). Do not leave unused room with bare short titles.',
      '- meta_description_en / meta_description_ar: target 140–155 characters (hard max 160).',
      '- Natural Modern Standard Arabic suitable for Jordan shoppers.',
      '- Use Western (0-9) numerals in Arabic meta, matching the rest of the Arabic UI.',
      '- Keep transliterated brand/product names consistent across fields.',
      '- Ban generic thin closers. Never use phrases like:',
      ...BANNED_META_CLOSERS.map((phrase) => `  - "${phrase}"`),
      '- No keyword stuffing. No quotes around the whole title/description. No emoji.',
      `- Trailing title suffix must be exactly " | ${SITE_BRAND_EN}" (EN) / " | ${SITE_BRAND_AR}" (AR).`,
    ];
  }

  private buildCatalogSystemPrompt(entityType: SeoEntityType): string {
    const common = [
      ...this.buildSharedFormattingRules(),
      '',
      '## Mode: CATALOG (database facts only)',
      '- You have been given a full catalog-derived payload for this entity.',
      '- Use ONLY the provided catalog payload. Do not assume facts from the web.',
      '- Do not invent prices, stock, warranties, delivery times, ratings, or specs not in the payload.',
      '- Prefer concrete value props grounded in payload data (product_count, brands, categories, price range, rating).',
      '- When description_en / description_ar exist, ground the meta description in those facts first.',
      '- When descriptions are null/empty, build uniqueness from real payload data — never interchangeable filler.',
      '- Pick ONE closer from value_prop_closers_en / value_prop_closers_ar (rotate by entity name so pages are not near-duplicates).',
    ];

    if (entityType === SeoEntityType.BRAND) {
      return [
        ...common,
        '',
        '## Brand page meta title formula (required)',
        `EN template: "{Brand Name} {Category/Differentiator} | ${SITE_BRAND_EN}"`,
        `AR template: "{اسم البراند} {الفئة/المميّز} | ${SITE_BRAND_AR}"`,
        '- Always include a category or differentiator when the brand sells more than one product type (use top 1–3 from category_names_en / category_names_ar).',
        '- Prefer patterns like "Ugreen Chargers, Cables & Hubs", "Canon Cameras & Printers", "Fantech Gaming Gear".',
        `- Never use bare "{Brand} | ${SITE_BRAND_EN}" when category_names_en has usable categories.`,
        '',
        '## Brand page meta description formula (required)',
        `EN: "{Action verb} {brand} {2-3 real categories} on ${SITE_BRAND_EN}. {Concrete value prop}."`,
        `AR: "{فعل} {البراند} {٢–٣ فئات حقيقية} على ${SITE_BRAND_AR}. {قيمة ملموسة}."`,
        '- Use 2–3 real categories from category_names_* when available.',
        '- If product_count > 0, you MAY mention it, then add a strong concrete second half.',
        '- Never reuse the same sentence skeleton with only the brand name swapped.',
      ].join('\n');
    }

    if (entityType === SeoEntityType.PRODUCT) {
      return [
        ...common,
        '',
        '## Product page meta',
        `EN title: "{Product Name}{optional short differentiator} | ${SITE_BRAND_EN}" (include brand_name when it fits).`,
        `AR title: "{اسم المنتج}{مميّز قصير اختياري} | ${SITE_BRAND_AR}".`,
        '- Description: what the product is + brand/category context from payload + one concrete value prop.',
      ].join('\n');
    }

    if (entityType === SeoEntityType.CATEGORY) {
      return [
        ...common,
        '',
        '## Category page meta title formula (required)',
        `Preferred: "{Category Name} in Jordan | ${SITE_BRAND_EN}" or "Shop {Category Name} Online | ${SITE_BRAND_EN}"`,
        `Subcategory with parent: "{Category Name} | {Parent Name} | ${SITE_BRAND_EN}"`,
        `AR: "{اسم الفئة} في الأردن | ${SITE_BRAND_AR}" / "تسوّق {اسم الفئة} أونلاين | ${SITE_BRAND_AR}" / "{اسم الفئة} | {اسم الفئة الأم} | ${SITE_BRAND_AR}"`,
        '- Put the exact-match category keyword as early as possible.',
        '- Include location qualifier when it fits search intent and length.',
        '',
        '## Category page meta description formula (required)',
        `EN: "{Action verb} {category} {2-3 real subcategory or brand examples} on ${SITE_BRAND_EN}. {Value prop}."`,
        '- MUST pull examples from brand_names_* and/or subcategory_names_* — never invent them.',
        '- Use product_count / price_min / price_max when present; do not disguise low inventory with filler.',
      ].join('\n');
    }

    if (entityType === SeoEntityType.VENDOR) {
      return [
        ...common,
        '',
        '## Store / vendor page meta title formula (required)',
        `Prefer "{Store Name} - {What they sell} | ${SITE_BRAND_EN}" when category_names_en exist; else "{Store Name} Store | ${SITE_BRAND_EN}".`,
        `AR: "{اسم المتجر} - {ما يبيعونه} | ${SITE_BRAND_AR}" or "متجر {اسم المتجر} | ${SITE_BRAND_AR}".`,
        '- Generic store names require a category differentiator.',
        '',
        '## Store / vendor page meta description formula (required)',
        `EN: "{Store name} sells {2-3 real product categories} on ${SITE_BRAND_EN}. {Trust signal}."`,
        '- MUST use category_names_*; surface rating/rating_count/product_count only when present in payload.',
        '- Do not invent verified status, years active, or order counts.',
      ].join('\n');
    }

    return [
      ...common,
      '',
      '## Fallback entity meta',
      `EN title: "{Name} | ${SITE_BRAND_EN}".`,
      `AR title: "{الاسم} | ${SITE_BRAND_AR}".`,
      '- Description: specific + concrete value prop from payload only.',
    ].join('\n');
  }

  private buildResearchSystemPrompt(entityType: SeoEntityType): string {
    const entityLabel =
      entityType === SeoEntityType.VENDOR
        ? 'vendor/store'
        : entityType === SeoEntityType.BRAND
          ? 'brand'
          : entityType === SeoEntityType.CATEGORY
            ? 'category'
            : 'product';

    const searchTarget =
      entityType === SeoEntityType.VENDOR
        ? 'Search for the real storefront/business behind this vendor name and what it is known for selling (product lines, specialties, market reputation). Prefer Jordan/regional context when available.'
        : entityType === SeoEntityType.BRAND
          ? "Search for this brand's actual product lines, categories, and market position. Prefer facts useful for an ecommerce brand page in Jordan."
          : entityType === SeoEntityType.CATEGORY
            ? 'Search for what this product category genuinely covers (typical subcategories, representative brands, shopper intent). Prefer Jordan ecommerce search intent when available.'
            : 'Search for publicly known facts about this product (what it is, brand/line context). Do not invent specs or commercial claims.';

    const formulas =
      entityType === SeoEntityType.BRAND
        ? [
            '## Brand page formulas (after research)',
            `EN title: "{Brand Name} {Category/Differentiator from research} | ${SITE_BRAND_EN}"`,
            `AR title: "{اسم البراند} {الفئة/المميّز} | ${SITE_BRAND_AR}"`,
            `EN description: "{Action verb} {brand} {2-3 researched product lines/categories} on ${SITE_BRAND_EN}. {Concrete true value prop}."`,
            'Only use differentiators/categories confirmed by web search.',
          ]
        : entityType === SeoEntityType.CATEGORY
          ? [
              '## Category page formulas (after research)',
              `EN title: "{Category Name} in Jordan | ${SITE_BRAND_EN}" or "Shop {Category Name} Online | ${SITE_BRAND_EN}"`,
              `AR title: "{اسم الفئة} في الأردن | ${SITE_BRAND_AR}"`,
              `EN description: "{Action verb} {category} {2-3 researched subcategories or representative brands} on ${SITE_BRAND_EN}. {Value prop}."`,
              'Only name brands/subcategories confirmed by web search.',
            ]
          : entityType === SeoEntityType.VENDOR
            ? [
                '## Store / vendor page formulas (after research)',
                `EN title: "{Store Name} - {What they sell from research} | ${SITE_BRAND_EN}" (or "{Store Name} Store | ${SITE_BRAND_EN}" if specialty unknown)`,
                `AR title: "{اسم المتجر} - {ما يبيعونه} | ${SITE_BRAND_AR}"`,
                `EN description: "{Store name} sells {2-3 researched specialties} on ${SITE_BRAND_EN}. {Trust/positioning only if found}."`,
                'Do not invent ratings, review counts, or verified badges.',
              ]
            : [
                '## Product page formulas (after research)',
                `EN title: "{Product Name}{short researched differentiator} | ${SITE_BRAND_EN}"`,
                `AR title: "{اسم المنتج}{مميّز قصير} | ${SITE_BRAND_AR}"`,
                '- Description from researched product identity + one concrete marketplace value prop; no invented specs.',
              ];

    return [
      ...this.buildSharedFormattingRules(),
      '',
      '## Mode: RESEARCH (web search required)',
      `You have been given ONLY the ${entityLabel}'s name in English and Arabic, plus locked marketplace constants.`,
      'You have NOT been given any catalog information about what this entity sells, its scale, ratings, prices, SKUs, descriptions, or related taxonomy.',
      'You MUST use web search to find out before writing anything.',
      'Workflow (mandatory):',
      '1) Search first using the web_search tool.',
      '2) Read/confirm useful public facts.',
      '3) Only then draft the four meta fields as JSON.',
      'Do not draft titles/descriptions before searching.',
      '',
      '## What to search for',
      searchTarget,
      '',
      '## Fallback when search is empty or unreliable',
      'If search returns nothing useful (obscure local vendor, unknown brand, ambiguous category name, conflicting results):',
      '- Write honest, generic-but-accurate copy using ONLY the entity name + entity type + marketplace constants.',
      '- Do NOT invent categories, product lines, scale, ratings, trust signals, prices, or inventory claims.',
      `- Safe fallback title shape: "{Name} | ${SITE_BRAND_EN}" / "{الاسم} | ${SITE_BRAND_AR}" (or minimal honest differentiator that does not invent facts).`,
      '- Safe fallback description: invite shoppers to browse that named entity on the marketplace + one non-specific Jordan marketplace value prop (delivery/selection framing) without fake specifics.',
      '',
      ...formulas,
      '',
      '- Still never invent commercial claims that search did not support.',
      '- Prefer concrete researched facts over filler; if unsure, use the fallback path.',
    ].join('\n');
  }

  private normalizeMetaField(
    field: keyof SeoMetaFields,
    value: string | null,
  ): string | null {
    if (!value?.trim()) {
      return null;
    }

    const isTitle = field.startsWith('meta_title');
    const isArabic = field.endsWith('_ar');
    let normalized = this.canonicalizeSiteBrand(value.trim(), isArabic);

    if (isTitle) {
      normalized = this.ensureTitleSiteSuffix(normalized, isArabic);
    }

    const max = isTitle ? 70 : 160;
    return normalized.slice(0, max).trim();
  }

  /** Force every meta string onto the two canonical site-brand spellings. */
  private canonicalizeSiteBrand(value: string, arabic: boolean): string {
    const siteBrand = arabic ? SITE_BRAND_AR : SITE_BRAND_EN;

    let next = value
      // Broken Arabic variants (typo with extra ر, alternate spellings)
      .replace(/أوردرن\s*سوق/g, SITE_BRAND_AR)
      .replace(/أوردن\s*سوق/g, SITE_BRAND_AR)
      .replace(/اردن\s*سوق/g, SITE_BRAND_AR)
      // Latin brand variants → canonical for the locale
      .replace(/Ordon\s*Sooq/gi, siteBrand)
      .replace(/ordonsooq/gi, siteBrand);

    if (arabic) {
      // Ensure Arabic fields never keep Latin site brand
      next = next.replace(/ordonsooq/gi, SITE_BRAND_AR);
    } else {
      // Ensure English fields never keep Arabic site brand
      next = next
        .replace(/أردن\s*سوق/g, SITE_BRAND_EN)
        .replace(/أوردن\s*سوق/g, SITE_BRAND_EN)
        .replace(/أوردرن\s*سوق/g, SITE_BRAND_EN);
    }

    return next.replace(/\s+/g, ' ').trim();
  }

  private ensureTitleSiteSuffix(title: string, arabic: boolean): string {
    const suffix = arabic ? SITE_BRAND_AR : SITE_BRAND_EN;
    const pipeSuffix = ` | ${suffix}`;

    // Strip any existing trailing site-brand suffix (with/without pipe)
    const stripped = title
      .replace(
        /\s*[|｜]\s*(ordonsooq|OrdonSooq|أردن\s*سوق|أوردن\s*سوق|أوردرن\s*سوق)\s*$/i,
        '',
      )
      .replace(
        /\s+(ordonsooq|OrdonSooq|أردن\s*سوق|أوردن\s*سوق|أوردرن\s*سوق)\s*$/i,
        '',
      )
      .trim();

    const withSuffix = `${stripped}${pipeSuffix}`;
    if (withSuffix.length <= 70) {
      return withSuffix;
    }

    // Truncate the head so the locked suffix always fits.
    const maxHead = 70 - pipeSuffix.length;
    return `${stripped.slice(0, Math.max(1, maxHead)).trimEnd()}${pipeSuffix}`;
  }

  private asTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
  }

  private tryParseJson(value: string): unknown | null {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  private extractOpenAiText(responseBody: unknown): string {
    if (!responseBody || typeof responseBody !== 'object') {
      throw new BadRequestException('OpenAI response was not a JSON object.');
    }

    const body = responseBody as Record<string, unknown>;
    if (typeof body.output_text === 'string' && body.output_text.trim()) {
      return body.output_text;
    }

    const output = Array.isArray(body.output) ? body.output : [];
    for (const item of output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const content = Array.isArray((item as { content?: unknown }).content)
        ? ((item as { content: Array<Record<string, unknown>> }).content)
        : [];
      for (const contentItem of content) {
        if (typeof contentItem.text === 'string' && contentItem.text.trim()) {
          return contentItem.text;
        }
      }
    }

    throw new BadRequestException('OpenAI response did not include text output.');
  }

  private stripCodeFences(value: string): string {
    return value
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
  }
}
