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
import { SeoEntityType } from './dto/list-missing-seo.dto';
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
  sku?: string | null;
  missing_fields: Array<keyof SeoMetaFields>;
} & SeoMetaFields;

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
    q?: string;
    page?: number;
    limit?: number;
  }) {
    const type = params.type ?? SeoEntityType.PRODUCT;
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 25));
    const q = params.q?.trim() || undefined;

    const { items, total } = await this.queryMissingPage(type, {
      q,
      page,
      limit,
      overwrite: false,
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
    const targets = await this.resolveTargets(dto.type, dto.ids, overwrite);

    job.total = targets.length;
    job.progress = 0;

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
  ): Promise<SeoCatalogItem[]> {
    if (ids === 'all_missing') {
      const pageSize = 200;
      let page = 1;
      const all: SeoCatalogItem[] = [];

      while (true) {
        const { items, total } = await this.queryMissingPage(type, {
          page,
          limit: pageSize,
          overwrite,
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

    const items = await this.loadItemsByIds(type, uniqueIds);
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
      overwrite: boolean;
    },
  ): Promise<{ items: SeoCatalogItem[]; total: number }> {
    const skip = (options.page - 1) * options.limit;

    if (type === SeoEntityType.PRODUCT) {
      const qb = this.productsRepository
        .createQueryBuilder('product')
        .leftJoinAndSelect('product.brand', 'brand')
        .leftJoinAndSelect('product.productCategories', 'productCategories')
        .leftJoinAndSelect('productCategories.category', 'category')
        .orderBy('product.id', 'DESC');

      if (!options.overwrite) {
        this.applyMissingMetaWhere(qb, 'product');
      }

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
            description_en: product.short_description_en,
            description_ar: product.short_description_ar,
            meta_title_en: product.meta_title_en,
            meta_title_ar: product.meta_title_ar,
            meta_description_en: product.meta_description_en,
            meta_description_ar: product.meta_description_ar,
            brand_name: product.brand?.name_en ?? null,
            category_names: (product.productCategories ?? [])
              .map((entry) => entry.category?.name_en)
              .filter((name): name is string => Boolean(name)),
            sku: product.sku,
          }),
        ),
      };
    }

    if (type === SeoEntityType.CATEGORY) {
      const qb = this.categoriesRepository
        .createQueryBuilder('category')
        .orderBy('category.id', 'DESC');

      if (!options.overwrite) {
        this.applyMissingMetaWhere(qb, 'category');
      }

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
      const productCounts = await this.loadCategoryProductCounts(
        rows.map((category) => category.id),
      );
      return {
        total,
        items: rows.map((category) =>
          this.toCatalogItem(SeoEntityType.CATEGORY, {
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
          }),
        ),
      };
    }

    if (type === SeoEntityType.BRAND) {
      const qb = this.brandsRepository
        .createQueryBuilder('brand')
        .orderBy('brand.id', 'DESC');

      if (!options.overwrite) {
        this.applyMissingMetaWhere(qb, 'brand');
      }

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
      const productCounts = await this.loadBrandProductCounts(
        rows.map((brand) => brand.id),
      );
      return {
        total,
        items: rows.map((brand) =>
          this.toCatalogItem(SeoEntityType.BRAND, {
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
          }),
        ),
      };
    }

    const qb = this.vendorsRepository
      .createQueryBuilder('vendor')
      .orderBy('vendor.id', 'DESC');

    if (!options.overwrite) {
      this.applyMissingMetaWhere(qb, 'vendor');
    }

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
    return {
      total,
      items: rows.map((vendor) =>
        this.toCatalogItem(SeoEntityType.VENDOR, {
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
        }),
      ),
    };
  }

  private applyMissingMetaWhere(
    qb: { andWhere: (condition: string) => unknown },
    alias: string,
  ) {
    qb.andWhere(
      `(
        ${alias}.meta_title_en IS NULL OR TRIM(${alias}.meta_title_en) = '' OR
        ${alias}.meta_title_ar IS NULL OR TRIM(${alias}.meta_title_ar) = '' OR
        ${alias}.meta_description_en IS NULL OR TRIM(${alias}.meta_description_en) = '' OR
        ${alias}.meta_description_ar IS NULL OR TRIM(${alias}.meta_description_ar) = ''
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

  private async countMissing(type: SeoEntityType): Promise<number> {
    const { total } = await this.queryMissingPage(type, {
      page: 1,
      limit: 1,
      overwrite: false,
    });
    return total;
  }

  private async loadItemsByIds(
    type: SeoEntityType,
    ids: number[],
  ): Promise<SeoCatalogItem[]> {
    if (type === SeoEntityType.PRODUCT) {
      const rows = await this.productsRepository.find({
        where: { id: In(ids) },
        relations: {
          brand: true,
          productCategories: {
            category: true,
          },
        },
      });
      return rows.map((product) =>
        this.toCatalogItem(SeoEntityType.PRODUCT, {
          id: product.id,
          slug: product.slug,
          name_en: product.name_en,
          name_ar: product.name_ar,
          description_en: product.short_description_en,
          description_ar: product.short_description_ar,
          meta_title_en: product.meta_title_en,
          meta_title_ar: product.meta_title_ar,
          meta_description_en: product.meta_description_en,
          meta_description_ar: product.meta_description_ar,
          brand_name: product.brand?.name_en ?? null,
          category_names: (product.productCategories ?? [])
            .map((entry) => entry.category?.name_en)
            .filter((name): name is string => Boolean(name)),
          sku: product.sku,
        }),
      );
    }

    if (type === SeoEntityType.CATEGORY) {
      const rows = await this.categoriesRepository.find({
        where: { id: In(ids) },
      });
      return rows.map((category) =>
        this.toCatalogItem(SeoEntityType.CATEGORY, {
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
        }),
      );
    }

    if (type === SeoEntityType.BRAND) {
      const rows = await this.brandsRepository.find({
        where: { id: In(ids) },
      });
      return rows.map((brand) =>
        this.toCatalogItem(SeoEntityType.BRAND, {
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
        }),
      );
    }

    const rows = await this.vendorsRepository.find({
      where: { id: In(ids) },
    });
    return rows.map((vendor) =>
      this.toCatalogItem(SeoEntityType.VENDOR, {
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
      }),
    );
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
      process.env.PRODUCT_IMPORT_OPENAI_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-4.1-mini';

    const systemPrompt = this.buildSystemPrompt(searchInternet);
    const userPrompt = JSON.stringify(
      {
        entity_type: item.type,
        name_en: item.name_en,
        name_ar: item.name_ar,
        slug: item.slug,
        description_en: item.description_en,
        description_ar: item.description_ar,
        product_count: item.product_count ?? null,
        brand_name: item.brand_name ?? null,
        category_names: item.category_names ?? [],
        sku: item.sku ?? null,
        site: 'OrdonSooq',
        market: 'Jordan',
        search_internet: searchInternet,
      },
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

  private buildSystemPrompt(searchInternet: boolean): string {
    return [
      'You write professional ecommerce SEO metadata for OrdonSooq (Jordan marketplace).',
      'Return ONLY valid JSON with keys:',
      'meta_title_en, meta_title_ar, meta_description_en, meta_description_ar.',
      'Rules:',
      '- meta_title_* max 70 characters; prefer "{Name} | OrdonSooq" when it fits.',
      '- meta_description_* max 160 characters; clear benefit + soft CTA; no keyword stuffing.',
      '- Natural Modern Standard Arabic suitable for Jordan shoppers.',
      '- Do not invent prices, stock, warranties, or specs not supported by the catalog payload.',
      '- Keep titles unique and specific to the entity.',
      searchInternet
        ? '- You may use web search for publicly known brand/category facts, but still do not invent commercial claims.'
        : '- Use only the provided catalog payload. Do not assume facts from the web.',
    ].join('\n');
  }

  private normalizeMetaField(
    field: keyof SeoMetaFields,
    value: string | null,
  ): string | null {
    if (!value?.trim()) {
      return null;
    }

    const max = field.startsWith('meta_title') ? 70 : 160;
    return value.trim().slice(0, max);
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
