import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AdminNotificationsService } from '../admin-notifications/admin-notifications.service';
import { AttributesService } from '../attributes/attributes.service';
import { Brand, BrandStatus } from '../brands/entities/brand.entity';
import { CategoriesService } from '../categories/categories.service';
import { ProductStatus } from '../products/entities/product.entity';
import { ProductsService } from '../products/products.service';
import {
  ProductCreatorContext,
  resolveCreatorVendorId,
} from '../products/utils/simplified-product-creator.util';
import { CreateProductDto } from '../products/dto/create-product.dto';
import { ProductAttributeInputDto } from '../products/dto/product-attribute.dto';
import { ProductSpecificationInputDto } from '../products/dto/product-specification.dto';
import { SpecificationsService } from '../specifications/specifications.service';
import { CreateVendorSubmissionDto } from './dto/create-vendor-submission.dto';
import { ListVendorSubmissionsDto } from './dto/list-vendor-submissions.dto';
import { CatalogRequest } from './entities/catalog-request.entity';
import { VendorProductSubmissionMedia } from './entities/vendor-product-submission-media.entity';
import { VendorProductSubmission } from './entities/vendor-product-submission.entity';
import { flattenCategoryTree } from './prompts/stage1-classifier.prompt';
import {
  Stage2AiAttribute,
  Stage2AiSpecification,
  Stage2AiValue,
  Stage2Result,
  VendorSubmissionAiService,
} from './vendor-submission-ai.service';

@Injectable()
export class VendorSubmissionsService {
  private readonly logger = new Logger(VendorSubmissionsService.name);

  constructor(
    @InjectRepository(VendorProductSubmission)
    private readonly submissionRepo: Repository<VendorProductSubmission>,
    @InjectRepository(VendorProductSubmissionMedia)
    private readonly submissionMediaRepo: Repository<VendorProductSubmissionMedia>,
    @InjectRepository(CatalogRequest)
    private readonly catalogRequestRepo: Repository<CatalogRequest>,
    @InjectRepository(Brand)
    private readonly brandRepo: Repository<Brand>,
    private readonly aiService: VendorSubmissionAiService,
    private readonly categoriesService: CategoriesService,
    private readonly specificationsService: SpecificationsService,
    private readonly attributesService: AttributesService,
    private readonly productsService: ProductsService,
    private readonly adminNotifications: AdminNotificationsService,
  ) {}

  // ───────────────────────── Vendor submit ─────────────────────────

