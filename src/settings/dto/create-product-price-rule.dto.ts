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
    example: 3,
    description: 'Optional vendor filter. Null means any vendor.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  vendor_id?: number | null;

  @ApiPropertyOptional({
    example: 12,
    description: 'Optional brand filter. Null means any brand.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  brand_id?: number | null;

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
    example: 'between',
    description:
      'Original price condition. between uses min/max, more_than uses min, less_than uses max.',
  })
  @IsEnum(['any', 'more_than', 'less_than', 'between'])
  @IsOptional()
  price_condition?: 'any' | 'more_than' | 'less_than' | 'between';

  @ApiPropertyOptional({
    enum: ['increase', 'decrease'],
    example: 'increase',
    description: 'Whether the percentage increases or decreases the original price.',
  })
  @IsEnum(['increase', 'decrease'])
  @IsOptional()
  adjustment_type?: 'increase' | 'decrease';

  @ApiProperty({
    example: 0,
    description:
      'Inclusive minimum original price threshold. Used by between and more_than rules.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  min_vendor_price: number;

  @ApiPropertyOptional({
    example: 99.9,
    description:
      'Inclusive maximum original price threshold. Used by between and less_than rules. Null means no upper bound for between.',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @IsOptional()
  max_vendor_price?: number | null;

  @ApiProperty({
    example: 10,
    description: 'Percentage to increase or decrease from the original price.',
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
