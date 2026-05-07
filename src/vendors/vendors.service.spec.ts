import { VendorsService } from './vendors.service';

describe('VendorsService vendor categories', () => {
  let service: VendorsService;
  let vendorRepository: { findOne: jest.Mock; find: jest.Mock };
  let categoriesRepository: { find: jest.Mock };
  let transactionVendorCategoryRepository: {
    delete: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let vendorCategoryRepository: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    delete: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: {
      transaction: jest.Mock;
    };
  };

  beforeEach(() => {
    vendorRepository = {
      findOne: jest.fn(),
      find: jest.fn(),
    };
    categoriesRepository = {
      find: jest.fn(),
    };

    const relationBuilder = {
      of: jest.fn().mockReturnThis(),
      loadMany: jest.fn().mockResolvedValue([]),
      add: jest.fn().mockResolvedValue(undefined),
      addAndRemove: jest.fn().mockResolvedValue(undefined),
    };

    const sortOrderQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ max: -1 }),
    };

    let nextSavedId = 100;
    transactionVendorCategoryRepository = {
      delete: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockImplementation((value) => value),
      save: jest
        .fn()
        .mockImplementation(async (value) => ({ ...value, id: ++nextSavedId })),
      createQueryBuilder: jest.fn().mockReturnValue({
        relation: jest.fn().mockReturnValue(relationBuilder),
      }),
    };

    const transactionManager = {
      getRepository: jest.fn().mockReturnValue(transactionVendorCategoryRepository),
    };

    vendorCategoryRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((value) => value),
      save: jest.fn(),
      delete: jest.fn(),
      createQueryBuilder: jest
        .fn()
        .mockImplementation((alias?: string) =>
          alias
            ? sortOrderQueryBuilder
            : {
                relation: jest.fn().mockReturnValue(relationBuilder),
              },
        ),
      manager: {
        transaction: jest.fn().mockImplementation(async (callback) =>
          callback(transactionManager),
        ),
      },
    };

    service = new VendorsService(
      vendorRepository as never,
      {} as never,
      categoriesRepository as never,
      {} as never,
      {} as never,
      vendorCategoryRepository as never,
    );
  });

  it('creates a vendor category without assigned categories', async () => {
    vendorRepository.findOne.mockResolvedValue({ id: 5, name_en: 'Vendor 5' });
    vendorCategoryRepository.findOne.mockResolvedValue(null);
    vendorCategoryRepository.save.mockResolvedValue({ id: 7 });
    vendorCategoryRepository.find.mockResolvedValue([
      {
        id: 7,
        title: 'Vendor Landing',
        reference_link: '/vendor-landing',
        vendor_id: 5,
        parent_id: null,
        sort_order: 0,
        created_at: new Date('2026-05-05T00:00:00.000Z'),
        updated_at: new Date('2026-05-05T00:00:00.000Z'),
        categories: [],
      },
    ]);

    const result = await service.createVendorCategory(5, {
      title: 'Vendor Landing',
      reference_link: '/vendor-landing',
    });

    expect(vendorCategoryRepository.create).toHaveBeenCalledWith({
      vendor_id: 5,
      title: 'Vendor Landing',
      reference_link: '/vendor-landing',
      parent_id: null,
      sort_order: 0,
    });
    expect(result).toMatchObject({
      id: 7,
      category_ids: [],
      categories: [],
    });
  });

  it('builds a vendor category tree and exposes all mapped category ids', async () => {
    vendorRepository.findOne.mockResolvedValue({ id: 5, name_en: 'Vendor 5' });
    vendorCategoryRepository.find.mockResolvedValue([
      {
        id: 1,
        title: 'Displays',
        reference_link: '/displays',
        vendor_id: 5,
        parent_id: null,
        sort_order: 0,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [
          { id: 11, name_en: 'Gaming Monitors' },
          { id: 9, name_en: 'Monitors' },
        ],
      },
      {
        id: 2,
        title: 'OLED',
        reference_link: '/displays/oled',
        vendor_id: 5,
        parent_id: 1,
        sort_order: 0,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [{ id: 12, name_en: 'OLED Monitors' }],
      },
    ]);

    const result = await service.findVendorCategoriesTree(5);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 1,
      category_ids: [9, 11],
    });
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0]).toMatchObject({
      id: 2,
      parent_id: 1,
      category_ids: [12],
    });
  });

  it('lists vendor categories from deepest children to parents without sort_order', async () => {
    vendorRepository.findOne.mockResolvedValue({ id: 5, name_en: 'Vendor 5' });
    vendorCategoryRepository.find.mockResolvedValue([
      {
        id: 1,
        title: 'Displays',
        reference_link: '/displays',
        vendor_id: 5,
        parent_id: null,
        sort_order: 0,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [{ id: 9, name_en: 'Monitors' }],
      },
      {
        id: 2,
        title: 'OLED',
        reference_link: '/displays/oled',
        vendor_id: 5,
        parent_id: 1,
        sort_order: 0,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [{ id: 12, name_en: 'OLED Monitors' }],
      },
      {
        id: 3,
        title: 'QD-OLED',
        reference_link: '/displays/oled/qd-oled',
        vendor_id: 5,
        parent_id: 2,
        sort_order: 0,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [{ id: 13, name_en: 'QD-OLED Monitors' }],
      },
      {
        id: 4,
        title: 'LCD',
        reference_link: '/displays/lcd',
        vendor_id: 5,
        parent_id: 1,
        sort_order: 1,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [{ id: 14, name_en: 'LCD Monitors' }],
      },
      {
        id: 5,
        title: 'Peripherals',
        reference_link: '/peripherals',
        vendor_id: 5,
        parent_id: null,
        sort_order: 1,
        created_at: new Date('2026-05-04T00:00:00.000Z'),
        updated_at: new Date('2026-05-04T00:00:00.000Z'),
        categories: [],
      },
    ]);

    const result = await service.findVendorCategories(5);

    expect(result.map((item) => item.id)).toEqual([3, 2, 4, 1, 5]);
    expect(result[0]).toMatchObject({
      id: 3,
      reference_link: '/displays/oled/qd-oled',
      category_ids: [13],
    });
    expect(result[0]).not.toHaveProperty('sort_order');
    expect(result[3]).toMatchObject({
      id: 1,
      reference_link: '/displays',
      category_ids: [9],
    });
  });

  it('replaces the full vendor category tree from one nested payload', async () => {
    vendorRepository.findOne.mockResolvedValue({ id: 5, name_en: 'Vendor 5' });
    categoriesRepository.find.mockResolvedValue([{ id: 9 }, { id: 11 }, { id: 12 }]);
    vendorCategoryRepository.find.mockResolvedValue([
      {
        id: 101,
        title: 'Displays',
        reference_link: '/displays',
        vendor_id: 5,
        parent_id: null,
        sort_order: 0,
        created_at: new Date('2026-05-05T00:00:00.000Z'),
        updated_at: new Date('2026-05-05T00:00:00.000Z'),
        categories: [
          { id: 11, name_en: 'Gaming Monitors' },
          { id: 9, name_en: 'Monitors' },
        ],
      },
      {
        id: 102,
        title: 'OLED',
        reference_link: '/displays/oled',
        vendor_id: 5,
        parent_id: 101,
        sort_order: 0,
        created_at: new Date('2026-05-05T00:00:00.000Z'),
        updated_at: new Date('2026-05-05T00:00:00.000Z'),
        categories: [{ id: 12, name_en: 'OLED Monitors' }],
      },
      {
        id: 103,
        title: 'Peripherals',
        reference_link: '/peripherals',
        vendor_id: 5,
        parent_id: null,
        sort_order: 1,
        created_at: new Date('2026-05-05T00:00:00.000Z'),
        updated_at: new Date('2026-05-05T00:00:00.000Z'),
        categories: [],
      },
    ]);

    const result = await service.replaceVendorCategoriesTree(5, {
      categories: [
        {
          title: 'Displays',
          reference_link: '/displays',
          category_ids: [11, 9],
          children: [
            {
              title: 'OLED',
              reference_link: '/displays/oled',
              category_ids: [12],
            },
          ],
        },
        {
          title: 'Peripherals',
          reference_link: '/peripherals',
        },
      ],
    });

    expect(transactionVendorCategoryRepository.delete).toHaveBeenCalledWith({
      vendor_id: 5,
    });
    expect(transactionVendorCategoryRepository.save).toHaveBeenNthCalledWith(1, {
      vendor_id: 5,
      title: 'Displays',
      reference_link: '/displays',
      parent_id: null,
      sort_order: 0,
    });
    expect(transactionVendorCategoryRepository.save).toHaveBeenNthCalledWith(2, {
      vendor_id: 5,
      title: 'OLED',
      reference_link: '/displays/oled',
      parent_id: 101,
      sort_order: 0,
    });
    expect(transactionVendorCategoryRepository.save).toHaveBeenNthCalledWith(3, {
      vendor_id: 5,
      title: 'Peripherals',
      reference_link: '/peripherals',
      parent_id: null,
      sort_order: 1,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: 101,
      category_ids: [9, 11],
    });
    expect(result[0].children).toHaveLength(1);
    expect(result[0].children[0]).toMatchObject({
      id: 102,
      parent_id: 101,
      category_ids: [12],
    });
    expect(result[1]).toMatchObject({
      id: 103,
      category_ids: [],
    });
  });

  it('allows duplicate reference_link values in one vendor category tree payload', async () => {
    vendorRepository.findOne.mockResolvedValue({ id: 5, name_en: 'Vendor 5' });
    categoriesRepository.find.mockResolvedValue([]);
    vendorCategoryRepository.find.mockResolvedValue([
      {
        id: 101,
        title: 'Displays',
        reference_link: '/shared-link',
        vendor_id: 5,
        parent_id: null,
        sort_order: 0,
        created_at: new Date('2026-05-05T00:00:00.000Z'),
        updated_at: new Date('2026-05-05T00:00:00.000Z'),
        categories: [],
      },
      {
        id: 102,
        title: 'OLED',
        reference_link: '/shared-link',
        vendor_id: 5,
        parent_id: 101,
        sort_order: 0,
        created_at: new Date('2026-05-05T00:00:00.000Z'),
        updated_at: new Date('2026-05-05T00:00:00.000Z'),
        categories: [],
      },
    ]);

    const result = await service.replaceVendorCategoriesTree(5, {
      categories: [
        {
          title: 'Displays',
          reference_link: '/shared-link',
          children: [
            {
              title: 'OLED',
              reference_link: '/shared-link',
            },
          ],
        },
      ],
    });

    expect(transactionVendorCategoryRepository.save).toHaveBeenNthCalledWith(1, {
      vendor_id: 5,
      title: 'Displays',
      reference_link: '/shared-link',
      parent_id: null,
      sort_order: 0,
    });
    expect(transactionVendorCategoryRepository.save).toHaveBeenNthCalledWith(2, {
      vendor_id: 5,
      title: 'OLED',
      reference_link: '/shared-link',
      parent_id: 101,
      sort_order: 0,
    });
    expect(result[0].reference_link).toBe('/shared-link');
    expect(result[0].children[0].reference_link).toBe('/shared-link');
  });
});