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
import { parseIncludeAdminFlag } from './list-popular-products.dto';

export class ListSearchQueriesDto {
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

  /** 1 = include admin browsers, 0 = exclude. */
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return 0;
    return parseIncludeAdminFlag(value) ? 1 : 0;
  })
  @Type(() => Number)
  @IsIn([0, 1])
  includeAdmin?: number = 0;

  @IsOptional()
  @IsIn(['views', 'sessions', 'clientIds'])
  sortBy?: 'views' | 'sessions' | 'clientIds' = 'views';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc' = 'desc';
}
