import { MigrationInterface, QueryRunner } from 'typeorm';
import { createSeoSettingsTableDefinition } from '../settings/seo-settings.table';

export class CreateSeoSettingsTable1712300000012 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(createSeoSettingsTableDefinition(), true);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('seo_settings');
  }
}