import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { In, DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { Product } from '../products/entities/product.entity';
import { ProductAttributeValue } from '../products/entities/product-attribute-value.entity';
import { ProductSpecificationValue } from '../products/entities/product-specification-value.entity';
import { mapProductToTypesenseDoc } from './mappers/product.mapper';
import { TypesenseService } from './typesense.service';

loadEnv({ override: true });

const logger = new Logger('TypesenseBackfill');
const BATCH_SIZE = 200;

async function seedTypesense() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const typesenseService = app.get(TypesenseService);

    if (!typesenseService.isEnabled()) {
      logger.error(
        'Typesense backfill aborted: TYPESENSE_ENABLED must be true for indexing.',
      );
      process.exitCode = 1;
      return;
    }

    const dataSource = app.get(DataSource);
    const repository = dataSource.getRepository(Product);
    const attributeValueRepository = dataSource.getRepository(ProductAttributeValue);
    const specificationValueRepository = dataSource.getRepository(
      ProductSpecificationValue,
    );

    let indexed = 0;
    let page = 0;

    while (true) {
      const products: Product[] = await repository.find({
        relations: {
          productCategories: {
            category: true,
          },
          specifications: true,
          brand: true,
          category: true,
        },
        order: {
          id: 'ASC',
        },
        skip: page * BATCH_SIZE,
        take: BATCH_SIZE,
      });

      if (products.length === 0) {
        break;
      }

      const productIds = products.map((product) => product.id);
      const [attributeValues, specificationValues] = await Promise.all([
        attributeValueRepository.find({
          where: { product_id: In(productIds) },
          select: { product_id: true, attribute_value_id: true },
        }),
        specificationValueRepository.find({
          where: { product_id: In(productIds) },
          select: { product_id: true, specification_value_id: true },
        }),
      ]);

      const attributeValuesByProductId = new Map<number, number[]>();
      attributeValues.forEach((entry) => {
        const current = attributeValuesByProductId.get(entry.product_id) ?? [];
        current.push(entry.attribute_value_id);
        attributeValuesByProductId.set(entry.product_id, current);
      });

      const specificationValuesByProductId = new Map<number, number[]>();
      specificationValues.forEach((entry) => {
        const current = specificationValuesByProductId.get(entry.product_id) ?? [];
        current.push(entry.specification_value_id);
        specificationValuesByProductId.set(entry.product_id, current);
      });

      const docs = products.map((product) =>
        mapProductToTypesenseDoc(product, {
          attributeValueIds: attributeValuesByProductId.get(product.id) ?? [],
          specificationValueIds:
            specificationValuesByProductId.get(product.id) ??
            (product.specifications ?? []).map(
              (entry) => entry.specification_value_id,
            ),
        }),
      );
      await typesenseService.bulkUpsert(docs);
      indexed += docs.length;
      page += 1;
      logger.log(`Indexed ${indexed} products so far...`);
    }

    logger.log(`Typesense backfill completed successfully. Indexed ${indexed} products.`);
  } finally {
    await app.close();
  }
}

seedTypesense().catch((error) => {
  logger.error(`Typesense backfill failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
