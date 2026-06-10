import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
} from 'class-validator';

function parseNumericArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map(Number);
  }

  if (typeof value === 'string') {
    return value.split(',').map(Number);
  }

  return [Number(value)];
}

export class SyncImportedPricingDto {
  @ApiProperty({
    example: [1410, 1589],
    description:
      'Imported product ids to dry-run or sync from product_input_jsons.input_json.',
  })
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @ArrayMinSize(1)
  @IsNumber({}, { each: true })
  product_ids!: number[];

  @ApiPropertyOptional({
    example: true,
    description:
      'When true, only compute and return the expected pricing changes without updating products.',
  })
  @IsOptional()
  @Transform(({ obj, key }) => {
    const value = obj[key];
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (value === 'false' || value === false || value === '0') return false;
    return [true, 'true', '1', 1].includes(value);
  })
  @IsBoolean()
  dry_run?: boolean = true;
}
