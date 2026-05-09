import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class OriginalVendorCategoryInputDto {
  @ApiPropertyOptional({
    example: 18,
    description: 'Original source vendor category ID when available',
  })
  @IsNumber()
  @IsOptional()
  id?: number;

  @ApiPropertyOptional({
    example: 'Gaming Monitors',
    description: 'Original source vendor category name',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  name?: string;
}