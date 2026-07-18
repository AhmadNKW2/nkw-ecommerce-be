import { NotFoundException } from '@nestjs/common';
import { MediaType } from '../media/entities/media.entity';
import { DataSource } from 'typeorm';
import { ProductsService } from './products.service';
import { ProductStatus } from './entities/product.entity';
import { ProductCategory } from './entities/product-category.entity';
import { ProductMedia } from './entities/product-media.entity';
import { ProductAttachment } from './entities/product-attachment.entity';
import { ProductAttribute } from './entities/product-attribute.entity';
import { ProductAttributeValue } from './entities/product-attribute-value.entity';
import { ProductSpecificationValue } from './entities/product-specification-value.entity';

type BaseQueryBuilderMock = {
  where: jest.Mock;
  andWhere: jest.Mock;
  clone: jest.Mock;
  getCount: jest.Mock;
};

type PageQueryBuilderMock = {
  select: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  skip: jest.Mock;
  take: jest.Mock;
  getRawMany: jest.Mock;
};

const createFindAllQueryBuilderMocks = () => {
  const pageQuery: PageQueryBuilderMock = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue([]),
  };

  const baseQuery: BaseQueryBuilderMock = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    clone: jest.fn().mockReturnValue(pageQuery),
    getCount: jest.fn().mockResolvedValue(0),
  };

  return { baseQuery, pageQuery };
};

