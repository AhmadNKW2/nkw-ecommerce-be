import {
  IsOptional,
  IsNumber,
  Min,
  IsEnum,
  IsBoolean,
  IsArray,
  ArrayMinSize,
  IsDateString,
  IsString,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ProductStatus } from '../entities/product.entity';

function parseNumericArray(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(Number);
  }

  if (typeof value === 'string') {
    return value.split(',').map(Number);
  }

  return [Number(value)];
}

export class AssignProductsDto {
  @IsArray()
  @ArrayMinSize(1)
  @Type(() => Number)
  @IsNumber({}, { each: true })
  product_ids!: number[];
}

export enum ProductSortBy {
  CREATED_AT = 'created_at',
  UPDATED_AT = 'updated_at',
  NAME_EN = 'name_en',
  NAME_AR = 'name_ar',
  AVERAGE_RATING = 'average_rating',
  TOTAL_RATINGS = 'total_ratings',
  PRICE = 'price',
}

export enum SortOrder {
  ASC = 'ASC',
  DESC = 'DESC',
}

export function getSingleVendorId(filterDto: {
  vendorId?: number;
  vendor_id?: number;
}) {
  return filterDto.vendorId ?? filterDto.vendor_id;
}

export function getOriginalVendorCategoryId(filterDto: {
  originalVendorCategoryId?: number;
  original_vendor_category_id?: number;
}) {
  return (
    filterDto.originalVendorCategoryId ??
    filterDto.original_vendor_category_id
  );
}

export function getCategoryIds(filterDto: {
  category_ids?: number[];
  categories_ids?: number[];
}) {
  return [
    ...new Set(
      [...(filterDto.category_ids ?? []), ...(filterDto.categories_ids ?? [])]
        .map((categoryId) => Number(categoryId))
        .filter(
          (categoryId) =>
            Number.isInteger(categoryId) && categoryId > 0,
        ),
    ),
  ];
}

export class FilterProductDto {
  // ─── Pagination ──────────────────────────────────────
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 10;

  // ─── Sorting ─────────────────────────────────────────
  @IsOptional()
  @IsEnum(ProductSortBy)
  sortBy?: ProductSortBy = ProductSortBy.CREATED_AT;

  @IsOptional()
  @IsEnum(SortOrder)
  sortOrder?: SortOrder = SortOrder.DESC;

  // ─── ID filter ───────────────────────────────────────
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsNumber({}, { each: true })
  ids?: number[];

  // ─── Status & Visibility ─────────────────────────────
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @IsOptional()
  @Transform(({ obj, key }) => {
    const value = obj[key];
    if (value === 'false' || value === false || value === '0') return false;
    return [true, 'true', '1', 1].includes(value);
  })
  @IsBoolean()
  visible?: boolean;

  // ─── Category filter ─────────────────────────────────
  /** Single category ID (backward compat). Use "none" to find uncategorized products. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === 'none') return 'none';
    const num = Number(value);
    return isNaN(num) ? undefined : num;
  })
  categoryId?: number | 'none';

  /** Multiple category IDs (comma-separated or repeated param) */
  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  category_ids?: number[];

  /** Backward-compatible alias for category_ids. */
  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  categories_ids?: number[];

  // ─── Attribute / Specification filters ──────────────
  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  attributes_ids?: number[];

  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  attributes_values_ids?: number[];

  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  specifications_ids?: number[];

  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  specifications_values_ids?: number[];

  // ─── Vendor filter ───────────────────────────────────
  /** Single vendor ID (backward compat). Accepts vendorId or vendor_id. */
  @IsOptional()
  @Transform(({ value, obj }) => {
    const rawValue = value ?? obj.vendor_id;

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return undefined;
    }

    const numericValue = Number(rawValue);
    return Number.isNaN(numericValue) ? undefined : numericValue;
  })
  @IsNumber()
  vendorId?: number;

  /** Backward-compatible alias for vendorId. Prefer vendorId in new clients. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const numericValue = Number(value);
    return Number.isNaN(numericValue) ? undefined : numericValue;
  })
  @IsNumber()
  vendor_id?: number;

  /** Multiple vendor IDs */
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsNumber({}, { each: true })
  vendor_ids?: number[];

  /** Single original vendor category ID (backward compat). */
  @IsOptional()
  @Transform(({ value, obj }) => {
    const rawValue = value ?? obj.original_vendor_category_id;

    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return undefined;
    }

    const numericValue = Number(rawValue);
    return Number.isNaN(numericValue) ? undefined : numericValue;
  })
  @IsNumber()
  originalVendorCategoryId?: number;

  /** Backward-compatible alias for originalVendorCategoryId. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    const numericValue = Number(value);
    return Number.isNaN(numericValue) ? undefined : numericValue;
  })
  @IsNumber()
  original_vendor_category_id?: number;

  // ─── Brand filter ────────────────────────────────────
  /** Single brand ID (backward compat) */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  brandId?: number;

  /** Multiple brand IDs */
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsNumber({}, { each: true })
  brand_ids?: number[];

  // ─── Creator filter ──────────────────────────────────
  @IsOptional()
  @Transform(({ value }) => {
    if (Array.isArray(value)) return value.map(Number);
    if (typeof value === 'string') return value.split(',').map(Number);
    return [Number(value)];
  })
  @IsArray()
  @IsNumber({}, { each: true })
  created_by?: number[];

  // ─── Price filter ────────────────────────────────────
  /** Minimum effective price (sale_price if set, otherwise price) */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number;

  /** Maximum effective price */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number;

  /** Only products currently on sale (have a sale_price) */
  @IsOptional()
  @Transform(({ obj, key }) => {
    const value = obj[key];
    if (value === 'false' || value === false || value === '0') return false;
    return [true, 'true', '1', 1].includes(value);
  })
  @IsBoolean()
  has_sale?: boolean;

  // ─── Rating filter ───────────────────────────────────
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minRating?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxRating?: number;

  // ─── Stock filter ────────────────────────────────────
  /** Only products that have at least 1 unit in stock */
  @IsOptional()
  @Transform(({ obj, key }) => {
    const value = obj[key];
    if (value === 'false' || value === false || value === '0') return false;
    return [true, 'true', '1', 1].includes(value);
  })
  @IsBoolean()
  in_stock?: boolean;

  // ─── Date range filter ───────────────────────────────
  /** ISO date string: only products created on or after this date */
  @IsOptional()
  @IsDateString()
  start_date?: string;

  /** ISO date string: only products created on or before this date */
  @IsOptional()
  @IsDateString()
  end_date?: string;

  // ─── Text search ─────────────────────────────────────
  /** Full-text search across name, SKU, descriptions */
  @IsOptional()
  @IsString()
  search?: string;

  /** Exact SKU match */
  @IsOptional()
  @IsString()
  sku?: string;
}
