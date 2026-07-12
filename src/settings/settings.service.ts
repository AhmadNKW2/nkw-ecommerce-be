import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import type { Cache } from 'cache-manager';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, TableColumn } from 'typeorm';
import {
  Product,
  ProductDimensionUnit,
  ProductWeightUnit,
} from '../products/entities/product.entity';
import { BulkUpdateProductPricingDto } from './dto/bulk-update-product-pricing.dto';
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

@Injectable()
export class SettingsService implements OnModuleInit {
  private static readonly SEO_SETTINGS_CACHE_KEY = 'settings:seo';
  private static readonly FEATURE_TOGGLES_CACHE_KEY = 'settings:features';

  private schemaInitialized = false;
  private schemaInitPromise: Promise<void> | null = null;
  private seoSettingsCache: SeoSettings | null = null;
  private featureTogglesCache: ProductFieldToggles | null = null;

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
  ) {}

  async onModuleInit() {
    await this.ensureSchemaReady();
  }

  async getSeoSettings(): Promise<SeoSettings> {
    if (this.seoSettingsCache) {
      return this.seoSettingsCache;
    }

    const cached = await this.cacheManager.get<SeoSettings>(
      SettingsService.SEO_SETTINGS_CACHE_KEY,
    );
    if (cached) {
      this.seoSettingsCache = cached;
      return cached;
    }

    const settings = await this.loadSeoSettingsFromDatabase();
    this.seoSettingsCache = settings;
    await this.cacheManager.set(
      SettingsService.SEO_SETTINGS_CACHE_KEY,
      settings,
      0,
    );

    return settings;
  }

  async updateSeoSettings(updateSeoSettingsDto: UpdateSeoSettingsDto) {
    const settings = await this.loadSeoSettingsFromDatabase();

    const normalizedPatch = Object.fromEntries(
      Object.entries(updateSeoSettingsDto).map(([key, value]) => {
        if (typeof value !== 'string') {
          return [key, value];
        }

        const trimmedValue = value.trim();
        return [key, trimmedValue.length > 0 ? trimmedValue : null];
      }),
    );

    Object.assign(settings, normalizedPatch);

    const savedSettings = await this.seoSettingsRepository.save(settings);
    this.seoSettingsCache = null;
    await this.cacheManager.del(SettingsService.SEO_SETTINGS_CACHE_KEY);

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
    if (this.featureTogglesCache) {
      return this.featureTogglesCache;
    }

    const cached = await this.cacheManager.get<ProductFieldToggles>(
      SettingsService.FEATURE_TOGGLES_CACHE_KEY,
    );
    if (cached) {
      this.featureTogglesCache = cached;
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

    this.featureTogglesCache = toggles;
    await this.cacheManager.set(
      SettingsService.FEATURE_TOGGLES_CACHE_KEY,
      toggles,
      0,
    );

    return toggles;
  }

  async updateProductFieldToggles(
    updateProductFieldTogglesDto: UpdateProductFieldTogglesDto,
  ): Promise<ProductFieldToggles> {
    const toggles = await this.loadProductFieldTogglesFromDatabase();

    Object.assign(toggles, updateProductFieldTogglesDto);

    const savedToggles = await this.productFieldTogglesRepository.save(toggles);
    this.featureTogglesCache = null;
    await this.cacheManager.del(SettingsService.FEATURE_TOGGLES_CACHE_KEY);

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
      order: { min_vendor_price: 'ASC', id: 'ASC' },
    });
  }

  async createProductPriceRule(dto: CreateProductPriceRuleDto) {
    await this.ensureSchemaReady();

    const candidate = this.normalizeProductPriceRulePayload(dto);
    await this.assertNoConflictingProductPriceRule(candidate);

    const rule = this.productPriceRuleRepository.create(candidate);
    const savedRule = await this.productPriceRuleRepository.save(rule);
    await this.repriceAllProductsByActiveRules();

    return savedRule;
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
      vendor_id:
        dto.vendor_id !== undefined ? dto.vendor_id : existingRule.vendor_id,
      brand_id:
        dto.brand_id !== undefined ? dto.brand_id : existingRule.brand_id,
      category_ids:
        dto.category_ids !== undefined
          ? dto.category_ids
          : existingRule.category_ids,
      price_condition:
        dto.price_condition ?? existingRule.price_condition ?? 'between',
      adjustment_type:
        dto.adjustment_type ?? existingRule.adjustment_type ?? 'decrease',
      min_vendor_price: dto.min_vendor_price ?? existingRule.min_vendor_price,
      max_vendor_price:
        dto.max_vendor_price !== undefined
          ? dto.max_vendor_price
          : existingRule.max_vendor_price,
      percentage: dto.percentage ?? existingRule.percentage,
      is_active: dto.is_active ?? existingRule.is_active,
    });

    await this.assertNoConflictingProductPriceRule(candidate, id);

    Object.assign(existingRule, candidate);

    const savedRule = await this.productPriceRuleRepository.save(existingRule);
    await this.repriceAllProductsByActiveRules();

    return savedRule;
  }

  async deleteProductPriceRule(id: number) {
    await this.ensureSchemaReady();

    const result = await this.productPriceRuleRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException('Product price rule not found');
    }

    await this.repriceAllProductsByActiveRules();

    return { message: 'Product price rule deleted successfully' };
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

    const pricingContext: ProductPricingContext = {
      vendorId: params.vendorId ?? null,
      brandId: params.brandId ?? null,
      categoryIds: params.categoryIds ?? [],
      originalPrice: params.originalVendorPrice,
    };

    const matchedPriceRule = params.fixedPercentage
      ? null
      : findBestMatchingProductPriceRule(activeRules, pricingContext);
    const pricePercentage =
      params.fixedPercentage ??
      matchedPriceRule?.percentage ??
      MIN_PRODUCT_PRICE_RULE_PERCENTAGE;
    const priceAdjustmentType =
      params.fixedAdjustmentType ??
      matchedPriceRule?.adjustment_type ??
      'decrease';
    const price = calculateManagedPrice(
      params.originalVendorPrice,
      pricePercentage,
      priceAdjustmentType,
    );

    let salePrice: number | null = null;
    let matchedSaleRule: AppliedProductPriceRule | null = null;

    if (
      params.originalVendorSalePrice !== null &&
      params.originalVendorSalePrice !== undefined
    ) {
      const salePricingContext: ProductPricingContext = {
        ...pricingContext,
        originalPrice: params.originalVendorSalePrice,
      };
      const matchedSalePriceRule = params.fixedPercentage
        ? null
        : findBestMatchingProductPriceRule(activeRules, salePricingContext);
      const salePercentage =
        params.fixedPercentage ??
        matchedSalePriceRule?.percentage ??
        MIN_PRODUCT_PRICE_RULE_PERCENTAGE;
      const saleAdjustmentType =
        params.fixedAdjustmentType ??
        matchedSalePriceRule?.adjustment_type ??
        'decrease';

      salePrice = calculateManagedPrice(
        params.originalVendorSalePrice,
        salePercentage,
        saleAdjustmentType,
      );
      salePrice = ensureSalePriceBelowPrice(price, salePrice);
      matchedSaleRule = matchedSalePriceRule
        ? toAppliedProductPriceRule(matchedSalePriceRule)
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

  async repriceAllProductsByActiveRules() {
    await this.ensureSchemaReady();

    const updatedCount = await this.dataSource.transaction(async (manager) => {
      const productRepository = manager.getRepository(Product);
      const products = await productRepository
        .createQueryBuilder('product')
        .leftJoinAndSelect('product.productCategories', 'productCategories')
        .select([
          'product.id',
          'product.vendor_id',
          'product.brand_id',
          'product.category_id',
          'product.original_vendor_price',
          'product.original_vendor_sale_price',
          'productCategories.category_id',
        ])
        .getMany();

      for (const product of products) {
        const categoryIds = this.resolveProductCategoryIds(product);
        const originalVendorPrice = Number(product.original_vendor_price ?? 0);
        const originalVendorSalePrice =
          product.original_vendor_sale_price === null ||
          product.original_vendor_sale_price === undefined
            ? null
            : Number(product.original_vendor_sale_price);

        if (!Number.isFinite(originalVendorPrice) || originalVendorPrice <= 0) {
          continue;
        }

        const nextPricing = await this.calculateManagedProductPrices({
          originalVendorPrice,
          originalVendorSalePrice,
          vendorId: product.vendor_id ?? null,
          brandId: product.brand_id ?? null,
          categoryIds,
        });

        await productRepository.update(product.id, {
          price: nextPricing.price,
          sale_price: nextPricing.salePrice,
        });
      }

      return products.length;
    });

    return {
      updated_count: updatedCount,
      message: 'Product prices were recalculated from active pricing rules.',
    };
  }

  async repriceExistingProductsByFixedPercentage() {
    await this.ensureSchemaReady();

    const updatedCount = await this.dataSource.transaction(async (manager) => {
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
      }

      return products.length;
    });

    return {
      updated_count: updatedCount,
      percentage: MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
      message:
        'Existing product prices were repriced successfully from their current catalog before-sale and after-sale values.',
    };
  }

  async bulkUpdateProductPricing(dto: BulkUpdateProductPricingDto) {
    await this.ensureSchemaReady();

    const normalizedVendorIds = Array.from(
      new Set((dto.vendor_ids ?? []).map((value) => Number(value)).filter(Number.isFinite)),
    );
    const percentage = dto.percentage === undefined ? undefined : Number(dto.percentage);

    if (dto.action !== 'reset' && (!Number.isFinite(percentage) || percentage === undefined)) {
      throw new BadRequestException('percentage is required for increase or decrease actions');
    }

    const updatedCount = await this.dataSource.transaction(async (manager) => {
      const productRepository = manager.getRepository(Product);
      const query = productRepository
        .createQueryBuilder('product')
        .select([
          'product.id',
          'product.vendor_id',
          'product.price',
          'product.sale_price',
          'product.original_vendor_price',
          'product.original_vendor_sale_price',
        ]);

      if (normalizedVendorIds.length > 0) {
        query.andWhere('product.vendor_id IN (:...vendor_ids)', {
          vendor_ids: normalizedVendorIds,
        });
      }

      const products = await query.getMany();

      for (const product of products) {
        const nextPricing = this.getBulkUpdatedPricing({
          action: dto.action,
          percentage,
          price: product.price,
          salePrice: product.sale_price,
          originalVendorPrice: product.original_vendor_price,
          originalVendorSalePrice: product.original_vendor_sale_price,
        });

        await productRepository.update(product.id, nextPricing);
      }

      return products.length;
    });

    return {
      action: dto.action,
      percentage: percentage ?? null,
      vendor_ids: normalizedVendorIds,
      updated_count: updatedCount,
      message:
        dto.action === 'reset'
          ? `Reset pricing for ${updatedCount} products to original vendor prices.`
          : `${dto.action === 'increase' ? 'Increased' : 'Decreased'} pricing for ${updatedCount} products by ${percentage}%.`,
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
    await this.seedDefaultProductPriceRule();
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

      if (!(await queryRunner.hasColumn('product_price_rules', 'vendor_id'))) {
        missingColumns.push(
          new TableColumn({
            name: 'vendor_id',
            type: 'int',
            isNullable: true,
          }),
        );
      }

      if (!(await queryRunner.hasColumn('product_price_rules', 'brand_id'))) {
        missingColumns.push(
          new TableColumn({
            name: 'brand_id',
            type: 'int',
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
            default: `'between'`,
          }),
        );
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

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('product_price_rules', missingColumns);
      }
    } finally {
      await queryRunner.release();
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

  private async seedDefaultProductPriceRule(): Promise<void> {
    const existingRulesCount = await this.productPriceRuleRepository.count();

    if (existingRulesCount > 0) {
      return;
    }

    await this.productPriceRuleRepository.save(
      this.productPriceRuleRepository.create({
        vendor_id: null,
        brand_id: null,
        category_ids: null,
        price_condition: 'between',
        adjustment_type: 'decrease',
        min_vendor_price: 0,
        max_vendor_price: null,
        percentage: MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
        is_active: true,
      }),
    );
  }

  private normalizeProductPriceRulePayload(input: {
    vendor_id?: number | null;
    brand_id?: number | null;
    category_ids?: number[] | null;
    price_condition?: 'any' | 'more_than' | 'less_than' | 'between';
    adjustment_type?: 'increase' | 'decrease';
    min_vendor_price: number;
    max_vendor_price?: number | null;
    percentage: number;
    is_active?: boolean;
  }) {
    const normalized = normalizeProductPriceRuleShape({
      min_vendor_price: Number(input.min_vendor_price),
      max_vendor_price:
        input.max_vendor_price === undefined || input.max_vendor_price === null
          ? null
          : Number(input.max_vendor_price),
      percentage: Number(input.percentage),
      is_active: input.is_active ?? true,
      vendor_id:
        input.vendor_id === undefined || input.vendor_id === null
          ? null
          : Number(input.vendor_id),
      brand_id:
        input.brand_id === undefined || input.brand_id === null
          ? null
          : Number(input.brand_id),
      category_ids: normalizeCategoryIds(input.category_ids),
      price_condition: input.price_condition ?? 'between',
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

  private getBulkUpdatedPricing(input: {
    action: 'increase' | 'decrease' | 'reset';
    percentage?: number;
    price: number | null;
    salePrice: number | null;
    originalVendorPrice: number | null;
    originalVendorSalePrice: number | null;
  }) {
    if (input.action === 'reset') {
      return {
        price: input.originalVendorPrice ?? input.price ?? 0,
        sale_price: input.originalVendorSalePrice ?? null,
      };
    }

    const multiplier = input.action === 'increase'
      ? 1 + (input.percentage ?? 0) / 100
      : 1 - (input.percentage ?? 0) / 100;

    return {
      price: this.roundManagedPrice((input.price ?? 0) * multiplier),
      sale_price:
        input.salePrice === null || input.salePrice === undefined
          ? null
          : this.roundManagedPrice(Math.max(input.salePrice, 0) * multiplier),
    };
  }

  private roundManagedPrice(value: number) {
    return Math.max(0, Number(value.toFixed(2)));
  }

  private async assertNoConflictingProductPriceRule(
    candidate: ReturnType<SettingsService['normalizeProductPriceRulePayload']>,
    excludedRuleId?: number,
  ) {
    const existingRules = await this.productPriceRuleRepository.find({
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