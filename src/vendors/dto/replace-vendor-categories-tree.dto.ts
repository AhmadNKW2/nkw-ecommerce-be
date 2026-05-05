import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
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

export const replaceVendorCategoriesTreeSwaggerExample = {
  categories: [
    {
      title: 'Components',
      reference_link: '/components',
      category_ids: [42],
      children: [
        {
          title: 'Desktop RAM',
          reference_link: '/components/desktop-ram',
          category_ids: [48],
          children: [],
        },
        {
          title: 'CPU Coolers',
          reference_link: '/components/cpu-coolers',
          children: [],
        },
      ],
    },
    {
      title: 'Peripherals',
      reference_link: '/peripherals',
      children: [
        {
          title: 'Keyboards',
          reference_link: '/peripherals/keyboards',
          category_ids: [10],
        },
      ],
    },
  ],
};

export class ReplaceVendorCategoryTreeNodeDto {
  @ApiProperty({
    example: 'Gaming Monitors',
    description: 'Vendor-specific category title.',
  })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({
    example: '/gaming-monitors',
    description: 'Vendor-specific category reference link or path.',
  })
  @IsString()
  @IsNotEmpty()
  reference_link: string;

  @ApiPropertyOptional({
    example: [9, 11, 14],
    description: 'Optional mapped category ids from your categories table.',
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
    description:
      'Optional nested vendor categories. Their order in the array becomes the saved sibling order.',
    type: () => ReplaceVendorCategoryTreeNodeDto,
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReplaceVendorCategoryTreeNodeDto)
  children?: ReplaceVendorCategoryTreeNodeDto[];
}

export class ReplaceVendorCategoriesTreeDto {
  @ApiProperty({
    description:
      'Full vendor category tree. This replaces the current tree for the vendor, and array order is used as sibling order.',
    type: () => ReplaceVendorCategoryTreeNodeDto,
    isArray: true,
    example: replaceVendorCategoriesTreeSwaggerExample.categories,
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReplaceVendorCategoryTreeNodeDto)
  categories: ReplaceVendorCategoryTreeNodeDto[];
}