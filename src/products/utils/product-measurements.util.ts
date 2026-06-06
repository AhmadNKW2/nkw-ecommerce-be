import {
  ProductDimensionUnit,
  ProductWeightUnit,
} from '../entities/product.entity';

type SourceDimensionUnit = ProductDimensionUnit | 'in' | 'ft';
type SourceWeightUnit = ProductWeightUnit | 'lb' | 'oz';

type ProductMeasurementsInput = {
  weight?: unknown;
  weight_unit?: unknown;
  length?: unknown;
  width?: unknown;
  height?: unknown;
  dimension_unit?: unknown;
};

export type NormalizedProductMeasurements = {
  weight?: number;
  weight_unit?: ProductWeightUnit;
  length?: number;
  width?: number;
  height?: number;
  dimension_unit?: ProductDimensionUnit;
};

const DIMENSION_TO_MILLIMETERS: Record<SourceDimensionUnit, number> = {
  [ProductDimensionUnit.MILLIMETER]: 1,
  [ProductDimensionUnit.CENTIMETER]: 10,
  [ProductDimensionUnit.METER]: 1000,
  in: 25.4,
  ft: 304.8,
};

const WEIGHT_TO_GRAMS: Record<SourceWeightUnit, number> = {
  [ProductWeightUnit.GRAM]: 1,
  [ProductWeightUnit.KILOGRAM]: 1000,
  lb: 453.59237,
  oz: 28.349523125,
};

function normalizeUnitToken(value: string): string {
  return value.toLowerCase().trim().replace(/\.+$/g, '').replace(/\s+/g, '');
}

function extractInlineUnit(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmedValue = value.trim().toLowerCase();
  if (!trimmedValue) {
    return undefined;
  }

  if (trimmedValue.includes('"')) {
    return 'in';
  }

  if (trimmedValue.includes("'")) {
    return 'ft';
  }

  const matchedUnit = trimmedValue.match(/[a-zA-Z]+$/);
  return matchedUnit?.[0];
}

function toMeasurementNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    return undefined;
  }

  const normalizedValue = value.replace(/,/g, '').trim();
  if (!normalizedValue) {
    return undefined;
  }

  const matchedNumber = normalizedValue.match(/-?\d+(?:\.\d+)?/);
  if (!matchedNumber) {
    return undefined;
  }

  const parsedValue = Number(matchedNumber[0]);
  return Number.isFinite(parsedValue) ? parsedValue : undefined;
}

function roundMeasurement(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function normalizeDimensionSourceUnit(value: unknown): SourceDimensionUnit | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const normalizedValue = normalizeUnitToken(value);
  const aliases: Record<string, SourceDimensionUnit> = {
    mm: ProductDimensionUnit.MILLIMETER,
    millimeter: ProductDimensionUnit.MILLIMETER,
    millimeters: ProductDimensionUnit.MILLIMETER,
    millimetre: ProductDimensionUnit.MILLIMETER,
    millimetres: ProductDimensionUnit.MILLIMETER,
    cm: ProductDimensionUnit.CENTIMETER,
    centimeter: ProductDimensionUnit.CENTIMETER,
    centimeters: ProductDimensionUnit.CENTIMETER,
    centimetre: ProductDimensionUnit.CENTIMETER,
    centimetres: ProductDimensionUnit.CENTIMETER,
    m: ProductDimensionUnit.METER,
    meter: ProductDimensionUnit.METER,
    meters: ProductDimensionUnit.METER,
    metre: ProductDimensionUnit.METER,
    metres: ProductDimensionUnit.METER,
    in: 'in',
    inch: 'in',
    inches: 'in',
    ft: 'ft',
    foot: 'ft',
    feet: 'ft',
  };

  return aliases[normalizedValue];
}

