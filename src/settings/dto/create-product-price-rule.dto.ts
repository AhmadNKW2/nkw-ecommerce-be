import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Min,
} from 'class-validator';

export class CreateProductPriceRuleDto {
  @ApiPropertyOptional({
    example: [3, 5],
    description: 'Optional vendor filters. Empty or null means any vendor.',
  })
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @IsOptional()
  vendor_ids?: number[] | null;

  @ApiPropertyOptional({
    example: [12, 18],
    description: 'Optional brand filters. Empty or null means any brand.',
  })
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @IsOptional()
  brand_ids?: number[] | null;

  @ApiPropertyOptional({
    example: [4, 9],
    description: 'Optional category filters. Empty or null means any category.',
  })
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @IsOptional()
  category_ids?: number[] | null;

  @ApiPropertyOptional({
    enum: ['any', 'more_than', 'less_than', 'between'],
    nullable: true,
    example: 'between',
    description:
      'Product price condition. Null/any means any product price. between uses min/max, more_than uses min, less_than uses max.',
  })
  @IsEnum(['any', 'more_than', 'less_than', 'between'])
  @IsOptional()
  price_condition?: 'any' | 'more_than' | 'less_than' | 'between' | null;

  @ApiPropertyOptional({
    enum: ['increase', 'decrease'],
    example: 'increase',
    description: 'Whether the percentage increases or decreases the product price.',
  })
  @IsEnum(['increase', 'decrease'])
  @IsOptional()
  adjustment_type?: 'increase' | 'decrease';

  @ApiPropertyOptional({
    example: 0,
    description:
      'Inclusive minimum product price threshold. Leave empty to apply to all products.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  min_product_price?: number | null;

  @ApiPropertyOptional({
    example: 99.9,
    description:
      'Inclusive maximum product price threshold. Leave empty to apply to all products.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  max_product_price?: number | null;

  @ApiProperty({
    example: 10,
    description: 'Percentage to increase or decrease from the original product price.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  percentage: number;

  @ApiPropertyOptional({ example: true, description: 'Whether this rule is active.' })
  @IsBoolean()
  @IsOptional()
  is_active?: boolean;
}
