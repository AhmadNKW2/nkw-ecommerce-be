import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

class SubmissionMediaInput {
  @ApiProperty({ example: 105, description: 'ID of a pre-uploaded media item' })
  @IsInt()
  media_id: number;

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  is_primary?: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsInt()
  @IsOptional()
  sort_order?: number;
}

/**
 * Minimal vendor product submission. The vendor provides a single-language
 * title/description; the AI produces bilingual name/description, brand match,
 * category match, and spec/attribute mapping.
 */
export class CreateVendorSubmissionDto {
  @ApiProperty({ example: 'Anker 20000mAh power bank 65W' })
  @IsString()
  @MaxLength(500)
  title: string;

  @ApiProperty({ example: 'Fast charging power bank with USB-C PD, LED display.' })
  @IsString()
  description: string;

  @ApiProperty({ example: 49.9, description: 'Vendor selling price' })
  @IsNumber()
  @Min(0)
  price: number;

  @ApiProperty({ example: 39.9, description: 'Vendor discounted sale price' })
  @IsNumber()
  @Min(0)
  sale_price: number;

  @ApiProperty({ example: 25, description: 'Available stock quantity' })
  @IsInt()
  @Min(0)
  stock: number;

  @ApiPropertyOptional({
    type: [SubmissionMediaInput],
    example: [{ media_id: 105, is_primary: true, sort_order: 1 }],
  })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SubmissionMediaInput)
  @IsOptional()
  media?: SubmissionMediaInput[];
}
