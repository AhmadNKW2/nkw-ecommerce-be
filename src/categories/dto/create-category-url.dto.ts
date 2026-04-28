import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUrl, Min } from 'class-validator';

export class CreateCategoryUrlDto {
  @ApiProperty({
    example: 'https://vendor.example.com/monitors/gaming-monitors',
    description:
      'Vendor-specific URL for this category landing page. Multiple URLs are allowed for the same category and vendor.',
  })
  @IsUrl()
  url: string;

  @ApiProperty({
    example: 9,
    description: 'Category id that this external URL belongs to.',
  })
  @Type(() => Number)
  @IsInt()
  category_id: number;

  @ApiProperty({
    example: 2,
    description: 'Vendor id that owns this category URL.',
  })
  @Type(() => Number)
  @IsInt()
  vendor_id: number;

  @ApiPropertyOptional({
    example: 0,
    description:
      'Optional display order for this URL within the same category and vendor. If omitted, it is appended to the end.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort_order?: number;
}