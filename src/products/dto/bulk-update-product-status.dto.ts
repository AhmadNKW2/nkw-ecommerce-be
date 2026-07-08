import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, Min } from 'class-validator';
import { ProductStatus } from '../entities/product.entity';

const BULK_STATUS_VALUES = [
  ProductStatus.ACTIVE,
  ProductStatus.REVIEW,
  ProductStatus.UPDATED,
] as const;

export class BulkUpdateProductStatusDto {
  @ApiProperty({ enum: BULK_STATUS_VALUES })
  @IsNotEmpty()
  @IsIn(BULK_STATUS_VALUES)
  from_status: ProductStatus;

  @ApiProperty({ enum: BULK_STATUS_VALUES })
  @IsNotEmpty()
  @IsIn(BULK_STATUS_VALUES)
  to_status: ProductStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  vendor_id?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  category_id?: number;
}
