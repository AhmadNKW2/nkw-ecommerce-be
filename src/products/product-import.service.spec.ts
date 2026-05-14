import { NotFoundException } from '@nestjs/common';
import { Brand } from '../brands/entities/brand.entity';
import { Category } from '../categories/entities/category.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { Product, ProductStatus } from './entities/product.entity';
import { ProductImportService } from './product-import.service';

describe('ProductImportService', () => {
  let service: ProductImportService;
  let productInputJsonRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    manager: { getRepository: jest.Mock };
  };
  let productsService: { create: jest.Mock; update: jest.Mock };
  let specificationsService: { addValue: jest.Mock };
  let attributesService: { addValue: jest.Mock };
  let brandsService: { create: jest.Mock };
  let categoryRepository: { findOne: jest.Mock };
  let vendorRepository: { findOne: jest.Mock };
  let productQueryBuilder: {
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    getMany: jest.Mock;
  };
  let productRepository: { createQueryBuilder: jest.Mock };

  beforeEach(() => {
    categoryRepository = {
      findOne: jest.fn(),
    };
    vendorRepository = {
      findOne: jest.fn(),
    };
    productQueryBuilder = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getMany: jest.fn(),
    };
    productRepository = {
      createQueryBuilder: jest.fn().mockReturnValue(productQueryBuilder),
    };
    productInputJsonRepository = {
      create: jest.fn((value) => value),
      save: jest.fn(),
      findOne: jest.fn(),
      manager: {
        getRepository: jest.fn((entity) => {
          if (entity === Category) {
            return categoryRepository;
          }

          if (entity === Vendor) {
            return vendorRepository;
          }

          if (entity === Product) {
            return productRepository;
          }

          throw new Error(`Unexpected repository requested: ${String(entity)}`);
        }),
      },
    };
    productsService = {
      create: jest.fn(),
      update: jest.fn(),
    };
    specificationsService = {
      addValue: jest.fn(),
    };
    attributesService = {
      addValue: jest.fn(),
    };
    brandsService = {
      create: jest.fn(),
    };

    service = new ProductImportService(
      { find: jest.fn() } as never,
      productInputJsonRepository as never,
      productsService as never,
      specificationsService as never,
      attributesService as never,
      { uploadAndCreate: jest.fn() } as never,
      brandsService as never,
    );

    jest.spyOn(service as any, 'getOpenAiApiKey').mockReturnValue('test-key');
  });

  it('stores the raw import request body after creating the product', async () => {
    const inputBody = {
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
      },
      category_id: 9,
      vendor_id: 2,
    };
    const createProductDto = {
      name_en: 'Imported Monitor',
      name_ar: 'شاشة مستوردة',
    };
    const createdProduct = {
      product: {
        id: 321,
      },
      message: 'Product created successfully.',
    };
    const createMock = productsService.create.mockResolvedValue(createdProduct);

    jest
      .spyOn(service as any, 'parseRequest')
      .mockReturnValue({
        payload: {
          title: 'Imported Monitor',
          description: 'Imported description',
          new_price: '99.99',
          old_price: undefined,
          price: undefined,
          sale_price: undefined,
          brand: null,
          image: null,
          images: [],
          media: [],
          specification: [],
          attributes: [],
          reference_link: null,
          quantity: undefined,
          stock: undefined,
          sku: null,
          record: null,
          raw_data: {},
        },
        categoryId: 9,
        categoryIds: [9],
        vendorId: 2,
        model: 'gpt-5.4',
        sourceFile: null,
      });
    jest.spyOn(service as any, 'loadImportCatalog').mockResolvedValue({
      brands: [],
      specifications: [],
      attributes: [],
    });
    jest.spyOn(service as any, 'callOpenAi').mockResolvedValue({
      title_en: 'Imported Monitor',
      title_ar: 'شاشة مستوردة',
      short_description_en: 'Imported short description',
      short_description_ar: 'وصف قصير مستورد',
      description_en: 'Imported long description',
      description_ar: 'وصف طويل مستورد',
      specifications: [],
      attributes: [],
    });
    jest
      .spyOn(service as any, 'buildCreateProductDto')
      .mockResolvedValue(createProductDto);

    const result = await service.importFromRequest(inputBody);

    expect(createMock).toHaveBeenCalledWith(createProductDto, undefined);
    expect(productInputJsonRepository.create).toHaveBeenCalledWith({
      product_id: 321,
      input_json: inputBody,
    });
    expect(productInputJsonRepository.save).toHaveBeenCalledWith({
      product_id: 321,
      input_json: inputBody,
    });
    expect(result).toBe(createdProduct);
  });

  it('extracts original vendor category metadata from import payload aliases', () => {
    const parsed = (service as any).parseRequest({
      category_id: 9,
      vendor_id: 2,
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
        vendorCategories: [
          {
            id: 44,
            title: 'Gaming Monitors',
          },
          {
            id: 51,
            title: 'LED Displays',
          },
        ],
      },
    });

    expect(parsed.payload.original_vendor_categories).toEqual([
      { id: 44, name: 'Gaming Monitors' },
      { id: 51, name: 'LED Displays' },
    ]);
    expect(parsed.payload.original_vendor_category_id).toBe(44);
    expect(parsed.payload.original_vendor_category_name).toBe(
      'Gaming Monitors',
    );
  });

  it('extracts original vendor category ids arrays from import payload aliases', () => {
    const parsed = (service as any).parseRequest({
      category_id: 9,
      vendor_id: 2,
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
        original_vendor_categories_ids: [44, '51', 44, null, 'invalid'],
      },
    });

    expect(parsed.payload.original_vendor_categories).toEqual([
      { id: 44 },
      { id: 51 },
    ]);
    expect(parsed.payload.original_vendor_category_id).toBe(44);
    expect(parsed.payload.original_vendor_category_name).toBeNull();
  });

  it('keeps all category_ids from the import payload', () => {
    const parsed = (service as any).parseRequest({
      vendor_id: 2,
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
        category_ids: [9, '12', 12, null, 'invalid', 18],
      },
    });

    expect(parsed.categoryId).toBe(9);
    expect(parsed.categoryIds).toEqual([9, 12, 18]);
  });

  it('loads the import catalog for all imported category ids', async () => {
    const parseRequestSpy = jest.spyOn(service as any, 'parseRequest').mockReturnValue({
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
        old_price: undefined,
        price: undefined,
        sale_price: undefined,
        brand: null,
        image: null,
        images: [],
        media: [],
        specification: [],
        attributes: [],
        reference_link: null,
        quantity: undefined,
        stock: undefined,
        sku: null,
        record: null,
        original_vendor_categories: [],
        original_vendor_category_id: null,
        original_vendor_category_name: null,
        raw_data: {},
      },
      categoryId: 9,
      categoryIds: [9, 12, 18],
      vendorId: 2,
      model: 'gpt-5.4',
      sourceFile: null,
    });
    const loadImportCatalogSpy = jest
      .spyOn(service as any, 'loadImportCatalog')
      .mockResolvedValue({
        brands: [],
        specifications: [],
        attributes: [],
      });
    const callOpenAiSpy = jest.spyOn(service as any, 'callOpenAi').mockResolvedValue({
      title_en: 'Imported Monitor',
      title_ar: 'شاشة مستوردة',
      short_description_en: 'Imported short description',
      short_description_ar: 'وصف قصير مستورد',
      description_en: 'Imported long description',
      description_ar: 'وصف طويل مستورد',
      specifications: [],
      attributes: [],
    });
    const buildCreateProductDtoSpy = jest
      .spyOn(service as any, 'buildCreateProductDto')
      .mockResolvedValue({
        name_en: 'Imported Monitor',
        name_ar: 'شاشة مستوردة',
      });

    await (service as any).buildImportedProductDto({
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
      },
      category_ids: [9, 12, 18],
      vendor_id: 2,
    });

    expect(parseRequestSpy).toHaveBeenCalled();
    expect(loadImportCatalogSpy).toHaveBeenCalledWith([9, 12, 18]);
    expect(callOpenAiSpy).toHaveBeenCalled();
    expect(buildCreateProductDtoSpy).toHaveBeenCalled();
  });

  it('builds a create dto with all imported category ids', async () => {
    jest.spyOn(service as any, 'resolveSpecifications').mockResolvedValue([]);
    jest.spyOn(service as any, 'resolveAttributes').mockResolvedValue([]);
    jest.spyOn(service as any, 'buildMedia').mockResolvedValue([]);
    jest.spyOn(service as any, 'resolveBrandForImport').mockResolvedValue(null);

    const createProductDto = await (service as any).buildCreateProductDto(
      {
        payload: {
          title: 'Imported Monitor',
          description: 'Imported description',
          new_price: '99.99',
          old_price: undefined,
          price: undefined,
          sale_price: undefined,
          brand: null,
          image: null,
          images: [],
          media: [],
          specification: [],
          attributes: [],
          reference_link: null,
          quantity: undefined,
          stock: undefined,
          sku: null,
          record: null,
          original_vendor_categories: [],
          original_vendor_category_id: null,
          original_vendor_category_name: null,
          raw_data: {},
        },
        categoryId: 9,
        categoryIds: [9, 12, 18],
        vendorId: 2,
        model: 'gpt-5.4',
        sourceFile: null,
      },
      {
        title_en: 'Imported Monitor',
        title_ar: 'شاشة مستوردة',
        short_description_en: 'Imported short description',
        short_description_ar: 'وصف قصير مستورد',
        description_en: 'Imported long description',
        description_ar: 'وصف طويل مستورد',
        specifications: [],
        attributes: [],
      },
      {
        brands: [],
        specifications: [],
        attributes: [],
      },
    );

    expect(createProductDto.category_ids).toEqual([9, 12, 18]);
  });

  it('copies original vendor category metadata into the create dto payload metadata', () => {
    const createProductDto: Record<string, unknown> = {};

    (service as any).applyPayloadMetadata(createProductDto, {
      title: 'Imported Monitor',
      description: 'Imported description',
      new_price: '99.99',
      image: null,
      images: [],
      media: [],
      specification: [],
      attributes: [],
      brand: null,
      reference_link: null,
      quantity: undefined,
      stock: undefined,
      sku: null,
      record: null,
      original_vendor_categories: [
        { id: 44, name: 'Gaming Monitors' },
        { id: 51, name: 'LED Displays' },
      ],
      original_vendor_category_id: 44,
      original_vendor_category_name: 'Gaming Monitors',
      raw_data: {},
    });

    expect(createProductDto).toMatchObject({
      original_vendor_categories: [
        { id: 44, name: 'Gaming Monitors' },
        { id: 51, name: 'LED Displays' },
      ],
      original_vendor_category_id: 44,
      original_vendor_category_name: 'Gaming Monitors',
    });
  });

  it('re-imports an existing product from its stored input_json payload', async () => {
    const storedInputBody = {
      payload: {
        title: 'Imported Monitor',
        description: 'Imported description',
        new_price: '99.99',
      },
      category_id: 9,
      vendor_id: 2,
    };
    const updateProductDto = {
      name_en: 'Imported Monitor',
      name_ar: 'شاشة مستوردة',
    };
    const updatedProduct = {
      product: {
        id: 321,
      },
      message: 'Product updated successfully.',
    };

    productInputJsonRepository.findOne.mockResolvedValue({
      product_id: 321,
      input_json: storedInputBody,
    });
    productsService.update.mockResolvedValue(updatedProduct);
    jest
      .spyOn(service as any, 'buildImportedProductDto')
      .mockResolvedValue(updateProductDto);

    const result = await service.reimportByProductId(321);

    expect(productInputJsonRepository.findOne).toHaveBeenCalledWith({
      where: { product_id: 321 },
    });
    expect((service as any).buildImportedProductDto).toHaveBeenCalledWith(
      storedInputBody,
    );
    expect(productsService.update).toHaveBeenCalledWith(321, updateProductDto);
    expect(productInputJsonRepository.create).not.toHaveBeenCalled();
    expect(productInputJsonRepository.save).not.toHaveBeenCalled();
    expect(result).toBe(updatedProduct);
  });

  it('throws a not found error when no stored input_json exists for re-import', async () => {
    productInputJsonRepository.findOne.mockResolvedValue(null);

    await expect(service.reimportByProductId(321)).rejects.toThrow(
      new NotFoundException('No stored import input JSON found for product 321.'),
    );
    expect(productsService.update).not.toHaveBeenCalled();
  });

  it('re-imports matching review products and reports item failures without stopping the batch', async () => {
    categoryRepository.findOne.mockResolvedValue({
      id: 35,
      name_en: 'Gaming',
    });
    vendorRepository.findOne.mockResolvedValue({
      id: 2,
      name_en: 'Tech Vendor',
    });
    productQueryBuilder.getMany.mockResolvedValue([
      { id: 101, name_en: 'Gaming Monitor' },
      { id: 102, name_en: 'Gaming Keyboard' },
    ]);
    const reimportSpy = jest
      .spyOn(service, 'reimportByProductId')
      .mockResolvedValueOnce({
        product: { id: 101 },
        message: 'Product updated successfully.',
      })
      .mockRejectedValueOnce(
        new NotFoundException('No stored import input JSON found for product 102.'),
      );

    const result = await service.reimportReviewProducts(35, 2);

    expect(categoryRepository.findOne).toHaveBeenCalledWith({
      where: { id: 35 },
    });
    expect(vendorRepository.findOne).toHaveBeenCalledWith({
      where: { id: 2 },
    });
    expect(productRepository.createQueryBuilder).toHaveBeenCalledWith('product');
    expect(productQueryBuilder.where).toHaveBeenCalledWith(
      'product.status = :status',
      { status: ProductStatus.REVIEW },
    );
    expect(reimportSpy).toHaveBeenNthCalledWith(1, 101);
    expect(reimportSpy).toHaveBeenNthCalledWith(2, 102);
    expect(result).toEqual({
      message:
        'Re-imported 1 of 2 review products for vendor "Tech Vendor" in category "Gaming"',
      matched: 2,
      reimported: 1,
      failed: 1,
      filters: {
        status: ProductStatus.REVIEW,
        category_id: 35,
        vendor_id: 2,
      },
      results: [
        {
          product_id: 101,
          name_en: 'Gaming Monitor',
          status: 'reimported',
        },
        {
          product_id: 102,
          name_en: 'Gaming Keyboard',
          status: 'failed',
          error: 'No stored import input JSON found for product 102.',
        },
      ],
    });
  });

  it('re-imports all review products when no vendor or category filters are provided', async () => {
    productQueryBuilder.getMany.mockResolvedValue([
      { id: 201, name_en: 'Office Monitor' },
      { id: 202, name_en: 'Office Keyboard' },
    ]);
    const reimportSpy = jest
      .spyOn(service, 'reimportByProductId')
      .mockResolvedValue({
        product: { id: 201 },
        message: 'Product updated successfully.',
      } as never);

    const result = await service.reimportReviewProducts();

    expect(categoryRepository.findOne).not.toHaveBeenCalled();
    expect(vendorRepository.findOne).not.toHaveBeenCalled();
    expect(productRepository.createQueryBuilder).toHaveBeenCalledWith('product');
    expect(productQueryBuilder.where).toHaveBeenCalledWith(
      'product.status = :status',
      { status: ProductStatus.REVIEW },
    );
    expect(productQueryBuilder.andWhere).not.toHaveBeenCalled();
    expect(reimportSpy).toHaveBeenNthCalledWith(1, 201);
    expect(reimportSpy).toHaveBeenNthCalledWith(2, 202);
    expect(result).toEqual({
      message: 'Re-imported 2 of 2 review products',
      matched: 2,
      reimported: 2,
      failed: 0,
      filters: {
        status: ProductStatus.REVIEW,
        category_id: null,
        vendor_id: null,
      },
      results: [
        {
          product_id: 201,
          name_en: 'Office Monitor',
          status: 'reimported',
        },
        {
          product_id: 202,
          name_en: 'Office Keyboard',
          status: 'reimported',
        },
      ],
    });
  });

  it('starts single-product re-import in background and returns a job id', async () => {
    jest.spyOn(service, 'reimportByProductId').mockResolvedValue({
      product: { id: 321 },
      message: 'Product updated successfully.',
    } as never);

    const jobId = service.startReimportByProductIdInBackground(321);

    expect(jobId).toMatch(/^reimport-one-/);
    expect(service.getJobStatus(jobId)).toMatchObject({
      job_id: jobId,
      type: 'reimport-one',
      status: 'running',
    });

    await Promise.resolve();

    expect(service.getJobStatus(jobId)).toMatchObject({
      job_id: jobId,
      type: 'reimport-one',
      status: 'done',
      result: {
        product: { id: 321 },
        message: 'Product updated successfully.',
      },
    });
  });

  it('starts review re-import in background and returns a job id', async () => {
    jest.spyOn(service, 'reimportReviewProducts').mockResolvedValue({
      message: 'Re-imported 2 of 2 review products',
      matched: 2,
      reimported: 2,
      failed: 0,
      filters: {
        status: ProductStatus.REVIEW,
        category_id: null,
        vendor_id: null,
      },
      results: [],
    } as never);

    const jobId = service.startReimportReviewProductsInBackground();

    expect(jobId).toMatch(/^reimport-review-/);
    expect(service.reimportReviewProducts).toHaveBeenCalledWith(
      undefined,
      undefined,
      jobId,
    );
    expect(service.getJobStatus(jobId)).toMatchObject({
      job_id: jobId,
      type: 'reimport-review',
      status: 'running',
    });

    await Promise.resolve();

    expect(service.getJobStatus(jobId)).toMatchObject({
      job_id: jobId,
      type: 'reimport-review',
      status: 'done',
      result: {
        message: 'Re-imported 2 of 2 review products',
        matched: 2,
        reimported: 2,
        failed: 0,
      },
    });
  });

  it('cancels older running bulk review re-import jobs when a new one starts', () => {
    jest
      .spyOn(service, 'reimportReviewProducts')
      .mockReturnValue(new Promise(() => undefined) as never);

    const firstJobId = service.startReimportReviewProductsInBackground();
    const secondJobId = service.startReimportReviewProductsInBackground(35, 2);

    expect(firstJobId).toMatch(/^reimport-review-/);
    expect(secondJobId).toMatch(/^reimport-review-/);
    expect(firstJobId).not.toBe(secondJobId);
    expect(service.getJobStatus(firstJobId)).toMatchObject({
      job_id: firstJobId,
      type: 'reimport-review',
      status: 'cancelled',
      error: 'Cancelled by a newer bulk review re-import job.',
    });
    expect(service.getJobStatus(secondJobId)).toMatchObject({
      job_id: secondJobId,
      type: 'reimport-review',
      status: 'running',
    });
  });

  it('prefers a corroborated payload brand over a conflicting AI brand', async () => {
    const brands = [
      { id: 1, name_en: 'Asus', name_ar: 'أسوس' },
      { id: 2, name_en: 'GIGABYTE', name_ar: 'جيجابايت' },
    ] as Brand[];

    const result = await (
      service as ProductImportService & {
        resolveOrCreateBrand: (
          brands: Brand[],
          payload: Record<string, unknown>,
          aiBrandName: unknown,
        ) => Promise<{
          brandId: number | null;
          brandName: string | null;
          brandCreated: boolean;
        }>;
      }
    ).resolveOrCreateBrand(
      brands,
      {
        title:
          'GIGABYTE G25F2A 24.5-inch FHD SuperSpeed IPS 1ms 240Hz Gaming Monitor',
        description:
          'GIGABYTE G25F2A monitor. for more Asus Rog & Asus Tuf & Asus Vivobook Laptops',
        new_price: '139.00',
        brand: 'GIGABYTE',
        image: null,
        images: [],
        media: [],
        specification: [{ key: 'BRAND', value: ['GIGABYTE'] }],
        attributes: [],
        reference_link:
          'https://mcc-jo.com/product/gigabyte-g25f2a-245-inch-fhd-superspeed-ips-1ms-240hz-gaming-monitor',
        raw_data: {},
      },
      'Asus',
    );

    expect(result).toEqual({
      brandId: 2,
      brandName: 'GIGABYTE',
      brandCreated: false,
    });
    expect(brandsService.create).not.toHaveBeenCalled();
  });

  it('reuses existing unit-based specification values before creating duplicates', async () => {
    const result = await (
      service as ProductImportService & {
        resolveSpecifications: (
          aiSpecifications: Array<{
            specification_id: number;
            values: Array<{
              original_value: { name_en: string; name_ar: string };
              matched_value_id: string;
            }>;
          }>,
          availableSpecifications: Array<Record<string, unknown>>,
        ) => Promise<
          Array<{
            specification_id: number;
            specification_value_ids: number[];
          }>
        >;
      }
    ).resolveSpecifications(
      [
        {
          specification_id: 9,
          values: [
            {
              original_value: { name_en: '25-inch', name_ar: '25-inch' },
              matched_value_id: 'not_exist',
            },
            {
              original_value: { name_en: '24.5-inch', name_ar: '24.5-inch' },
              matched_value_id: 'not_exist',
            },
          ],
        },
      ],
      [
        {
          id: 9,
          name_en: 'Screen Size',
          unit_en: 'inch',
          unit_ar: 'انش',
          values: [
            { id: 270, value_en: '25', value_ar: '25' },
            { id: 276, value_en: '24.5', value_ar: '24.5' },
          ],
        },
      ],
    );

    expect(result).toEqual([
      {
        specification_id: 9,
        specification_value_ids: [270, 276],
      },
    ]);
    expect(specificationsService.addValue).not.toHaveBeenCalled();
  });

  it('creates new unit-based specification values without persisting the unit text', async () => {
    specificationsService.addValue.mockResolvedValue({ id: 901 });

    const result = await (
      service as ProductImportService & {
        resolveSpecifications: (
          aiSpecifications: Array<{
            specification_id: number;
            values: Array<{
              original_value: { name_en: string; name_ar: string };
              matched_value_id: string;
            }>;
          }>,
          availableSpecifications: Array<Record<string, unknown>>,
        ) => Promise<
          Array<{
            specification_id: number;
            specification_value_ids: number[];
          }>
        >;
      }
    ).resolveSpecifications(
      [
        {
          specification_id: 9,
          values: [
            {
              original_value: { name_en: '9-inch', name_ar: '9-inch' },
              matched_value_id: 'not_exist',
            },
          ],
        },
      ],
      [
        {
          id: 9,
          name_en: 'Screen Size',
          unit_en: 'inch',
          unit_ar: 'انش',
          values: [],
        },
      ],
    );

    expect(result).toEqual([
      {
        specification_id: 9,
        specification_value_ids: [901],
      },
    ]);
    expect(specificationsService.addValue).toHaveBeenCalledWith(
      9,
      '9',
      '9',
      undefined,
    );
  });

  it('creates child specification values with the configured parent_value_id', async () => {
    specificationsService.addValue.mockResolvedValue({ id: 990 });

    const result = await (
      service as ProductImportService & {
        resolveSpecifications: (
          aiSpecifications: Array<{
            specification_id: number;
            values: Array<{
              original_value: { name_en: string; name_ar: string };
              matched_value_id: string;
            }>;
          }>,
          availableSpecifications: Array<Record<string, unknown>>,
        ) => Promise<
          Array<{
            specification_id: number;
            specification_value_ids: number[];
          }>
        >;
      }
    ).resolveSpecifications(
      [
        {
          specification_id: 19,
          values: [
            {
              original_value: { name_en: 'Nano SIM', name_ar: 'Nano SIM' },
              matched_value_id: 'not_exist',
            },
          ],
        },
      ],
      [
        {
          id: 19,
          name_en: 'SIM Type',
          parent_id: 11,
          parent_value_id: 330,
          values: [],
        },
      ],
    );

    expect(result).toEqual([
      {
        specification_id: 19,
        specification_value_ids: [990],
      },
    ]);
    expect(specificationsService.addValue).toHaveBeenCalledWith(
      19,
      'Nano SIM',
      'Nano SIM',
      330,
    );
  });

  it('creates child attribute values using the resolved parent value when parent_value_id is not fixed', async () => {
    attributesService.addValue.mockResolvedValue({ id: 880 });

    const result = await (
      service as ProductImportService & {
        resolveAttributes: (
          aiAttributes: Array<{
            attribute: { attribute_id: number; original_value: string };
            values: Array<{
              original_value: string;
              matched_value_id: number | string;
            }>;
          }>,
          availableAttributes: Array<Record<string, unknown>>,
        ) => Promise<
          Array<{
            attribute_id: number;
            attribute_value_ids: number[];
          }>
        >;
      }
    ).resolveAttributes(
      [
        {
          attribute: {
            attribute_id: 22,
            original_value: 'Storage Option',
          },
          values: [
            {
              original_value: '256',
              matched_value_id: 'not_exist',
            },
          ],
        },
        {
          attribute: {
            attribute_id: 11,
            original_value: 'Storage Type',
          },
          values: [
            {
              original_value: 'SSD',
              matched_value_id: 77,
            },
          ],
        },
      ],
      [
        {
          id: 22,
          name_en: 'Storage Option',
          parent_id: 11,
          level: 1,
          values: [],
        },
        {
          id: 11,
          name_en: 'Storage Type',
          level: 0,
          values: [
            {
              id: 77,
              value_en: 'SSD',
              value_ar: 'SSD',
            },
          ],
        },
      ],
    );

    expect(result).toEqual([
      {
        attribute_id: 11,
        attribute_value_ids: [77],
      },
      {
        attribute_id: 22,
        attribute_value_ids: [880],
      },
    ]);
    expect(attributesService.addValue).toHaveBeenCalledWith(
      22,
      '256',
      '256',
      77,
    );
  });

  it('rejects AI attributes that return more than one value for the same attribute', async () => {
    await expect(
      (
      service as ProductImportService & {
        resolveAttributes: (
          aiAttributes: Array<{
            attribute: { attribute_id: number; original_value: string };
            values: Array<{
              original_value: string;
              matched_value_id: number | string;
            }>;
          }>,
          availableAttributes: Array<Record<string, unknown>>,
        ) => Promise<
          Array<{
            attribute_id: number;
            attribute_value_ids: number[];
          }>
        >;
      }
      ).resolveAttributes(
        [
          {
            attribute: {
              attribute_id: 11,
              original_value: 'Storage Type',
            },
            values: [
              {
                original_value: 'SSD',
                matched_value_id: 77,
              },
              {
                original_value: 'HDD',
                matched_value_id: 78,
              },
            ],
          },
        ],
        [
          {
            id: 11,
            name_en: 'Storage Type',
            level: 0,
            values: [
              {
                id: 77,
                value_en: 'SSD',
                value_ar: 'SSD',
              },
              {
                id: 78,
                value_en: 'HDD',
                value_ar: 'HDD',
              },
            ],
          },
        ],
      )
    ).rejects.toThrow(
      'AI returned multiple values for attribute 11. Exactly one value is required per attribute.',
    );
  });
});