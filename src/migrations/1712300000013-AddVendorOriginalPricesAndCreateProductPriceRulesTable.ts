import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';
import { createProductPriceRulesTableDefinition } from '../settings/product-price-rule.table';

export class AddVendorOriginalPricesAndCreateProductPriceRulesTable1712300000013
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasOriginalVendorPrice = await queryRunner.hasColumn(
      'products',
      'original_vendor_price',
    );
    const hasOriginalVendorSalePrice = await queryRunner.hasColumn(
      'products',
      'original_vendor_sale_price',
    );

    if (!hasOriginalVendorPrice) {
      await queryRunner.addColumn(
        'products',
        new TableColumn({
          name: 'original_vendor_price',
          type: 'decimal',
          precision: 10,
          scale: 2,
          isNullable: true,
        }),
      );
    }

    if (!hasOriginalVendorSalePrice) {
      await queryRunner.addColumn(
        'products',
        new TableColumn({
          name: 'original_vendor_sale_price',
          type: 'decimal',
          precision: 10,
          scale: 2,
          isNullable: true,
        }),
      );
    }

    await queryRunner.createTable(createProductPriceRulesTableDefinition(), true);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasOriginalVendorSalePrice = await queryRunner.hasColumn(
      'products',
      'original_vendor_sale_price',
    );
    const hasOriginalVendorPrice = await queryRunner.hasColumn(
      'products',
      'original_vendor_price',
    );

    await queryRunner.dropTable('product_price_rules', true, true, true);

    if (hasOriginalVendorSalePrice) {
      await queryRunner.dropColumn('products', 'original_vendor_sale_price');
    }

    if (hasOriginalVendorPrice) {
      await queryRunner.dropColumn('products', 'original_vendor_price');
    }
  }
}