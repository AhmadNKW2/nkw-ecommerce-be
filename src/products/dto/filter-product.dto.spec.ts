import { ValidationPipe } from '@nestjs/common';
import {
  FilterProductDto,
  getCategoryIds,
  getOriginalVendorCategoryId,
  getSingleVendorId,
} from './filter-product.dto';

describe('FilterProductDto', () => {
  const validationPipe = new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    transformOptions: {
      enableImplicitConversion: true,
    },
  });

  async function transformQuery(query: Record<string, unknown>) {
    return validationPipe.transform(query, {
      type: 'query',
      metatype: FilterProductDto,
      data: '',
    }) as Promise<FilterProductDto>;
  }

  it('accepts vendorId as the canonical query parameter', async () => {
    const result = await transformQuery({ vendorId: '2' });

    expect(result.vendorId).toBe(2);
  });

  it('accepts vendor_id as a backward-compatible alias', async () => {
    const result = await transformQuery({ vendor_id: '2' });

    expect(result.vendor_id).toBe(2);
    expect(getSingleVendorId(result)).toBe(2);
  });

  it('accepts originalVendorCategoryId as the canonical query parameter', async () => {
    const result = await transformQuery({ originalVendorCategoryId: '14' });

    expect(result.originalVendorCategoryId).toBe(14);
    expect(getOriginalVendorCategoryId(result)).toBe(14);
  });

  it('accepts original_vendor_category_id as a backward-compatible alias', async () => {
    const result = await transformQuery({ original_vendor_category_id: '14' });

    expect(result.original_vendor_category_id).toBe(14);
    expect(getOriginalVendorCategoryId(result)).toBe(14);
  });

  it('accepts categories_ids as an alias for category_ids', async () => {
    const result = await transformQuery({ categories_ids: '1,2,3' });

    expect(result.categories_ids).toEqual([1, 2, 3]);
    expect(getCategoryIds(result)).toEqual([1, 2, 3]);
  });

  it('merges category_ids and categories_ids into one normalized list', () => {
    expect(
      getCategoryIds({
        category_ids: [1, 2],
        categories_ids: [2, 3],
      }),
    ).toEqual([1, 2, 3]);
  });

  it('accepts attribute and specification id filters', async () => {
    const result = await transformQuery({
      attributes_ids: '5,6',
      attributes_values_ids: '7,8',
      specifications_ids: '9,10',
      specifications_values_ids: '11,12',
    });

    expect(result.attributes_ids).toEqual([5, 6]);
    expect(result.attributes_values_ids).toEqual([7, 8]);
    expect(result.specifications_ids).toEqual([9, 10]);
    expect(result.specifications_values_ids).toEqual([11, 12]);
  });
});