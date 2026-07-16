import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
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

const REQUEST_TYPES: CatalogRequestType[] = ['brand', 'category', 'specs'];
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
 *
 * For matched brand/category requests, omit existing_entity_id to keep the
 * AI match, or pass a different id / force create with names only.
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

  @ApiPropertyOptional({
    description:
      'Confirm an existing brand/category id (match approval). Omit to create new.',
  })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  existing_entity_id?: number | null;

  @ApiPropertyOptional({
    description:
      'When true, create a new brand/category even if a match id is present.',
  })
  @IsOptional()
  create_new?: boolean;

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
