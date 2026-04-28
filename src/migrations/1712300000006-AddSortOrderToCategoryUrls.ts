import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSortOrderToCategoryUrls1712300000006
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "category_urls"
      ADD COLUMN IF NOT EXISTS "sort_order" integer NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_category_urls_sort_order"
      ON "category_urls" ("sort_order")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_category_urls_sort_order"
    `);

    await queryRunner.query(`
      ALTER TABLE "category_urls"
      DROP COLUMN IF EXISTS "sort_order"
    `);
  }
}