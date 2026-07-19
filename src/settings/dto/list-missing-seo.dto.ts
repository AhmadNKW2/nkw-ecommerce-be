import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum SeoEntityType {
  PRODUCT = 'product',
  CATEGORY = 'category',
  BRAND = 'brand',
  VENDOR = 'vendor',
}

export enum SeoListStatus {
  MISSING = 'missing',
  ALL = 'all',
  COMPLETE = 'complete',
}

export class ListMissingSeoDto {
  @ApiPropertyOptional({ enum: SeoEntityType })
  @IsEnum(SeoEntityType)
  @IsOptional()
  type?: SeoEntityType;

  @ApiPropertyOptional({
    enum: SeoListStatus,
    description:
      'missing = any empty meta field; complete = all meta filled; all = every entity',
    default: SeoListStatus.ALL,
  })
  @IsEnum(SeoListStatus)
  @IsOptional()
  seo_status?: SeoListStatus = SeoListStatus.ALL;

  @IsString()
  @IsOptional()
  q?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  limit?: number = 25;
}
