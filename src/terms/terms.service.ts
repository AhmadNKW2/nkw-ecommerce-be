import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  MessageEvent,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Observable, interval } from 'rxjs';
import { map, startWith, takeWhile } from 'rxjs/operators';
import { TermGroup } from './entities/term-group.entity';
import { GenerateTermsDto } from './dto/generate-terms.dto';
import { CreateTermGroupDto } from './dto/create-term-group.dto';
import { UpdateTermGroupDto } from './dto/update-term-group.dto';
import { TermConceptSynonymSyncService } from '../typesense/term-concept-synonym-sync.service';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { Category, CategoryStatus } from '../categories/entities/category.entity';
import { ProductCategory } from '../products/entities/product-category.entity';

type ConceptCluster = {
  concept_key: string;
  concept_label_en: string;
  concept_label_ar: string;
  terms_en: string[];
  terms_ar: string[];
  reference_product_ids: number[];
};

type TermsGenerationJob = {
  status: 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
  startedAt: Date;
  finishedAt?: Date;
  progress: number;
  total: number;
  cancellationRequested: boolean;
  current_concept_key?: string;
  current_concept_label_en?: string;
  error?: string;
  result?: {
    processed_products: number;
    detected_concepts: number;
    updated_groups: number;
    failed_concepts: number;
    updated: Array<{
      concept_key: string;
      concept_label_en: string;
      concept_label_ar: string;
      terms_en_count: number;
      terms_ar_count: number;
    }>;
    failed: Array<{ concept_key: string; error: string }>;
  };
};

type OpenAiConceptOutput = {
  concepts: Array<{
    concept_key?: string;
    concept_label_en?: string;
    concept_label_ar?: string;
    terms_en?: string[];
    terms_ar?: string[];
    reference_product_ids?: number[];
  }>;
};

@Injectable()
export class TermsService implements OnModuleInit {
  private readonly logger = new Logger(TermsService.name);
  private readonly termsJobs = new Map<string, TermsGenerationJob>();

  constructor(
    @InjectRepository(TermGroup)
    private readonly termGroupsRepository: Repository<TermGroup>,
    @InjectRepository(Product)
    private readonly productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private readonly categoriesRepository: Repository<Category>,
    @InjectRepository(ProductCategory)
    private readonly productCategoriesRepository: Repository<ProductCategory>,
    private readonly termConceptSynonymSync: TermConceptSynonymSyncService,
  ) {}

  async onModuleInit() {
    await this.syncConceptSynonymsToTypesense();
  }