function normalizeWeightSourceUnit(value: unknown): SourceWeightUnit | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const normalizedValue = normalizeUnitToken(value);
  const aliases: Record<string, SourceWeightUnit> = {
    g: ProductWeightUnit.GRAM,
    gram: ProductWeightUnit.GRAM,
    grams: ProductWeightUnit.GRAM,
    kg: ProductWeightUnit.KILOGRAM,
    kgs: ProductWeightUnit.KILOGRAM,
    kilogram: ProductWeightUnit.KILOGRAM,
    kilograms: ProductWeightUnit.KILOGRAM,
    lb: 'lb',
    lbs: 'lb',
    pound: 'lb',
    pounds: 'lb',
    oz: 'oz',
    ounce: 'oz',
    ounces: 'oz',
  };

  return aliases[normalizedValue];
}

function normalizeDimensionValue(
  value: unknown,
  sourceUnit: SourceDimensionUnit,
): number | undefined {
  const numericValue = toMeasurementNumber(value);
  if (numericValue === undefined) {
    return undefined;
  }

  const targetUnit =
    sourceUnit === 'in' || sourceUnit === 'ft'
      ? ProductDimensionUnit.CENTIMETER
      : sourceUnit;
  const valueInMillimeters = numericValue * DIMENSION_TO_MILLIMETERS[sourceUnit];

  return roundMeasurement(
    valueInMillimeters / DIMENSION_TO_MILLIMETERS[targetUnit],
  );
}

function normalizeWeightValue(
  value: unknown,
  sourceUnit: SourceWeightUnit,
): number | undefined {
  const numericValue = toMeasurementNumber(value);
  if (numericValue === undefined) {
    return undefined;
  }

  const targetUnit = sourceUnit === 'oz' ? ProductWeightUnit.GRAM : sourceUnit === 'lb' ? ProductWeightUnit.KILOGRAM : sourceUnit;
  const valueInGrams = numericValue * WEIGHT_TO_GRAMS[sourceUnit];

  return roundMeasurement(valueInGrams / WEIGHT_TO_GRAMS[targetUnit]);
}

export function normalizeProductMeasurements(
  input: ProductMeasurementsInput,
): NormalizedProductMeasurements {
  const dimensionSourceUnit =
    normalizeDimensionSourceUnit(input.dimension_unit) ??
    normalizeDimensionSourceUnit(extractInlineUnit(input.length) ?? '') ??
    normalizeDimensionSourceUnit(extractInlineUnit(input.width) ?? '') ??
    normalizeDimensionSourceUnit(extractInlineUnit(input.height) ?? '') ??
    ProductDimensionUnit.CENTIMETER;
  const weightSourceUnit =
    normalizeWeightSourceUnit(input.weight_unit) ??
    normalizeWeightSourceUnit(extractInlineUnit(input.weight) ?? '') ??
    ProductWeightUnit.KILOGRAM;

  const normalizedWeight = normalizeWeightValue(input.weight, weightSourceUnit);
  const normalizedLength = normalizeDimensionValue(input.length, dimensionSourceUnit);
  const normalizedWidth = normalizeDimensionValue(input.width, dimensionSourceUnit);
  const normalizedHeight = normalizeDimensionValue(input.height, dimensionSourceUnit);

  const normalizedMeasurements: NormalizedProductMeasurements = {};

  if (normalizedWeight !== undefined) {
    normalizedMeasurements.weight = normalizedWeight;
    normalizedMeasurements.weight_unit =
      weightSourceUnit === 'lb'
        ? ProductWeightUnit.KILOGRAM
        : weightSourceUnit === 'oz'
          ? ProductWeightUnit.GRAM
          : weightSourceUnit;
  }

  if (
    normalizedLength !== undefined ||
    normalizedWidth !== undefined ||
    normalizedHeight !== undefined
  ) {
    normalizedMeasurements.dimension_unit =
      dimensionSourceUnit === 'in' || dimensionSourceUnit === 'ft'
        ? ProductDimensionUnit.CENTIMETER
        : dimensionSourceUnit;

    if (normalizedLength !== undefined) {
      normalizedMeasurements.length = normalizedLength;
    }

    if (normalizedWidth !== undefined) {
      normalizedMeasurements.width = normalizedWidth;
    }

    if (normalizedHeight !== undefined) {
      normalizedMeasurements.height = normalizedHeight;
    }
  }

  return normalizedMeasurements;
}