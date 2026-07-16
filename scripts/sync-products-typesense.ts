import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ProductsService } from '../src/products/products.service';

loadEnv({ override: true });

const productIds = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0);

if (!productIds.length) {
  console.error(
    'Usage: ts-node -r tsconfig-paths/register scripts/sync-products-typesense.ts <productId...>',
  );
  process.exit(1);
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const productsService = app.get(ProductsService);
    await productsService.syncProductsToTypesense(productIds);
    console.log('TYPESENSE_SYNC_OK', productIds);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
