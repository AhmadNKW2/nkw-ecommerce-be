import { Table } from 'typeorm';

export function createProductAttachmentsTableDefinition() {
  return new Table({
    name: 'product_attachments',
    columns: [
      {
        name: 'id',
        type: 'serial',
        isPrimary: true,
      },
      {
        name: 'product_id',
        type: 'int',
        isNullable: false,
      },
      {
        name: 'media_id',
        type: 'int',
        isNullable: false,
      },
      {
        name: 'sort_order',
        type: 'int',
        default: 0,
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
    foreignKeys: [
      {
        columnNames: ['product_id'],
        referencedTableName: 'products',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
      {
        columnNames: ['media_id'],
        referencedTableName: 'media',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      },
    ],
    uniques: [
      {
        name: 'uq_product_attachments_product_media',
        columnNames: ['product_id', 'media_id'],
      },
    ],
    indices: [
      {
        name: 'idx_product_attachments_product_id',
        columnNames: ['product_id'],
      },
      {
        name: 'idx_product_attachments_media_id',
        columnNames: ['media_id'],
      },
      {
        name: 'idx_product_attachments_product_sort',
        columnNames: ['product_id', 'sort_order'],
      },
    ],
  });
}
