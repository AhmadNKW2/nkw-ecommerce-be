import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreateTermGroupDto {
  @IsString()
  @IsNotEmpty()
  concept_key: string;

  @IsOptional()
  @IsString()
  concept_label_en?: string;

  @IsOptional()
  @IsString()
  concept_label_ar?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  terms_en?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  terms_ar?: string[];

  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Type(() => Number)
  reference_product_ids?: number[];
}
