import { Table } from 'typeorm';

export function createProductPriceRulesTableDefinition() {
  return new Table({
    name: 'product_price_rules',
    columns: [
      {
        name: 'id',
        type: 'serial',
        isPrimary: true,
      },
      {
        name: 'min_vendor_price',
        type: 'decimal',
        precision: 10,
        scale: 2,
      },
      {
        name: 'max_vendor_price',
        type: 'decimal',
        precision: 10,
        scale: 2,
        isNullable: true,
      },
      {
        name: 'percentage',
        type: 'decimal',
        precision: 5,
        scale: 2,
      },
      {
        name: 'is_active',
        type: 'boolean',
        default: true,
      },
      {
        name: 'created_at',
        type: 'timestamp',
        default: 'now()',
      },
      {
        name: 'updated_at',
        type: 'timestamp',
        default: 'now()',
      },
    ],
    indices: [
      {
        name: 'idx_product_price_rules_is_active',
        columnNames: ['is_active'],
      },
      {
        name: 'idx_product_price_rules_min_vendor_price',
        columnNames: ['min_vendor_price'],
      },
    ],
  });
}