import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNumber,
  IsOptional,
  IsBoolean,
  IsArray,
  ArrayUnique,
  ValidateNested,
  MaxLength,
  Min,
  IsEnum,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ProductStatus } from '../entities/product.entity';
import { PreserveRawNumberInput } from '../../common/decorators/preserve-raw-number-input.decorator';
import { ProductSpecificationInputDto } from './product-specification.dto';
import { OriginalVendorCategoryInputDto } from './original-vendor-category.dto';

import { ProductAttributeInputDto } from './product-attribute.dto';

// ==================== MEDIA ====================

export class MediaItemDto {
  @ApiProperty({ example: 105, description: 'ID of the uploaded media item' })
  @IsNumber()
  media_id: number;

  @ApiPropertyOptional({ example: true, description: 'Is this the primary image?' })
  @IsBoolean()
  @IsOptional()
  is_primary?: boolean;

  @ApiPropertyOptional({ example: 1, description: 'Sort order for the images' })
  @IsNumber()
  @IsOptional()
  sort_order?: number;
}

// ==================== MAIN UPDATE DTO ====================

/**
 * Full update DTO for products (PUT request)
 *
 * The payload represents the COMPLETE state of the product.
 * All basic product information is required.
 *
 * Uses the same flat field model as CreateProductDto.
 * - Scalar fields overwrite the existing product values
 * - Attributes, specifications, media, tags, and linked products are synced from the payload
 */
export class UpdateProductDto {
  // ============== Basic Product Info (Required) ==============

  @ApiProperty({ example: 'Wireless Headphones Re-Issue', description: 'Product name in English' })
  @IsString()
  @MaxLength(300)
  name_en: string;

  @ApiProperty({ example: 'سماعات البلوتوث المحدثة', description: 'Product name in Arabic' })
  @IsString()
  @MaxLength(300)
  name_ar: string;

