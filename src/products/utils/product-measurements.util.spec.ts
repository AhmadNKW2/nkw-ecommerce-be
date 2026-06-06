import {
  ProductDimensionUnit,
  ProductWeightUnit,
} from '../entities/product.entity';
import { normalizeProductMeasurements } from './product-measurements.util';

describe('normalizeProductMeasurements', () => {
  it('keeps already-allowed units as-is', () => {
    expect(
      normalizeProductMeasurements({
        weight: 2.5,
        weight_unit: 'kg',
        length: 120,
        width: 80,
        height: 40,
        dimension_unit: 'cm',
      }),
    ).toEqual({
      weight: 2.5,
      weight_unit: ProductWeightUnit.KILOGRAM,
      length: 120,
      width: 80,
      height: 40,
      dimension_unit: ProductDimensionUnit.CENTIMETER,
    });
  });

  it('converts inch dimensions into centimeters', () => {
    expect(
      normalizeProductMeasurements({
        length: 10,
        width: '5 in',
        height: 2,
        dimension_unit: 'inches',
      }),
    ).toEqual({
      length: 25.4,
      width: 12.7,
      height: 5.08,
      dimension_unit: ProductDimensionUnit.CENTIMETER,
    });
  });

  it('converts pounds into kilograms', () => {
    expect(
      normalizeProductMeasurements({
        weight: 3,
        weight_unit: 'lb',
      }),
    ).toEqual({
      weight: 1.36,
      weight_unit: ProductWeightUnit.KILOGRAM,
    });
  });

  it('parses inline units and falls back to existing defaults when missing', () => {
    expect(
      normalizeProductMeasurements({
        weight: '750 g',
        length: '2.5',
      }),
    ).toEqual({
      weight: 750,
      weight_unit: ProductWeightUnit.GRAM,
      length: 2.5,
      dimension_unit: ProductDimensionUnit.CENTIMETER,
    });
  });
});