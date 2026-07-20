import { ApiPropertyOptional } from '@nestjs/swagger';
import { plainToInstance, Transform } from 'class-transformer';
import { IsArray, IsInt, IsOptional } from 'class-validator';

function dedupePositiveIntegers(values: unknown[]): number[] {
  return [
    ...new Set(
      values
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

function normalizeProductIdList(value: unknown): number[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === '' || value === null) {
    return [];
  }

  if (typeof value === 'string') {
    try {
      return normalizeProductIdList(JSON.parse(value));
    } catch {
      return dedupePositiveIntegers(value.split(','));
    }
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return dedupePositiveIntegers(value);
}

export class ProductChangesDto {
  @ApiPropertyOptional({
    type: [Number],
    example: [101, 102, 103],
    description: 'Product IDs to add or link to this resource.',
  })
  @IsOptional()
  @Transform(({ value }) => normalizeProductIdList(value))
  @IsArray()
  @IsInt({ each: true })
  add_product_ids?: number[];

  @ApiPropertyOptional({
    type: [Number],
    example: [201, 202, 203],
    description: 'Product IDs to remove or unlink from this resource.',
  })
  @IsOptional()
  @Transform(({ value }) => normalizeProductIdList(value))
  @IsArray()
  @IsInt({ each: true })
  remove_product_ids?: number[];
}

/**
 * Parse multipart/JSON product_changes into a DTO instance.
 * Returning a class instance is required so ValidationPipe whitelist /
 * forbidNonWhitelisted accepts nested add_product_ids / remove_product_ids.
 */
export function parseProductChangesInput(
  value: unknown,
): ProductChangesDto | undefined {
  if (value === undefined || value === '' || value === null) {
    return undefined;
  }

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return value as ProductChangesDto;
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed as ProductChangesDto;
  }

  return plainToInstance(ProductChangesDto, parsed);
}

export function getNormalizedProductChanges(productChanges?: ProductChangesDto): {
  addProductIds: number[];
  removeProductIds: number[];
  conflictingProductIds: number[];
} {
  const addProductIds = productChanges?.add_product_ids ?? [];
  const removeProductIds = productChanges?.remove_product_ids ?? [];
  const removeProductIdSet = new Set(removeProductIds);
  const conflictingProductIds = [
    ...new Set(
      addProductIds.filter((productId) => removeProductIdSet.has(productId)),
    ),
  ];

  return {
    addProductIds,
    removeProductIds,
    conflictingProductIds,
  };
}