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
import {
  PRODUCT_SYNONYM_GROUPS,
  PRODUCT_SYNONYM_SET_NAME,
} from './config/synonyms';

// Typesense v30 replaced the classic per-collection Synonyms API with a new
// `synonym_sets` API (the old one still logs a deprecation warning via the
// client, and isn't guaranteed to keep working). Since production and local
// dev can run different major versions at different times, we detect the
// server's version at boot and use whichever API actually exists there.
const SYNONYM_SETS_MIN_MAJOR_VERSION = 30;

@Injectable()
export class TypesenseService implements OnModuleInit {
  private readonly logger = new Logger(TypesenseService.name);
  private readonly collectionName: string;
  private readonly host: string;
  private readonly port: number;
  private readonly protocol: string;
  private readonly apiKey: string;

  constructor(
    @Inject(TYPESENSE_CLIENT) private readonly client: any,
    private readonly configService: ConfigService,
  ) {
    this.collectionName = this.configService.get<string>(
      'TYPESENSE_COLLECTION_PRODUCTS',
      TYPESENSE_PRODUCT_COLLECTION_DEFAULT,
    );
    this.host = this.configService.get<string>('TYPESENSE_HOST', 'localhost');
    this.port = Number(this.configService.get<string>('TYPESENSE_PORT', '8108'));
    this.protocol = this.configService.get<string>('TYPESENSE_PROTOCOL', 'http');
    this.apiKey = this.configService.get<string>('TYPESENSE_API_KEY', '');
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
    await this.ensureSynonyms();
  }

  private async detectServerMajorVersion(): Promise<number | null> {
    try {
      const url = `${this.protocol}://${this.host}:${this.port}/debug`;
      const response = await fetch(url, {
        headers: { 'X-TYPESENSE-API-KEY': this.apiKey },
      });
      if (!response.ok) return null;

      const body = (await response.json()) as { version?: string };
      const match = String(body?.version ?? '').match(/^(\d+)/);
      return match ? Number(match[1]) : null;
    } catch {
      return null;
    }
  }

  private async ensureSynonyms() {
    try {
      const majorVersion = await this.detectServerMajorVersion();
      if (majorVersion !== null && majorVersion >= SYNONYM_SETS_MIN_MAJOR_VERSION) {
        await this.ensureSynonymsViaSynonymSets();
      } else {
        await this.ensureSynonymsViaClassicApi();
      }
    } catch (error) {
      this.logger.warn(
        `Failed to register Typesense synonyms: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async ensureSynonymsViaSynonymSets() {
    const items = Object.entries(PRODUCT_SYNONYM_GROUPS).map(([id, synonyms]) => ({
      id,
      synonyms,
    }));

    await this.client.synonymSets(PRODUCT_SYNONYM_SET_NAME).upsert({ items });

    const collection = await this.client.collections(this.collectionName).retrieve();
    const linkedSets: string[] = Array.isArray(collection.synonym_sets)
      ? collection.synonym_sets
      : [];

    if (!linkedSets.includes(PRODUCT_SYNONYM_SET_NAME)) {
      await this.client.collections(this.collectionName).update({
        synonym_sets: [...linkedSets, PRODUCT_SYNONYM_SET_NAME],
      });
    }

    this.logger.log(
      `Registered Typesense synonym set "${PRODUCT_SYNONYM_SET_NAME}" (${items.length} groups)`,
    );
  }

  private async ensureSynonymsViaClassicApi() {
    for (const [id, synonyms] of Object.entries(PRODUCT_SYNONYM_GROUPS)) {
      try {
        await this.client
          .collections(this.collectionName)
          .synonyms(id)
          .upsert({ synonyms });
      } catch (error) {
        this.logger.warn(
          `Failed to register Typesense synonym "${id}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `Registered ${Object.keys(PRODUCT_SYNONYM_GROUPS).length} classic Typesense synonym groups`,
    );
  }

  private async ensureCollectionSchema() {
    try {
      const collection = await this.client.collections(this.collectionName).retrieve();
      const existingFieldNames = new Set(
        (collection.fields ?? []).map((field: { name: string }) => field.name),
      );
      const autoMigrateFieldNames = new Set([
        'attributes_values_ids',
        'specifications_values_ids',
        'short_description_ar',
        'long_description_ar',
      ]);
      const fieldsToEnsure = productSchema.fields.filter(
        (field) =>
          autoMigrateFieldNames.has(field.name) &&
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
