import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export enum SeoEntityType {
  PRODUCT = 'product',
  CATEGORY = 'category',
  BRAND = 'brand',
  VENDOR = 'vendor',
}

export class ListMissingSeoDto {
  @ApiPropertyOptional({ enum: SeoEntityType })
  @IsEnum(SeoEntityType)
  @IsOptional()
  type?: SeoEntityType;

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
  @Max(100)
  @IsOptional()
  limit?: number = 25;
}
