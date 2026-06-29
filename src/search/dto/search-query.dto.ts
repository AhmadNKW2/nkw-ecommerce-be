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

export class SearchQueryDto {
  @IsOptional()
  @IsString()
  q?: string = '*';

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
  @Type(() => Number)
  @IsInt()
  vendor_id?: number;

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
  @Transform(({ value }: { value: string }) => value === 'true')
  @IsBoolean()
  in_stock?: boolean;

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

  // ── Sorting ─────────────────────────────────────────────────────────────────

  @IsOptional()
  @IsString()
  @IsIn([
    'popularity_score:desc',
    'price_min:asc',
    'price_min:desc',
    'rating:desc',
    'created_at:desc',
  ])
  sort_by?: string = 'popularity_score:desc';
}

export class AutocompleteQueryDto {
  @IsString()
  q: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  per_page?: number;
}
