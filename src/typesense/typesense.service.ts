import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SearchParams } from 'typesense/lib/Typesense/Documents';
import { TYPESENSE_CLIENT, TYPESENSE_PRODUCT_COLLECTION_DEFAULT } from './typesense.constants';
import { productSchema } from './schemas/product.schema';

@Injectable()
export class TypesenseService implements OnModuleInit {
  private readonly logger = new Logger(TypesenseService.name);
  private readonly collectionName: string;

  constructor(
    @Inject(TYPESENSE_CLIENT) private readonly client: any,
    private readonly configService: ConfigService,
  ) {
    this.collectionName = this.configService.get<string>(
      'TYPESENSE_COLLECTION_PRODUCTS',
      TYPESENSE_PRODUCT_COLLECTION_DEFAULT,
    );
  }

  isEnabled(): boolean {
    const value = this.configService.get<string>('TYPESENSE_ENABLED', 'false');
    return value.toLowerCase() === 'true';
  }

  async onModuleInit() {
    if (!this.isEnabled()) {
      this.logger.log('Typesense is disabled (TYPESENSE_ENABLED=false)');
      return;
    }

    await this.ensureCollection();
    await this.ensureCollectionSchema();
  }

  private async ensureCollectionSchema() {
    try {
      const collection = await this.client.collections(this.collectionName).retrieve();
      const existingFieldNames = new Set(
        (collection.fields ?? []).map((field: { name: string }) => field.name),
      );
      const fieldsToEnsure = productSchema.fields.filter(
        (field) =>
          (field.name === 'attributes_values_ids' ||
            field.name === 'specifications_values_ids') &&
          !existingFieldNames.has(field.name),
      );

      if (fieldsToEnsure.length === 0) {
        return;
      }

      await this.client.collections(this.collectionName).update({
        fields: fieldsToEnsure,
      });
      this.logger.log(
        `Updated Typesense collection schema with fields: ${fieldsToEnsure
          .map((field) => field.name)
          .join(', ')}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to update Typesense collection schema: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async ensureCollection() {
    try {
      await this.client.collections(this.collectionName).retrieve();
    } catch {
      await this.client.collections().create({
        ...productSchema,
        name: this.collectionName,
      });
      this.logger.log(`Created Typesense collection: ${this.collectionName}`);
    }
  }

  async upsertProduct(doc: Record<string, any>) {
    if (!this.isEnabled()) return null;

    return this.client.collections(this.collectionName).documents().upsert(doc);
  }

  async deleteProduct(id: string) {
    if (!this.isEnabled()) return null;

    try {
      await this.client.collections(this.collectionName).documents(id).delete();
      return true;
    } catch {
      return false;
    }
  }

  async bulkUpsert(docs: Record<string, any>[]) {
    if (!this.isEnabled() || docs.length === 0) return null;

    return this.client
      .collections(this.collectionName)
      .documents()
      .import(docs, { action: 'upsert' });
  }

  async search(params: SearchParams<Record<string, any>>) {
    if (!this.isEnabled()) {
      throw new Error('Typesense is disabled');
    }

    return this.client.collections(this.collectionName).documents().search(params);
  }

  async healthCheck() {
    if (!this.isEnabled()) {
      return {
        enabled: false,
        status: 'disabled',
      };
    }

    const start = Date.now();
    try {
      const result = await this.client.health.retrieve();
      return {
        enabled: true,
        status: 'ok',
        latency_ms: Date.now() - start,
        result,
      };
    } catch (error) {
      return {
        enabled: true,
        status: 'down',
        latency_ms: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
