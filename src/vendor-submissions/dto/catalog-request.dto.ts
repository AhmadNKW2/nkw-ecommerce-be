import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type {
  CatalogRequestStatus,
  CatalogRequestType,
} from '../entities/catalog-request.entity';

const REQUEST_TYPES: CatalogRequestType[] = ['brand', 'category'];
const REQUEST_STATUSES: CatalogRequestStatus[] = [
  'pending',
  'approved',
  'rejected',
];

export class ListCatalogRequestsDto {
  @ApiPropertyOptional({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ enum: REQUEST_TYPES })
  @IsIn(REQUEST_TYPES)
  @IsOptional()
  type?: CatalogRequestType;

  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsIn(REQUEST_STATUSES)
  @IsOptional()
  status?: CatalogRequestStatus;
}

/**
 * Admin approval payload. All fields optional so the admin can accept the AI
 * suggestion as-is or edit brand/category names and category placement.
 */
export class ApproveCatalogRequestDto {
  @ApiPropertyOptional({ description: 'Override brand/category English name' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name_en?: string;

  @ApiPropertyOptional({ description: 'Override brand/category Arabic name' })
  @IsString()
  @MaxLength(120)
  @IsOptional()
  name_ar?: string;

  @ApiPropertyOptional({
    description: 'Category only: parent category id (null/omit for a root category)',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  parent_id?: number | null;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  admin_notes?: string;
}

export class RejectCatalogRequestDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  admin_notes?: string;
}
