import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOriginalVendorCategoryToProducts1712300000010
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
      ADD COLUMN IF NOT EXISTS "original_vendor_category_id" integer
    `);

    await queryRunner.query(`
      ALTER TABLE "products"
      ADD COLUMN IF NOT EXISTS "original_vendor_category_name" character varying(255)
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_products_original_vendor_category_id"
      ON "products" ("original_vendor_category_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS "idx_products_original_vendor_category_id"
    `);

    await queryRunner.query(`
      ALTER TABLE "products"
      DROP COLUMN IF EXISTS "original_vendor_category_name"
    `);

    await queryRunner.query(`
      ALTER TABLE "products"
      DROP COLUMN IF EXISTS "original_vendor_category_id"
    `);
  }
}