  private createTermsJob(): string {
    const jobId = `terms-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.termsJobs.set(jobId, {
      status: 'running',
      startedAt: new Date(),
      progress: 0,
      total: 0,
      cancellationRequested: false,
    });
    setTimeout(() => this.termsJobs.delete(jobId), 24 * 60 * 60 * 1000).unref?.();
    return jobId;
  }

  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private normalizeArabic(value: string): string {
    return this.normalizeWhitespace(value)
      .replace(/[\u064B-\u065F\u0670]/g, '')
      .replace(/[ـ]/g, '')
      .replace(/[أإآ]/g, 'ا')
      .replace(/[ؤ]/g, 'و')
      .replace(/[ئ]/g, 'ي')
      .replace(/[ى]/g, 'ي')
      .replace(/[ة]/g, 'ه');
  }

  private normalizeEnglish(value: string): string {
    return this.normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim();
  }

  private levenshteinDistanceWithinOne(a: string, b: string): boolean {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;

    let i = 0;
    let j = 0;
    let edits = 0;

    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i += 1;
        j += 1;
        continue;
      }
      edits += 1;
      if (edits > 1) return false;

      if (a.length > b.length) {
        i += 1;
      } else if (b.length > a.length) {
        j += 1;
      } else {
        i += 1;
        j += 1;
      }
    }

    if (i < a.length || j < b.length) {
      edits += 1;
    }

    return edits <= 1;
  }

  private isLikelyInvalidTerm(value: string): boolean {
    const normalized = value.trim();
    if (!normalized) {
      return true;
    }

    const lower = normalized.toLowerCase();
    return (
      lower.includes('model') ||
      lower.includes('brand') ||
      /(ddr\d|gb|tb|mhz|inch|mm|cm|ssd|hdd|nvme|pcie|gen\s?\d|i[3579])/.test(lower) ||
      /(^|\s)\d+(\.\d+)?\s?(gb|tb|mhz|hz|inch|in|mm|cm|w|v)(\s|$)/.test(lower) ||
      /\b(upgrade|module|for|with|gaming|enterprise|data center)\b/.test(lower) ||
      normalized.includes('موديل') ||
      normalized.includes('ماركة') ||
      /(ترقية|موديول|للابتوب|للابتوبات|للبيسي|للـ ?pc|للخادم|سيرفرات|مركز بيانات|احترافي)/.test(
        normalized,
      ) ||
      /(جيجا|تيرا|بوصة|إنش|رام\s?\d+|ddr\d)/.test(normalized)
    );
  }

  private chunkArray<T>(items: T[], chunkSize: number): T[][] {
    if (chunkSize <= 0) return [items];
    const chunks: T[][] = [];
    for (let index = 0; index < items.length; index += chunkSize) {
      chunks.push(items.slice(index, index + chunkSize));
    }
    return chunks;
  }

  private normalizeAndDedupeTerms(terms: string[], language: 'en' | 'ar'): string[] {
    const deduped: string[] = [];
    const seen = new Set<string>();

    for (const term of terms) {
      if (typeof term !== 'string') continue;

      const cleaned = this.normalizeWhitespace(term);
      if (!cleaned || this.isLikelyInvalidTerm(cleaned)) continue;

      const key = language === 'ar' ? this.normalizeArabic(cleaned) : this.normalizeEnglish(cleaned);
      if (!key) continue;

      let duplicate = seen.has(key);
      if (!duplicate && language === 'en') {
        for (const existing of seen) {
          if (this.levenshteinDistanceWithinOne(existing, key)) {
            duplicate = true;
            break;
          }
        }
      }

      if (duplicate) continue;

      seen.add(key);
      deduped.push(cleaned);
    }

    return deduped;
  }

  private normalizeConceptKey(value: string): string {
    const normalized = this.normalizeArabic(this.normalizeEnglish(value));
    return normalized
      .replace(/[^a-z0-9\u0600-\u06ff\s]/g, '')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 120);
  }

  private mergeNearDuplicateConceptKeys(concepts: ConceptCluster[]): ConceptCluster[] {
    const merged = new Map<string, ConceptCluster>();

    for (const concept of concepts) {
      let key = this.normalizeConceptKey(concept.concept_key || concept.concept_label_en || concept.concept_label_ar);
      if (!key) {
        key = this.normalizeConceptKey(concept.terms_en[0] || concept.terms_ar[0] || 'concept');
      }

      let targetKey = key;
      for (const existingKey of merged.keys()) {
        if (existingKey === key || this.levenshteinDistanceWithinOne(existingKey, key)) {
          targetKey = existingKey;
          break;
        }
      }

      const existing = merged.get(targetKey);
      if (!existing) {
        merged.set(targetKey, {
          ...concept,
          concept_key: targetKey,
          terms_en: this.normalizeAndDedupeTerms(concept.terms_en ?? [], 'en'),
          terms_ar: this.normalizeAndDedupeTerms(concept.terms_ar ?? [], 'ar'),
          reference_product_ids: [...new Set(concept.reference_product_ids ?? [])],
        });
        continue;
      }

      existing.terms_en = this.normalizeAndDedupeTerms(
        [...existing.terms_en, ...(concept.terms_en ?? [])],
        'en',
      );
      existing.terms_ar = this.normalizeAndDedupeTerms(
        [...existing.terms_ar, ...(concept.terms_ar ?? [])],
        'ar',
      );
      existing.reference_product_ids = [
        ...new Set([...(existing.reference_product_ids ?? []), ...(concept.reference_product_ids ?? [])]),
      ];

      if (!existing.concept_label_en && concept.concept_label_en) {
        existing.concept_label_en = concept.concept_label_en;
      }
      if (!existing.concept_label_ar && concept.concept_label_ar) {
        existing.concept_label_ar = concept.concept_label_ar;
      }
    }

    return [...merged.values()].filter((concept) => concept.terms_en.length > 0 || concept.terms_ar.length > 0);
  }

  private mergeConceptIntoAccumulator(
    accumulator: Map<string, ConceptCluster>,
    concept: ConceptCluster,
  ): ConceptCluster | null {
    const normalizedEn = this.normalizeAndDedupeTerms(concept.terms_en ?? [], 'en');
    const normalizedAr = this.normalizeAndDedupeTerms(concept.terms_ar ?? [], 'ar');
    if (normalizedEn.length === 0 && normalizedAr.length === 0) {
      return null;
    }

    let key = this.normalizeConceptKey(
      concept.concept_key || concept.concept_label_en || concept.concept_label_ar || normalizedEn[0] || normalizedAr[0],
    );
    if (!key) {
      return null;
    }

    for (const existingKey of accumulator.keys()) {
      if (existingKey === key || this.levenshteinDistanceWithinOne(existingKey, key)) {
        key = existingKey;
        break;
      }
    }

    const existing = accumulator.get(key);
    if (!existing) {
      const created: ConceptCluster = {
        concept_key: key,
        concept_label_en: concept.concept_label_en || normalizedEn[0] || '',
        concept_label_ar: concept.concept_label_ar || normalizedAr[0] || '',
        terms_en: normalizedEn,
        terms_ar: normalizedAr,
        reference_product_ids: [...new Set(concept.reference_product_ids ?? [])],
      };
      accumulator.set(key, created);
      return created;
    }

    existing.terms_en = this.normalizeAndDedupeTerms([...existing.terms_en, ...normalizedEn], 'en');
    existing.terms_ar = this.normalizeAndDedupeTerms([...existing.terms_ar, ...normalizedAr], 'ar');
    existing.reference_product_ids = [
      ...new Set([...(existing.reference_product_ids ?? []), ...(concept.reference_product_ids ?? [])]),
    ];
    if (!existing.concept_label_en && concept.concept_label_en) {
      existing.concept_label_en = concept.concept_label_en;
    }
    if (!existing.concept_label_ar && concept.concept_label_ar) {
      existing.concept_label_ar = concept.concept_label_ar;
    }

    return existing;
  }

  private getOpenAiApiKey(): string {
    const openAiKey = process.env.OPENAI_API_KEY?.trim();
    if (!openAiKey) {
      throw new BadRequestException('Missing OPENAI_API_KEY environment variable.');
    }
    return openAiKey;
  }

  private extractOpenAiText(body: Record<string, unknown>): string {
    if (typeof body.output_text === 'string' && body.output_text.trim().length > 0) {
      return body.output_text;
    }

    const output = Array.isArray(body.output)
      ? (body.output as Array<Record<string, unknown>>)
      : [];

    for (const item of output) {
      const content = Array.isArray(item.content)
        ? (item.content as Array<Record<string, unknown>>)
        : [];

      for (const contentItem of content) {
        if (typeof contentItem.text === 'string' && contentItem.text.trim().length > 0) {
          return contentItem.text;
        }
      }
    }

    throw new BadRequestException('OpenAI response did not include text output.');
  }

  private async generateConceptClustersWithOpenAi(input: {
    productIds: number[];
    productNamesEn: string[];
    productNamesAr: string[];
    model?: string;
  }): Promise<ConceptCluster[]> {
    const model =
      input.model?.trim() ||
      process.env.TERMS_OPENAI_MODEL?.trim() ||
      process.env.CATEGORY_TAGS_OPENAI_MODEL?.trim() ||
      process.env.OPENAI_MODEL?.trim() ||
      'gpt-5.4';
    const openAiKey = this.getOpenAiApiKey();

    const requestBody = {
      model,
      input: [
        {
          role: 'system',
          content:
            'You generate global bilingual concept term groups from product titles. Return strict JSON only with key concepts (array). Each product title maps to exactly one dominant concept only. Never split one title into multiple concepts. Merge semantically equal concepts together. For each concept output concept_key, concept_label_en, concept_label_ar, terms_en, terms_ar, reference_product_ids. Concept labels must be short core product nouns such as ssd, keyboard, laptop, bag.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Cluster product titles into dominant concepts and generate one synonym group per concept.',
            rules: {
              include: [
                'Direct synonyms and spelling variants of the same concept only',
                'Arabic colloquial Levant + Modern Standard Arabic variants',
                'Arabic variants used by Syria/Jordan/Levant public speech (عامية) and formal Arabic (فصحى)',
                'Common misspellings and orthographic variants customers actually type',
                'Plural and singular variants when used in search',
                'Concept label must be core noun (no modifiers)',
                'Concept keys must stay stable and reusable across similar products',
              ],
              exclude: [
                'Brands, model numbers, capacities, dimensions, technical specs',
                'Composite/cross-intent phrases like laptop ram, server ram upgrade',
                'Any term that mixes more than one concept intent',
                'Labels like internal ssd, mechanical keyboard, workstation laptop, laptop bag',
              ],
              examples: {
                dominant_concept: [
                  {
                    title: 'laptop ram 32gb',
                    concept: 'ram',
                  },
                  {
                    title: 'ram for laptop 16gb xpg',
                    concept: 'ram',
                  },
                ],
                arabic_variants: [
                  {
                    concept: 'bag',
                    terms_ar: ['حقيبة', 'شنطة', 'شنطه', 'شنتة', 'شنتا', 'شنتاية', 'شناتي', 'حقائب'],
                  },
                ],
                core_labeling: [
                  { input: 'Internal SSD', output: 'ssd' },
                  { input: 'Mechanical keyboard', output: 'keyboard' },
                  { input: 'Workstation laptop', output: 'laptop' },
                  { input: 'Laptop bag', output: 'bag' },
                ],
              },
              output_json_shape: {
                concepts: [
                  {
                    concept_key: 'string',
                    concept_label_en: 'string',
                    concept_label_ar: 'string',
                    terms_en: ['string'],
                    terms_ar: ['string'],
                    reference_product_ids: [123],
                  },
                ],
              },
            },
            product_ids: input.productIds,
            product_names: {
              en: input.productNamesEn,
              ar: input.productNamesAr,
            },
          }),
        },
      ],
    };

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${openAiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new BadRequestException(
        `OpenAI request failed (${response.status}): ${responseText}`,
      );
    }

    let parsedBody: Record<string, unknown>;
    try {
      parsedBody = JSON.parse(responseText) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('OpenAI response was not valid JSON.');
    }

    const rawText = this.extractOpenAiText(parsedBody)
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    let parsedOutput: OpenAiConceptOutput;
    try {
      parsedOutput = JSON.parse(rawText) as OpenAiConceptOutput;
    } catch {
      throw new BadRequestException('OpenAI output was not valid JSON.');
    }

    if (!Array.isArray(parsedOutput.concepts)) {
      return [];
    }

    return parsedOutput.concepts
      .map((concept) => ({
        concept_key: String(concept.concept_key ?? ''),
        concept_label_en: String(concept.concept_label_en ?? ''),
        concept_label_ar: String(concept.concept_label_ar ?? ''),
        terms_en: Array.isArray(concept.terms_en)
          ? concept.terms_en.filter((value): value is string => typeof value === 'string')
          : [],
        terms_ar: Array.isArray(concept.terms_ar)
          ? concept.terms_ar.filter((value): value is string => typeof value === 'string')
          : [],
        reference_product_ids: Array.isArray(concept.reference_product_ids)
          ? concept.reference_product_ids
              .map((value) => Number(value))
              .filter((value) => Number.isInteger(value) && value > 0)
          : [],
      }))
      .filter((concept) => concept.terms_en.length > 0 || concept.terms_ar.length > 0);
  }

  private async replaceAllConceptGroups(concepts: ConceptCluster[]): Promise<void> {
    await this.termGroupsRepository.query(`
      ALTER TABLE term_groups
      ADD COLUMN IF NOT EXISTS reference_product_ids integer[] NOT NULL DEFAULT '{}'
    `);
    await this.termGroupsRepository.clear();

    if (concepts.length === 0) {
      return;
    }

    const entities = concepts.map((concept) =>
      this.termGroupsRepository.create({
        concept_key: concept.concept_key,
        concept_label_en: concept.concept_label_en || concept.terms_en[0] || null,
        concept_label_ar: concept.concept_label_ar || concept.terms_ar[0] || null,
        terms_en: concept.terms_en,
        terms_ar: concept.terms_ar,
        reference_product_ids: [...new Set(concept.reference_product_ids)].sort((a, b) => a - b),
        source_product_id: null,
      }),
    );

    await this.termGroupsRepository.save(entities);
  }

  private async upsertConceptGroup(concept: ConceptCluster): Promise<void> {
    const conceptKey = this.normalizeConceptKey(concept.concept_key);
    if (!conceptKey) return;

    const existing = await this.termGroupsRepository.findOne({
      where: { concept_key: conceptKey },
    });

    if (!existing) {
      const created = this.termGroupsRepository.create({
        concept_key: conceptKey,
        concept_label_en: concept.concept_label_en || concept.terms_en[0] || null,
        concept_label_ar: concept.concept_label_ar || concept.terms_ar[0] || null,
        terms_en: this.normalizeAndDedupeTerms(concept.terms_en ?? [], 'en'),
        terms_ar: this.normalizeAndDedupeTerms(concept.terms_ar ?? [], 'ar'),
        reference_product_ids: [...new Set(concept.reference_product_ids ?? [])].sort((a, b) => a - b),
        source_product_id: null,
      });
      await this.termGroupsRepository.save(created);
      return;
    }

    existing.concept_label_en = existing.concept_label_en || concept.concept_label_en || concept.terms_en[0] || null;
    existing.concept_label_ar = existing.concept_label_ar || concept.concept_label_ar || concept.terms_ar[0] || null;
    existing.terms_en = this.normalizeAndDedupeTerms([...(existing.terms_en ?? []), ...(concept.terms_en ?? [])], 'en');
    existing.terms_ar = this.normalizeAndDedupeTerms([...(existing.terms_ar ?? []), ...(concept.terms_ar ?? [])], 'ar');
    existing.reference_product_ids = [
      ...new Set([...(existing.reference_product_ids ?? []), ...(concept.reference_product_ids ?? [])]),
    ].sort((a, b) => a - b);
    await this.termGroupsRepository.save(existing);
  }

  private async resolveScopedCategoryIds(selectedCategoryIds: number[]): Promise<Set<number>> {
    const activeCategories = await this.categoriesRepository.find({
      where: { status: CategoryStatus.ACTIVE },
      select: { id: true, parent_id: true },
    });

    const categoryById = new Map(activeCategories.map((category) => [category.id, category]));
    if (selectedCategoryIds.length > 0) {
      const missing = selectedCategoryIds.filter((id) => !categoryById.has(id));
      if (missing.length > 0) {
        throw new NotFoundException(`Selected categories not found or archived: ${missing.join(', ')}`);
      }
    }

    if (selectedCategoryIds.length === 0) {
      return new Set(activeCategories.map((category) => category.id));
    }

    const childrenByParent = new Map<number, number[]>();
    for (const category of activeCategories) {
      if (category.parent_id === null) continue;
      const list = childrenByParent.get(category.parent_id) ?? [];
      list.push(category.id);
      childrenByParent.set(category.parent_id, list);
    }

    const scoped = new Set<number>();
    const queue = [...selectedCategoryIds];
    while (queue.length > 0) {
      const current = queue.shift() as number;
      if (scoped.has(current)) continue;
      scoped.add(current);
      queue.push(...(childrenByParent.get(current) ?? []));
    }

    return scoped;
  }

  private async fetchScopedProducts(
    scopeCategoryIds: Set<number>,
  ): Promise<Array<{ id: number; name_en: string; name_ar: string }>> {
    const allowedStatuses = [ProductStatus.ACTIVE, ProductStatus.UPDATED, ProductStatus.REVIEW];

    const directRows = await this.productsRepository
      .createQueryBuilder('product')
      .select('product.id', 'id')
      .addSelect('product.name_en', 'name_en')
      .addSelect('product.name_ar', 'name_ar')
      .where('product.status IN (:...allowedStatuses)', { allowedStatuses })
      .andWhere('product.category_id IN (:...categoryIds)', { categoryIds: [...scopeCategoryIds] })
      .getRawMany<{ id: number; name_en: string | null; name_ar: string | null }>();

    const junctionRows = await this.productCategoriesRepository
      .createQueryBuilder('pc')
      .innerJoin(
        Product,
        'product',
        'product.id = pc.product_id AND product.status IN (:...allowedStatuses)',
        { allowedStatuses },
      )
      .select('product.id', 'id')
      .addSelect('product.name_en', 'name_en')
      .addSelect('product.name_ar', 'name_ar')
      .where('pc.category_id IN (:...categoryIds)', { categoryIds: [...scopeCategoryIds] })
      .getRawMany<{ id: number; name_en: string | null; name_ar: string | null }>();

    const productsById = new Map<number, { id: number; name_en: string; name_ar: string }>();
    for (const row of [...directRows, ...junctionRows]) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) {
        continue;
      }
      const current = productsById.get(id) ?? { id, name_en: '', name_ar: '' };
      if (row.name_en?.trim()) current.name_en = this.normalizeWhitespace(row.name_en);
      if (row.name_ar?.trim()) current.name_ar = this.normalizeWhitespace(row.name_ar);
      productsById.set(id, current);
    }

    return [...productsById.values()];
  }

  async listTermGroups(input: {
    page?: number;
    perPage?: number;
    search?: string;
  }) {
    const page = Number.isInteger(input.page) && (input.page as number) > 0 ? (input.page as number) : 1;
    const perPage =
      Number.isInteger(input.perPage) && (input.perPage as number) > 0
        ? Math.min(input.perPage as number, 200)
        : 50;

    const qb = this.termGroupsRepository.createQueryBuilder('termGroup').orderBy('termGroup.id', 'ASC');

    if (input.search) {
      const search = `%${input.search.trim()}%`;
      qb.where(
        `termGroup.concept_key ILIKE :search
         OR termGroup.concept_label_en ILIKE :search
         OR termGroup.concept_label_ar ILIKE :search
         OR EXISTS (SELECT 1 FROM unnest(termGroup.terms_en) AS term_en WHERE term_en ILIKE :search)
         OR EXISTS (SELECT 1 FROM unnest(termGroup.terms_ar) AS term_ar WHERE term_ar ILIKE :search)`,
        { search },
      );
    }

    const [items, total] = await qb.skip((page - 1) * perPage).take(perPage).getManyAndCount();

    return {
      items: items.map((group) => this.mapTermGroup(group)),
      total,
      page,
      per_page: perPage,
      total_pages: Math.ceil(total / perPage),
    };
  }

  async getConceptCoverage() {
    const allowedStatuses = [ProductStatus.ACTIVE, ProductStatus.UPDATED, ProductStatus.REVIEW];

    const totalProducts = await this.productsRepository.count({
      where: { status: In(allowedStatuses) },
    });

    const conceptGroups = await this.termGroupsRepository.count();

    const referencedRow = await this.termGroupsRepository.query(`
      SELECT COUNT(DISTINCT unnest_id)::int AS count
      FROM (
        SELECT unnest(reference_product_ids) AS unnest_id
        FROM term_groups
      ) t
    `);
    const referencedProducts = Number(referencedRow?.[0]?.count ?? 0);

    const unreferencedRow = await this.productsRepository.query(
      `
      SELECT COUNT(*)::int AS count
      FROM products p
      WHERE p.status::text = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM term_groups tg
          WHERE p.id = ANY(tg.reference_product_ids)
        )
    `,
      [allowedStatuses],
    );
    const unreferencedProducts = Number(unreferencedRow?.[0]?.count ?? 0);

    const sampleRows = await this.productsRepository.query(
      `
      SELECT p.id, p.name_en
      FROM products p
      WHERE p.status::text = ANY($1::text[])
        AND NOT EXISTS (
          SELECT 1 FROM term_groups tg
          WHERE p.id = ANY(tg.reference_product_ids)
        )
      ORDER BY p.id
      LIMIT 15
    `,
      [allowedStatuses],
    );

    return {
      total_products: totalProducts,
      concept_groups: conceptGroups,
      referenced_products: referencedProducts,
      unreferenced_products: unreferencedProducts,
      sample_unreferenced: sampleRows as Array<{ id: number; name_en: string | null }>,
    };
  }

  async getTermGroup(id: number) {
    const group = await this.termGroupsRepository.findOne({ where: { id } });
    if (!group) {
      throw new NotFoundException('Concept not found');
    }
    return this.mapTermGroup(group);
  }

  async createTermGroup(dto: CreateTermGroupDto) {
    const conceptKey = this.normalizeConceptKey(dto.concept_key);
    if (!conceptKey) {
      throw new BadRequestException('concept_key is required and must contain valid characters');
    }

    const existing = await this.termGroupsRepository.findOne({ where: { concept_key: conceptKey } });
    if (existing) {
      throw new ConflictException(`Concept key "${conceptKey}" already exists`);
    }

    const created = this.termGroupsRepository.create({
      concept_key: conceptKey,
      concept_label_en: dto.concept_label_en?.trim() || null,
      concept_label_ar: dto.concept_label_ar?.trim() || null,
      terms_en: this.normalizeAndDedupeTerms(dto.terms_en ?? [], 'en'),
      terms_ar: this.normalizeAndDedupeTerms(dto.terms_ar ?? [], 'ar'),
      reference_product_ids: this.normalizeReferenceProductIds(dto.reference_product_ids ?? []),
      source_product_id: null,
    });

    const saved = await this.termGroupsRepository.save(created);
    await this.syncConceptSynonymsToTypesense();
    return this.mapTermGroup(saved);
  }

  async updateTermGroup(id: number, dto: UpdateTermGroupDto) {
    const group = await this.termGroupsRepository.findOne({ where: { id } });
    if (!group) {
      throw new NotFoundException('Concept not found');
    }

    if (dto.concept_key !== undefined) {
      const conceptKey = this.normalizeConceptKey(dto.concept_key);
      if (!conceptKey) {
        throw new BadRequestException('concept_key must contain valid characters');
      }

      if (conceptKey !== group.concept_key) {
        const duplicate = await this.termGroupsRepository.findOne({ where: { concept_key: conceptKey } });
        if (duplicate && duplicate.id !== id) {
          throw new ConflictException(`Concept key "${conceptKey}" already exists`);
        }
        group.concept_key = conceptKey;
      }
    }

    if (dto.concept_label_en !== undefined) {
      group.concept_label_en = dto.concept_label_en?.trim() || null;
    }
    if (dto.concept_label_ar !== undefined) {
      group.concept_label_ar = dto.concept_label_ar?.trim() || null;
    }
    if (dto.terms_en !== undefined) {
      group.terms_en = this.normalizeAndDedupeTerms(dto.terms_en, 'en');
    }
    if (dto.terms_ar !== undefined) {
      group.terms_ar = this.normalizeAndDedupeTerms(dto.terms_ar, 'ar');
    }
    if (dto.reference_product_ids !== undefined) {
      group.reference_product_ids = this.normalizeReferenceProductIds(dto.reference_product_ids);
    }

    const saved = await this.termGroupsRepository.save(group);
    await this.syncConceptSynonymsToTypesense();
    return this.mapTermGroup(saved);
  }

  async deleteTermGroup(id: number) {
    const group = await this.termGroupsRepository.findOne({ where: { id } });
    if (!group) {
      throw new NotFoundException('Concept not found');
    }

    await this.termGroupsRepository.remove(group);
    await this.syncConceptSynonymsToTypesense();
    return {
      message: 'Concept deleted successfully.',
      group_id: id,
    };
  }

  private mapTermGroup(group: TermGroup) {
    return {
      group_id: group.id,
      concept_key: group.concept_key,
      concept_label_en: group.concept_label_en,
      concept_label_ar: group.concept_label_ar,
      terms_en: group.terms_en ?? [],
      terms_ar: group.terms_ar ?? [],
      reference_product_ids: group.reference_product_ids ?? [],
    };
  }

  private normalizeReferenceProductIds(ids: number[]): number[] {
    return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  }

  private async syncConceptSynonymsToTypesense(): Promise<void> {
    try {
      const groups = await this.termGroupsRepository.find({
        order: { id: 'ASC' },
      });
      await this.termConceptSynonymSync.syncGroups(groups);
    } catch (error) {
      this.logger.warn(
        `Failed to sync concept synonyms to Typesense: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async startTermsGeneration(dto: GenerateTermsDto) {
    const jobId = this.createTermsJob();

    this.runTermsGenerationJob(jobId, dto).catch((error: unknown) => {
      const job = this.termsJobs.get(jobId);
      if (!job) return;

      job.status = 'failed';
      job.finishedAt = new Date();
      job.error = error instanceof Error ? error.message : String(error);
      this.logger.error(`Terms job ${jobId} failed`, error as Error);
    });

    return {
      job_id: jobId,
      status: 'running',
      started_at: new Date(),
    };
  }

