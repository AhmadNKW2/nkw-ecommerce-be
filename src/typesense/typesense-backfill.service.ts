import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Product } from '../products/entities/product.entity';
import { ProductAttributeValue } from '../products/entities/product-attribute-value.entity';
import { ProductSpecificationValue } from '../products/entities/product-specification-value.entity';
import { SearchCacheService } from '../search/search-cache.service';
import { mapProductToTypesenseDoc } from './mappers/product.mapper';
import { TypesenseService } from './typesense.service';

const BATCH_SIZE = 200;

export type TypesenseBackfillResult = {
  indexed: number;
  batches: number;
  cache_generation: number;
};

export type TypesenseBackfillStatus = {
  in_progress: boolean;
  last_result: TypesenseBackfillResult | null;
  last_error: string | null;
};

@Injectable()
export class TypesenseBackfillService {
  private readonly logger = new Logger(TypesenseBackfillService.name);
  private backfillInProgress = false;
  private lastResult: TypesenseBackfillResult | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly typesenseService: TypesenseService,
    private readonly searchCacheService: SearchCacheService,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(ProductAttributeValue)
    private readonly attributeValuesRepository: Repository<ProductAttributeValue>,
    @InjectRepository(ProductSpecificationValue)
    private readonly specificationValuesRepository: Repository<ProductSpecificationValue>,
  ) {}

  isBackfillInProgress(): boolean {
    return this.backfillInProgress;
  }

  getStatus(): TypesenseBackfillStatus {
    return {
      in_progress: this.backfillInProgress,
      last_result: this.lastResult,
      last_error: this.lastError,
    };
  }

  startFullBackfillInBackground(): void {
    if (this.backfillInProgress) {
      throw new ConflictException('A Typesense backfill is already running.');
    }

    void this.runFullBackfill().catch((error) => {
      this.logger.error(
        `Background Typesense backfill failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }

  async runFullBackfill(): Promise<TypesenseBackfillResult> {
    if (!this.typesenseService.isEnabled()) {
      throw new ServiceUnavailableException(
        'Typesense is disabled. Set TYPESENSE_ENABLED=true before running a backfill.',
      );
    }

    if (this.backfillInProgress) {
      throw new ConflictException('A Typesense backfill is already running.');
    }

    this.backfillInProgress = true;
    let indexed = 0;
    let batches = 0;

    try {
      let page = 0;

      while (true) {
        const products = await this.productsRepository.find({
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
          this.attributeValuesRepository.find({
            where: { product_id: In(productIds) },
            select: { product_id: true, attribute_value_id: true },
          }),
          this.specificationValuesRepository.find({
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
          const current =
            specificationValuesByProductId.get(entry.product_id) ?? [];
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

        await this.typesenseService.bulkUpsert(docs);
        indexed += docs.length;
        batches += 1;
        page += 1;
        this.logger.log(`Indexed ${indexed} products so far...`);
      }

      const cacheGeneration = await this.searchCacheService.invalidateSearchCache(
        'typesense full backfill',
      );

      this.logger.log(
        `Typesense backfill completed. Indexed ${indexed} products. Search cache generation v${cacheGeneration}.`,
      );

      const result = {
        indexed,
        batches,
        cache_generation: cacheGeneration,
      };
      this.lastResult = result;
      this.lastError = null;
      return result;
    } catch (error) {
      this.lastError =
        error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.backfillInProgress = false;
    }
  }
}
