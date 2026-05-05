import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

function parseNumberArrayInput(value: unknown): unknown {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      return value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return value;
}

function emptyToUndefined(value: unknown): unknown {
  return value === '' ? undefined : value;
}

export class CreateVendorCategoryDto {
  @ApiProperty({
    example: 'Gaming Monitors',
    description: 'Vendor-specific category title.',
  })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    example: 'https://vendor.example.com/collections/gaming-monitors',
    description: 'Vendor-specific category reference link or path.',
  })
  @IsString()
  @IsNotEmpty()
  reference_link: string;

  @ApiPropertyOptional({
    example: [9, 11, 14],
    description:
      'Optional mapped category ids from your categories table.',
    type: [Number],
  })
  @IsOptional()
  @Transform(({ value }) => parseNumberArrayInput(value))
  @Type(() => Number)
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  category_ids?: number[];

  @ApiPropertyOptional({
    example: 3,
    description: 'Optional parent vendor category id to build the vendor tree.',
  })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Type(() => Number)
  @IsInt()
  parent_id?: number | null;

  @ApiPropertyOptional({
    example: 0,
    description: 'Optional sort order within the same vendor category level.',
  })
  @IsOptional()
  @Transform(({ value }) => emptyToUndefined(value))
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort_order?: number;
}