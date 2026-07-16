import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';
import type { VendorProductSubmissionStatus } from '../entities/vendor-product-submission.entity';

const SUBMISSION_STATUSES: VendorProductSubmissionStatus[] = [
  'pending_ai',
  'ai_processing',
  'awaiting_brand',
  'awaiting_category',
  'awaiting_category_specs',
  'awaiting_specs_approval',
  'ready',
  'materialized',
  'rejected',
  'failed',
];

export class ListVendorSubmissionsDto {
  @ApiPropertyOptional({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ enum: SUBMISSION_STATUSES })
  @IsIn(SUBMISSION_STATUSES)
  @IsOptional()
  status?: VendorProductSubmissionStatus;

  @ApiPropertyOptional({ example: 4, description: 'Admin-only vendor filter' })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  vendor_id?: number;
}
