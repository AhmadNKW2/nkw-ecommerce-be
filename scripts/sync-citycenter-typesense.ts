import { config as loadEnv } from 'dotenv';
import pg from 'pg';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ProductsService } from '../src/products/products.service';
import { SearchCacheService } from '../src/search/search-cache.service';

loadEnv({ path: 'c:/Projects/ordonsooq/ordonsooq-be/.env', override: true });

const BATCH_SIZE = 200;

async function main() {
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  const result = await client.query(`
    SELECT id
    FROM products
    WHERE vendor_id = 1
    ORDER BY id
  `);
  await client.end();

  const productIds = result.rows.map((row) => Number(row.id));
  console.log('CITYCENTER_PRODUCTS_TO_SYNC', productIds.length);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const productsService = app.get(ProductsService);
    const searchCacheService = app.get(SearchCacheService);

    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
      const chunk = productIds.slice(i, i + BATCH_SIZE);
      await productsService.syncProductsToTypesense(chunk);
      console.log(
        `Synced ${Math.min(i + BATCH_SIZE, productIds.length)} / ${productIds.length}`,
      );
    }

    const generation = await searchCacheService.invalidateSearchCache(
      'citycenter vendor typesense sync',
    );
    console.log('TYPESENSE_SYNC_DONE', {
      synced: productIds.length,
      cache_generation: generation,
    });
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
