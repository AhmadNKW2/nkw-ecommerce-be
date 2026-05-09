import { DataSource } from 'typeorm';
import { ProductsService } from './products.service';
import { ProductStatus } from './entities/product.entity';
import { ProductCategory } from './entities/product-category.entity';
import { ProductMedia } from './entities/product-media.entity';
import { ProductAttribute } from './entities/product-attribute.entity';
import { ProductAttributeValue } from './entities/product-attribute-value.entity';
import { ProductSpecificationValue } from './entities/product-specification-value.entity';

describe('ProductsService detail attributes', () => {
  let service: ProductsService;
  let productsRepository: { findOne: jest.Mock };
  let groupProductsRepository: { findOne: jest.Mock };
  let dataSource: { getRepository: jest.Mock };
  let repositoryByEntity: Map<unknown, { find: jest.Mock }>;

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
    };

    groupProductsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    repositoryByEntity = new Map([
      [ProductCategory, { find: jest.fn().mockResolvedValue([]) }],
      [ProductMedia, { find: jest.fn().mockResolvedValue([]) }],
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

    service = new ProductsService(
      productsRepository as never,
      {} as never,
      {} as never,
      groupProductsRepository as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      dataSource as DataSource,
      {} as never,
      {} as never,
      {} as never,
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
});