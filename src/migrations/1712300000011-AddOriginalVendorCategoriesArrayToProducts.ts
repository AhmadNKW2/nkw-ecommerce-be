import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOriginalVendorCategoriesArrayToProducts1712300000011
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "products"
      ADD COLUMN IF NOT EXISTS "original_vendor_categories" jsonb NOT NULL DEFAULT '[]'::jsonb
    `);

    await queryRunner.query(`
      UPDATE "products"
      SET "original_vendor_categories" = jsonb_build_array(
        jsonb_strip_nulls(
          jsonb_build_object(
            'id', "original_vendor_category_id",
            'name', "original_vendor_category_name"
          )
        )
      )
      WHERE (
        "original_vendor_category_id" IS NOT NULL
        OR "original_vendor_category_name" IS NOT NULL
      )
      AND COALESCE("original_vendor_categories", '[]'::jsonb) = '[]'::jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "products"
      SET
        "original_vendor_category_id" = COALESCE(
          "original_vendor_category_id",
          CASE
            WHEN ("original_vendor_categories"->0->>'id') ~ '^[0-9]+$'
              THEN CAST("original_vendor_categories"->0->>'id' AS integer)
            ELSE NULL
          END
        ),
        "original_vendor_category_name" = COALESCE(
          "original_vendor_category_name",
          NULLIF("original_vendor_categories"->0->>'name', '')
        )
      WHERE jsonb_array_length(COALESCE("original_vendor_categories", '[]'::jsonb)) > 0
    `);

    await queryRunner.query(`
      ALTER TABLE "products"
      DROP COLUMN IF EXISTS "original_vendor_categories"
    `);
  }
}