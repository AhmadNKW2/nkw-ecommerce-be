import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  ConflictException,
  forwardRef,
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { Observable, interval } from 'rxjs';
import { map, startWith, takeWhile } from 'rxjs/operators';
import { DataSource, Repository, TableColumn } from 'typeorm';
import {
  Product,
  ProductDimensionUnit,
  ProductWeightUnit,
} from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';
import { CreateProductPriceRuleDto } from './dto/create-product-price-rule.dto';
import { UpdateProductPriceRuleDto } from './dto/update-product-price-rule.dto';
import { ProductPriceRule } from './entities/product-price-rule.entity';
import { SeoSettings } from './entities/seo-settings.entity';
import {
  AppliedProductPriceRule,
  assertProductPriceRuleValues,
  calculateManagedPrice,
  doScopedProductPriceRulesConflict,
  ensureSalePriceBelowPrice,
  findBestMatchingProductPriceRule,
  MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
  normalizeCategoryIds,
  normalizeProductPriceRuleShape,
  ProductPricingContext,
  toAppliedProductPriceRule,
} from './product-pricing.util';
import { createProductPriceRulesTableDefinition } from './product-price-rule.table';
import { UpdateProductFieldTogglesDto } from './dto/product-field-toggles.dto';
import { UpdateSeoSettingsDto } from './dto/update-seo-settings.dto';
import { UpdateSitePopupSettingsDto } from './dto/update-site-popup-settings.dto';
import { ProductFieldToggles } from './entities/product-field-toggles.entity';
import { SitePopupSettings } from './entities/site-popup-settings.entity';
import { createProductFieldTogglesTableDefinition } from './product-field-toggles.table';
import { createSeoSettingsTableDefinition } from './seo-settings.table';
import { createSitePopupSettingsTableDefinition } from './site-popup-settings.table';

type ProductPricingJobMode = 'reprice' | 'verify_and_fix';

type ProductPricingJob = {
  status: 'running' | 'done' | 'failed' | 'cancelled';
  mode: ProductPricingJobMode;
  startedAt: Date;
  finishedAt?: Date;
  progress: number;
  total: number;
  changedCount: number;
  unchangedCount: number;
  skippedCount: number;
  mismatchedCount: number;
  cancellationRequested: boolean;
  currentProductId?: number | null;
  error?: string;
};

@Injectable()
export class SettingsService implements OnModuleInit {
  private readonly logger = new Logger(SettingsService.name);
  private static readonly SEO_SETTINGS_CACHE_KEY = 'settings:seo:v2-shipping-rules';
  /** Legacy Redis keys from older deploys — always clear these on write. */
  private static readonly SEO_SETTINGS_LEGACY_CACHE_KEYS = [
    'settings:seo',
    'keyv:settings:seo',
  ] as const;
  private static readonly FEATURE_TOGGLES_CACHE_KEY = 'settings:features';
  /**
   * Short TTL safety net. Never use 0 (forever): if invalidation fails, stale
   * shipping/cutoff settings would stick until process restart.
   */
  private static readonly SETTINGS_CACHE_TTL_MS = 30_000;

  private schemaInitialized = false;
  private schemaInitPromise: Promise<void> | null = null;
  private readonly productPricingJobs = new Map<string, ProductPricingJob>();

  constructor(
    @InjectRepository(SeoSettings)
    private readonly seoSettingsRepository: Repository<SeoSettings>,
    @InjectRepository(ProductPriceRule)
    private readonly productPriceRuleRepository: Repository<ProductPriceRule>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(ProductFieldToggles)
    private readonly productFieldTogglesRepository: Repository<ProductFieldToggles>,
    @InjectRepository(SitePopupSettings)
    private readonly sitePopupSettingsRepository: Repository<SitePopupSettings>,
    private readonly dataSource: DataSource,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Inject(forwardRef(() => ProductsService))
    private readonly productsService: ProductsService,
  ) {}

  async onModuleInit() {
    await this.ensureSchemaReady();
  }

  private normalizeSeoSettings(settings: SeoSettings): SeoSettings {
    if (!Array.isArray(settings.shipping_rules)) {
      settings.shipping_rules = [];
    }
    return settings;
  }

  private async writeSeoSettingsCache(settings: SeoSettings): Promise<void> {
    await this.cacheManager.set(
      SettingsService.SEO_SETTINGS_CACHE_KEY,
      settings,
      SettingsService.SETTINGS_CACHE_TTL_MS,
    );
  }

  private async invalidateSeoSettingsCache(): Promise<void> {
    await Promise.all([
      this.cacheManager.del(SettingsService.SEO_SETTINGS_CACHE_KEY),
      ...SettingsService.SEO_SETTINGS_LEGACY_CACHE_KEYS.map((key) =>
        this.cacheManager.del(key),
      ),
    ]);
  }

  async getSeoSettings(): Promise<SeoSettings> {
    const cached = await this.cacheManager.get<SeoSettings>(
      SettingsService.SEO_SETTINGS_CACHE_KEY,
    );
    if (cached) {
      return this.normalizeSeoSettings(cached);
    }

    const settings = this.normalizeSeoSettings(
      await this.loadSeoSettingsFromDatabase(),
    );
    await this.writeSeoSettingsCache(settings);

    return settings;
  }

