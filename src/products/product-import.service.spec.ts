import { NotFoundException } from '@nestjs/common';
import { Brand } from '../brands/entities/brand.entity';
import { ProductImportService } from './product-import.service';

describe('ProductImportService', () => {
  let service: ProductImportService;
  let productInputJsonRepository: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
  };
  let productsService: { create: jest.Mock; update: jest.Mock };
  let specificationsService: { addValue: jest.Mock };
  let attributesService: { addValue: jest.Mock };
  let brandsService: { create: jest.Mock };

  beforeEach(() => {
    productInputJsonRepository = {
      create: jest.fn((value) => value),
      save: jest.fn(),
      findOne: jest.fn(),
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
});