describe('ProductsService detail attributes', () => {
  let service: ProductsService;
  let productsRepository: {
    findOne: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let groupProductsRepository: { findOne: jest.Mock };
  let dataSource: { getRepository: jest.Mock };
  let repositoryByEntity: Map<unknown, { find: jest.Mock }>;
  let settingsService: { getSeoSettings: jest.Mock };

  const productBase = {
    id: 7,
    name_en: 'Gaming Monitor',
    name_ar: 'شاشة ألعاب',
    slug: 'gaming-monitor',
    sku: 'GM-7',
    short_description_en: 'Short description',
    short_description_ar: 'وصف قصير',
    long_description_en: 'Long description',
    long_description_ar: 'وصف طويل',
    reference_link: '/products/gaming-monitor',
    status: ProductStatus.ACTIVE,
    visible: true,
    category_id: null,
    vendor_id: null,
    brand_id: null,
    quantity: 8,
    is_out_of_stock: false,
    original_vendor_categories: [
      { id: 44, name: 'Gaming Monitors' },
      { id: 51 },
    ],
    original_vendor_category_id: 44,
    original_vendor_category_name: null,
    original_vendor_price: 220,
    original_vendor_sale_price: 199.9,
    cost: 100,
    price: 150,
    sale_price: null,
    productMedia: [],
    createdByUser: null,
    brand: null,
    category: null,
  };

  beforeEach(() => {
    productsRepository = {
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(),
    };

    groupProductsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    repositoryByEntity = new Map<unknown, { find: jest.Mock }>([
      [ProductCategory, { find: jest.fn().mockResolvedValue([]) }],
      [ProductMedia, { find: jest.fn().mockResolvedValue([]) }],
      [ProductAttachment, { find: jest.fn().mockResolvedValue([]) }],
      [ProductAttribute, { find: jest.fn().mockResolvedValue([]) }],
      [ProductAttributeValue, { find: jest.fn().mockResolvedValue([]) }],
      [ProductSpecificationValue, { find: jest.fn().mockResolvedValue([]) }],
    ]);

    dataSource = {
      getRepository: jest.fn().mockImplementation((entity: unknown) => {
        const repository = repositoryByEntity.get(entity);
        if (!repository) {
          throw new Error(`Unexpected repository request: ${String(entity)}`);
        }

        return repository;
      }),
    };

    settingsService = {
      getSeoSettings: jest.fn().mockResolvedValue({ show_sale_pricing: true }),
    };

    service = new ProductsService(
      productsRepository as never,
      {} as never,
      {} as never,
      groupProductsRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dataSource as unknown as DataSource,
      {} as never,
      settingsService as never,
      {} as never,
      {
        invalidateSearchCache: jest.fn().mockResolvedValue(2),
      } as never,
    );
  });

  it('includes is_color and color_code in product detail by id', async () => {
    productsRepository.findOne.mockResolvedValue({ ...productBase });
    repositoryByEntity.get(ProductAttribute)?.find.mockResolvedValue([
      {
        product_id: 7,
        attribute_id: 10,
        attribute: {
          id: 10,
          name_en: 'Color',
          name_ar: 'اللون',
          unit_en: null,
          unit_ar: null,
          is_color: true,
          list_separately: false,
        },
      },
    ]);
    repositoryByEntity.get(ProductAttributeValue)?.find.mockResolvedValue([
      {
        product_id: 7,
        attribute_value_id: 101,
        attribute_value: {
          id: 101,
          value_en: 'Red',
          value_ar: 'أحمر',
          color_code: '#FF0000',
          attribute: {
            id: 10,
          },
        },
      },
    ]);

    const result = await service.findOne(7);

    expect(result.attributes['10']).toMatchObject({
      name_en: 'Color',
      is_color: true,
    });
    expect(result.attributes['10'].values['101']).toMatchObject({
      name_en: 'Red',
      color_code: '#FF0000',
    });
  });

  it('includes the same attribute color metadata in product detail by slug', async () => {
    productsRepository.findOne
      .mockResolvedValueOnce({ id: 7 })
      .mockResolvedValueOnce({ ...productBase });
    repositoryByEntity.get(ProductAttribute)?.find.mockResolvedValue([
      {
        product_id: 7,
        attribute_id: 10,
        attribute: {
          id: 10,
          name_en: 'Color',
          name_ar: 'اللون',
          unit_en: null,
          unit_ar: null,
          is_color: true,
          list_separately: false,
        },
      },
    ]);
    repositoryByEntity.get(ProductAttributeValue)?.find.mockResolvedValue([
      {
        product_id: 7,
        attribute_value_id: 101,
        attribute_value: {
          id: 101,
          value_en: 'Red',
          value_ar: 'أحمر',
          color_code: '#FF0000',
          attribute: {
            id: 10,
          },
        },
      },
    ]);

    const result = await service.findOneBySlug('gaming-monitor');

    expect(result.attributes['10']).toMatchObject({
      name_en: 'Color',
      is_color: true,
    });
    expect(result.attributes['10'].values['101']).toMatchObject({
      name_en: 'Red',
      color_code: '#FF0000',
    });
  });

  it('returns original vendor category arrays without legacy single fields', async () => {
    productsRepository.findOne.mockResolvedValue({ ...productBase });

    const result = await service.findOne(7);

    expect(result.original_vendor_categories).toEqual([
      { id: 44, name: 'Gaming Monitors' },
      { id: 51 },
    ]);
    expect(result.original_vendor_categories_ids).toEqual([44, 51]);
    expect(result).not.toHaveProperty('original_vendor_category_id');
    expect(result).not.toHaveProperty('original_vendor_category_name');
  });

  it('hides vendor original pricing fields from public product detail responses', async () => {
    productsRepository.findOne.mockResolvedValue({ ...productBase });

    const result = await service.findOne(7, false);

    expect(result).not.toHaveProperty('original_vendor_price');
    expect(result).not.toHaveProperty('original_vendor_sale_price');
  });

  it('includes vendor original pricing fields for admin product detail responses', async () => {
    productsRepository.findOne.mockResolvedValue({ ...productBase });

    const result = await service.findOne(7, true);

    expect(result).toMatchObject({
      original_vendor_price: 220,
      original_vendor_sale_price: 199.9,
    });
  });

  it('normalizes multiple original vendor categories while keeping order and deduping', () => {
    const result = (service as any).normalizeOriginalVendorCategories({
      categoryIds: [51, 44, 51],
      categories: [
        { id: 44, name: 'Gaming Monitors' },
        { id: 51, name: 'LED Displays' },
        { id: 44 },
      ],
      legacyId: 44,
      legacyName: 'Gaming Monitors',
    });

    expect(result).toEqual([
      { id: 44, name: 'Gaming Monitors' },
      { id: 51, name: 'LED Displays' },
    ]);
  });

  it('includes active, review, and updated products by default for admin lists', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    const result = await service.findAll({}, true);

    expect(baseQuery.where).toHaveBeenCalledWith(
      'product.status IN (:...defaultStatuses)',
      {
        defaultStatuses: [
          ProductStatus.ACTIVE,
          ProductStatus.REVIEW,
          ProductStatus.UPDATED,
        ],
      },
    );
    expect(result).toEqual({
      data: [],
      meta: {
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      },
    });
  });

  it('includes active, review, and updated products by default for public lists', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    await service.findAll({}, false);

    expect(baseQuery.where).toHaveBeenCalledWith(
      'product.status IN (:...defaultStatuses)',
      {
        defaultStatuses: [
          ProductStatus.ACTIVE,
          ProductStatus.REVIEW,
          ProductStatus.UPDATED,
        ],
      },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.is_out_of_stock = false',
    );
  });

  it('filters products without a vendor when requested', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    await service.findAll({ has_no_vendor: true }, true);

    expect(baseQuery.andWhere).toHaveBeenCalledWith('product.vendor_id IS NULL');
  });

  it('includes vendorless products alongside selected vendors', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    await service.findAll({ vendor_ids: [5, 9], has_no_vendor: true }, true);

    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      '(product.vendor_id IN (:...vendor_ids) OR product.vendor_id IS NULL)',
      { vendor_ids: [5, 9] },
    );
  });

  it('includes brandless products alongside selected brands', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    await service.findAll({ brand_ids: [3], has_no_brand: true }, true);

    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      '(product.brand_id IN (:...brand_ids) OR product.brand_id IS NULL)',
      { brand_ids: [3] },
    );
  });

  it('applies every catalog-list filter to the database query', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    await service.findAll(
      {
        status: ProductStatus.REVIEW,
        visible: false,
        in_stock: false,
        has_duplicate_reference_link: true,
        minPrice: 10,
        maxPrice: 50,
        created_by: [7, 8],
        start_date: '2026-07-01',
        end_date: '2026-07-15',
        brand_ids: [3],
        vendor_ids: [5],
        category_ids: [11],
        attributes_ids: [13],
        attributes_values_ids: [17],
        specifications_ids: [19],
        specifications_values_ids: [23],
      },
      true,
    );

    expect(baseQuery.where).toHaveBeenCalledWith(
      'product.status = :status',
      { status: ProductStatus.REVIEW },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.visible = :visible',
      { visible: false },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.is_out_of_stock = true',
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.vendor_id IN (:...vendor_ids)',
      { vendor_ids: [5] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.brand_id IN (:...brand_ids)',
      { brand_ids: [3] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.created_by IN (:...created_by)',
      { created_by: [7, 8] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'COALESCE(product.sale_price, product.price) >= :minPrice',
      { minPrice: 10 },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'COALESCE(product.sale_price, product.price) <= :maxPrice',
      { maxPrice: 50 },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'product_categories pc WHERE pc.product_id = product.id AND pc.category_id IN',
      ),
      { category_ids: [11] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'product_attributes pa WHERE pa.product_id = product.id AND pa.attribute_id IN',
      ),
      { attributes_ids: [13] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'product_attribute_values pav WHERE pav.product_id = product.id AND pav.attribute_value_id IN',
      ),
      { attributes_values_ids: [17] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'specification_values sv ON sv.id = psv.specification_value_id',
      ),
      { specifications_ids: [19] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining(
        'product_specification_values psv WHERE psv.product_id = product.id AND psv.specification_value_id IN',
      ),
      { specifications_values_ids: [23] },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.created_at >= :start_date',
      { start_date: '2026-06-30T21:00:00.000Z' },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      'product.created_at <= :end_date',
      { end_date: '2026-07-15T20:59:59.999Z' },
    );
    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      expect.stringContaining('duplicate_product.reference_link'),
    );
  });

  it('filters products with no reference link', async () => {
    const { baseQuery } = createFindAllQueryBuilderMocks();
    productsRepository.createQueryBuilder.mockReturnValue(baseQuery);

    await service.findAll({ has_no_reference_link: true }, true);

    expect(baseQuery.andWhere).toHaveBeenCalledWith(
      `(product.reference_link IS NULL OR btrim(product.reference_link) = '')`,
    );
  });

  it('returns out-of-stock product details for public requests', async () => {
    productsRepository.findOne.mockResolvedValue({
      ...productBase,
      is_out_of_stock: true,
    });

    const result = await service.findOne(productBase.id, false);

    expect(result.is_out_of_stock).toBe(true);
  });

  it('returns only content fields and image urls from findProductContent', async () => {
    jest.spyOn(service, 'findAll').mockResolvedValue({
      data: [
        {
          id: 1,
          name_en: 'Monitor',
          name_ar: 'شاشة',
          long_description_en: 'Long EN',
          long_description_ar: 'Long AR',
          price: 100,
          sku: 'MON-1',
          media: [
            {
              id: 10,
              url: 'https://cdn.example.com/video.mp4',
              type: MediaType.VIDEO,
              is_primary: true,
              sort_order: 0,
            },
            {
              id: 11,
              url: 'https://cdn.example.com/secondary.jpg',
              type: MediaType.IMAGE,
              is_primary: false,
              sort_order: 1,
            },
            {
              id: 12,
              url: 'https://cdn.example.com/primary.jpg',
              type: MediaType.IMAGE,
              is_primary: true,
              sort_order: 0,
            },
          ],
        },
      ],
      meta: {
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      },
    });

    const result = await service.findProductContent({}, true);

    expect(result).toEqual({
      data: [
        {
          id: 1,
          name_en: 'Monitor',
          name_ar: 'شاشة',
          long_description_en: 'Long EN',
          long_description_ar: 'Long AR',
          images: [
            'https://cdn.example.com/primary.jpg',
            'https://cdn.example.com/secondary.jpg',
          ],
        },
      ],
      meta: {
        total: 1,
        page: 1,
        limit: 10,
        totalPages: 1,
      },
    });
  });
});