import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository, TableColumn } from 'typeorm';
import {
  Product,
  ProductDimensionUnit,
  ProductWeightUnit,
} from '../products/entities/product.entity';
import { CreateProductPriceRuleDto } from './dto/create-product-price-rule.dto';
import { UpdateProductPriceRuleDto } from './dto/update-product-price-rule.dto';
import { ProductPriceRule } from './entities/product-price-rule.entity';
import { SeoSettings } from './entities/seo-settings.entity';
import {
  assertProductPriceRuleValues,
  calculateManagedPrice,
  doProductPriceRulesOverlap,
  ensureSalePriceBelowPrice,
  findMatchingProductPriceRule,
  MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
} from './product-pricing.util';
import { createProductPriceRulesTableDefinition } from './product-price-rule.table';
import { UpdateSeoSettingsDto } from './dto/update-seo-settings.dto';
import { createSeoSettingsTableDefinition } from './seo-settings.table';

@Injectable()
export class SettingsService implements OnModuleInit {
  private ensureSchemaPromise: Promise<void> | null = null;

  constructor(
    @InjectRepository(SeoSettings)
    private readonly seoSettingsRepository: Repository<SeoSettings>,
    @InjectRepository(ProductPriceRule)
    private readonly productPriceRuleRepository: Repository<ProductPriceRule>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit() {
    await this.ensureSchemaReady();
  }

  async getSeoSettings(): Promise<SeoSettings> {
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

  async updateSeoSettings(updateSeoSettingsDto: UpdateSeoSettingsDto) {
    const settings = await this.getSeoSettings();

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

    return this.seoSettingsRepository.save(settings);
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
    await this.assertNoOverlappingProductPriceRule(candidate);

    const rule = this.productPriceRuleRepository.create(candidate);

    return this.productPriceRuleRepository.save(rule);
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
      min_vendor_price: dto.min_vendor_price ?? existingRule.min_vendor_price,
      max_vendor_price:
        dto.max_vendor_price !== undefined
          ? dto.max_vendor_price
          : existingRule.max_vendor_price,
      percentage: dto.percentage ?? existingRule.percentage,
      is_active: dto.is_active ?? existingRule.is_active,
    });

    await this.assertNoOverlappingProductPriceRule(candidate, id);

    Object.assign(existingRule, candidate);

    return this.productPriceRuleRepository.save(existingRule);
  }

  async deleteProductPriceRule(id: number) {
    await this.ensureSchemaReady();

    const result = await this.productPriceRuleRepository.delete(id);

    if (result.affected === 0) {
      throw new NotFoundException('Product price rule not found');
    }

    return { message: 'Product price rule deleted successfully' };
  }

  async calculateManagedProductPrices(params: {
    originalVendorPrice: number;
    originalVendorSalePrice: number | null;
    fixedPercentage?: number;
  }) {
    await this.ensureSchemaReady();

    const activeRules = params.fixedPercentage
      ? []
      : await this.productPriceRuleRepository.find({
          where: { is_active: true },
          order: { min_vendor_price: 'ASC', id: 'ASC' },
        });

    const pricePercentage = params.fixedPercentage
      ?? findMatchingProductPriceRule(activeRules, params.originalVendorPrice)
        ?.percentage
      ?? MIN_PRODUCT_PRICE_RULE_PERCENTAGE;
    const price = calculateManagedPrice(
      params.originalVendorPrice,
      pricePercentage,
    );

    let salePrice: number | null = null;

    if (
      params.originalVendorSalePrice !== null &&
      params.originalVendorSalePrice !== undefined
    ) {
      const salePercentage = params.fixedPercentage
        ?? findMatchingProductPriceRule(
          activeRules,
          params.originalVendorSalePrice,
        )?.percentage
        ?? MIN_PRODUCT_PRICE_RULE_PERCENTAGE;

      salePrice = calculateManagedPrice(
        params.originalVendorSalePrice,
        salePercentage,
      );
      salePrice = ensureSalePriceBelowPrice(price, salePrice);
    }

    return {
      price,
      salePrice,
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

  private async ensureSchemaReady(): Promise<void> {
    if (this.ensureSchemaPromise) {
      return this.ensureSchemaPromise;
    }

    this.ensureSchemaPromise = this.createMissingSchemaArtifacts();

    try {
      await this.ensureSchemaPromise;
    } finally {
      this.ensureSchemaPromise = null;
    }
  }

  private async createMissingSchemaArtifacts(): Promise<void> {
    await this.ensureSeoSettingsTableExists();
    await this.ensureSeoSettingsColumnsExist();
    await this.ensureProductPriceRulesTableExists();
    await this.ensureProductVendorPriceColumnsExist();
    await this.ensureProductMeasurementUnitColumnsExist();
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

      if (missingColumns.length > 0) {
        await queryRunner.addColumns('seo_settings', missingColumns);
      }
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

  private async seedDefaultProductPriceRule(): Promise<void> {
    const existingRulesCount = await this.productPriceRuleRepository.count();

    if (existingRulesCount > 0) {
      return;
    }

    await this.productPriceRuleRepository.save(
      this.productPriceRuleRepository.create({
        min_vendor_price: 0,
        max_vendor_price: null,
        percentage: MIN_PRODUCT_PRICE_RULE_PERCENTAGE,
        is_active: true,
      }),
    );
  }

  private normalizeProductPriceRulePayload(input: {
    min_vendor_price: number;
    max_vendor_price?: number | null;
    percentage: number;
    is_active?: boolean;
  }) {
    const normalized = {
      min_vendor_price: Number(input.min_vendor_price),
      max_vendor_price:
        input.max_vendor_price === undefined || input.max_vendor_price === null
          ? null
          : Number(input.max_vendor_price),
      percentage: Number(input.percentage),
      is_active: input.is_active ?? true,
    };

    assertProductPriceRuleValues(normalized);

    return normalized;
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

  private async assertNoOverlappingProductPriceRule(
    candidate: {
      min_vendor_price: number;
      max_vendor_price: number | null;
      percentage: number;
      is_active: boolean;
    },
    excludedRuleId?: number,
  ) {
    const existingRules = await this.productPriceRuleRepository.find({
      order: { min_vendor_price: 'ASC', id: 'ASC' },
    });

    const conflictingRule = existingRules.find((rule) => {
      if (excludedRuleId !== undefined && rule.id === excludedRuleId) {
        return false;
      }

      return doProductPriceRulesOverlap(candidate, rule);
    });

    if (conflictingRule) {
      throw new ConflictException(
        `This price range overlaps with existing rule #${conflictingRule.id}.`,
      );
    }
  }
}