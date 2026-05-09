import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OriginalVendorCategoryInputDto } from './original-vendor-category.dto';

export class ImportProductPayloadDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'Raw source payload. If omitted, the endpoint treats the whole request body as the source payload.',
    example: {
      category_id: 35,
      vendor_id: 2,
      reference_link: 'https://example.com/products/sample-monitor',
      data: {
        title: '27 Inch Gaming Monitor 180Hz IPS',
        description:
          'Fast IPS panel with 180Hz refresh rate, 1ms response time, and Adaptive Sync support.',
        brand: 'ASUS',
        new_price: '199.99',
        old_price: '249.99',
        image: 'https://example.com/images/monitor-front.jpg',
        images: [
          'https://example.com/images/monitor-front.jpg',
          'https://example.com/images/monitor-side.jpg',
        ],
        specification: [
          {
            name: 'Panel Type',
            value: 'IPS',
          },
          {
            name: 'Refresh Rate',
            value: '180Hz',
          },
        ],
        attributes: [
          {
            name: 'Color',
            value: 'Black',
          },
        ],
      },
    },
  })
  payload?: Record<string, unknown>;

  @ApiPropertyOptional({
    example: 35,
    description:
      'Category override. If omitted, the endpoint will try payload.category_id or payload.category_ids[0].',
  })
  category_id?: number;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Vendor override. If omitted, the endpoint will try payload.vendor_id.',
  })
  vendor_id?: number;

  @ApiPropertyOptional({
    type: [OriginalVendorCategoryInputDto],
    example: [
      { id: 18, name: 'Gaming Monitors' },
      { id: 24, name: 'LED Displays' },
    ],
    description:
      'Optional ordered source vendor categories to persist on the imported product. Accepts the same value inside payload as original_vendor_categories or vendor_categories.',
  })
  original_vendor_categories?: OriginalVendorCategoryInputDto[];

  @ApiPropertyOptional({
    example: 18,
    description:
      'Optional primary source vendor category id to persist on the imported product. Accepts the same value inside payload as original_vendor_category_id or vendor_category_id.',
  })
  original_vendor_category_id?: number;

  @ApiPropertyOptional({
    example: 'Gaming Monitors',
    description:
      'Optional primary source vendor category name to persist on the imported product. Accepts the same value inside payload as original_vendor_category_name or vendor_category_name.',
  })
  original_vendor_category_name?: string;

  @ApiPropertyOptional({
    example: 'gpt-5.4',
    description:
      'Optional OpenAI model override. Falls back to PRODUCT_IMPORT_OPENAI_MODEL or gpt-5.4.',
  })
  model?: string;
}