  async create(
    dto: CreateVendorSubmissionDto,
    user: ProductCreatorContext & { id?: number },
  ): Promise<VendorProductSubmission> {
    const vendorId = resolveCreatorVendorId(user);
    if (!vendorId) {
      throw new ForbiddenException(
        'Your account is not linked to a vendor. Contact an administrator.',
      );
    }

    const submission = this.submissionRepo.create({
      vendor_id: vendorId,
      created_by: user?.id ?? null,
      title: dto.title.trim(),
      description: dto.description,
      price: dto.price,
      stock: dto.stock,
      status: 'pending_ai',
      ai_result: null,
    });
    const saved = await this.submissionRepo.save(submission);

    if (dto.media?.length) {
      const mediaRows = dto.media.map((item, index) =>
        this.submissionMediaRepo.create({
          submission_id: saved.id,
          media_id: item.media_id,
          is_primary: item.is_primary ?? index === 0,
          sort_order: item.sort_order ?? index,
        }),
      );
      await this.submissionMediaRepo.save(mediaRows);
    }

    this.adminNotifications.publishSubmissionCreated(saved.id);

    // Fire and forget: enrich in the background.
    void this.processSubmission(saved.id).catch((error) => {
      this.logger.error(
        `Failed to process vendor submission ${saved.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });

    return this.findOne(saved.id);
  }

  // ─────────────────────── AI processing ───────────────────────

  async processSubmission(id: number): Promise<void> {
    const submission = await this.submissionRepo.findOne({ where: { id } });
    if (!submission) {
      return;
    }

    try {
      submission.status = 'ai_processing';
      submission.error = null;
      await this.submissionRepo.save(submission);

      const [brands, categoryTree] = await Promise.all([
        this.brandRepo.find({
          where: { status: BrandStatus.ACTIVE },
          select: { id: true, name_en: true },
        }),
        this.categoriesService.getCategoryTree(),
      ]);
      const categoryNodes = flattenCategoryTree(categoryTree);

      const stage1 = await this.aiService.classify(
        { title: submission.title, description: submission.description },
        brands,
        categoryNodes,
      );

      submission.ai_result = { stage1 };

      // Resolve brand.
      submission.resolved_brand_id = null;
      submission.brand_request_id = null;
      if (stage1.brand_match) {
        const matched = brands.find(
          (brand) =>
            brand.name_en?.trim().toLowerCase() ===
            stage1.brand_match!.trim().toLowerCase(),
        );
        if (matched) {
          submission.resolved_brand_id = matched.id;
        }
      }
      if (!submission.resolved_brand_id && stage1.suggested_brand) {
        const request = await this.catalogRequestRepo.save(
          this.catalogRequestRepo.create({
            type: 'brand',
            status: 'pending',
            submission_id: submission.id,
            requested_by: submission.created_by,
            payload: {
              name_en: stage1.suggested_brand.name_en,
              name_ar: stage1.suggested_brand.name_ar,
            },
          }),
        );
        submission.brand_request_id = request.id;
        this.adminNotifications.publishCatalogRequestCreated(request.id);
      }

      // Resolve category.
      submission.resolved_category_id = null;
      submission.category_request_id = null;
      if (stage1.category_match) {
        const exists = categoryNodes.some(
          (node) => node.id === stage1.category_match,
        );
        if (exists) {
          submission.resolved_category_id = stage1.category_match;
        }
      }
      if (!submission.resolved_category_id && stage1.suggested_category) {
        const request = await this.catalogRequestRepo.save(
          this.catalogRequestRepo.create({
            type: 'category',
            status: 'pending',
            submission_id: submission.id,
            requested_by: submission.created_by,
            payload: {
              name_en: stage1.suggested_category.name_en,
              name_ar: stage1.suggested_category.name_ar,
              parent_id: stage1.suggested_category.parent_id,
              reason: stage1.suggested_category.reason ?? null,
            },
          }),
        );
        submission.category_request_id = request.id;
        this.adminNotifications.publishCatalogRequestCreated(request.id);
      }

      await this.submissionRepo.save(submission);

      // If we already have a category, enrich now.
      if (submission.resolved_category_id) {
        await this.runStage2(submission.id);
      } else {
        await this.recomputeStatus(submission.id);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.submissionRepo.update(id, {
        status: 'failed',
        error: message,
      });
      throw error;
    }
  }

  /** Re-run the scoped Stage 2 enrichment for a submission with a resolved category. */
  async runStage2(id: number): Promise<VendorProductSubmission> {
    const submission = await this.submissionRepo.findOne({ where: { id } });
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    if (!submission.resolved_category_id) {
      throw new BadRequestException(
        'Submission has no resolved category yet; approve a category first.',
      );
    }

    const categoryId = submission.resolved_category_id;
    const [brands, specifications, attributes] = await Promise.all([
      this.brandRepo.find({ where: { status: BrandStatus.ACTIVE } }),
      this.specificationsService.findAll([categoryId]),
      this.attributesService.findAll([categoryId]),
    ]);

    const stage2 = await this.aiService.enrich(
      {
        title: submission.title,
        description: submission.description,
        price: submission.price,
        stock: submission.stock,
      },
      { brands, specifications, attributes },
    );

    submission.ai_result = {
      ...(submission.ai_result ?? {}),
      stage2,
    };
    await this.submissionRepo.save(submission);
    await this.recomputeStatus(submission.id);

    return this.findOne(submission.id);
  }

  // ─────── Called by CatalogRequestsService on approval ───────

  async onBrandResolved(submissionId: number, brandId: number): Promise<void> {
    await this.submissionRepo.update(submissionId, {
      resolved_brand_id: brandId,
    });
    await this.recomputeStatus(submissionId);
  }

  async onCategoryResolved(
    submissionId: number,
    categoryId: number,
  ): Promise<void> {
    await this.submissionRepo.update(submissionId, {
      resolved_category_id: categoryId,
    });
    // Category exists but its specs/attributes may still be empty; the admin
    // adds them, then triggers Stage 2 via run-ai.
    await this.recomputeStatus(submissionId);
  }

  private async recomputeStatus(submissionId: number): Promise<void> {
    const submission = await this.submissionRepo.findOne({
      where: { id: submissionId },
    });
    if (!submission) {
      return;
    }
    if (submission.status === 'rejected' || submission.status === 'materialized') {
      return;
    }

    const brandRequest = submission.brand_request_id
      ? await this.catalogRequestRepo.findOne({
          where: { id: submission.brand_request_id },
        })
      : null;
    const brandBlocked = brandRequest?.status === 'pending';

    const categoryResolved = Boolean(submission.resolved_category_id);
    const stage2Done = Boolean(
      (submission.ai_result as Record<string, unknown> | null)?.stage2,
    );

    let status: VendorProductSubmission['status'];
    if (brandBlocked) {
      status = 'awaiting_brand';
    } else if (!categoryResolved) {
      status = 'awaiting_category';
    } else if (!stage2Done) {
      status = 'awaiting_category_specs';
    } else {
      status = 'ready';
    }

    submission.status = status;
    await this.submissionRepo.save(submission);
  }

  // ─────────────────────── Materialize ───────────────────────

  async materialize(id: number, userId?: number): Promise<{ product_id: number }> {
    const submission = await this.submissionRepo.findOne({
      where: { id },
      relations: { media: true },
    });
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    if (submission.status === 'materialized' && submission.product_id) {
      return { product_id: submission.product_id };
    }
    if (submission.status !== 'ready') {
      throw new BadRequestException(
        `Submission is not ready to materialize (status: ${submission.status}).`,
      );
    }
    if (!submission.resolved_category_id) {
      throw new BadRequestException('Submission has no resolved category.');
    }

    const stage2 = (submission.ai_result as Record<string, unknown> | null)
      ?.stage2 as Stage2Result | undefined;
    if (!stage2) {
      throw new BadRequestException('Submission has no AI enrichment result.');
    }

    const [specifications, attributes] = await Promise.all([
      this.resolveSpecifications(stage2.specifications ?? []),
      this.resolveAttributes(stage2.attributes ?? []),
    ]);

    const media = (submission.media ?? [])
      .slice()
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((item) => ({
        media_id: item.media_id,
        is_primary: item.is_primary,
        sort_order: item.sort_order,
      }));

    const dto: CreateProductDto = {
      name_en: this.requireString(stage2.title_en, 'AI title_en'),
      name_ar: this.requireString(stage2.title_ar, 'AI title_ar'),
      short_description_en: this.requireString(
        stage2.short_description_en,
        'AI short_description_en',
      ),
      short_description_ar: this.requireString(
        stage2.short_description_ar,
        'AI short_description_ar',
      ),
      long_description_en: this.requireString(
        stage2.description_en,
        'AI description_en',
      ),
      long_description_ar: this.requireString(
        stage2.description_ar,
        'AI description_ar',
      ),
      category_ids: [submission.resolved_category_id],
      vendor_id: submission.vendor_id,
      brand_id: submission.resolved_brand_id ?? undefined,
      status: ProductStatus.REVIEW,
      visible: true,
      price: submission.price,
      original_vendor_price: submission.price,
      quantity: submission.stock,
      is_out_of_stock: submission.stock <= 0,
      media,
      specifications,
      attributes,
      meta_title_en: this.optionalString(stage2.meta_title_en),
      meta_title_ar: this.optionalString(stage2.meta_title_ar),
      meta_description_en: this.optionalString(stage2.meta_description_en),
      meta_description_ar: this.optionalString(stage2.meta_description_ar),
      weight: this.optionalNumber(stage2.weight),
      length: this.optionalNumber(stage2.length),
      width: this.optionalNumber(stage2.width),
      height: this.optionalNumber(stage2.height),
      linked_product_ids: [],
    };

    const created = await this.productsService.create(dto, userId);
    const productId = created?.product?.id ?? created?.id;
    if (!productId) {
      throw new BadRequestException('Failed to determine created product id.');
    }

    submission.product_id = productId;
    submission.status = 'materialized';
    await this.submissionRepo.save(submission);

    return { product_id: productId };
  }

  private async resolveSpecifications(
    aiSpecs: Stage2AiSpecification[],
  ): Promise<ProductSpecificationInputDto[]> {
    const result: ProductSpecificationInputDto[] = [];
    for (const spec of aiSpecs) {
      const specificationId = Number(spec.specification_id);
      if (!Number.isInteger(specificationId) || specificationId <= 0) {
        continue;
      }
      const valueIds: number[] = [];
      for (const value of spec.values ?? []) {
        const resolved = await this.resolveSpecValueId(specificationId, value);
        if (resolved) {
          valueIds.push(resolved);
        }
      }
      if (valueIds.length > 0) {
        result.push({
          specification_id: specificationId,
          specification_value_ids: [...new Set(valueIds)],
        });
      }
    }
    return result;
  }

  private async resolveSpecValueId(
    specificationId: number,
    value: Stage2AiValue,
  ): Promise<number | null> {
    const matchedId = Number(value.matched_value_id);
    if (Number.isInteger(matchedId) && matchedId > 0) {
      return matchedId;
    }
    if (value.matched_value_id === 'not_exist') {
      const { en, ar } = this.extractBilingualValue(value.original_value);
      if (!en) {
        return null;
      }
      const created = await this.specificationsService.addValue(
        specificationId,
        en,
        ar || en,
      );
      return created.id;
    }
    return null;
  }

  private async resolveAttributes(
    aiAttributes: Stage2AiAttribute[],
  ): Promise<ProductAttributeInputDto[]> {
    const result: ProductAttributeInputDto[] = [];
    for (const attr of aiAttributes) {
      const attributeId = Number(attr.attribute?.attribute_id);
      if (!Number.isInteger(attributeId) || attributeId <= 0) {
        continue;
      }
      const firstValue = (attr.values ?? [])[0];
      if (!firstValue) {
        continue;
      }
      const resolved = await this.resolveAttributeValueId(
        attributeId,
        firstValue,
      );
      if (resolved) {
        result.push({
          attribute_id: attributeId,
          attribute_value_ids: [resolved],
        });
      }
    }
    return result;
  }

  private async resolveAttributeValueId(
    attributeId: number,
    value: Stage2AiValue,
  ): Promise<number | null> {
    const matchedId = Number(value.matched_value_id);
    if (Number.isInteger(matchedId) && matchedId > 0) {
      return matchedId;
    }
    if (value.matched_value_id === 'not_exist') {
      const { en, ar } = this.extractBilingualValue(value.original_value);
      if (!en) {
        return null;
      }
      const created = await this.attributesService.addValue(
        attributeId,
        en,
        ar || en,
      );
      return created.id;
    }
    return null;
  }

  private extractBilingualValue(original: unknown): { en: string; ar: string } {
    if (typeof original === 'string') {
      return { en: original.trim(), ar: original.trim() };
    }
    if (original && typeof original === 'object') {
      const record = original as Record<string, unknown>;
      const en =
        typeof record.name_en === 'string' ? record.name_en.trim() : '';
      const ar =
        typeof record.name_ar === 'string' ? record.name_ar.trim() : '';
      return { en, ar: ar || en };
    }
    return { en: '', ar: '' };
  }

  private requireString(value: unknown, label: string): string {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    throw new BadRequestException(`Missing required AI field: ${label}`);
  }

  private optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private optionalNumber(value: unknown): number | undefined {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  }

  // ─────────────────────── Reads ───────────────────────

  async findOne(id: number, vendorId?: number): Promise<VendorProductSubmission> {
    const submission = await this.submissionRepo.findOne({
      where: { id },
      relations: { media: { media: true } },
    });
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    if (vendorId && submission.vendor_id !== vendorId) {
      throw new ForbiddenException('You cannot access this submission.');
    }
    return submission;
  }

  async list(dto: ListVendorSubmissionsDto, vendorId?: number) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const where: Record<string, unknown> = {};
    if (vendorId) {
      where.vendor_id = vendorId;
    } else if (dto.vendor_id) {
      where.vendor_id = dto.vendor_id;
    }
    if (dto.status) {
      where.status = dto.status;
    }

    const [data, total] = await this.submissionRepo.findAndCount({
      where,
      relations: { media: { media: true } },
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
