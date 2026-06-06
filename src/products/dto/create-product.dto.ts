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
import {
  ProductDimensionUnit,
  ProductStatus,
  ProductWeightUnit,
} from '../entities/product.entity';
import { PreserveRawNumberInput } from '../../common/decorators/preserve-raw-number-input.decorator';
import { ProductSpecificationInputDto } from './product-specification.dto';
import { OriginalVendorCategoryInputDto } from './original-vendor-category.dto';

import { ProductAttributeInputDto } from './product-attribute.dto';

/**
 * Media item DTO for linking pre-uploaded media to products
 */
class MediaInput {
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

/**
 * Main DTO for product creation
 *
 * Current payload model is flat:
 * - Pricing uses cost, price, and sale_price
 * - Dimensions use weight, length, width, and height
 * - Stock uses quantity, low_stock_threshold, and is_out_of_stock
 * - Media uses pre-uploaded media IDs
 * - Attributes and specifications accept selected IDs only
 */
export class CreateProductDto {
  // Basic product info
  @ApiProperty({ example: 'Wireless Headphones', description: 'Product name in English' })
  @IsString()
  @MaxLength(300)
  name_en: string;

  @ApiPropertyOptional({ example: 'wireless-headphones-pro', description: 'URL slug (auto-generated if empty)' })
  @IsString()
  @MaxLength(300)
  @IsOptional()
  slug?: string;

  @ApiProperty({ example: 'سماعات لاسلكية', description: 'Product name in Arabic' })
  @IsString()
  @MaxLength(300)
  name_ar: string;

  @ApiPropertyOptional({ example: 'WH-PRO-001', description: 'Stock Keeping Unit identifier' })
  @IsString()
  @MaxLength(100)
  @IsOptional()
  sku?: string;

  @ApiPropertyOptional({ example: 'Some extra record or string data', description: 'Any extra string record you want to store' })
  @IsString()
  @IsOptional()
  record?: string;

  @ApiProperty({ example: 'High quality wireless headphones with ANC.', description: 'Short description in English' })
  @IsString()
  short_description_en: string;

  @ApiProperty({ example: 'سماعات لاسلكية عالية الجودة مع خاصية إلغاء الضوضاء.', description: 'Short description in Arabic' })
  @IsString()
  short_description_ar: string;

  @ApiProperty({ example: '<p>Experience immersive audio...</p>', description: 'Full description in English (HTML allowed)' })
  @IsString()
  long_description_en: string;

  @ApiProperty({ example: '<p>استمتع بتجربة صوتية غامرة...</p>', description: 'Full description in Arabic (HTML allowed)' })
  @IsString()
  long_description_ar: string;

  @ApiPropertyOptional({ example: 'https://example.com/product/123' })
  @IsString()
  @IsOptional()
  reference_link?: string;

  @ApiProperty({ example: [5, 12], description: 'Array of category IDs this product belongs to' })
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

  @ApiPropertyOptional({ example: 50.00, description: 'The cost price of the product' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  cost?: number;

  @ApiPropertyOptional({ example: 99.99, description: 'The regular selling price' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  price?: number;

  @ApiPropertyOptional({ example: 79.99, description: 'The discounted sale price (if applicable)' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  sale_price?: number;

  @ApiPropertyOptional({ example: 100, description: 'The original price from the vendor source before platform adjustments.' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  original_vendor_price?: number;

  @ApiPropertyOptional({ example: 89.9, description: 'The original sale price from the vendor source before platform adjustments.' })
  @PreserveRawNumberInput()
  @IsNumber()
  @IsOptional()
  original_vendor_sale_price?: number;

  // ============== Weight & Dimensions ==============

  @ApiPropertyOptional({ example: 1.5, description: 'Weight value using g or kg' })
  @IsNumber()
  @IsOptional()
  weight?: number;

  @ApiPropertyOptional({ enum: ProductWeightUnit, example: ProductWeightUnit.KILOGRAM })
  @IsEnum(ProductWeightUnit)
  @IsOptional()
  weight_unit?: ProductWeightUnit;

  @ApiPropertyOptional({ example: 20, description: 'Length value using mm, cm, or m' })
  @IsNumber()
  @IsOptional()
  length?: number;

  @ApiPropertyOptional({ example: 15, description: 'Width value using mm, cm, or m' })
  @IsNumber()
  @IsOptional()
  width?: number;

  @ApiPropertyOptional({ example: 5, description: 'Height value using mm, cm, or m' })
  @IsNumber()
  @IsOptional()
  height?: number;

  @ApiPropertyOptional({ enum: ProductDimensionUnit, example: ProductDimensionUnit.CENTIMETER })
  @IsEnum(ProductDimensionUnit)
  @IsOptional()
  dimension_unit?: ProductDimensionUnit;

  // ============== Stock ==============

  @ApiPropertyOptional({ example: 150, description: 'Current available stock quantity' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  quantity?: number;

  @ApiPropertyOptional({ example: 10, description: 'Threshold to trigger low stock warnings' })
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
    type: [MediaInput],
    example: [
      { media_id: 105, is_primary: true, sort_order: 1 },
      { media_id: 106, is_primary: false, sort_order: 2 }
    ],
    description: 'Array of media items (images) linked to this product'
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MediaInput)
  @IsOptional()
  media?: MediaInput[];

  // ============== Attributes ==============

  @ApiPropertyOptional({
    type: [ProductAttributeInputDto],
    example: [{ attribute_id: 21, attribute_value_ids: [81] }, { attribute_id: 22, attribute_value_ids: [90] }],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductAttributeInputDto)
  @IsOptional()
  attributes?: ProductAttributeInputDto[];

  // ============== Specifications ==============

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
      'Existing product IDs to link with the new product in a shared group.',
  })
  @IsArray()
  @ArrayUnique()
  @Type(() => Number)
  @IsNumber({}, { each: true })
  @IsOptional()
  linked_product_ids?: number[];

  // ============== Tags ==============

  @ApiPropertyOptional({ example: ['electronics', 'headphones', 'wireless'], description: 'Array of tag names' })
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
