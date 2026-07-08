import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class BulkUpdateProductPricingDto {
  @IsIn(['increase', 'decrease', 'reset'])
  action: 'increase' | 'decrease' | 'reset';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  percentage?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsNumber({}, { each: true })
  vendor_ids?: number[];
}