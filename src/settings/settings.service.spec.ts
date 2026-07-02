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
    expect(result).toBe(existingSettings);
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
      price: 32.6,
      sale_price: 29.6,
    });
    expect(transactionProductRepository.update).toHaveBeenNthCalledWith(2, 11, {
      original_vendor_price: 12.49,
      original_vendor_sale_price: null,
      price: 12.3,
      sale_price: null,
    });
    expect(result).toEqual({
      updated_count: 2,
      percentage: 1,
      message:
        'Existing product prices were repriced successfully from their current catalog before-sale and after-sale values.',
    });
  });
});