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
        default: `'ordonsooq'`,
      },
      {
        name: 'site_name_ar',
        type: 'varchar',
        length: '120',
        default: `'ordonsooq'`,
      },
      {
        name: 'default_meta_title_en',
        type: 'varchar',
        length: '70',
        default: `'ordonsooq'`,
      },
      {
        name: 'default_meta_title_ar',
        type: 'varchar',
        length: '70',
        default: `'ordonsooq'`,
      },
      {
        name: 'default_meta_description_en',
        type: 'varchar',
        length: '160',
        default:
          `'Your premier destination for online shopping - Quality products, great prices, fast delivery'`,
      },
      {
        name: 'default_meta_description_ar',
        type: 'varchar',
        length: '160',
        default:
          `'وجهتك المميزة للتسوق الإلكتروني - منتجات عالية الجودة وأسعار رائعة وتوصيل سريع'`,
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