  async clearAllConcepts() {
    await this.termGroupsRepository.clear();
    await this.syncConceptSynonymsToTypesense();
    return {
      message: 'All concepts removed successfully.',
    };
  }

  getTermsGenerationJob(jobId: string) {
    const job = this.termsJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Terms job not found');
    }

    return {
      job_id: jobId,
      status: job.status,
      started_at: job.startedAt,
      finished_at: job.finishedAt ?? null,
      progress: job.progress,
      total: job.total,
      current_concept_key: job.current_concept_key ?? null,
      current_concept_label_en: job.current_concept_label_en ?? null,
      result: job.result ?? null,
      error: job.error ?? null,
      duration_seconds: job.finishedAt
        ? Math.round((job.finishedAt.getTime() - job.startedAt.getTime()) / 1000)
        : Math.round((Date.now() - job.startedAt.getTime()) / 1000),
    };
  }

  cancelTermsGenerationJob(jobId: string) {
    const job = this.termsJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Terms job not found');
    }

    if (job.status !== 'running' && job.status !== 'paused') {
      return {
        job_id: jobId,
        status: job.status,
        message: 'Job is not active.',
      };
    }

    job.cancellationRequested = true;
    job.status = 'cancelled';
    job.finishedAt = new Date();
    return {
      job_id: jobId,
      status: 'cancelled',
      message: 'Job cancelled.',
    };
  }

  pauseTermsGenerationJob(jobId: string) {
    const job = this.termsJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Terms job not found');
    }

    if (job.status !== 'running') {
      return {
        job_id: jobId,
        status: job.status,
        message: 'Job is not running.',
      };
    }

    job.status = 'paused';
    return {
      job_id: jobId,
      status: job.status,
      message: 'Job paused.',
    };
  }

  resumeTermsGenerationJob(jobId: string) {
    const job = this.termsJobs.get(jobId);
    if (!job) {
      throw new NotFoundException('Terms job not found');
    }

    if (job.status !== 'paused') {
      return {
        job_id: jobId,
        status: job.status,
        message: 'Job is not paused.',
      };
    }

    job.status = 'running';
    return {
      job_id: jobId,
      status: job.status,
      message: 'Job resumed.',
    };
  }

  private async waitIfPaused(job: TermsGenerationJob): Promise<void> {
    while (job.status === 'paused' && !job.cancellationRequested) {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }

  streamTermsGenerationJob(jobId: string): Observable<MessageEvent> {
    return interval(1000).pipe(
      startWith(0),
      map(() => ({ data: this.getTermsGenerationJob(jobId) }) as MessageEvent),
      takeWhile((event) => {
        const payload = event.data as { status?: string } | undefined;
        return payload?.status === 'running' || payload?.status === 'paused';
      }, true),
    );
  }

  private async runTermsGenerationJob(jobId: string, dto: GenerateTermsDto): Promise<void> {
    const job = this.termsJobs.get(jobId);
    if (!job) return;

    const selectedCategoryIds = [
      ...new Set(
        (dto.category_ids ?? []).filter(
          (categoryId) => Number.isInteger(categoryId) && categoryId > 0,
        ),
      ),
    ];

    const scopedCategoryIds = await this.resolveScopedCategoryIds(selectedCategoryIds);
    const scopedProducts = await this.fetchScopedProducts(scopedCategoryIds);
    if (scopedProducts.length === 0) {
      throw new BadRequestException('No eligible products found for concept generation.');
    }

    // Progress is product-based for UI clarity and SSE updates.
    job.total = scopedProducts.length;
    job.progress = 0;
    job.current_concept_label_en = 'Preparing concepts';
    const productChunks = this.chunkArray(scopedProducts, 1);
    const accumulatedConcepts = new Map<string, ConceptCluster>();
    const failed: Array<{ concept_key: string; error: string }> = [];
    const updated = new Map<
      string,
      {
        concept_key: string;
        concept_label_en: string;
        concept_label_ar: string;
        terms_en_count: number;
        terms_ar_count: number;
      }
    >();
    job.result = {
      processed_products: 0,
      detected_concepts: 0,
      updated_groups: 0,
      failed_concepts: 0,
      updated: [],
      failed: [],
    };

    for (let chunkIndex = 0; chunkIndex < productChunks.length; chunkIndex += 1) {
      await this.waitIfPaused(job);
      if (job.cancellationRequested) {
        job.finishedAt = new Date();
        job.status = 'cancelled';
        return;
      }

      const chunk = productChunks[chunkIndex];
      const productIds = chunk.map((product) => product.id);
      const productHint = chunk[0]?.name_en || chunk[0]?.name_ar || `Product ${chunkIndex + 1}`;
      const productNamesEn = chunk
        .map((product) => product.name_en)
        .filter((name) => !!name);
      const productNamesAr = chunk
        .map((product) => product.name_ar)
        .filter((name) => !!name);

      if (productNamesEn.length === 0 && productNamesAr.length === 0) {
        job.progress = Math.min(scopedProducts.length, job.progress + 1);
        job.result.processed_products = job.progress;
        continue;
      }

      job.current_concept_label_en = productHint;
      try {
        const chunkConcepts = await this.generateConceptClustersWithOpenAi({
          productIds,
          productNamesEn,
          productNamesAr,
          model: dto.model,
        });
        const mergedChunkConcepts = this.mergeNearDuplicateConceptKeys(chunkConcepts);
        for (const concept of mergedChunkConcepts) {
          const merged = this.mergeConceptIntoAccumulator(accumulatedConcepts, concept);
          if (!merged) {
            continue;
          }
          job.current_concept_key = merged.concept_key;
          job.current_concept_label_en = merged.concept_label_en || merged.concept_label_ar || productHint;
          await this.upsertConceptGroup(merged);
          updated.set(merged.concept_key, {
            concept_key: merged.concept_key,
            concept_label_en: merged.concept_label_en || '',
            concept_label_ar: merged.concept_label_ar || '',
            terms_en_count: merged.terms_en.length,
            terms_ar_count: merged.terms_ar.length,
          });
        }
      } catch (error: unknown) {
        failed.push({
          concept_key: `product_${productIds[0] ?? chunkIndex + 1}`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      job.progress = Math.min(scopedProducts.length, job.progress + 1);
      job.result.processed_products = job.progress;
      job.result.detected_concepts = accumulatedConcepts.size;
      job.result.updated_groups = accumulatedConcepts.size;
      job.result.failed_concepts = failed.length;
      job.result.updated = [...updated.values()];
      job.result.failed = [...failed];
    }
    if (accumulatedConcepts.size === 0 && failed.length > 0) {
      throw new BadRequestException('No valid concepts were generated by AI.');
    }
    job.current_concept_label_en = undefined;
    if (job.result) {
      job.result.processed_products = job.progress;
      job.result.detected_concepts = accumulatedConcepts.size;
      job.result.updated_groups = accumulatedConcepts.size;
      job.result.failed_concepts = failed.length;
      job.result.updated = [...updated.values()];
      job.result.failed = [...failed];
    }

    job.finishedAt = new Date();
    job.status = job.cancellationRequested ? 'cancelled' : 'done';

    if (job.status === 'done') {
      await this.syncConceptSynonymsToTypesense();
    }
  }
}
