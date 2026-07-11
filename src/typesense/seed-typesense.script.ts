import { config as loadEnv } from 'dotenv';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { TypesenseBackfillService } from './typesense-backfill.service';

loadEnv({ override: true });

const logger = new Logger('TypesenseBackfill');

async function seedTypesense() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const backfillService = app.get(TypesenseBackfillService);
    const result = await backfillService.runFullBackfill();
    logger.log(
      `Typesense backfill completed successfully. Indexed ${result.indexed} products in ${result.batches} batches. Search cache generation v${result.cache_generation}.`,
    );
  } catch (error) {
    logger.error(
      `Typesense backfill failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

seedTypesense();
