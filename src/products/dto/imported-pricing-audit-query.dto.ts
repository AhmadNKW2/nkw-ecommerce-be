import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsNumber, IsOptional, Min } from 'class-validator';

function parseNumericArray(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map(Number);
  }

  if (typeof value === 'string') {
    return value.split(',').map(Number);
  }

  return [Number(value)];
}

export class ImportedPricingAuditQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 50;

  @ApiPropertyOptional({
    example: true,
    description: 'Return only products whose stored pricing differs from the input_json-derived pricing.',
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
  mismatch_only?: boolean = true;

  @ApiPropertyOptional({
    example: '1410,1747',
    description: 'Optional comma-separated product ids to audit.',
  })
  @IsOptional()
  @Transform(({ value }) => parseNumericArray(value))
  @IsArray()
  @IsNumber({}, { each: true })
  product_ids?: number[];
}
