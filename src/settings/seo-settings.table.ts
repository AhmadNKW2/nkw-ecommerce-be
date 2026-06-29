import { Table } from 'typeorm';

export function createSeoSettingsTableDefinition() {
  return new Table({
    name: 'seo_settings',
    columns: [
      {
        name: 'id',
        type: 'serial',
        isPrimary: true,
      },
      {
        name: 'site_name_en',
        type: 'varchar',
        length: '120',
        default: `'Storefront'`,
      },
      {
        name: 'site_name_ar',
        type: 'varchar',
        length: '120',
        default: `'المتجر الإلكتروني'`,
      },
      {
        name: 'default_meta_title_en',
        type: 'varchar',
        length: '70',
        default: `'Storefront'`,
      },
      {
        name: 'default_meta_title_ar',
        type: 'varchar',
        length: '70',
        default: `'المتجر الإلكتروني'`,
      },
      {
        name: 'default_meta_description_en',
        type: 'varchar',
        length: '160',
        default:
          `'A modern online shopping destination with quality products, fair prices, and reliable delivery.'`,
      },
      {
        name: 'default_meta_description_ar',
        type: 'varchar',
        length: '160',
        default:
          `'وجهة تسوق إلكترونية حديثة بمنتجات مميزة وأسعار مناسبة وتوصيل موثوق.'`,
      },
      {
        name: 'default_og_image',
        type: 'varchar',
        length: '2048',
        isNullable: true,
      },
      {
        name: 'twitter_handle',
        type: 'varchar',
        length: '255',
        isNullable: true,
      },
      {
        name: 'google_verification',
        type: 'varchar',
        length: '255',
        isNullable: true,
      },
      {
        name: 'robots_index',
        type: 'boolean',
        default: true,
      },
      {
        name: 'robots_follow',
        type: 'boolean',
        default: true,
      },
      {
        name: 'show_sale_pricing',
        type: 'boolean',
        default: true,
      },
      {
        name: 'free_delivery_amount',
        type: 'decimal',
        precision: 10,
        scale: 2,
        default: '50.00',
      },
      {
        name: 'free_delivery_enabled',
        type: 'boolean',
        default: true,
      },
      {
        name: 'delivery_fee',
        type: 'decimal',
        precision: 10,
        scale: 2,
        default: '2.00',
      },
      {
        name: 'low_stock_threshold',
        type: 'int',
        default: 10,
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