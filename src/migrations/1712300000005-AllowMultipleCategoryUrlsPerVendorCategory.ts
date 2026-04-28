import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowMultipleCategoryUrlsPerVendorCategory1712300000005
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "category_urls"
      DROP CONSTRAINT IF EXISTS "uq_category_urls_category_vendor"
    `);

    await queryRunner.query(`
      ALTER TABLE "category_urls"
      ADD CONSTRAINT "uq_category_urls_category_vendor_url"
      UNIQUE ("category_id", "vendor_id", "url")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "category_urls"
      DROP CONSTRAINT IF EXISTS "uq_category_urls_category_vendor_url"
    `);

    await queryRunner.query(`
      ALTER TABLE "category_urls"
      ADD CONSTRAINT "uq_category_urls_category_vendor"
      UNIQUE ("category_id", "vendor_id")
    `);
  }
}