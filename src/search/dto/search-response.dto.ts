import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchHitDto {
  @ApiProperty({ example: '101' })
  id: string;

  @ApiPropertyOptional({ example: 'organic-dates-101' })
  slug?: string;

  @ApiPropertyOptional({ example: 'OD-101' })
  sku?: string;

  @ApiProperty({ example: 'Organic Dates' })
  name_en: string;

  @ApiProperty({ example: 'Organic Dates' })
  name_ar: string;

  @ApiPropertyOptional({ example: 'Premium organic dates from Al Qassim.' })
  description_en?: string;

  @ApiPropertyOptional({ example: 'Premium organic dates from Al Qassim.' })
  description_ar?: string;

  @ApiProperty({ example: 'Storefront Farms' })
  brand: string;

  @ApiPropertyOptional({ example: 12 })
  brand_id?: number;

  @ApiProperty({ example: 'Dates' })
  category: string;

  @ApiPropertyOptional({ example: 'Premium Dates' })
  subcategory?: string;

  @ApiPropertyOptional({ type: [Number], example: [4, 7] })
  category_ids?: number[];

  @ApiPropertyOptional({ type: [String], example: ['Dates', 'Seasonal'] })
  category_names_en?: string[];

  @ApiPropertyOptional({ type: [String], example: ['Dates', 'Seasonal'] })
  category_names_ar?: string[];

  @ApiPropertyOptional({ type: [String], example: ['organic', 'premium'] })
  tags?: string[];

  @ApiProperty({ example: 45.5 })
  price: number;

  @ApiPropertyOptional({ example: 39.99 })
  sale_price?: number;

  @ApiProperty({ example: 39.99 })
  price_min: number;

  @ApiProperty({ example: 49.99 })
  price_max: number;

  @ApiPropertyOptional({ example: 4.7 })
  rating?: number;

  @ApiPropertyOptional({ example: 128 })
  rating_count?: number;

  @ApiProperty({ example: 24 })
  stock_quantity: number;

  @ApiProperty({ example: true })
  in_stock: boolean;

  @ApiProperty({ example: true })
  is_available: boolean;

  @ApiPropertyOptional({ type: [String], example: ['size:large', 'color:brown'] })
  attr_pairs?: string[];

  @ApiPropertyOptional({
    type: [String],
    example: ['https://cdn.example.com/products/101-primary.jpg'],
  })
  images?: string[];

  @ApiProperty({ example: 1711887000 })
  created_at: number;

  @ApiProperty({ example: 987.4 })
  popularity_score: number;

  @ApiPropertyOptional({ example: 9 })
  vendor_id?: number;

  @ApiPropertyOptional({ example: 'seller-123' })
  seller_id?: string;

  @ApiPropertyOptional({ example: 230 })
  sales_count?: number;
}

export class FacetCountItemDto {
  @ApiProperty({ example: 'Dates' })
  value: string;

  @ApiProperty({ example: 14 })
  count: number;
}

export class FacetCountDto {
  @ApiProperty({ example: 'category' })
  field_name: string;

  @ApiProperty({ type: () => [FacetCountItemDto] })
  counts: FacetCountItemDto[];
}

export class SearchResponseDto {
  @ApiProperty({ type: () => [SearchHitDto] })
  hits: SearchHitDto[];

  @ApiProperty({ example: 42 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  per_page: number;

  @ApiProperty({ example: 3 })
  total_pages: number;

  @ApiPropertyOptional({ type: () => [FacetCountDto] })
  facets?: FacetCountDto[];

  @ApiPropertyOptional({ example: 14 })
  search_time_ms?: number;
}

export class AutocompleteSuggestionDto {
  @ApiProperty({ example: '101' })
  id: string;

  @ApiPropertyOptional({ example: 'organic-dates-101' })
  slug?: string;

  @ApiProperty({ example: 'Organic Dates' })
  name_en: string;

  @ApiProperty({ example: 'Organic Dates' })
  name_ar: string;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/products/101-primary.jpg',
  })
  image?: string;

  @ApiPropertyOptional({ example: 39.99 })
  price_min?: number;
}

export class AutocompleteResponseDto {
  @ApiProperty({ type: () => [AutocompleteSuggestionDto] })
  suggestions: AutocompleteSuggestionDto[];
}
