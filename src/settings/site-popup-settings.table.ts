import { Table } from 'typeorm';

export function createSitePopupSettingsTableDefinition() {
  return new Table({
    name: 'site_popup_settings',
    columns: [
      {
        name: 'id',
        type: 'serial',
        isPrimary: true,
      },
      {
        name: 'enabled',
        type: 'boolean',
        default: false,
      },
      {
        name: 'image_url',
        type: 'varchar',
        length: '2048',
        isNullable: true,
      },
      {
        name: 'link_url',
        type: 'varchar',
        length: '2048',
        isNullable: true,
      },
      {
        name: 'dismiss_after_seconds',
        type: 'int',
        default: 8,
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
