import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

export class ReimportReviewProductsDto {
  @ApiPropertyOptional({
    example: 35,
    description:
      'Optional category ID filter. Omit it to re-import review products across all categories.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  category_id?: number;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Optional vendor ID filter. Omit it to re-import review products across all vendors.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  vendor_id?: number;
}