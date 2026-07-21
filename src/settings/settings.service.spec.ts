import { DataSource } from 'typeorm';
import { SettingsService } from './settings.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let seoSettingsRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let queryRunner: {
    connect: jest.Mock;
    hasTable: jest.Mock;
    hasColumn: jest.Mock;
    createTable: jest.Mock;
    addColumns: jest.Mock;
    query: jest.Mock;
    release: jest.Mock;
  };
  let productPriceRuleRepository: {
    count: jest.Mock;
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    delete: jest.Mock;
  };
  let productsRepository: {
    createQueryBuilder: jest.Mock;
  };
  let transactionProductRepository: {
    createQueryBuilder: jest.Mock;
    update: jest.Mock;
  };
  let productFieldTogglesRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let sitePopupSettingsRepository: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };
  let cacheManager: {
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
  let productsService: {
    syncProductsToTypesense: jest.Mock;
  };
  let dataSource: {
    createQueryRunner: jest.Mock;
    transaction: jest.Mock;
  };

  beforeEach(() => {
    seoSettingsRepository = {
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
    };

    queryRunner = {
      connect: jest.fn().mockResolvedValue(undefined),
      hasTable: jest.fn().mockResolvedValue(true),
      hasColumn: jest.fn().mockResolvedValue(true),
      createTable: jest.fn().mockResolvedValue(undefined),
      addColumns: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
    };

    productPriceRuleRepository = {
      count: jest.fn().mockResolvedValue(1),
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      save: jest.fn(),
      findOne: jest.fn(),
      delete: jest.fn(),
    };

    productsRepository = {
      createQueryBuilder: jest.fn(),
    };

    productFieldTogglesRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
    };

    sitePopupSettingsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      save: jest.fn(),
    };

    cacheManager = {
      get: jest.fn().mockResolvedValue(undefined),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    productsService = {
      syncProductsToTypesense: jest.fn().mockResolvedValue(undefined),
    };

    transactionProductRepository = {
      createQueryBuilder: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunner),
      transaction: jest.fn().mockImplementation(async (callback) =>
        callback({
          getRepository: jest.fn().mockReturnValue(transactionProductRepository),
        }),
      ),
    };

    service = new SettingsService(
      seoSettingsRepository as never,
      productPriceRuleRepository as never,
      productsRepository as never,
      productFieldTogglesRepository as never,
      sitePopupSettingsRepository as never,
      dataSource as unknown as DataSource,
      cacheManager as never,
      productsService as never,
    );
  });

  it('creates the seo_settings table and a default row when the table is missing', async () => {
    queryRunner.hasTable.mockImplementation(async (tableName: string) => {
      return tableName !== 'seo_settings';
    });
    seoSettingsRepository.findOne.mockResolvedValue(null);
    seoSettingsRepository.create.mockReturnValue({ site_name_en: 'Storefront' });
    seoSettingsRepository.save.mockResolvedValue({
      id: 1,
      site_name_en: 'Storefront',
    });

    const result = await service.getSeoSettings();

    expect(queryRunner.connect).toHaveBeenCalled();
    expect(queryRunner.hasTable).toHaveBeenCalledWith('seo_settings');
    expect(queryRunner.createTable).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'seo_settings' }),
      true,
    );
    expect(seoSettingsRepository.create).toHaveBeenCalledWith({});
    expect(seoSettingsRepository.save).toHaveBeenCalledWith({
      site_name_en: 'Storefront',
    });
    expect(queryRunner.release).toHaveBeenCalled();
    expect(result).toEqual({
      id: 1,
      site_name_en: 'Storefront',
      shipping_rules: [],
    });
  });

  it('returns the existing settings row without seeding a new one', async () => {
    const existingSettings = {
      id: 7,
      site_name_en: 'Storefront',
      robots_index: true,
      robots_follow: true,
    };

    seoSettingsRepository.findOne.mockResolvedValue(existingSettings);

    const result = await service.getSeoSettings();

    expect(queryRunner.createTable).not.toHaveBeenCalled();
    expect(seoSettingsRepository.create).not.toHaveBeenCalled();
    expect(seoSettingsRepository.save).not.toHaveBeenCalled();
    expect(result).toEqual({
      ...existingSettings,
      shipping_rules: [],
    });
    expect(cacheManager.set).toHaveBeenCalledWith(
      'settings:seo:v2-shipping-rules',
      expect.objectContaining({ id: 7 }),
      30_000,
    );
  });

  it('write-through caches fresh SEO settings after update and clears legacy keys', async () => {
    const existingSettings = {
      id: 1,
      site_name_en: 'Storefront',
      site_name_ar: 'المتجر',
      brand_primary: '#00193d',
      brand_secondary: '#f0bb1c',
      shipping_cutoff_hour: 20,
      shipping_rules: [],
    };
    const savedSettings = {
      ...existingSettings,
      shipping_cutoff_hour: 23,
    };

    seoSettingsRepository.findOne
      .mockResolvedValueOnce(existingSettings)
      .mockResolvedValueOnce(savedSettings);
    seoSettingsRepository.save.mockResolvedValue(savedSettings);

    const result = await service.updateSeoSettings({
      shipping_cutoff_hour: 23,
      // Simulate ValidationPipe leaving omitted DTO keys as undefined
      brand_primary: undefined,
      brand_secondary: undefined,
      site_name_en: undefined,
    } as never);

    expect(seoSettingsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        shipping_cutoff_hour: 23,
        brand_primary: '#00193d',
        brand_secondary: '#f0bb1c',
      }),
    );
    expect(result.brand_primary).toBe('#00193d');
    expect(result.shipping_cutoff_hour).toBe(23);
    expect(cacheManager.del).toHaveBeenCalledWith('settings:seo:v2-shipping-rules');
    expect(cacheManager.del).toHaveBeenCalledWith('settings:seo');
    expect(cacheManager.set).toHaveBeenCalledWith(
      'settings:seo:v2-shipping-rules',
      expect.objectContaining({
        shipping_cutoff_hour: 23,
        brand_primary: '#00193d',
      }),
      30_000,
    );
  });

  it('overwrites vendor original prices from the current catalog values and reprices all existing products by 1%', async () => {
    const productRows = [
      {
        id: 10,
        price: 29.99,
        sale_price: 33,
        original_vendor_price: 999,
        original_vendor_sale_price: 888,
      },
      {
        id: 11,
        price: 12.49,
        sale_price: null,
        original_vendor_price: null,
        original_vendor_sale_price: null,
      },
    ];
    const transactionQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue(productRows),
    };

    transactionProductRepository.createQueryBuilder.mockReturnValue(
      transactionQueryBuilder,
    );

    const result = await service.repriceExistingProductsByFixedPercentage();

    expect(transactionProductRepository.update).toHaveBeenNthCalledWith(1, 10, {
      original_vendor_price: 33,
      original_vendor_sale_price: 29.99,
      price: 32.5,
      sale_price: 29.5,
    });
    expect(transactionProductRepository.update).toHaveBeenNthCalledWith(2, 11, {
      original_vendor_price: 12.49,
      original_vendor_sale_price: null,
      price: 12.5,
      sale_price: null,
    });
    expect(result).toEqual({
      updated_count: 2,
      percentage: 1,
      message:
        'Existing product prices were repriced successfully from their current catalog before-sale and after-sale values.',
    });
    expect(productsService.syncProductsToTypesense).toHaveBeenCalledWith([
      10, 11,
    ]);
  });

  it('applies the rule selected by original price to price and sale price', async () => {
    productPriceRuleRepository.find.mockResolvedValue([
      {
        id: 8,
        vendor_ids: null,
        brand_ids: null,
        category_ids: null,
        price_condition: 'between',
        adjustment_type: 'decrease',
        min_product_price: 90,
        max_product_price: 110,
        percentage: 10,
        is_active: true,
      },
    ]);

    const result = await service.calculateManagedProductPrices({
      originalVendorPrice: 100,
      originalVendorSalePrice: 80,
    });

    expect(result.price).toBe(90);
    expect(result.salePrice).toBe(72);
    expect(result.appliedPriceRule?.id).toBe(8);
    expect(result.appliedSalePriceRule?.id).toBe(8);
  });

  it('keeps original prices when no pricing rule matches', async () => {
    productPriceRuleRepository.find.mockResolvedValue([]);

    const result = await service.calculateManagedProductPrices({
      originalVendorPrice: 100.21,
      originalVendorSalePrice: 80.42,
    });

    expect(result.price).toBe(100.21);
    expect(result.salePrice).toBe(80.42);
    expect(result.appliedPriceRule).toBeNull();
    expect(result.appliedSalePriceRule).toBeNull();
  });
});