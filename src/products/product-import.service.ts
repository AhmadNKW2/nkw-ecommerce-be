import {
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { appendFile, mkdir } from 'fs/promises';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { dirname, extname, isAbsolute, resolve as resolvePath } from 'path';
import { Readable } from 'stream';
import { AttributesService } from '../attributes/attributes.service';
import { Attribute } from '../attributes/entities/attribute.entity';
import { BrandsService } from '../brands/brands.service';
import { MediaService } from '../media/media.service';
import { Brand, BrandStatus } from '../brands/entities/brand.entity';
import { Specification } from '../specifications/entities/specification.entity';
import { SpecificationsService } from '../specifications/specifications.service';
import { CreateProductDto } from './dto/create-product.dto';
import { ProductStatus } from './entities/product.entity';
import { ProductsService } from './products.service';

const NOT_EXIST = 'not_exist';
const NUMERIC_TOKEN_REGEX = /\d+(?:\.\d+)?/g;
const LOOKUP_TOKEN_REGEX = /[\p{L}\p{N}]+/gu;
const DEFINITION_MATCH_THRESHOLD = 0.78;
const MISSING_VALUE_MARKERS = new Set(['', '-', '--', 'n/a', 'na', 'none', 'null']);
const DEFAULT_OPENAI_LOG_PATH = resolvePath(
  process.cwd(),
  'logs',
  'import_product_openai.jsonl',
);

interface ImportDefinitionValue {
  id?: number | null;
  value_en?: string | null;
  value_ar?: string | null;
}

interface ImportDefinition {
  id: number;
  name_en?: string | null;
  name_ar?: string | null;
  unit_en?: string | null;
  unit_ar?: string | null;
  allow_ai_inference?: boolean | null;
  values?: ImportDefinitionValue[];
}

interface ParsedImportRequest {
  payload: NormalizedImportPayload;
  categoryId: number;
  vendorId: number;
  model: string;
  sourceFile: string | null;
}

interface NormalizedImportPayload {
  title: string;
  description: string;
  new_price: unknown;
  old_price?: unknown;
  price?: unknown;
  sale_price?: unknown;
  brand?: string | null;
  image?: unknown;
  images: unknown[];
  media: unknown[];
  specification: unknown[];
  attributes: unknown[];
  reference_link?: string | null;
  quantity?: unknown;
  stock?: unknown;
  sku?: string | null;
  record?: string | null;
}

interface ImportAiSpecificationValue {
  original_value?: unknown;
  matched_value_id?: unknown;
}

interface ImportAiSpecification {
  specification_id?: unknown;
  values?: ImportAiSpecificationValue[];
}

interface ImportAiAttributeValue {
  original_value?: unknown;
  matched_value_id?: unknown;
}

interface ImportAiAttribute {
  attribute?: {
    attribute_id?: unknown;
    original_value?: unknown;
  };
  values?: ImportAiAttributeValue[];
}

interface ImportAiResult {
  brand_name?: unknown;
  title_en?: unknown;
  title_ar?: unknown;
  meta_title_en?: unknown;
  meta_title_ar?: unknown;
  short_description_en?: unknown;
  short_description_ar?: unknown;
  description_en?: unknown;
  description_ar?: unknown;
  meta_description_en?: unknown;
  meta_description_ar?: unknown;
  specifications?: ImportAiSpecification[];
  attributes?: ImportAiAttribute[];
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

@Injectable()
export class ProductImportService {
  private readonly logger = new Logger(ProductImportService.name);

  constructor(
    @InjectRepository(Brand)
    private readonly brandsRepository: Repository<Brand>,
    private readonly productsService: ProductsService,
    private readonly specificationsService: SpecificationsService,
    private readonly attributesService: AttributesService,
    private readonly mediaService: MediaService,
    private readonly brandsService: BrandsService,
  ) {}

  async importFromRequest(
    body: Record<string, unknown>,
    userId?: number,
  ) {
    try {
      const request = this.parseRequest(body);
      const brands = await this.brandsRepository.find({
        where: { status: BrandStatus.ACTIVE },
        order: { name_en: 'ASC' },
      });
      const specifications = (await this.specificationsService.findAll([
        request.categoryId,
      ])).filter((specification) => specification.is_active);
      const attributes = (await this.attributesService.findAll([
        request.categoryId,
      ])).filter((attribute) => attribute.is_active);
      const aiResult = await this.callOpenAi(
        request.payload,
        brands,
        specifications,
        attributes,
        request.model,
        request.sourceFile,
      );
      const enforcedSpecifications = this.enforceRequiredSpecifications(
        request.payload,
        aiResult.specifications ?? [],
        specifications,
      );
      const enforcedAttributes = this.enforceRequiredAttributes(
        request.payload,
        aiResult.attributes ?? [],
        attributes,
      );
      const { brandId, brandName, brandCreated } = await this.resolveOrCreateBrand(
        brands,
        request.payload,
        aiResult.brand_name,
      );
      if (brandId !== null && brandName) {
        this.logger.log(
          `${brandCreated ? 'Created' : 'Resolved'} brand '${brandName}' -> id=${brandId}`,
        );
      } else {
        this.logger.log(
          'No brand resolved from source data or AI; creating product without brand_id.',
        );
      }
      const specificationsPayload = await this.resolveSpecifications(
        enforcedSpecifications,
        specifications,
      );
      const attributesPayload = await this.resolveAttributes(
        enforcedAttributes,
        attributes,
      );
      const media = await this.buildMedia(request.payload);
      const pricing = this.resolvePricing(request.payload);
      const isOutOfStock = this.resolveOutOfStock(request.payload);
      const quantity = this.resolveQuantity(request.payload, isOutOfStock);
      const metaTitleEn = this.requireOptionalString(aiResult.meta_title_en);
      const metaTitleAr = this.requireOptionalString(aiResult.meta_title_ar);
      const metaDescriptionEn = this.requireOptionalString(
        aiResult.meta_description_en,
      );
      const metaDescriptionAr = this.requireOptionalString(
        aiResult.meta_description_ar,
      );
      const referenceLink = request.payload.reference_link ?? undefined;

      const createProductDto: CreateProductDto = {
        name_en: this.requireString(aiResult.title_en, 'AI title_en'),
        name_ar: this.requireString(aiResult.title_ar, 'AI title_ar'),
        status: ProductStatus.REVIEW,
        short_description_en: this.requireString(
          aiResult.short_description_en,
          'AI short_description_en',
        ),
        short_description_ar: this.requireString(
          aiResult.short_description_ar,
          'AI short_description_ar',
        ),
        long_description_en: this.requireString(
          aiResult.description_en,
          'AI description_en',
        ),
        long_description_ar: this.requireString(
          aiResult.description_ar,
          'AI description_ar',
        ),
        category_ids: [request.categoryId],
        vendor_id: request.vendorId,
        visible: true,
        specifications: specificationsPayload,
        attributes: attributesPayload,
        price: pricing.price,
        quantity,
        is_out_of_stock: isOutOfStock,
        media,
        linked_product_ids: [],
      };

      if (metaTitleEn) {
        createProductDto.meta_title_en = metaTitleEn;
      }

      if (metaTitleAr) {
        createProductDto.meta_title_ar = metaTitleAr;
      }

      if (metaDescriptionEn) {
        createProductDto.meta_description_en = metaDescriptionEn;
      }

      if (metaDescriptionAr) {
        createProductDto.meta_description_ar = metaDescriptionAr;
      }

      if (referenceLink) {
        createProductDto.reference_link = referenceLink;
      }

      if (pricing.salePrice !== null) {
        createProductDto.sale_price = pricing.salePrice;
      }

      const sku = this.requireOptionalString(request.payload.sku);
      if (sku) {
        createProductDto.sku = sku;
      }

      const record = this.requireOptionalString(request.payload.record);
      if (record) {
        createProductDto.record = record;
      }

      if (brandId !== null) {
        createProductDto.brand_id = brandId;
      }

      return this.productsService.create(createProductDto, userId);
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to import product payload: ${getErrorMessage(error)}`,
      );
      throw new BadRequestException(
        `Failed to import product payload: ${getErrorMessage(error)}`,
      );
    }
  }

  private parseRequest(body: Record<string, unknown>): ParsedImportRequest {
    const payloadCandidate = this.getObject(body.payload);
    const rawPayload = payloadCandidate ?? body;
    const payload = this.normalizePayload(rawPayload);
    const categoryId =
      this.extractPositiveInteger(body.category_id) ??
      this.extractPositiveInteger(rawPayload.category_id) ??
      this.extractFirstPositiveInteger(body.category_ids) ??
      this.extractFirstPositiveInteger(rawPayload.category_ids);
    const vendorId =
      this.extractPositiveInteger(body.vendor_id) ??
      this.extractPositiveInteger(rawPayload.vendor_id);
    const model =
      this.requireOptionalString(body.model) ??
      this.requireOptionalString(rawPayload.model) ??
      process.env.PRODUCT_IMPORT_OPENAI_MODEL?.trim() ??
      'gpt-5.4';
    const sourceFile =
      this.requireOptionalString(body.source_file) ??
      this.requireOptionalString(rawPayload.source_file) ??
      null;

    if (!categoryId) {
      throw new BadRequestException(
        'category_id is required either at the top level or inside payload.',
      );
    }

    if (!vendorId) {
      throw new BadRequestException(
        'vendor_id is required either at the top level or inside payload.',
      );
    }

    return {
      payload,
      categoryId,
      vendorId,
      model,
      sourceFile,
    };
  }

  private normalizePayload(
    rawPayload: Record<string, unknown>,
  ): NormalizedImportPayload {
    const nestedData = this.getObject(rawPayload.data);
    const mergedPayload = nestedData
      ? { ...rawPayload, ...nestedData }
      : { ...rawPayload };
    const title =
      this.firstNonEmptyString([
        mergedPayload.title,
        mergedPayload.name_en,
        mergedPayload.title_en,
      ]) ?? null;
    const description =
      this.firstNonEmptyString([
        mergedPayload.description,
        mergedPayload.long_description_en,
        mergedPayload.short_description_en,
      ]) ?? null;
    const newPrice = this.firstDefinedValue([
      mergedPayload.new_price,
      mergedPayload.sale_price,
      mergedPayload.price,
    ]);
    const oldPrice = this.firstDefinedValue([
      mergedPayload.old_price,
      mergedPayload.sale_price !== undefined ? mergedPayload.price : undefined,
    ]);

    if (!title || !description || newPrice === undefined) {
      throw new BadRequestException(
        'The import payload must include title, description, and new_price (or price/sale_price equivalents).',
      );
    }

    return {
      title,
      description,
      new_price: newPrice,
      old_price: oldPrice,
      price: mergedPayload.price,
      sale_price: mergedPayload.sale_price,
      brand: this.requireOptionalString(mergedPayload.brand),
      image: mergedPayload.image,
      images: this.normalizeInputCollection(mergedPayload.images),
      media: this.normalizeInputCollection(mergedPayload.media),
      specification: this.normalizeInputCollection(
        mergedPayload.specification ?? mergedPayload.specifications,
      ),
      attributes: this.normalizeInputCollection(mergedPayload.attributes),
      reference_link:
        this.requireOptionalString(mergedPayload.reference_link) ??
        this.requireOptionalString(mergedPayload.url) ??
        this.requireOptionalString(mergedPayload.link),
      quantity: mergedPayload.quantity,
      stock: mergedPayload.stock ?? mergedPayload.in_stock,
      sku: this.requireOptionalString(mergedPayload.sku),
      record: this.requireOptionalString(mergedPayload.record),
    };
  }

  private normalizeInputCollection(value: unknown): unknown[] {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return value;
    }

    if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);

      if (!entries.length) {
        return [];
      }

      return entries.map(([name, entryValue]) => ({
        name,
        value: entryValue,
      }));
    }

    return [value];
  }

  private async callOpenAi(
    payload: NormalizedImportPayload,
    brands: Brand[],
    specifications: Specification[],
    attributes: Attribute[],
    model: string,
    sourceFile: string | null,
  ): Promise<ImportAiResult> {
    const openaiKey = process.env.OPENAI_API_KEY?.trim();

    if (!openaiKey) {
      throw new BadRequestException(
        'Missing OPENAI_API_KEY environment variable.',
      );
    }

    const openaiInput = [
      {
        role: 'system',
        content: this.buildSystemPrompt(brands, specifications, attributes),
      },
      {
        role: 'user',
        content: JSON.stringify(
          {
            brand: payload.brand,
            title: payload.title,
            description: payload.description,
            specification: payload.specification,
            attributes: payload.attributes,
          },
          null,
          2,
        ),
      },
    ] satisfies Array<{ role: string; content: string }>;

    let openAiResponse: unknown = null;
    let rawOutputText: string | null = null;

    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model,
          input: openaiInput,
        }),
      });

      const responseText = await response.text();
      openAiResponse = this.tryParseJson(responseText) ?? responseText;

      if (!response.ok) {
        throw new BadRequestException(
          `OpenAI error ${response.status}: ${responseText}`,
        );
      }

      const body = this.getObject(openAiResponse);
      if (!body) {
        throw new BadRequestException(
          'OpenAI response was not a JSON object.',
        );
      }

      rawOutputText = this.stripCodeFences(this.extractOpenAiText(body));
      const parsedOutput = JSON.parse(rawOutputText) as ImportAiResult;

      await this.appendOpenAiLog(
        this.buildOpenAiLogEntry({
          model,
          openAiInput: openaiInput,
          rawProductInput: payload,
          sourceFile,
          openAiResponse,
          rawOutputText,
          parsedOutput,
        }),
      );

      return parsedOutput;
    } catch (error) {
      await this.appendOpenAiLog(
        this.buildOpenAiLogEntry({
          model,
          openAiInput: openaiInput,
          rawProductInput: payload,
          sourceFile,
          openAiResponse,
          rawOutputText,
          errorMessage: getErrorMessage(error),
        }),
      );

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(
        `OpenAI returned invalid JSON: ${getErrorMessage(error)}`,
      );
    }
  }

  private tryParseJson(value: string): unknown | null {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }

  private extractOpenAiText(body: Record<string, unknown>): string {
    const outputText = this.requireOptionalString(body.output_text);
    if (outputText) {
      return outputText;
    }

    const choices = Array.isArray(body.choices)
      ? (body.choices as Array<Record<string, unknown>>)
      : [];
    const choiceMessage = this.getObject(choices[0]?.message);
    const messageContent = this.requireOptionalString(choiceMessage?.content);
    if (messageContent) {
      return messageContent;
    }

    const output = Array.isArray(body.output)
      ? (body.output as Array<Record<string, unknown>>)
      : [];

    for (const item of output) {
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];

      for (const contentItem of content) {
        const text =
          this.requireOptionalString(contentItem.text) ??
          this.requireOptionalString(this.getObject(contentItem.text)?.value);

        if (text) {
          return text;
        }
      }
    }

    throw new BadRequestException('OpenAI response did not include text output.');
  }

  private stripCodeFences(value: string): string {
    return value
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();
  }

  private resolveOptionalBrand(
    brands: Brand[],
    payload: NormalizedImportPayload,
    aiBrandName: unknown,
  ): { brandId: number | null; brandName: string | null } {
    const sourceBrand = this.requireOptionalString(payload.brand);
    const detectedBrand = this.detectBrandNameFromText(brands, payload);
    const aiBrand = this.requireOptionalString(aiBrandName);

    for (const candidate of [sourceBrand, detectedBrand, aiBrand]) {
      if (!candidate) {
        continue;
      }

      const brandId = this.findBrandIdByName(brands, candidate);
      if (brandId !== null) {
        return {
          brandId,
          brandName: candidate,
        };
      }
    }

    return {
      brandId: null,
      brandName: null,
    };
  }

  private async resolveOrCreateBrand(
    brands: Brand[],
    payload: NormalizedImportPayload,
    aiBrandName: unknown,
  ): Promise<{
    brandId: number | null;
    brandName: string | null;
    brandCreated: boolean;
  }> {
    const resolvedBrand = this.resolveOptionalBrand(brands, payload, aiBrandName);

    if (resolvedBrand.brandId !== null) {
      return {
        ...resolvedBrand,
        brandCreated: false,
      };
    }

    const sourceBrandName = this.requireOptionalString(payload.brand);
    if (!sourceBrandName) {
      return {
        brandId: null,
        brandName: null,
        brandCreated: false,
      };
    }

    try {
      const createdBrand = await this.brandsService.create({
        name_en: sourceBrandName,
        name_ar: sourceBrandName,
      });
      brands.push(createdBrand);

      return {
        brandId: createdBrand.id,
        brandName: createdBrand.name_en?.trim() || sourceBrandName,
        brandCreated: true,
      };
    } catch (error) {
      const refreshedBrands = await this.brandsRepository.find({
        where: { status: BrandStatus.ACTIVE },
        order: { name_en: 'ASC' },
      });
      const refreshedBrand = this.resolveOptionalBrand(
        refreshedBrands,
        payload,
        aiBrandName,
      );

      if (refreshedBrand.brandId !== null) {
        return {
          ...refreshedBrand,
          brandCreated: false,
        };
      }

      throw error;
    }
  }

  private detectBrandNameFromText(
    brands: Brand[],
    payload: NormalizedImportPayload,
  ): string | null {
    const searchableText = [
      payload.title,
      payload.description,
      payload.reference_link,
    ]
      .filter((value): value is string => !!value)
      .join(' ');
    const normalizedText = this.normalizeLookupText(searchableText);

    if (!normalizedText) {
      return null;
    }

    const candidates = brands
      .map((brand) => brand.name_en?.trim())
      .filter((name): name is string => !!name)
      .sort((left, right) => right.length - left.length);

    for (const candidate of candidates) {
      if (normalizedText.includes(this.normalizeLookupText(candidate))) {
        return candidate;
      }
    }

    return null;
  }

  private findBrandIdByName(brands: Brand[], brandName: string): number | null {
    const normalizedBrandName = this.normalizeLookupText(brandName);

    for (const brand of brands) {
      const brandNames = [brand.name_en, brand.name_ar]
        .map((name) => this.requireOptionalString(name))
        .filter((name): name is string => !!name)
        .map((name) => this.normalizeLookupText(name));

      if (brandNames.includes(normalizedBrandName)) {
        return brand.id;
      }
    }

    return null;
  }

  private normalizeLookupText(value: string): string {
    return Array.from(value.toLowerCase())
      .filter((character) => /[\p{L}\p{N}]/u.test(character))
      .join('');
  }

  private dedupeNonEmptyStrings(values: string[]): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      deduped.push(normalized);
    }

    return deduped;
  }

  private isMissingTextValue(value: string): boolean {
    return MISSING_VALUE_MARKERS.has(value.trim().toLowerCase());
  }

  private tokenizeLookupText(value: string): Set<string> {
    return new Set(
      (value.toLowerCase().match(LOOKUP_TOKEN_REGEX) ?? []).filter(Boolean),
    );
  }

  private calculateEditSimilarity(left: string, right: string): number {
    if (left === right) {
      return 1;
    }

    if (!left.length || !right.length) {
      return 0;
    }

    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      let diagonal = previous[0];
      previous[0] = leftIndex;

      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const temp = previous[rightIndex];
        const substitutionCost =
          left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        previous[rightIndex] = Math.min(
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + 1,
          diagonal + substitutionCost,
        );
        diagonal = temp;
      }
    }

    const distance = previous[right.length];
    return 1 - distance / Math.max(left.length, right.length);
  }

  private calculateLookupSimilarity(left: string, right: string): number {
    const normalizedLeft = this.normalizeLookupText(left);
    const normalizedRight = this.normalizeLookupText(right);

    if (!normalizedLeft || !normalizedRight) {
      return 0;
    }

    if (normalizedLeft === normalizedRight) {
      return 1;
    }

    const leftTokens = this.tokenizeLookupText(left);
    const rightTokens = this.tokenizeLookupText(right);
    let tokenScore = 0;

    if (leftTokens.size && rightTokens.size) {
      const overlap = [...leftTokens].filter((token) => rightTokens.has(token)).length;
      if (overlap) {
        tokenScore = overlap / new Set([...leftTokens, ...rightTokens]).size;
        if (overlap === Math.min(leftTokens.size, rightTokens.size) && overlap >= 2) {
          tokenScore = Math.max(tokenScore, 0.85);
        }
      }
    }

    let containmentScore = 0;
    if (
      normalizedLeft.includes(normalizedRight) ||
      normalizedRight.includes(normalizedLeft)
    ) {
      const shorter = Math.min(normalizedLeft.length, normalizedRight.length);
      const longer = Math.max(normalizedLeft.length, normalizedRight.length);
      if (shorter >= 6) {
        containmentScore = shorter / longer;
      }
    }

    return Math.max(
      tokenScore,
      containmentScore,
      this.calculateEditSimilarity(normalizedLeft, normalizedRight),
    );
  }

  private extractSourceFieldNames(entry: unknown): string[] {
    const entryObject = this.getObject(entry);

    if (!entryObject) {
      return [];
    }

    return this.dedupeNonEmptyStrings(
      ['key', 'name', 'name_en', 'name_ar', 'label', 'title']
        .map((key) => this.requireOptionalString(entryObject[key]))
        .filter((value): value is string => !!value && !this.isMissingTextValue(value)),
    );
  }

  private extractSourceValueTexts(value: unknown): string[] {
    if (value === null || value === undefined) {
      return [];
    }

    if (Array.isArray(value)) {
      return this.dedupeNonEmptyStrings(
        value.flatMap((item) => this.extractSourceValueTexts(item)),
      );
    }

    const valueObject = this.getObject(value);
    if (valueObject) {
      if (valueObject.value !== undefined) {
        return this.extractSourceValueTexts(valueObject.value);
      }

      if (valueObject.values !== undefined) {
        return this.extractSourceValueTexts(valueObject.values);
      }

      return this.dedupeNonEmptyStrings(
        ['translate', 'value_en', 'value_ar', 'name_en', 'name_ar', 'value', 'name']
          .filter((key) => valueObject[key] !== undefined)
          .flatMap((key) => this.extractSourceValueTexts(valueObject[key])),
      );
    }

    const normalized = String(value).trim();
    if (!normalized || this.isMissingTextValue(normalized)) {
      return [];
    }

    return [normalized];
  }

  private getDefinitionDisplayName(definition: ImportDefinition): string {
    return definition.name_en?.trim() || definition.name_ar?.trim() || String(definition.id);
  }

  private buildDefinitionAliases(definition: ImportDefinition): string[] {
    return this.dedupeNonEmptyStrings([
      definition.name_en ?? '',
      definition.name_ar ?? '',
    ]);
  }

  private mapSourceValuesByDefinition<T extends ImportDefinition>(
    sourceEntries: unknown[],
    availableDefinitions: T[],
  ): Map<number, string[]> {
    const valuesByDefinition = new Map<number, string[]>();

    for (const entry of sourceEntries) {
      const fieldNames = this.extractSourceFieldNames(entry);
      const sourceValues = this.extractSourceValueTexts(entry);
      if (!fieldNames.length || !sourceValues.length) {
        continue;
      }

      let bestDefinition: T | null = null;
      let bestScore = 0;
      for (const definition of availableDefinitions) {
        const aliases = this.buildDefinitionAliases(definition);
        if (!aliases.length) {
          continue;
        }

        const score = Math.max(
          ...fieldNames.flatMap((fieldName) =>
            aliases.map((alias) => this.calculateLookupSimilarity(fieldName, alias)),
          ),
        );
        if (score > bestScore) {
          bestScore = score;
          bestDefinition = definition;
        }
      }

      if (!bestDefinition || bestScore < DEFINITION_MATCH_THRESHOLD) {
        continue;
      }

      valuesByDefinition.set(bestDefinition.id, [
        ...(valuesByDefinition.get(bestDefinition.id) ?? []),
        ...sourceValues,
      ]);
    }

    for (const [definitionId, values] of valuesByDefinition.entries()) {
      valuesByDefinition.set(definitionId, this.dedupeNonEmptyStrings(values));
    }

    return valuesByDefinition;
  }

  private extractDefinitionUnits(definition: ImportDefinition): string[] {
    return this.dedupeNonEmptyStrings([
      definition.unit_en ?? '',
      definition.unit_ar ?? '',
    ]);
  }

  private hasDefinedUnit(definition: ImportDefinition): boolean {
    return this.extractDefinitionUnits(definition).length > 0;
  }

  private buildDefinitionValueCandidates(
    definition: ImportDefinition,
    matchedValue: ImportDefinitionValue,
  ): string[] {
    const baseCandidates = this.dedupeNonEmptyStrings([
      matchedValue.value_en ?? '',
      matchedValue.value_ar ?? '',
    ]);
    const unitCandidates = this.extractDefinitionUnits(definition);

    if (!unitCandidates.length) {
      return baseCandidates;
    }

    return this.dedupeNonEmptyStrings([
      ...baseCandidates,
      ...baseCandidates.flatMap((baseCandidate) =>
        unitCandidates.map((unitCandidate) => `${baseCandidate} ${unitCandidate}`),
      ),
    ]);
  }

  private extractNumericSignature(value: string): string[] {
    return (value.replace(/,/g, '').match(NUMERIC_TOKEN_REGEX) ?? []).filter(Boolean);
  }

  private buildExistingValueMap(definition: ImportDefinition): Map<number, ImportDefinitionValue> {
    return new Map(
      (definition.values ?? [])
        .filter((value): value is ImportDefinitionValue & { id: number } =>
          typeof value.id === 'number',
        )
        .map((value) => [value.id, value]),
    );
  }

  private findExactMatchedValueId(
    definition: ImportDefinition,
    rawValue: string,
  ): number | null {
    const normalizedRawValue = this.normalizeLookupText(rawValue);
    const rawNumericSignature = this.extractNumericSignature(rawValue).join('|');

    for (const value of definition.values ?? []) {
      if (typeof value.id !== 'number') {
        continue;
      }

      const normalizedCandidates = new Set(
        this.buildDefinitionValueCandidates(definition, value).map((candidate) =>
          this.normalizeLookupText(candidate),
        ),
      );
      if (normalizedCandidates.has(normalizedRawValue)) {
        return value.id;
      }

      if (this.hasDefinedUnit(definition) && rawNumericSignature) {
        const candidateSignatures = new Set(
          this.buildDefinitionValueCandidates(definition, value)
            .map((candidate) => this.extractNumericSignature(candidate).join('|'))
            .filter(Boolean),
        );
        if (candidateSignatures.has(rawNumericSignature)) {
          return value.id;
        }
      }
    }

    return null;
  }

  private buildValueTextCandidates(
    value: ImportAiSpecificationValue | ImportAiAttributeValue,
    definition: ImportDefinition,
    matchedValues: Map<number, ImportDefinitionValue>,
    localized: boolean,
  ): string[] {
    const candidates: string[] = [];

    try {
      if (localized) {
        const localizedValue = this.extractLocalizedValue(value.original_value);
        candidates.push(localizedValue.name_en, localizedValue.name_ar);
      } else {
        candidates.push(this.extractSimpleText(value.original_value));
      }
    } catch {
      // Ignore invalid AI original_value fields here; later validation still applies.
    }

    const matchedValueId = this.extractPositiveInteger(value.matched_value_id);
    if (matchedValueId) {
      const matchedValue = matchedValues.get(matchedValueId);
      if (matchedValue) {
        candidates.push(...this.buildDefinitionValueCandidates(definition, matchedValue));
      }
    }

    return this.dedupeNonEmptyStrings(candidates);
  }

  private analyzeApproximateMatch(
    rawCandidates: string[],
    matchedCandidates: string[],
  ): {
    shouldReplace: boolean;
    reason: string;
  } {
    const normalizedMatchedCandidates = new Set(
      matchedCandidates
        .map((candidate) => this.normalizeLookupText(candidate))
        .filter(Boolean),
    );
    const matchedNumericSignatures = new Set(
      matchedCandidates
        .map((candidate) => this.extractNumericSignature(candidate).join('|'))
        .filter(Boolean),
    );

    let hasMeasurableRawValue = false;

    for (const rawCandidate of rawCandidates) {
      const normalizedRawCandidate = rawCandidate.trim();
      if (!normalizedRawCandidate) {
        continue;
      }

      if (
        normalizedMatchedCandidates.has(
          this.normalizeLookupText(normalizedRawCandidate),
        )
      ) {
        return {
          shouldReplace: false,
          reason: 'raw value matches an existing database value after normalization',
        };
      }

      const rawNumericSignature = this.extractNumericSignature(
        normalizedRawCandidate,
      ).join('|');
      if (rawNumericSignature) {
        hasMeasurableRawValue = true;
        if (matchedNumericSignatures.has(rawNumericSignature)) {
          return {
            shouldReplace: false,
            reason: 'raw value matches an existing database numeric signature',
          };
        }
      }
    }

    if (hasMeasurableRawValue) {
      return {
        shouldReplace: true,
        reason:
          'raw measurable value differs from all existing unit-based database values',
      };
    }

    return {
      shouldReplace: false,
      reason: 'raw value has no measurable token; approximate numeric safeguard not applied',
    };
  }

  private valuesOverlap(
    sourceValues: string[],
    candidateValues: string[],
    allowNumericSignature: boolean,
  ): boolean {
    const normalizedSourceValues = new Set(
      sourceValues
        .map((sourceValue) => this.normalizeLookupText(sourceValue))
        .filter(Boolean),
    );
    const sourceNumericSignatures = new Set(
      sourceValues
        .map((sourceValue) => this.extractNumericSignature(sourceValue).join('|'))
        .filter(Boolean),
    );

    for (const candidateValue of candidateValues) {
      const normalizedCandidate = this.normalizeLookupText(candidateValue);
      if (normalizedSourceValues.has(normalizedCandidate)) {
        return true;
      }

      if (allowNumericSignature) {
        const candidateSignature = this.extractNumericSignature(candidateValue).join('|');
        if (candidateSignature && sourceNumericSignatures.has(candidateSignature)) {
          return true;
        }
      }
    }

    return false;
  }

  private enforceRequiredSpecifications(
    payload: NormalizedImportPayload,
    aiSpecifications: ImportAiSpecification[],
    availableSpecifications: Specification[],
  ): ImportAiSpecification[] {
    const sourceValuesBySpecification = this.mapSourceValuesByDefinition(
      payload.specification,
      availableSpecifications,
    );
    const aiValuesBySpecification = new Map<number, ImportAiSpecificationValue[]>();

    for (const specification of aiSpecifications) {
      const specificationId = this.extractPositiveInteger(
        specification.specification_id,
      );
      if (!specificationId) {
        continue;
      }

      aiValuesBySpecification.set(specificationId, [
        ...(aiValuesBySpecification.get(specificationId) ?? []),
        ...(specification.values ?? []),
      ]);
    }

    const mergedSpecifications: ImportAiSpecification[] = [];
    const missingInferenceSpecifications: string[] = [];

    for (const specification of availableSpecifications) {
      const sourceValues = sourceValuesBySpecification.get(specification.id) ?? [];
      const allowAiInference = !!specification.allow_ai_inference;
      const matchedValues = this.buildExistingValueMap(specification);
      let values = [...(aiValuesBySpecification.get(specification.id) ?? [])];

      if (sourceValues.length && !allowAiInference) {
        values = values.filter((value) =>
          this.valuesOverlap(
            sourceValues,
            this.buildValueTextCandidates(value, specification, matchedValues, true),
            this.hasDefinedUnit(specification),
          ),
        );
      }

      if (sourceValues.length) {
        const currentValueCandidates = this.dedupeNonEmptyStrings(
          values.flatMap((value) =>
            this.buildValueTextCandidates(value, specification, matchedValues, true),
          ),
        );
        const missingSourceValues = sourceValues.filter(
          (sourceValue) =>
            !this.valuesOverlap(
              [sourceValue],
              currentValueCandidates,
              this.hasDefinedUnit(specification),
            ),
        );

        if (missingSourceValues.length) {
          this.logger.log(
            `Backfilling source specification '${this.getDefinitionDisplayName(specification)}' with values ${missingSourceValues.join(', ')}`,
          );
          values.push(
            ...missingSourceValues.map((rawValue) => ({
              original_value: {
                name_en: rawValue,
                name_ar: rawValue,
              },
              matched_value_id:
                this.findExactMatchedValueId(specification, rawValue) ?? NOT_EXIST,
            })),
          );
        }
      } else if (!allowAiInference) {
        values = [];
      } else if (!values.length) {
        missingInferenceSpecifications.push(
          this.getDefinitionDisplayName(specification),
        );
      }

      if (values.length) {
        mergedSpecifications.push({
          specification_id: specification.id,
          values,
        });
      }
    }

    if (missingInferenceSpecifications.length) {
      throw new BadRequestException(
        `AI inference is required but missing for specifications: ${missingInferenceSpecifications.join(', ')}`,
      );
    }

    return mergedSpecifications;
  }

  private enforceRequiredAttributes(
    payload: NormalizedImportPayload,
    aiAttributes: ImportAiAttribute[],
    availableAttributes: Attribute[],
  ): ImportAiAttribute[] {
    const sourceValuesByAttribute = this.mapSourceValuesByDefinition(
      payload.attributes,
      availableAttributes,
    );
    const aiValuesByAttribute = new Map<number, ImportAiAttributeValue[]>();

    for (const attribute of aiAttributes) {
      const attributeId = this.extractPositiveInteger(attribute.attribute?.attribute_id);
      if (!attributeId) {
        continue;
      }

      aiValuesByAttribute.set(attributeId, [
        ...(aiValuesByAttribute.get(attributeId) ?? []),
        ...(attribute.values ?? []),
      ]);
    }

    const mergedAttributes: ImportAiAttribute[] = [];
    const missingInferenceAttributes: string[] = [];

    for (const attribute of availableAttributes) {
      const sourceValues = sourceValuesByAttribute.get(attribute.id) ?? [];
      const allowAiInference = !!attribute.allow_ai_inference;
      const matchedValues = this.buildExistingValueMap(attribute);
      let values = [...(aiValuesByAttribute.get(attribute.id) ?? [])];

      if (sourceValues.length && !allowAiInference) {
        values = values.filter((value) =>
          this.valuesOverlap(
            sourceValues,
            this.buildValueTextCandidates(value, attribute, matchedValues, false),
            this.hasDefinedUnit(attribute),
          ),
        );
      }

      if (sourceValues.length) {
        const currentValueCandidates = this.dedupeNonEmptyStrings(
          values.flatMap((value) =>
            this.buildValueTextCandidates(value, attribute, matchedValues, false),
          ),
        );
        const missingSourceValues = sourceValues.filter(
          (sourceValue) =>
            !this.valuesOverlap(
              [sourceValue],
              currentValueCandidates,
              this.hasDefinedUnit(attribute),
            ),
        );

        if (missingSourceValues.length) {
          this.logger.log(
            `Backfilling source attribute '${this.getDefinitionDisplayName(attribute)}' with values ${missingSourceValues.join(', ')}`,
          );
          values.push(
            ...missingSourceValues.map((rawValue) => ({
              original_value: rawValue,
              matched_value_id:
                this.findExactMatchedValueId(attribute, rawValue) ?? NOT_EXIST,
            })),
          );
        }
      } else if (!allowAiInference) {
        values = [];
      } else if (!values.length) {
        missingInferenceAttributes.push(this.getDefinitionDisplayName(attribute));
      }

      if (values.length) {
        mergedAttributes.push({
          attribute: {
            attribute_id: attribute.id,
            original_value: this.getDefinitionDisplayName(attribute),
          },
          values,
        });
      }
    }

    if (missingInferenceAttributes.length) {
      throw new BadRequestException(
        `AI inference is required but missing for attributes: ${missingInferenceAttributes.join(', ')}`,
      );
    }

    return mergedAttributes;
  }

  private async resolveSpecifications(
    aiSpecifications: ImportAiSpecification[],
    availableSpecifications: Specification[],
  ): Promise<
    Array<{
      specification_id: number;
      specification_value_ids: number[];
    }>
  > {
    const specificationLookup = new Map(
      availableSpecifications.map((specification) => [
        specification.id,
        specification,
      ]),
    );
    const specificationMap = new Map<number, Set<number>>();

    for (const specification of aiSpecifications) {
      const specificationId = this.extractPositiveInteger(
        specification.specification_id,
      );

      if (!specificationId) {
        continue;
      }

      if (!specificationLookup.has(specificationId)) {
        this.logger.log(
          `Skipping unknown specification id=${specificationId} returned by AI.`,
        );
        continue;
      }

      if (!specificationMap.has(specificationId)) {
        specificationMap.set(specificationId, new Set<number>());
      }

      const matchedSpecification = specificationLookup.get(specificationId);
      if (!matchedSpecification) {
        continue;
      }

      const valueLookup = this.buildExistingValueMap(matchedSpecification);

      for (const value of specification.values ?? []) {
        let matchedValueId = this.extractPositiveInteger(value.matched_value_id);
        let shouldCreateValue = this.isNotExist(value.matched_value_id);
        const localizedValue = this.extractLocalizedValue(value.original_value);

        if (matchedValueId) {
          const matchedValue = valueLookup.get(matchedValueId);

          if (!matchedValue) {
            this.logger.log(
              `Specification ${specificationId}: AI returned unknown value id=${matchedValueId} for '${localizedValue.name_en}'; creating new value.`,
            );
            matchedValueId = null;
            shouldCreateValue = true;
          } else if (this.hasDefinedUnit(matchedSpecification)) {
            const matchDecision = this.analyzeApproximateMatch(
              [localizedValue.name_en, localizedValue.name_ar],
              this.buildDefinitionValueCandidates(
                matchedSpecification,
                matchedValue,
              ),
            );

            if (matchDecision.shouldReplace) {
              this.logger.log(
                `Specification ${specificationId}: rejecting approximate match id=${matchedValueId} for raw value '${localizedValue.name_en}'; creating exact value (${matchDecision.reason}).`,
              );
              matchedValueId = null;
              shouldCreateValue = true;
            } else {
              this.logger.log(
                `Specification ${specificationId}: keeping matched value id=${matchedValueId} for raw value '${localizedValue.name_en}' (${matchDecision.reason}).`,
              );
            }
          } else {
            this.logger.log(
              `Specification ${specificationId}: keeping matched value id=${matchedValueId} for raw value '${localizedValue.name_en}' (no unit defined; approximate numeric safeguard not applied).`,
            );
          }
        }

        if (!matchedValueId && shouldCreateValue) {
          this.logger.log(
            `Specification ${specificationId}: creating missing value '${localizedValue.name_en}'.`,
          );
          matchedValueId = (
            await this.specificationsService.addValue(
              specificationId,
              localizedValue.name_en,
              localizedValue.name_ar,
            )
          ).id;
          this.logger.log(
            `Specification ${specificationId}: created value id=${matchedValueId}`,
          );
        }

        if (matchedValueId) {
          specificationMap.get(specificationId)?.add(matchedValueId);
        }
      }
    }

    return Array.from(specificationMap.entries())
      .map(([specification_id, valueIds]) => ({
        specification_id,
        specification_value_ids: Array.from(valueIds).sort((left, right) => left - right),
      }))
      .filter((specification) => specification.specification_value_ids.length > 0);
  }

  private async resolveAttributes(
    aiAttributes: ImportAiAttribute[],
    availableAttributes: Attribute[],
  ): Promise<
    Array<{
      attribute_id: number;
      attribute_value_ids: number[];
    }>
  > {
    const attributeLookup = new Map(
      availableAttributes.map((attribute) => [attribute.id, attribute]),
    );
    const attributeMap = new Map<number, Set<number>>();

    for (const attribute of aiAttributes) {
      const attributeId = this.extractPositiveInteger(
        attribute.attribute?.attribute_id,
      );

      if (!attributeId) {
        continue;
      }

      if (!attributeLookup.has(attributeId)) {
        this.logger.log(
          `Skipping unknown attribute id=${attributeId} returned by AI.`,
        );
        continue;
      }

      if (!attributeMap.has(attributeId)) {
        attributeMap.set(attributeId, new Set<number>());
      }

      const matchedAttribute = attributeLookup.get(attributeId);
      if (!matchedAttribute) {
        continue;
      }

      const valueLookup = this.buildExistingValueMap(matchedAttribute);

      for (const value of attribute.values ?? []) {
        let matchedValueId = this.extractPositiveInteger(value.matched_value_id);
        let shouldCreateValue = this.isNotExist(value.matched_value_id);
        const rawValue = this.extractSimpleText(value.original_value);

        if (matchedValueId) {
          const matchedValue = valueLookup.get(matchedValueId);

          if (!matchedValue) {
            this.logger.log(
              `Attribute ${attributeId}: AI returned unknown value id=${matchedValueId} for '${rawValue}'; creating new value.`,
            );
            matchedValueId = null;
            shouldCreateValue = true;
          } else if (this.hasDefinedUnit(matchedAttribute)) {
            const matchDecision = this.analyzeApproximateMatch(
              [rawValue],
              this.buildDefinitionValueCandidates(matchedAttribute, matchedValue),
            );

            if (matchDecision.shouldReplace) {
              this.logger.log(
                `Attribute ${attributeId}: rejecting approximate match id=${matchedValueId} for raw value '${rawValue}'; creating exact value (${matchDecision.reason}).`,
              );
              matchedValueId = null;
              shouldCreateValue = true;
            } else {
              this.logger.log(
                `Attribute ${attributeId}: keeping matched value id=${matchedValueId} for raw value '${rawValue}' (${matchDecision.reason}).`,
              );
            }
          } else {
            this.logger.log(
              `Attribute ${attributeId}: keeping matched value id=${matchedValueId} for raw value '${rawValue}' (no unit defined; approximate numeric safeguard not applied).`,
            );
          }
        }

        if (!matchedValueId && shouldCreateValue) {
          this.logger.log(
            `Attribute ${attributeId}: creating missing value '${rawValue}'.`,
          );
          matchedValueId = (
            await this.attributesService.addValue(
              attributeId,
              rawValue,
              rawValue,
            )
          ).id;
          this.logger.log(
            `Attribute ${attributeId}: created value id=${matchedValueId}`,
          );
        }

        if (matchedValueId) {
          attributeMap.get(attributeId)?.add(matchedValueId);
        }
      }
    }

    return Array.from(attributeMap.entries())
      .map(([attribute_id, valueIds]) => ({
        attribute_id,
        attribute_value_ids: Array.from(valueIds).sort((left, right) => left - right),
      }))
      .filter((attribute) => attribute.attribute_value_ids.length > 0);
  }

  private isNotExist(value: unknown): boolean {
    return (
      typeof value === 'string' && value.trim().toLowerCase() === NOT_EXIST
    );
  }

  private extractLocalizedValue(value: unknown): {
    name_en: string;
    name_ar: string;
  } {
    const valueObject = this.getObject(value);
    const nameEn =
      this.requireOptionalString(valueObject?.name_en) ??
      this.extractSimpleText(value);
    const nameAr =
      this.requireOptionalString(valueObject?.name_ar) ??
      nameEn;

    return {
      name_en: nameEn,
      name_ar: nameAr,
    };
  }

  private extractSimpleText(value: unknown): string {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }

    const valueObject = this.getObject(value);
    const candidate =
      this.requireOptionalString(valueObject?.name_en) ??
      this.requireOptionalString(valueObject?.value_en) ??
      this.requireOptionalString(valueObject?.name) ??
      this.requireOptionalString(valueObject?.value);

    if (!candidate) {
      throw new BadRequestException('AI returned an empty attribute/specification value.');
    }

    return candidate;
  }

  private async buildMedia(
    payload: NormalizedImportPayload,
  ): Promise<Array<{ media_id: number; is_primary: boolean; sort_order: number }>> {
    const directMedia = this.normalizeDirectMedia(payload.media);
    if (directMedia.length > 0) {
      return directMedia;
    }

    const orderedMediaSources: unknown[] = [];
    if (payload.image !== undefined && payload.image !== null) {
      orderedMediaSources.push(payload.image);
    }
    orderedMediaSources.push(...payload.images);

    if (!orderedMediaSources.length) {
      throw new BadRequestException(
        'The import payload must include image, images, or media.',
      );
    }

    const media: Array<{
      media_id: number;
      is_primary: boolean;
      sort_order: number;
    }> = [];
    const seenReferences = new Set<string>();

    for (const source of orderedMediaSources) {
      const resolved = await this.resolveMediaId(source);
      if (!resolved) {
        continue;
      }

      if (seenReferences.has(resolved.referenceKey)) {
        continue;
      }

      seenReferences.add(resolved.referenceKey);
      media.push({
        media_id: resolved.mediaId,
        is_primary: media.length === 0,
        sort_order: media.length,
      });
    }

    if (!media.length) {
      throw new BadRequestException(
        'The import payload must include at least one valid image reference.',
      );
    }

    return media;
  }

  private normalizeDirectMedia(
    mediaItems: unknown[],
  ): Array<{ media_id: number; is_primary: boolean; sort_order: number }> {
    const normalized: Array<{
      media_id: number;
      is_primary: boolean;
      sort_order: number;
    }> = [];
    const seenIds = new Set<number>();

    for (const [index, mediaItem] of mediaItems.entries()) {
      const mediaObject = this.getObject(mediaItem);
      const mediaId =
        this.extractPositiveInteger(mediaObject?.media_id) ??
        this.extractPositiveInteger(mediaObject?.id) ??
        this.extractPositiveInteger(mediaItem);

      if (!mediaId || seenIds.has(mediaId)) {
        continue;
      }

      seenIds.add(mediaId);
      normalized.push({
        media_id: mediaId,
        is_primary:
          typeof mediaObject?.is_primary === 'boolean'
            ? mediaObject.is_primary
            : normalized.length === 0,
        sort_order:
          this.extractNumber(mediaObject?.sort_order) ?? index,
      });
    }

    if (normalized.length > 1 && !normalized.some((item) => item.is_primary)) {
      normalized[0].is_primary = true;
    }

    return normalized;
  }

  private async resolveMediaId(
    mediaReference: unknown,
  ): Promise<{ mediaId: number; referenceKey: string } | null> {
    const parsedReference = this.parseMediaReference(mediaReference);

    if (!parsedReference) {
      return null;
    }

    if (parsedReference.kind === 'id') {
      return {
        mediaId: parsedReference.value,
        referenceKey: `id:${parsedReference.value}`,
      };
    }

    return {
      mediaId: await this.downloadImage(parsedReference.value),
      referenceKey: `url:${parsedReference.value}`,
    };
  }

  private parseMediaReference(
    mediaReference: unknown,
  ): { kind: 'id'; value: number } | { kind: 'url'; value: string } | null {
    if (mediaReference === null || mediaReference === undefined) {
      return null;
    }

    const numericId = this.extractPositiveInteger(mediaReference);
    if (numericId) {
      return {
        kind: 'id',
        value: numericId,
      };
    }

    if (typeof mediaReference === 'string') {
      const normalized = mediaReference.trim();

      if (!normalized || normalized.toLowerCase() === 'none') {
        return null;
      }

      return {
        kind: 'url',
        value: normalized,
      };
    }

    const mediaObject = this.getObject(mediaReference);
    if (!mediaObject) {
      return null;
    }

    return (
      this.parseMediaReference(mediaObject.media_id) ??
      this.parseMediaReference(mediaObject.url) ??
      this.parseMediaReference(mediaObject.id)
    );
  }

  private async downloadImage(imageUrl: string): Promise<number> {
    this.logger.log(`Downloading image ${imageUrl}`);
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new BadRequestException(
        `Failed to download image ${imageUrl}: ${response.status} ${response.statusText}`,
      );
    }

    const contentType =
      response.headers.get('content-type')?.split(';', 1)[0] ??
      'application/octet-stream';
    const buffer = Buffer.from(await response.arrayBuffer());
    const originalname = this.buildUploadFilename(imageUrl, contentType);
    const file = {
      fieldname: 'file',
      originalname,
      encoding: '7bit',
      mimetype: contentType,
      size: buffer.length,
      buffer,
      stream: Readable.from(buffer),
      destination: '',
      filename: originalname,
      path: '',
    } as Express.Multer.File;
    const media = await this.mediaService.uploadAndCreate(file, 'products');

    return media.id;
  }

  private buildUploadFilename(imageUrl: string, contentType: string): string {
    try {
      const pathname = new URL(imageUrl).pathname;
      const decodedName = decodeURIComponent(pathname.split('/').pop() ?? '');

      if (decodedName && extname(decodedName)) {
        return decodedName;
      }
    } catch {
      // Ignore malformed URLs and fall back to content type.
    }

    return `imported-image${this.guessExtensionFromContentType(contentType)}`;
  }

  private guessExtensionFromContentType(contentType: string): string {
    const normalizedType = contentType.toLowerCase();

    if (normalizedType.includes('jpeg')) return '.jpg';
    if (normalizedType.includes('png')) return '.png';
    if (normalizedType.includes('gif')) return '.gif';
    if (normalizedType.includes('webp')) return '.webp';
    if (normalizedType.includes('avif')) return '.avif';
    if (normalizedType.includes('tiff')) return '.tiff';

    return '.jpg';
  }

  private resolvePricing(payload: NormalizedImportPayload): {
    price: number;
    salePrice: number | null;
  } {
    const explicitPrice = this.firstDefinedValue([payload.price, payload.new_price]);
    const explicitSalePrice = this.firstDefinedValue([payload.sale_price]);

    if (explicitPrice !== undefined && explicitSalePrice !== undefined) {
      return {
        price: this.normalizePriceValue(explicitPrice),
        salePrice: this.normalizePriceValue(explicitSalePrice),
      };
    }

    const newPrice = this.normalizePriceValue(payload.new_price);
    if (!this.isMissingPrice(payload.old_price)) {
      return {
        price: this.normalizePriceValue(payload.old_price),
        salePrice: newPrice,
      };
    }

    return {
      price: newPrice,
      salePrice: null,
    };
  }

  private resolveOutOfStock(payload: NormalizedImportPayload): boolean {
    const quantity = this.extractNumber(payload.quantity);
    if (quantity !== null) {
      return quantity <= 0;
    }

    if (typeof payload.stock === 'boolean') {
      return !payload.stock;
    }

    const stockValue = this.requireOptionalString(payload.stock)?.toLowerCase();
    return !!stockValue && ['none', '0', 'false', 'out_of_stock'].includes(stockValue);
  }

  private resolveQuantity(
    payload: NormalizedImportPayload,
    isOutOfStock: boolean,
  ): number {
    if (isOutOfStock) {
      return 0;
    }

    const quantity = this.extractNumber(payload.quantity);
    if (quantity !== null && quantity >= 0) {
      return quantity;
    }

    const stockQuantity = this.extractNumber(payload.stock);
    if (stockQuantity !== null && stockQuantity >= 0) {
      return stockQuantity;
    }

    return 100;
  }

  private normalizePriceValue(value: unknown): number {
    if (typeof value === 'number') {
      return value;
    }

    const valueObject = this.getObject(value);
    const nestedValue = valueObject?.translate;
    const candidate =
      nestedValue !== undefined && nestedValue !== null ? nestedValue : value;

    if (typeof candidate === 'number') {
      return candidate;
    }

    if (typeof candidate !== 'string') {
      throw new BadRequestException(`Invalid price value: ${String(candidate)}`);
    }

    const normalized = candidate.trim();
    if (!normalized || normalized.toLowerCase() === 'none') {
      throw new BadRequestException(`Invalid price value: ${candidate}`);
    }

    const parsed = Number(normalized.replace(/,/g, ''));
    if (!Number.isFinite(parsed)) {
      throw new BadRequestException(`Invalid price value: ${candidate}`);
    }

    return parsed;
  }

  private isMissingPrice(value: unknown): boolean {
    if (value === null || value === undefined) {
      return true;
    }

    if (typeof value === 'string') {
      return !value.trim() || value.trim().toLowerCase() === 'none';
    }

    const valueObject = this.getObject(value);
    if (valueObject) {
      const translated = valueObject.translate;
      return this.isMissingPrice(translated);
    }

    return false;
  }

  private buildSystemPrompt(
    brands: Brand[],
    specifications: Specification[],
    attributes: Attribute[],
  ): string {
    const brandsCatalog = brands
      .map((brand) => brand.name_en?.trim())
      .filter((name): name is string => !!name);
    const specificationsCatalog = specifications.map((specification) => ({
      id: specification.id,
      name_en: specification.name_en,
      name_ar: specification.name_ar,
      unit_en: specification.unit_en,
      unit_ar: specification.unit_ar,
      allow_ai_inference: specification.allow_ai_inference,
      values: (specification.values ?? [])
        .filter((value) => value.is_active)
        .map((value) => ({
          id: value.id,
          value_en: value.value_en,
          value_ar: value.value_ar,
        })),
    }));
    const attributesCatalog = attributes.map((attribute) => ({
      id: attribute.id,
      name_en: attribute.name_en,
      name_ar: attribute.name_ar,
      type: attribute.type,
      unit_en: attribute.unit_en,
      unit_ar: attribute.unit_ar,
      is_color: attribute.is_color,
      allow_ai_inference: attribute.allow_ai_inference,
      values: (attribute.values ?? [])
        .filter((value) => value.is_active)
        .map((value) => ({
          id: value.id,
          value_en: value.value_en,
          value_ar: value.value_ar,
          color_code: value.color_code,
        })),
    }));

    return [
      'You are an expert ecommerce data entry specialist and SEO optimizer.',
      '',
      'Your job is to receive a raw product and return a fully optimized, clean product ready for publishing.',
      '',
      'DATABASE BRANDS:',
      JSON.stringify(brandsCatalog, null, 2),
      '',
      'DATABASE SPECIFICATIONS:',
      JSON.stringify(specificationsCatalog, null, 2),
      '',
      'DATABASE ATTRIBUTES:',
      JSON.stringify(attributesCatalog, null, 2),
      '',
      'Instructions:',
      '',
      '0. BRAND:',
      '    - The source brand may be missing.',
      '    - Use DATABASE BRANDS plus the title/description to infer the correct brand when possible.',
      '    - Return brand_name as the exact English brand name from DATABASE BRANDS.',
      '    - If no confident brand match exists, return null.',
      '',
      '1. TITLE:',
      '    - Rewrite the title to be SEO-friendly, clear, and concise.',
      '    - Translate the optimized title to Arabic.',
      '',
      '2. DESCRIPTION:',
      '    - Rewrite the description to be engaging, informative, and SEO-optimized.',
      '    - Format it as clean HTML using tags like <ul>, <li>, <strong> - NO inline styles, NO classes.',
      '    - Structure it as a bullet list.',
      '    - If any specification has no match in the database (specification_id = "not_exist"), append it naturally into the HTML description.',
      '    - If any attribute has no match in the database (attribute_id = "not_exist"), append it naturally into the HTML description.',
      '    - Translate the full HTML description to Arabic (keep HTML tags, translate only the text inside them).',
      '',
      '3. SPECIFICATIONS:',
      '    STEP 1 - EXTRACT (do this first, before any matching):',
      '        - Read the product title word by word. Pull out every measurable or descriptive value.',
      '        - Read the product description sentence by sentence. Pull out every measurable or descriptive value.',
      '        - Read every raw specification key-value pair.',
      '        - Combine all extracted values into a single master list.',
      '        - DO NOT skip this step.',
      '',
      '    STEP 2 - CLASSIFY AND MATCH (CRITICAL RULE):',
      '        - Go through the DATABASE SPECIFICATIONS list from top to bottom.',
      '        - Pay STRICT attention to the "allow_ai_inference" flag for each specification:',
      '            * If allow_ai_inference is FALSE: The metric MUST exist in the source data. You ARE EXPLICITLY ALLOWED to match synonyms, typos, and slight naming variations (e.g., source "Response Time" maps to DB "Responsive Time"). This is NOT considered guessing. If the spec name exists in the source but its specific value (e.g., "4ms") is missing from the DB values list, DO NOT skip the specification.',
      '            * If allow_ai_inference is TRUE: You MUST deduce the value based on other specifications, even if the exact word is not explicitly written in the source text.',
      '        - If a category specification has an explicit source value, you MUST include it in the output and MUST NOT omit it.',
      '        - If a category specification has no explicit source value and allow_ai_inference is FALSE, omit it.',
      '        - If a category specification has no explicit source value and allow_ai_inference is TRUE, you MUST infer it and include it.',
      '        - Mark each DB spec as: FOUND, INFERRED, or NOT FOUND.',
      '',
      '    STEP 3 - BUILD the specifications array:',
      '        - For every FOUND or INFERRED DB spec:',
      '            * If the exact value exists in DB -> matched_value_id = <int id>.',
      '            * If the exact value does NOT exist in DB -> matched_value_id = "not_exist", and put the raw string in original_value.name_en.',
      '            * YOU MUST NOT drop a specification just because its value is missing from the DB. Use "not_exist".',
      '            * ONLY when the specification has a unit such as inch, Hz, ms, or GB, NEVER choose the nearest or closest existing database value for measurable data. If the source says "25 inch" and the database has only "24.5 inch", you MUST return "not_exist" and preserve "25 inch" as the original value.',
      '        - For every NOT FOUND DB spec -> skip it entirely.',
      '',
      '4. ATTRIBUTES:',
      '    STEP 1 - EXTRACT:',
      '        - Read the product title/description for color, size, material, language, or variant.',
      '        - Read every raw attribute field.',
      '        - Combine all extracted values into a single master list.',
      '',
      '    STEP 2 - CLASSIFY AND MATCH (CRITICAL RULE):',
      '        - Go through the DATABASE ATTRIBUTES list from top to bottom.',
      '        - Pay STRICT attention to the "allow_ai_inference" flag for each attribute:',
      '            * If allow_ai_inference is FALSE: The value MUST exist in the source data. You ARE EXPLICITLY ALLOWED to match synonyms, typos, and slight naming variations. This is NOT considered guessing. If the attribute exists in the source but its specific value is missing from the DB values list, DO NOT skip the attribute.',
      '            * If allow_ai_inference is TRUE: You MUST deduce ALL applicable values based on context (e.g., if a monitor has "Game Mode" and is a "Business Monitor", you MUST infer BOTH "Gaming" and "Office" usages).',
      '        - If a category attribute has an explicit source value, you MUST include it in the output and MUST NOT omit it.',
      '        - If a category attribute has no explicit source value and allow_ai_inference is FALSE, omit it.',
      '        - If a category attribute has no explicit source value and allow_ai_inference is TRUE, you MUST infer it and include it.',
      '        - Mark each DB attribute as: FOUND, INFERRED, or NOT FOUND.',
      '',
      '    STEP 3 - BUILD the attributes array:',
      '        - For every FOUND or INFERRED DB attribute:',
      '            * An attribute can have MULTIPLE values. If multiple values apply (like multiple Usages or multiple Ports), include ALL of them as separate objects inside the "values" array.',
      '            * If the exact value exists in DB -> matched_value_id = <int id>.',
      '            * If the exact value does NOT exist in DB -> matched_value_id = "not_exist", and put the raw string in original_value.name_en.',
      '            * YOU MUST NOT drop an attribute just because its value is missing from the DB. Use "not_exist".',
      '            * ONLY when the attribute has a unit such as inch, Hz, ms, or GB, NEVER choose the nearest or closest existing database value for measurable data. If the exact raw value is missing, return "not_exist" and preserve the raw value.',
      '            * If the attribute has no unit, do normal text/value matching and do not force a new value based only on this numeric safeguard.',
      '        - For every NOT FOUND DB attribute -> skip it entirely.',
      '',
      '5. META DESCRIPTION: Must be 160 characters or fewer.',
      '6. META TITLE: Must be 70 characters or fewer.',
      '7. SHORT DESCRIPTION: The 4 most important points as clean HTML bullet list.',
      '',
      'STRICT RULES:',
      '    1. DO NOT explain anything.',
      '    2. Output JSON ONLY. No markdown. No comments. No code fences.',
      '',
      'Respond ONLY with a JSON object in this exact format:',
      '{',
      '"brand_name": "<exact english brand name from database> or null",',
      '"title_en": "<seo optimized title in english>",',
      '"title_ar": "<seo optimized title in arabic>",',
      '"meta_title_en": "<meta seo optimized title in english>",',
      '"meta_title_ar": "<meta seo optimized title in arabic>",',
      '"short_description_en": "<4 most important points as HTML bullet list in english>",',
      '"short_description_ar": "<4 most important points as HTML bullet list in arabic>",',
      '"description_en": "<full HTML formatted description in english>",',
      '"description_ar": "<full HTML formatted description in arabic>",',
      '"meta_description_en": "<meta seo optimized description in english, max 160 chars>",',
      '"meta_description_ar": "<meta seo optimized description in arabic, max 160 chars>",',
      '"specifications": [',
      '    {',
      '    "specification_id": <int>,',
      '    "values": [',
      '        {',
      '            "original_value": {',
      '                "name_en": "<raw extracted value in english>",',
      '                "name_ar": "<arabic translation if text, same as name_en if numeric/technical>"',
      '            },',
      '            "matched_value_id": <int> or "not_exist"',
      '        }',
      '    ]',
      '    }',
      '],',
      '"attributes": [',
      '    {',
      '        "attribute": {',
      '            "original_value": "<string>",',
      '            "attribute_id": <int>',
      '        },',
      '        "values": [',
      '            {',
      '            "original_value": "<raw extracted value string>",',
      '            "matched_value_id": <int> or "not_exist"',
      '            }',
      '        ]',
      '    }',
      ']',
      '}',
    ].join('\n');
  }

  private getObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    return value as Record<string, unknown>;
  }

  private firstNonEmptyString(values: unknown[]): string | null {
    for (const value of values) {
      const normalized = this.requireOptionalString(value);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private firstDefinedValue(values: unknown[]): unknown {
    for (const value of values) {
      if (value !== undefined && value !== null) {
        return value;
      }
    }

    return undefined;
  }

  private getOpenAiLogPath(): string {
    const configuredPath = process.env.PRODUCT_IMPORT_OPENAI_LOG_PATH?.trim();

    if (!configuredPath) {
      return DEFAULT_OPENAI_LOG_PATH;
    }

    return isAbsolute(configuredPath)
      ? configuredPath
      : resolvePath(process.cwd(), configuredPath);
  }

  private buildOpenAiLogEntry(input: {
    model: string;
    openAiInput: Array<{ role: string; content: string }>;
    rawProductInput: NormalizedImportPayload;
    sourceFile: string | null;
    openAiResponse?: unknown;
    rawOutputText?: string | null;
    parsedOutput?: ImportAiResult;
    errorMessage?: string;
  }): Record<string, unknown> {
    return {
      timestamp: new Date().toISOString(),
      source_file: input.sourceFile,
      model: input.model,
      raw_product_input: input.rawProductInput,
      openai_input: input.openAiInput,
      openai_response: input.openAiResponse ?? null,
      raw_output_text: input.rawOutputText ?? null,
      parsed_output: input.parsedOutput ?? null,
      error: input.errorMessage ?? null,
    };
  }

  private async appendOpenAiLog(entry: Record<string, unknown>): Promise<void> {
    try {
      const logPath = this.getOpenAiLogPath();
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      this.logger.warn(
        `Failed to append OpenAI import log: ${getErrorMessage(error)}`,
      );
    }
  }

  private requireString(value: unknown, fieldName: string): string {
    const normalized = this.requireOptionalString(value);
    if (!normalized) {
      throw new BadRequestException(`${fieldName} is missing in the AI response.`);
    }

    return normalized;
  }

  private requireOptionalString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized ? normalized : null;
  }

  private extractPositiveInteger(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isInteger(value) && value > 0 ? value : null;
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!normalized) {
        return null;
      }

      const parsed = Number(normalized);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    }

    return null;
  }

  private extractFirstPositiveInteger(value: unknown): number | null {
    if (!Array.isArray(value)) {
      return null;
    }

    for (const item of value) {
      const parsed = this.extractPositiveInteger(item);
      if (parsed) {
        return parsed;
      }
    }

    return null;
  }

  private extractNumber(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
      const normalized = value.trim();
      if (!normalized) {
        return null;
      }

      const parsed = Number(normalized.replace(/,/g, ''));
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }
}