  async updateSeoSettings(updateSeoSettingsDto: UpdateSeoSettingsDto) {
    const settings = await this.loadSeoSettingsFromDatabase();

    // ValidationPipe + class-transformer leave every DTO key present as
    // `undefined` for omitted fields. Filtering is required — otherwise
    // Object.assign would wipe brand colors / SEO fields on a shipping-only save.
    const normalizedPatch = Object.fromEntries(
      Object.entries(updateSeoSettingsDto)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => {
          if (typeof value !== 'string') {
            return [key, value];
          }

          const trimmedValue = value.trim();
          return [key, trimmedValue.length > 0 ? trimmedValue : null];
        }),
    );

    Object.assign(settings, normalizedPatch);

    await this.seoSettingsRepository.save(settings);

    // Reload a clean row so the response/cache never carry assigned `undefined`
    // brand fields from the in-memory entity after a partial patch.
    const savedSettings = this.normalizeSeoSettings(
      await this.loadSeoSettingsFromDatabase(),
    );
    const cachePayload = JSON.parse(
      JSON.stringify(savedSettings),
    ) as SeoSettings;

    await this.invalidateSeoSettingsCache();
    await this.writeSeoSettingsCache(cachePayload);

    return savedSettings;
  }

  private async loadSeoSettingsFromDatabase(): Promise<SeoSettings> {
    await this.ensureSchemaReady();

    const existingSettings = await this.seoSettingsRepository.findOne({
      where: {},
      order: { id: 'ASC' },
    });

    if (existingSettings) {
      return existingSettings;
    }

    const defaultSettings = this.seoSettingsRepository.create({});
    return this.seoSettingsRepository.save(defaultSettings);
  }

  async getProductFieldToggles(): Promise<ProductFieldToggles> {
    const cached = await this.cacheManager.get<ProductFieldToggles>(
      SettingsService.FEATURE_TOGGLES_CACHE_KEY,
    );
    if (cached) {
      return cached;
    }

    await this.ensureSchemaReady();

    const existingToggles = await this.productFieldTogglesRepository.findOne({
      where: {},
      order: { id: 'ASC' },
    });

    const toggles =
      existingToggles ??
      (await this.productFieldTogglesRepository.save(
        this.productFieldTogglesRepository.create({}),
      ));

    await this.cacheManager.set(
      SettingsService.FEATURE_TOGGLES_CACHE_KEY,
      toggles,
      SettingsService.SETTINGS_CACHE_TTL_MS,
    );

    return toggles;
  }

  async updateProductFieldToggles(
    updateProductFieldTogglesDto: UpdateProductFieldTogglesDto,
  ): Promise<ProductFieldToggles> {
    const toggles = await this.loadProductFieldTogglesFromDatabase();

    Object.assign(toggles, updateProductFieldTogglesDto);

    const savedToggles = await this.productFieldTogglesRepository.save(toggles);
    await this.cacheManager.del(SettingsService.FEATURE_TOGGLES_CACHE_KEY);
    await this.cacheManager.set(
      SettingsService.FEATURE_TOGGLES_CACHE_KEY,
      savedToggles,
      SettingsService.SETTINGS_CACHE_TTL_MS,
    );

    return savedToggles;
  }

  private async loadProductFieldTogglesFromDatabase(): Promise<ProductFieldToggles> {
    await this.ensureSchemaReady();

    const existingToggles = await this.productFieldTogglesRepository.findOne({
      where: {},
      order: { id: 'ASC' },
    });

    if (existingToggles) {
      return existingToggles;
    }

    const defaultToggles = this.productFieldTogglesRepository.create({});
    return this.productFieldTogglesRepository.save(defaultToggles);
  }

  async getSitePopupSettings(): Promise<SitePopupSettings> {
    await this.ensureSchemaReady();

    const existingSettings = await this.sitePopupSettingsRepository.findOne({
      where: {},
      order: { id: 'ASC' },
    });

    if (existingSettings) {
      return existingSettings;
    }

    const defaultSettings = this.sitePopupSettingsRepository.create({});
    return this.sitePopupSettingsRepository.save(defaultSettings);
  }

  async updateSitePopupSettings(
    updateSitePopupSettingsDto: UpdateSitePopupSettingsDto,
  ): Promise<SitePopupSettings> {
    const settings = await this.getSitePopupSettings();

    const normalizedPatch = Object.fromEntries(
      Object.entries(updateSitePopupSettingsDto).map(([key, value]) => {
        if (typeof value !== 'string') {
          return [key, value];
        }

        const trimmedValue = value.trim();
        return [key, trimmedValue.length > 0 ? trimmedValue : null];
      }),
    );

    Object.assign(settings, normalizedPatch);

    return this.sitePopupSettingsRepository.save(settings);
  }

  async getProductPriceRules() {
    await this.ensureSchemaReady();

    return this.productPriceRuleRepository.find({
      order: { min_product_price: 'ASC', id: 'ASC' },
    });
  }

  async createProductPriceRule(dto: CreateProductPriceRuleDto) {
    await this.ensureSchemaReady();

    const candidate = this.normalizeProductPriceRulePayload(dto);
    await this.assertNoConflictingProductPriceRule(candidate);

    const rule = this.productPriceRuleRepository.create(candidate);
    const savedRule = await this.productPriceRuleRepository.save(rule);
    const repriceJob = this.startProductPricingJob('reprice');

    return {
      ...savedRule,
      reprice_job_id: repriceJob.job_id,
    };
  }

  async updateProductPriceRule(id: number, dto: UpdateProductPriceRuleDto) {
    await this.ensureSchemaReady();

    const existingRule = await this.productPriceRuleRepository.findOne({
      where: { id },
    });

    if (!existingRule) {
      throw new NotFoundException('Product price rule not found');
    }

    const candidate = this.normalizeProductPriceRulePayload({
      vendor_ids:
        dto.vendor_ids !== undefined ? dto.vendor_ids : existingRule.vendor_ids,
      brand_ids:
        dto.brand_ids !== undefined ? dto.brand_ids : existingRule.brand_ids,
      category_ids:
        dto.category_ids !== undefined
          ? dto.category_ids
          : existingRule.category_ids,
      price_condition:
        dto.price_condition !== undefined
          ? dto.price_condition
          : existingRule.price_condition,
      adjustment_type:
        dto.adjustment_type ?? existingRule.adjustment_type ?? 'decrease',
      min_product_price:
        dto.min_product_price !== undefined
          ? dto.min_product_price
          : existingRule.min_product_price,
      max_product_price:
        dto.max_product_price !== undefined
          ? dto.max_product_price
          : existingRule.max_product_price,
      percentage: dto.percentage ?? existingRule.percentage,
      is_active: dto.is_active ?? existingRule.is_active,
    });

    await this.assertNoConflictingProductPriceRule(candidate, id);

    Object.assign(existingRule, candidate);

    const savedRule = await this.productPriceRuleRepository.save(existingRule);
    const repriceJob = this.startProductPricingJob('reprice');

    return {
      ...savedRule,
      reprice_job_id: repriceJob.job_id,
    };
  }

  async deleteProductPriceRule(id: number) {
    await this.ensureSchemaReady();

    const result = await this.productPriceRuleRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException('Product price rule not found');
    }

    const repriceJob = this.startProductPricingJob('reprice');

    return {
      message: 'Product price rule deleted successfully',
      reprice_job_id: repriceJob.job_id,
    };
  }

  async calculateManagedProductPrices(params: {
    originalVendorPrice: number;
    originalVendorSalePrice: number | null;
    fixedPercentage?: number;
    fixedAdjustmentType?: 'increase' | 'decrease';
    vendorId?: number | null;
    brandId?: number | null;
    categoryIds?: number[];
  }) {
    await this.ensureSchemaReady();

    const activeRules = params.fixedPercentage
      ? []
      : (await this.productPriceRuleRepository.find({
          where: { is_active: true },
          order: { id: 'ASC' },
        })).map((rule) => normalizeProductPriceRuleShape(rule));

    return this.calculateManagedProductPricesWithRules(params, activeRules);
  }

  private calculateManagedProductPricesWithRules(
    params: {
      originalVendorPrice: number;
      originalVendorSalePrice: number | null;
      fixedPercentage?: number;
      fixedAdjustmentType?: 'increase' | 'decrease';
      vendorId?: number | null;
      brandId?: number | null;
      categoryIds?: number[];
    },
    activeRules: ReturnType<typeof normalizeProductPriceRuleShape>[],
  ) {
    const pricingContext: ProductPricingContext = {
      vendorId: params.vendorId ?? null,
      brandId: params.brandId ?? null,
      categoryIds: params.categoryIds ?? [],
      originalPrice: params.originalVendorPrice,
    };

    const matchedPriceRule = params.fixedPercentage
      ? null
      : findBestMatchingProductPriceRule(activeRules, pricingContext);

    // No matching rule: keep catalog prices equal to original vendor prices.
    if (!params.fixedPercentage && !matchedPriceRule) {
      return {
        price: params.originalVendorPrice,
        salePrice:
          params.originalVendorSalePrice === null ||
          params.originalVendorSalePrice === undefined
            ? null
            : params.originalVendorSalePrice,
        appliedPriceRule: null,
        appliedSalePriceRule: null,
      };
    }

    const price =
      params.fixedPercentage !== undefined
        ? calculateManagedPrice(
            params.originalVendorPrice,
            params.fixedPercentage,
            params.fixedAdjustmentType ?? 'decrease',
          )
        : calculateManagedPrice(
            params.originalVendorPrice,
            matchedPriceRule!.percentage,
            matchedPriceRule!.adjustment_type ?? 'decrease',
          );

    let salePrice: number | null = null;
    let matchedSaleRule: AppliedProductPriceRule | null = null;

    if (
      params.originalVendorSalePrice !== null &&
      params.originalVendorSalePrice !== undefined
    ) {
      salePrice =
        params.fixedPercentage !== undefined
          ? calculateManagedPrice(
              params.originalVendorSalePrice,
              params.fixedPercentage,
              params.fixedAdjustmentType ?? 'decrease',
            )
          : calculateManagedPrice(
              params.originalVendorSalePrice,
              matchedPriceRule!.percentage,
              matchedPriceRule!.adjustment_type ?? 'decrease',
            );
      salePrice = ensureSalePriceBelowPrice(price, salePrice);
      matchedSaleRule = matchedPriceRule
        ? toAppliedProductPriceRule(matchedPriceRule)
        : null;
    }

    return {
      price,
      salePrice,
      appliedPriceRule: matchedPriceRule
        ? toAppliedProductPriceRule(matchedPriceRule)
        : null,
      appliedSalePriceRule: matchedSaleRule,
    };
  }

  startProductPricingVerifyAndFixJob() {
    return this.startProductPricingJob('verify_and_fix');
  }

  getProductPricingJob(jobId: string) {
    const job = this.productPricingJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Product pricing job not found');
    }

    const remaining = Math.max(0, job.total - job.progress);

    return {
      job_id: jobId,
      status: job.status,
      mode: job.mode,
      started_at: job.startedAt,
      finished_at: job.finishedAt ?? null,
      progress: job.progress,
      total: job.total,
      remaining,
      changed_count: job.changedCount,
      unchanged_count: job.unchangedCount,
      skipped_count: job.skippedCount,
      mismatched_count: job.mismatchedCount,
      current_product_id: job.currentProductId ?? null,
      error: job.error ?? null,
      duration_seconds: job.finishedAt
        ? Math.round(
            (job.finishedAt.getTime() - job.startedAt.getTime()) / 1000,
          )
        : Math.round((Date.now() - job.startedAt.getTime()) / 1000),
      message:
        job.status === 'running'
          ? `Processing products: ${job.progress}/${job.total} (${remaining} left)`
          : job.status === 'done'
            ? job.mode === 'verify_and_fix'
              ? `Verified ${job.total} products. Fixed ${job.changedCount}, already correct ${job.unchangedCount}, skipped ${job.skippedCount}.`
              : `Repriced ${job.changedCount} products. Unchanged ${job.unchangedCount}, skipped ${job.skippedCount}.`
            : job.error ?? `Job ${job.status}`,
    };
  }

  streamProductPricingJob(jobId: string): Observable<MessageEvent> {
    this.getProductPricingJob(jobId);

    return interval(1000).pipe(
      startWith(0),
      map(() => ({ data: this.getProductPricingJob(jobId) }) as MessageEvent),
      takeWhile((event) => {
        const payload = event.data as { status?: string } | undefined;
        return payload?.status === 'running';
      }, true),
    );
  }

  cancelProductPricingJob(jobId: string) {
    const job = this.productPricingJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Product pricing job not found');
    }

    if (job.status !== 'running') {
      return {
        job_id: jobId,
        status: job.status,
        message: 'Job is not active.',
      };
    }

    job.cancellationRequested = true;
    job.status = 'cancelled';
    job.finishedAt = new Date();

    return {
      job_id: jobId,
      status: 'cancelled' as const,
      message: 'Product pricing job cancelled.',
    };
  }

  private startProductPricingJob(mode: ProductPricingJobMode) {
    for (const [existingJobId, existingJob] of this.productPricingJobs) {
      if (existingJob.status === 'running') {
        throw new ConflictException(
          `A product pricing job is already running (${existingJobId}). Wait for it to finish or cancel it.`,
        );
      }
    }

    const jobId = `pricing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.productPricingJobs.set(jobId, {
      status: 'running',
      mode,
      startedAt: new Date(),
      progress: 0,
      total: 0,
      changedCount: 0,
      unchangedCount: 0,
      skippedCount: 0,
      mismatchedCount: 0,
      cancellationRequested: false,
      currentProductId: null,
    });
    setTimeout(() => this.productPricingJobs.delete(jobId), 24 * 60 * 60 * 1000).unref?.();

    void this.runProductPricingJob(jobId).catch((error: unknown) => {
      const job = this.productPricingJobs.get(jobId);
      if (!job || job.status !== 'running') {
        return;
      }

      job.status = 'failed';
      job.finishedAt = new Date();
      job.error =
        error instanceof Error ? error.message : 'Product pricing job failed';
      this.logger.error(
        `Product pricing job ${jobId} failed: ${job.error}`,
        error instanceof Error ? error.stack : undefined,
      );
    });

    return {
      job_id: jobId,
      status: 'running' as const,
      mode,
      started_at: new Date(),
    };
  }

  private pricesMatch(
    left: number | null | undefined,
    right: number | null | undefined,
  ): boolean {
    if (
      (left === null || left === undefined) &&
      (right === null || right === undefined)
    ) {
      return true;
    }

    if (
      left === null ||
      left === undefined ||
      right === null ||
      right === undefined
    ) {
      return false;
    }

    return Math.abs(Number(left) - Number(right)) < 0.005;
  }

  private async runProductPricingJob(jobId: string): Promise<void> {
    const job = this.productPricingJobs.get(jobId);
    if (!job) {
      return;
    }

    await this.ensureSchemaReady();

    const activeRules = (
      await this.productPriceRuleRepository.find({
        where: { is_active: true },
        order: { id: 'ASC' },
      })
    ).map((rule) => normalizeProductPriceRuleShape(rule));

    const products = await this.productsRepository
      .createQueryBuilder('product')
      .leftJoinAndSelect('product.productCategories', 'productCategories')
      .select([
        'product.id',
        'product.vendor_id',
        'product.brand_id',
        'product.category_id',
        'product.price',
        'product.sale_price',
        'product.original_vendor_price',
        'product.original_vendor_sale_price',
        'productCategories.category_id',
      ])
      .getMany();

    job.total = products.length;
    job.progress = 0;

    const changedProductIds: number[] = [];

    for (const product of products) {
      if (job.cancellationRequested || job.status === 'cancelled') {
        await this.syncRepricedProductsToTypesense(changedProductIds);
        job.status = 'cancelled';
        job.finishedAt = new Date();
        return;
      }

      job.currentProductId = product.id;

      const categoryIds = this.resolveProductCategoryIds(product);
      const originalVendorPrice = Number(product.original_vendor_price ?? 0);
      const originalVendorSalePrice =
        product.original_vendor_sale_price === null ||
        product.original_vendor_sale_price === undefined
          ? null
          : Number(product.original_vendor_sale_price);

      if (!Number.isFinite(originalVendorPrice) || originalVendorPrice <= 0) {
        job.skippedCount += 1;
        job.progress += 1;
        continue;
      }

      const nextPricing = this.calculateManagedProductPricesWithRules(
        {
          originalVendorPrice,
          originalVendorSalePrice,
          vendorId: product.vendor_id ?? null,
          brandId: product.brand_id ?? null,
          categoryIds,
        },
        activeRules,
      );

      const currentPrice =
        product.price === null || product.price === undefined
          ? null
          : Number(product.price);
      const currentSalePrice =
        product.sale_price === null || product.sale_price === undefined
          ? null
          : Number(product.sale_price);

      const isMismatch =
        !this.pricesMatch(currentPrice, nextPricing.price) ||
        !this.pricesMatch(currentSalePrice, nextPricing.salePrice);

      if (!isMismatch) {
        job.unchangedCount += 1;
        job.progress += 1;
        continue;
      }

      job.mismatchedCount += 1;

      await this.productsRepository.update(product.id, {
        price: nextPricing.price,
        sale_price: nextPricing.salePrice,
      });

      changedProductIds.push(product.id);
      job.changedCount += 1;
      job.progress += 1;
    }

    await this.syncRepricedProductsToTypesense(changedProductIds);

    job.currentProductId = null;
    job.status = 'done';
    job.finishedAt = new Date();
  }

  private async syncRepricedProductsToTypesense(
    productIds: number[],
  ): Promise<void> {
    if (productIds.length === 0) {
      return;
    }

    this.logger.log(
      `Syncing ${productIds.length} repriced product(s) to Typesense`,
    );
    await this.productsService.syncProductsToTypesense(productIds);
  }

  /** @deprecated Prefer startProductPricingJob('reprice') for async progress. */
  async repriceAllProductsByActiveRules() {
    const started = this.startProductPricingJob('reprice');

    const waitForCompletion = async () => {
      for (;;) {
        const status = this.getProductPricingJob(started.job_id);
        if (status.status !== 'running') {
          return status;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    };

    const finalStatus = await waitForCompletion();

    return {
      updated_count: finalStatus.changed_count,
      message: finalStatus.message,
      job_id: started.job_id,
    };
  }

  async repriceExistingProductsByFixedPercentage() {
    await this.ensureSchemaReady();

    const updatedProductIds = await this.dataSource.transaction(
      async (manager) => {
        const productRepository = manager.getRepository(Product);
        const products = await productRepository
          .createQueryBuilder('product')
          .select([
            'product.id',
            'product.price',
            'product.sale_price',
            'product.original_vendor_price',
            'product.original_vendor_sale_price',
          ])
          .getMany();

        const productIds: number[] = [];

        for (const product of products) {
          const { originalVendorPrice, originalVendorSalePrice } =
            this.resolveVendorOriginalPricesFromCurrentCatalog({
              price: product.price ?? null,
              salePrice: product.sale_price ?? null,
            });
          const nextPricing = await this.calculateManagedProductPrices({
            originalVendorPrice,
            originalVendorSalePrice,
            fixedPercentage: MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
            fixedAdjustmentType: 'decrease',
          });

          await productRepository.update(product.id, {
            original_vendor_price: originalVendorPrice,
            original_vendor_sale_price: originalVendorSalePrice,
            price: nextPricing.price,
            sale_price: nextPricing.salePrice,
          });
          productIds.push(product.id);
        }

        return productIds;
      },
    );

    await this.syncRepricedProductsToTypesense(updatedProductIds);

    return {
      updated_count: updatedProductIds.length,
      percentage: MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
      message:
        'Existing product prices were repriced successfully from their current catalog before-sale and after-sale values.',
    };
  }

  private async ensureSchemaReady(): Promise<void> {
    if (this.schemaInitialized) {
      return;
    }

    if (!this.schemaInitPromise) {
      this.schemaInitPromise = this.createMissingSchemaArtifacts()
        .then(() => {
          this.schemaInitialized = true;
        })
        .finally(() => {
          this.schemaInitPromise = null;
        });
    }

    return this.schemaInitPromise;
  }

  private async createMissingSchemaArtifacts(): Promise<void> {
    await this.ensureSeoSettingsTableExists();
    await this.ensureSeoSettingsColumnsExist();
    await this.ensureProductFieldTogglesTableExists();
    await this.ensureSitePopupSettingsTableExists();
    await this.ensureProductPriceRulesTableExists();
    await this.ensureProductPriceRuleColumnsExist();
    await this.ensureProductVendorPriceColumnsExist();
    await this.ensureProductMeasurementUnitColumnsExist();
    await this.ensureProductReferenceSlugColumnExists();
    await this.ensureProductReferenceLinksColumnExists();
  }

  private async ensureSeoSettingsTableExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      const hasTable = await queryRunner.hasTable('seo_settings');

      if (hasTable) {
        return;
      }

      await queryRunner.createTable(createSeoSettingsTableDefinition(), true);
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureSeoSettingsColumnsExist(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await queryRunner.hasTable('seo_settings'))) {
        return;
      }

      const missingColumns: TableColumn[] = [];

      if (!(await queryRunner.hasColumn('seo_settings', 'show_sale_pricing'))) {
        missingColumns.push(
          new TableColumn({
            name: 'show_sale_pricing',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('seo_settings', 'free_delivery_amount'))) {
        missingColumns.push(
          new TableColumn({
            name: 'free_delivery_amount',
            type: 'decimal',
            precision: 10,
            scale: 2,
            default: '50.00',
          }),
        );
      }

      if (!(await queryRunner.hasColumn('seo_settings', 'free_delivery_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'free_delivery_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('seo_settings', 'delivery_fee'))) {
        missingColumns.push(
          new TableColumn({
            name: 'delivery_fee',
            type: 'decimal',
            precision: 10,
            scale: 2,
            default: '2.00',
          }),
        );
      }

      if (!(await queryRunner.hasColumn('seo_settings', 'low_stock_threshold'))) {
        missingColumns.push(
          new TableColumn({
            name: 'low_stock_threshold',
            type: 'int',
            default: 10,
          }),
        );
      }

      const shippingRuleColumns: Array<{
        name: string;
        type: 'boolean' | 'int' | 'varchar' | 'jsonb';
        length?: string;
        isNullable?: boolean;
        default?: string | boolean | number;
      }> = [
        {
          name: 'shipping_rules_enabled',
          type: 'boolean',
          default: false,
        },
        {
          name: 'shipping_cutoff_hour',
          type: 'int',
          default: 14,
        },
        {
          name: 'shipping_rules',
          type: 'jsonb',
          default: `'[]'`,
        },
        {
          name: 'shipping_rule_1_when_en',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_1_when_ar',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_1_arrives_en',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_1_arrives_ar',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_2_when_en',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_2_when_ar',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_2_arrives_en',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_2_arrives_ar',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_3_when_en',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_3_when_ar',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_3_arrives_en',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
        {
          name: 'shipping_rule_3_arrives_ar',
          type: 'varchar',
          length: '255',
          isNullable: true,
          default: `''`,
        },
      ];

      for (const column of shippingRuleColumns) {
        if (!(await queryRunner.hasColumn('seo_settings', column.name))) {
          missingColumns.push(
            new TableColumn({
              name: column.name,
              type: column.type,
              ...(column.length ? { length: column.length } : {}),
              ...(column.isNullable ? { isNullable: true } : {}),
              ...(column.default !== undefined ? { default: column.default } : {}),
            }),
          );
        }
      }

      if (!(await queryRunner.hasColumn('seo_settings', 'site_logo'))) {
        missingColumns.push(
          new TableColumn({
            name: 'site_logo',
            type: 'varchar',
            length: '2048',
            isNullable: true,
          }),
        );
      }

      const contactAndSocialColumns: Array<{
        name: string;
        type: 'varchar';
        length: string;
        isNullable?: boolean;
        default?: string;
      }> = [
        {
          name: 'support_email',
          type: 'varchar',
          length: '255',
          default: `'help@ordonsooq.com'`,
        },
        {
          name: 'facebook_url',
          type: 'varchar',
          length: '2048',
          isNullable: true,
        },
        {
          name: 'twitter_url',
          type: 'varchar',
          length: '2048',
          isNullable: true,
        },
        {
          name: 'instagram_url',
          type: 'varchar',
          length: '2048',
          isNullable: true,
        },
      ];

      for (const column of contactAndSocialColumns) {
        if (!(await queryRunner.hasColumn('seo_settings', column.name))) {
          missingColumns.push(
            new TableColumn({
              name: column.name,
              type: column.type,
              length: column.length,
              isNullable: column.isNullable,
              default: column.default,
            }),
          );
        }
      }

      const brandColorColumns = [
        'brand_primary',
        'brand_primary_2',
        'brand_primary_3',
        'brand_secondary',
        'brand_success',
        'brand_success_2',
        'brand_danger',
        'brand_danger_2',
      ] as const;

      for (const columnName of brandColorColumns) {
        if (!(await queryRunner.hasColumn('seo_settings', columnName))) {
          missingColumns.push(
            new TableColumn({
              name: columnName,
              type: 'varchar',
              length: '7',
              isNullable: true,
            }),
          );
        }
      }

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('seo_settings', missingColumns);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductFieldTogglesTableExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      const hasTable = await queryRunner.hasTable('product_field_toggles');

      if (!hasTable) {
        await queryRunner.createTable(
          createProductFieldTogglesTableDefinition(),
          true,
        );
        return;
      }

      const missingColumns: TableColumn[] = [];

      if (!(await queryRunner.hasColumn('product_field_toggles', 'vendors_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'vendors_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'attributes_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'attributes_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'specifications_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'specifications_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn(
          'product_field_toggles',
          'weight_and_dimensions_enabled',
        ))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'weight_and_dimensions_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'partners_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'partners_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'ratings_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'ratings_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'cashback_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'cashback_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'banners_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'banners_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'import_ai_products_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'import_ai_products_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'linked_products_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'linked_products_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'reference_links_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'reference_links_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'easy_purchase_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'easy_purchase_enabled',
            type: 'boolean',
            default: false,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'cart_sidebar_button_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'cart_sidebar_button_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'popup_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'popup_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'product_status_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'product_status_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'product_files_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'product_files_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_field_toggles', 'pricing_view_enabled'))) {
        missingColumns.push(
          new TableColumn({
            name: 'pricing_view_enabled',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn(
          'product_field_toggles',
          'reference_link_visible_admin',
        ))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'reference_link_visible_admin',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn(
          'product_field_toggles',
          'meta_title_visible_admin',
        ))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'meta_title_visible_admin',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn(
          'product_field_toggles',
          'meta_description_visible_admin',
        ))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'meta_description_visible_admin',
            type: 'boolean',
            default: true,
          }),
        );
      }

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('product_field_toggles', missingColumns);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureSitePopupSettingsTableExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      const hasTable = await queryRunner.hasTable('site_popup_settings');

      if (hasTable) {
        return;
      }

      await queryRunner.createTable(
        createSitePopupSettingsTableDefinition(),
        true,
      );
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductPriceRulesTableExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      const hasTable = await queryRunner.hasTable('product_price_rules');

      if (hasTable) {
        return;
      }

      await queryRunner.createTable(
        createProductPriceRulesTableDefinition(),
        true,
      );
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductPriceRuleColumnsExist(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await queryRunner.hasTable('product_price_rules'))) {
        return;
      }

      const missingColumns: TableColumn[] = [];

      if (!(await queryRunner.hasColumn('product_price_rules', 'vendor_ids'))) {
        missingColumns.push(
          new TableColumn({
            name: 'vendor_ids',
            type: 'jsonb',
            isNullable: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_price_rules', 'brand_ids'))) {
        missingColumns.push(
          new TableColumn({
            name: 'brand_ids',
            type: 'jsonb',
            isNullable: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_price_rules', 'category_ids'))) {
        missingColumns.push(
          new TableColumn({
            name: 'category_ids',
            type: 'jsonb',
            isNullable: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn('product_price_rules', 'price_condition'))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'price_condition',
            type: 'varchar',
            length: '20',
            isNullable: true,
            default: null,
          }),
        );
      } else {
        const priceConditionNullable = await queryRunner.query(`
          SELECT is_nullable
          FROM information_schema.columns
          WHERE table_name = 'product_price_rules'
            AND column_name = 'price_condition'
          LIMIT 1
        `);

        if (priceConditionNullable?.[0]?.is_nullable === 'NO') {
          await queryRunner.query(`
            ALTER TABLE product_price_rules
            ALTER COLUMN price_condition DROP DEFAULT,
            ALTER COLUMN price_condition DROP NOT NULL
          `);
        }

        await queryRunner.query(`
          UPDATE product_price_rules
          SET price_condition = NULL
          WHERE price_condition = 'any'
             OR (
               price_condition = 'between'
               AND min_product_price IS NULL
               AND max_product_price IS NULL
             )
        `);
      }

      if (
        !(await queryRunner.hasColumn('product_price_rules', 'adjustment_type'))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'adjustment_type',
            type: 'varchar',
            length: '20',
            default: `'decrease'`,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn('product_price_rules', 'min_product_price'))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'min_product_price',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn('product_price_rules', 'max_product_price'))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'max_product_price',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: true,
          }),
        );
      }

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('product_price_rules', missingColumns);
      }

      if (await queryRunner.hasColumn('product_price_rules', 'vendor_id')) {
        await queryRunner.query(`
          UPDATE product_price_rules
          SET vendor_ids = jsonb_build_array(vendor_id)
          WHERE vendor_id IS NOT NULL
            AND (vendor_ids IS NULL OR jsonb_array_length(vendor_ids) = 0)
        `);
      }

      if (await queryRunner.hasColumn('product_price_rules', 'brand_id')) {
        await queryRunner.query(`
          UPDATE product_price_rules
          SET brand_ids = jsonb_build_array(brand_id)
          WHERE brand_id IS NOT NULL
            AND (brand_ids IS NULL OR jsonb_array_length(brand_ids) = 0)
        `);
      }

      if (await queryRunner.hasColumn('product_price_rules', 'min_vendor_price')) {
        await queryRunner.query(`
          UPDATE product_price_rules
          SET min_product_price = CASE
            WHEN min_vendor_price IS NULL OR min_vendor_price = 0 THEN NULL
            ELSE min_vendor_price
          END
          WHERE min_product_price IS NULL
        `);
      }

      if (await queryRunner.hasColumn('product_price_rules', 'max_vendor_price')) {
        await queryRunner.query(`
          UPDATE product_price_rules
          SET max_product_price = max_vendor_price
          WHERE max_product_price IS NULL
        `);
      }

      await this.relaxLegacyProductPriceRuleColumns(queryRunner);
    } finally {
      await queryRunner.release();
    }
  }

  private async relaxLegacyProductPriceRuleColumns(queryRunner: {
    hasColumn: (table: string, column: string) => Promise<boolean>;
    query: (sql: string) => Promise<unknown>;
  }): Promise<void> {
    if (await queryRunner.hasColumn('product_price_rules', 'min_vendor_price')) {
      await queryRunner.query(`
        ALTER TABLE product_price_rules
        ALTER COLUMN min_vendor_price DROP NOT NULL
      `);
    }

    const legacyIndexes = [
      'idx_product_price_rules_vendor_id',
      'idx_product_price_rules_brand_id',
      'idx_product_price_rules_min_vendor_price',
    ];

    for (const indexName of legacyIndexes) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${indexName}"`);
    }

    const legacyColumns = [
      'vendor_id',
      'brand_id',
      'min_vendor_price',
      'max_vendor_price',
    ];

    for (const columnName of legacyColumns) {
      if (await queryRunner.hasColumn('product_price_rules', columnName)) {
        await queryRunner.query(`
          ALTER TABLE product_price_rules
          DROP COLUMN IF EXISTS "${columnName}"
        `);
      }
    }
  }

  private async ensureProductVendorPriceColumnsExist(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      const missingColumns: TableColumn[] = [];

      if (!(await queryRunner.hasColumn('products', 'original_vendor_price'))) {
        missingColumns.push(
          new TableColumn({
            name: 'original_vendor_price',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: true,
          }),
        );
      }

      if (
        !(await queryRunner.hasColumn('products', 'original_vendor_sale_price'))
      ) {
        missingColumns.push(
          new TableColumn({
            name: 'original_vendor_sale_price',
            type: 'decimal',
            precision: 10,
            scale: 2,
            isNullable: true,
          }),
        );
      }

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('products', missingColumns);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductMeasurementUnitColumnsExist(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      const missingColumns: TableColumn[] = [];

      if (!(await queryRunner.hasColumn('products', 'weight_unit'))) {
        missingColumns.push(
          new TableColumn({
            name: 'weight_unit',
            type: 'varchar',
            length: '10',
            default: `'${ProductWeightUnit.KILOGRAM}'`,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('products', 'dimension_unit'))) {
        missingColumns.push(
          new TableColumn({
            name: 'dimension_unit',
            type: 'varchar',
            length: '10',
            default: `'${ProductDimensionUnit.CENTIMETER}'`,
          }),
        );
      }

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('products', missingColumns);
      }
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductReferenceSlugColumnExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (await queryRunner.hasColumn('products', 'reference_slug')) {
        return;
      }

      await queryRunner.addColumn(
        'products',
        new TableColumn({
          name: 'reference_slug',
          type: 'varchar',
          length: '300',
          isNullable: true,
        }),
      );
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductReferenceLinksColumnExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (!(await queryRunner.hasColumn('products', 'reference_links'))) {
        await queryRunner.addColumn(
          'products',
          new TableColumn({
            name: 'reference_links',
            type: 'jsonb',
            isNullable: false,
            default: "'[]'",
          }),
        );
      }

      await queryRunner.query(`
        UPDATE products
        SET reference_links = jsonb_build_array(btrim(reference_link))
        WHERE reference_link IS NOT NULL
          AND btrim(reference_link) <> ''
          AND (
            reference_links IS NULL
            OR reference_links = '[]'::jsonb
          )
      `);
    } finally {
      await queryRunner.release();
    }
  }

  private normalizeProductPriceRulePayload(input: {
    vendor_ids?: number[] | null;
    brand_ids?: number[] | null;
    category_ids?: number[] | null;
    price_condition?: 'any' | 'more_than' | 'less_than' | 'between' | null;
    adjustment_type?: 'increase' | 'decrease';
    min_product_price?: number | null;
    max_product_price?: number | null;
    percentage: number;
    is_active?: boolean;
  }) {
    const normalized = normalizeProductPriceRuleShape({
      min_product_price:
        input.min_product_price === undefined || input.min_product_price === null
          ? null
          : Number(input.min_product_price),
      max_product_price:
        input.max_product_price === undefined || input.max_product_price === null
          ? null
          : Number(input.max_product_price),
      percentage: Number(input.percentage),
      is_active: input.is_active ?? true,
      vendor_ids: input.vendor_ids,
      brand_ids: input.brand_ids,
      category_ids: normalizeCategoryIds(input.category_ids),
      price_condition: input.price_condition ?? null,
      adjustment_type: input.adjustment_type ?? 'decrease',
    });

    assertProductPriceRuleValues(normalized);

    return normalized;
  }

  private resolveProductCategoryIds(
    product: Pick<Product, 'category_id' | 'productCategories'>,
  ) {
    const categoryIds = new Set<number>();

    if (product.category_id) {
      categoryIds.add(product.category_id);
    }

    for (const productCategory of product.productCategories ?? []) {
      if (productCategory.category_id) {
        categoryIds.add(productCategory.category_id);
      }
    }

    return Array.from(categoryIds);
  }

  private resolveVendorOriginalPricesFromCurrentCatalog(input: {
    price: number | null;
    salePrice: number | null;
  }) {
    const { price, salePrice } = input;

    if (price === null && salePrice === null) {
      return {
        originalVendorPrice: 0,
        originalVendorSalePrice: null,
      };
    }

    if (price === null) {
      return {
        originalVendorPrice: salePrice ?? 0,
        originalVendorSalePrice: null,
      };
    }

    if (salePrice === null) {
      return {
        originalVendorPrice: price,
        originalVendorSalePrice: null,
      };
    }

    if (price === salePrice) {
      return {
        originalVendorPrice: price,
        originalVendorSalePrice: null,
      };
    }

    return {
      originalVendorPrice: Math.max(price, salePrice),
      originalVendorSalePrice: Math.min(price, salePrice),
    };
  }

  private async assertNoConflictingProductPriceRule(
    candidate: ReturnType<SettingsService['normalizeProductPriceRulePayload']>,
    excludedRuleId?: number,
  ) {
    // Inactive rules are treated as if they don't exist, so they never conflict.
    if (candidate.is_active === false) {
      return;
    }

    const existingRules = await this.productPriceRuleRepository.find({
      where: { is_active: true },
      order: { id: 'ASC' },
    });

    const conflictingRule = existingRules.find((rule) => {
      if (excludedRuleId !== undefined && rule.id === excludedRuleId) {
        return false;
      }

      return doScopedProductPriceRulesConflict(
        candidate,
        normalizeProductPriceRuleShape(rule),
      );
    });

    if (conflictingRule) {
      throw new ConflictException(
        `This rule conflicts with existing rule #${conflictingRule.id} for the same scope and price range.`,
      );
    }
  }
}