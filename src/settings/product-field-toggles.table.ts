import { Table } from 'typeorm';

export function createProductFieldTogglesTableDefinition() {
  return new Table({
    name: 'product_field_toggles',
    columns: [
      {
        name: 'id',
        type: 'serial',
        isPrimary: true,
      },
      {
        name: 'vendors_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'attributes_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'specifications_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'weight_and_dimensions_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'partners_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'cashback_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'banners_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'import_ai_products_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'linked_products_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'reference_link_visible_admin',
        type: 'boolean',
        default: true,
      },
      {
        name: 'meta_title_visible_admin',
        type: 'boolean',
        default: true,
      },
      {
        name: 'meta_description_visible_admin',
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
  });
}
