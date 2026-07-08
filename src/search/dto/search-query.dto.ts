import {
  IsOptional,
  IsString,
  IsInt,
  IsBoolean,
  IsArray,
  Min,
  Max,
  IsIn,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { parseQueryBoolean } from '../../common/utils/query-boolean.util';

export class SearchQueryDto {
  @IsOptional()
  @IsString()
  q?: string = '*';

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  is_admin?: boolean;

  /**
   * Admin-only override of the default status set (active/updated/review).
   * Comma-separated for multiple values, e.g. ?status=archived or ?status=active,review
   */
  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    String(value)
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  )
  @IsArray()
  @IsString({ each: true })
  status?: string[];

  /**
   * Admin-only override of the default visible-only filter.
   */
  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  visible?: boolean;

  // ── Text filters ────────────────────────────────────────────────────────────


  @IsOptional()
  @IsString()
  brand?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  subcategory?: string;

  // ── ID filters (facets) ─────────────────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  brand_id?: number;

  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    String(value)
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !isNaN(n)),
  )
  @IsArray()
  brand_ids?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  vendor_id?: number;

  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    String(value)
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !isNaN(n)),
  )
  @IsArray()
  vendor_ids?: number[];

  /**
   * Filter by a single category ID.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  category_id?: number;

  /**
   * Filter by multiple category IDs (comma-separated string → array).
   * Example: ?category_ids=1,3,7
   */
  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    String(value)
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !isNaN(n)),
  )
  @IsArray()
  category_ids?: number[];

  @IsOptional()
  @IsString()
  seller_id?: string;

  // ── Price filter ────────────────────────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  min_price?: number;

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  max_price?: number;

  // ── Availability ────────────────────────────────────────────────────────────

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  in_stock?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  is_out_of_stock?: boolean;

  // ── Rating filter ────────────────────────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(5)
  rating_min?: number;

  // ── Attribute filter ────────────────────────────────────────────────────────
  /**
   * Filter by one or more attribute pairs.
   * Each value is "key:value" e.g. ?attrs=color:Black&attrs=ram:16GB
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }: { value: string | string[] | undefined }) => {
    if (value === undefined || value === null) return value;
    return Array.isArray(value) ? value : [value];
  })
  attrs?: string[];

  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    String(value)
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !isNaN(n)),
  )
  @IsArray()
  attributes_values_ids?: number[];

  @IsOptional()
  @Transform(({ value }: { value: string }) =>
    String(value)
      .split(',')
      .map((v) => parseInt(v.trim(), 10))
      .filter((n) => !isNaN(n)),
  )
  @IsArray()
  specifications_values_ids?: number[];

  @IsOptional()
  @Type(() => Number)
  @Min(0)
  @Max(5)
  average_rating_min?: number;

  // ── Pagination ──────────────────────────────────────────────────────────────

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  per_page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  // ── Sorting ─────────────────────────────────────────────────────────────────

  @IsOptional()
  @IsString()
  @IsIn([
    'popularity_score:desc',
    'price:asc',
    'price:desc',
    'price_min:asc',
    'price_min:desc',
    'rating:desc',
    'created_at:desc',
  ])
  sort_by?: string;

  // ── Admin-only filters (DB fallback; not indexed in Typesense) ─────────────

  @IsOptional()
  @IsString()
  start_date?: string;

  @IsOptional()
  @IsString()
  end_date?: string;

  @IsOptional()
  @IsString()
  created_by?: string;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  has_no_vendor?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  has_no_brand?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  has_duplicate_reference_link?: boolean;
}

export class AutocompleteQueryDto {
  @IsString()
  q: string;

  @IsOptional()
  @Transform(({ value }) => parseQueryBoolean(value))
  @IsBoolean()
  is_admin?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  per_page?: number;
}
