import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createProductAttachmentsTableDefinition } from './product-attachments.table';

@Injectable()
export class ProductSchemaService implements OnModuleInit {
  private readonly logger = new Logger(ProductSchemaService.name);
  private schemaInitPromise: Promise<void> | null = null;

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchemaReady();
  }

  async ensureSchemaReady(): Promise<void> {
    if (this.schemaInitPromise) {
      return this.schemaInitPromise;
    }

    this.schemaInitPromise = Promise.all([
      this.ensureProductAttachmentsTableExists(),
      this.ensureProductStatusEnumValues(),
    ])
      .then(() => undefined)
      .catch((error) => {
        this.logger.error(
          `Failed to ensure product schema: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      })
      .finally(() => {
        this.schemaInitPromise = null;
      });

    return this.schemaInitPromise;
  }

  private async ensureProductStatusEnumValues(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'products_status_enum' AND e.enumlabel = 'vendor'
          ) THEN
            ALTER TYPE products_status_enum ADD VALUE 'vendor';
          END IF;
        END $$;
      `);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1
            FROM pg_enum e
            JOIN pg_type t ON e.enumtypid = t.oid
            WHERE t.typname = 'products_status_enum' AND e.enumlabel = 'store'
          ) THEN
            ALTER TYPE products_status_enum ADD VALUE 'store';
          END IF;
        END $$;
      `);
    } catch (error) {
      this.logger.warn(
        `Could not ensure product status enum values: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await queryRunner.release();
    }
  }

  private async ensureProductAttachmentsTableExists(): Promise<void> {
    const queryRunner = this.dataSource.createQueryRunner();

    try {
      await queryRunner.connect();

      if (await queryRunner.hasTable('product_attachments')) {
        return;
      }

      await queryRunner.createTable(
        createProductAttachmentsTableDefinition(),
        true,
      );
      this.logger.log('Created product_attachments table');
    } finally {
      await queryRunner.release();
    }
  }
}
