import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class GenerateCategoryTagsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  category_ids?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  max_tags_per_category?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(300)
  max_product_names_per_category?: number;

  @IsOptional()
  @IsString()
  model?: string;
}
