import {
  IsBoolean,
  IsEnum,
  IsOptional,
  ValidateBy,
  ValidationOptions,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SeoEntityType } from './list-missing-seo.dto';

function parseGenerateIds(value: unknown): number[] | 'all_missing' {
  if (value === 'all_missing') {
    return 'all_missing';
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === 'all_missing') {
      return 'all_missing';
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .map((entry) => Number(entry))
          .filter((entry) => Number.isInteger(entry) && entry > 0);
      }
    } catch {
      // fall through
    }
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isInteger(entry) && entry > 0);
  }

  return [];
}

function isGenerateSeoIdsValue(value: unknown): value is number[] | 'all_missing' {
  if (value === 'all_missing') {
    return true;
  }

  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => Number.isInteger(entry) && entry > 0)
  );
}

function IsGenerateSeoIds(validationOptions?: ValidationOptions) {
  return ValidateBy(
    {
      name: 'isGenerateSeoIds',
      validator: {
        validate: (value: unknown) => isGenerateSeoIdsValue(value),
        defaultMessage: () =>
          'ids must be a non-empty array of positive integers or "all_missing"',
      },
    },
    validationOptions,
  );
}

export class GenerateSeoDto {
  @ApiProperty({ enum: SeoEntityType })
  @IsEnum(SeoEntityType)
  type: SeoEntityType;

  @ApiProperty({
    description: 'Entity IDs to generate, or the string "all_missing".',
  })
  @Transform(({ value }) => parseGenerateIds(value))
  @IsGenerateSeoIds()
  ids: number[] | 'all_missing';

  @ApiPropertyOptional({
    description:
      'When true, OpenAI may use web search. Off by default (cheaper catalog-only).',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  search_internet?: boolean = false;

  @ApiPropertyOptional({
    description: 'When true, regenerate meta even if fields already exist.',
    default: false,
  })
  @IsBoolean()
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  overwrite?: boolean = false;
}