  @ApiPropertyOptional({ example: 'WH-PRO-002', description: 'Stock Keeping Unit identifier' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  sku?: string;

  @ApiPropertyOptional({ example: 'Some extra record or string data', description: 'Any extra string record you want to store' })
  @IsString()
  @IsOptional()
  record?: string;

  @ApiProperty({ example: 'Updated short description in English', description: 'Short description in English' })
  @IsString()
  short_description_en: string;

  @ApiProperty({ example: 'وصف قصير محدث', description: 'Short description in Arabic' })
  @IsString()
  short_description_ar: string;

  @ApiProperty({ example: '<p>Updated full description...</p>', description: 'Full description in English (HTML allowed)' })
  @IsString()
  long_description_en: string;

  @ApiProperty({ example: '<p>وصف طويل محدث...</p>', description: 'Full description in Arabic (HTML allowed)' })
  @IsString()
  long_description_ar: string;

  @ApiPropertyOptional({ example: 'https://example.com/product/123' })
  @IsString()
  @IsOptional()
  reference_link?: string;

  @ApiProperty({ example: [5, 12, 14], description: 'Updated array of category IDs' })
  @IsArray()
  @IsNumber({}, { each: true })
  category_ids: number[];

  @ApiPropertyOptional({ example: 4, description: 'Vendor ID creating the product' })
  @IsNumber()
  @IsOptional()
  vendor_id?: number;

  @ApiPropertyOptional({
    example: [18, 24],
    description:
      'Ordered source vendor category IDs captured during import or manual sync',
  })
  @IsArray()
  @ArrayUnique()
  @IsNumber({}, { each: true })
  @IsOptional()
  original_vendor_categories_ids?: number[];

  @ApiPropertyOptional({
    type: [OriginalVendorCategoryInputDto],
    example: [
      { id: 18, name: 'Gaming Monitors' },
      { id: 24, name: 'LED Displays' },
    ],
    description: 'Ordered source vendor categories captured during import',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OriginalVendorCategoryInputDto)
  @IsOptional()
  original_vendor_categories?: OriginalVendorCategoryInputDto[];

  @ApiPropertyOptional({
    example: 18,
    description: 'Primary source vendor category ID captured during import',
  })
  @IsNumber()
  @IsOptional()
  original_vendor_category_id?: number | null;

  @ApiPropertyOptional({
    example: 'Gaming Monitors',
    description: 'Primary source vendor category name captured during import',
  })
  @IsString()
  @MaxLength(255)
  @IsOptional()
  original_vendor_category_name?: string | null;

  @ApiPropertyOptional({ example: 8, description: 'Brand ID of the product' })
  @IsNumber()
  @IsOptional()
  brand_id?: number;

  @ApiPropertyOptional({ enum: ProductStatus, example: ProductStatus.ACTIVE })
  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @ApiPropertyOptional({ example: true, description: 'Whether the product is visible in the store' })
  @IsBoolean()
  @IsOptional()
  visible?: boolean;

  // ============== Pricing ==============

  @ApiPropertyOptional({ example: 45.00, description: 'The cost price of the product' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  cost?: number;

  @ApiPropertyOptional({ example: 89.99, description: 'The regular selling price' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ example: 69.99, description: 'The discounted sale price (if applicable)' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  sale_price?: number;

  @ApiPropertyOptional({ example: 100, description: 'The original price from the vendor source before platform adjustments.' })
  @IsNumber()
  @IsOptional()
  original_vendor_price?: number;

  @ApiPropertyOptional({ example: 89.9, description: 'The original sale price from the vendor source before platform adjustments.' })
  @IsNumber()
  @IsOptional()
  original_vendor_sale_price?: number;

  // ============== Weight & Dimensions ==============

  @ApiPropertyOptional({ example: 1.4, description: 'Weight in kg' })
  @IsNumber()
  @IsOptional()
  weight?: number;

  @ApiPropertyOptional({ example: 19, description: 'Length in cm' })
  @IsNumber()
  @IsOptional()
  length?: number;

  @ApiPropertyOptional({ example: 14, description: 'Width in cm' })
  @IsNumber()
  @IsOptional()
  width?: number;

  @ApiPropertyOptional({ example: 4, description: 'Height in cm' })
  @IsNumber()
  @IsOptional()
  height?: number;

  // ============== Stock ==============

  @ApiPropertyOptional({ example: 350, description: 'Current available stock quantity' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiPropertyOptional({ example: 15, description: 'Threshold to trigger low stock warnings' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  low_stock_threshold?: number;

  @ApiPropertyOptional({ example: false, description: 'Manual override to mark product as out of stock' })
  @IsBoolean()
  @IsOptional()
  is_out_of_stock?: boolean;

  // ============== Media ==============

  @ApiPropertyOptional({
    type: [MediaItemDto],
    example: [
      { media_id: 105, is_primary: true, sort_order: 1 },
      { media_id: 106, is_primary: false, sort_order: 2 }
    ],
    description: 'Array of media items (images) linked to this product'
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaItemDto)
  @IsOptional()
  media?: MediaItemDto[];

  // ============== Attributes Management ==============

  @ApiPropertyOptional({
    type: [ProductAttributeInputDto],
    example: [{ attribute_id: 21, attribute_value_ids: [81] }, { attribute_id: 22, attribute_value_ids: [90] }],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeInputDto)
  @IsOptional()
  attributes?: ProductAttributeInputDto[];

  // ============== Specifications Management ====================

  @ApiPropertyOptional({
    type: [ProductSpecificationInputDto],
    example: [
      { specification_id: 1, specification_value_ids: [60] },
      { specification_id: 4, specification_value_ids: [7, 8, 39] },
    ],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSpecificationInputDto)
  @IsOptional()
  specifications?: ProductSpecificationInputDto[];

  // ============== Linked Products ==============

  @ApiPropertyOptional({
    type: [Number],
    example: [12, 18, 27],
    description:
      'Existing product IDs to keep linked with this product. Use an empty array to clear links.',
  })
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  @IsOptional()
  linked_product_ids?: number[];

  // ============== Tags ==============

  @ApiPropertyOptional({ example: ['electronics', 'headphones', 'wireless', 'accessories'], description: 'Array of tag names' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];

  // ============== SEO ==============

  @ApiPropertyOptional({ example: 'Wireless Headphones | Ordonsooq', description: 'Meta title EN — max 70 chars. Leave empty for AI generation later.' })
  @IsString()
  @MaxLength(70)
  @IsOptional()
  meta_title_en?: string;

  @ApiPropertyOptional({ example: 'سماعات لاسلكية | أوردون سوق', description: 'Meta title AR — max 70 chars. Leave empty for AI generation later.' })
  @IsString()
  @MaxLength(70)
  @IsOptional()
  meta_title_ar?: string;

  @ApiPropertyOptional({ example: 'Buy the best wireless headphones with ANC technology.', description: 'Meta description EN — max 160 chars. Leave empty for AI generation later.' })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  meta_description_en?: string;

  @ApiPropertyOptional({ example: 'اشترِ أفضل السماعات اللاسلكية بتقنية إلغاء الضوضاء.', description: 'Meta description AR — max 160 chars. Leave empty for AI generation later.' })
  @IsString()
  @MaxLength(160)
  @IsOptional()
  meta_description_ar?: string;
}
