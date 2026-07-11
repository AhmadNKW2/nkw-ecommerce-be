import {
  IsString,
  IsOptional,
  IsNumber,
  MaxLength,
  IsBoolean,
  IsEnum,
  IsArray,
  IsInt,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { CategoryStatus } from '../entities/category.entity';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  parseProductChangesInput,
  ProductChangesDto,
} from '../../common/dto/product-changes.dto';

export class CreateCategoryDto {
  @IsString()
  @MaxLength(100)
  name_en: string;

  @IsString()
  @MaxLength(100)
  name_ar: string;

  @IsString()
  @IsOptional()
  description_en?: string;

  @IsString()
  @IsOptional()
  description_ar?: string;

  @IsString()
  @IsOptional()
  image?: string;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === null || value === 'null') return null;
    if (value === undefined) return undefined;
    const num = Number(value);
    return isNaN(num) ? undefined : num;
  })
  parent_id?: number | null; // For creating subcategories (omit or null for root category)

  @IsEnum(CategoryStatus)
  @IsOptional()
  @Transform(({ value }) => (value === '' ? undefined : value))
  status?: CategoryStatus;

  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => {
    if (value === '' || value === undefined) return undefined;
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  visible?: boolean;

  @ApiPropertyOptional({
    type: ProductChangesDto,
    description:
      'Delta product assignment changes. Send add/remove product IDs here instead of product_ids.',
  })
  @IsOptional()
  @Transform(({ value }) => parseProductChangesInput(value))
  @ValidateNested()
  @Type(() => ProductChangesDto)
  product_changes?: ProductChangesDto;

  @ApiPropertyOptional({
    type: [Number],
    example: [3, 10, 11],
    description: 'Attribute IDs that should be linked to this category.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === '' || value === null) return [];
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return value
          .split(',')
          .map(Number)
          .filter((n) => !isNaN(n));
      }
    }
    return Array.isArray(value) ? value : [];
  })
  @IsArray()
  @IsInt({ each: true })
  attribute_ids?: number[];

  @ApiPropertyOptional({
    type: [Number],
    example: [3, 10, 11],
    description: 'Specification IDs that should be linked to this category.',
  })
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined) return undefined;
    if (value === '' || value === null) return [];
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return value
          .split(',')
          .map(Number)
          .filter((n) => !isNaN(n));
      }
    }
    return Array.isArray(value) ? value : [];
  })
  @IsArray()
  @IsInt({ each: true })
  specification_ids?: number[];

  // image will be handled separately in multipart/form-data
}
