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
        name: 'vendor_id',
        type: 'int',
        isNullable: true,
      },
      {
        name: 'brand_id',
        type: 'int',
        isNullable: true,
      },
      {
        name: 'category_ids',
        type: 'jsonb',
        isNullable: true,
      },
      {
        name: 'price_condition',
        type: 'varchar',
        length: '20',
        default: `'between'`,
      },
      {
        name: 'adjustment_type',
        type: 'varchar',
        length: '20',
        default: `'decrease'`,
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
      {
        name: 'idx_product_price_rules_vendor_id',
        columnNames: ['vendor_id'],
      },
      {
        name: 'idx_product_price_rules_brand_id',
        columnNames: ['brand_id'],
      },
    ],
  });
}
