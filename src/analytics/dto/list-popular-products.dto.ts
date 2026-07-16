import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/**
 * Query-string includeAdmin as 0|1 (avoids Nest Boolean("false") === true bug).
 */
export function parseIncludeAdminFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }
  return false;
}

export class ListPopularProductsDto {
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
  limit?: number = 20;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate?: string;

  @IsOptional()
  @IsString()
  search?: string;

  /** 1 = include admin browsers, 0 = exclude. Prefer 0/1 over true/false. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return 0;
    return parseIncludeAdminFlag(value) ? 1 : 0;
  })
  @Type(() => Number)
  @IsIn([0, 1])
  includeAdmin?: number = 0;

  @IsOptional()
  @IsIn(['views', 'sessions', 'clientIds', 'clicks'])
  sortBy?: 'views' | 'sessions' | 'clientIds' | 'clicks' = 'views';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
