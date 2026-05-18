import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

export class CreateProductPriceRuleDto {
  @ApiProperty({ example: 0, description: 'Inclusive minimum vendor price for this rule.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_vendor_price: number;

  @ApiPropertyOptional({ example: 99.9, description: 'Inclusive maximum vendor price for this rule. Null means no upper bound.' })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  max_vendor_price?: number | null;

  @ApiProperty({ example: 5, description: 'Percentage to reduce from the vendor price. Must be at least 1.' })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  percentage: number;

  @ApiPropertyOptional({ example: true, description: 'Whether this rule is active.' })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}