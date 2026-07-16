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
import { Category } from '../categories/entities/category.entity';
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
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
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
      sale_price: dto.sale_price,
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

      // Brand always requires admin approve / edit / reject — even when matched.
      submission.resolved_brand_id = null;
      submission.brand_request_id = null;
      {
        let matchedBrand: { id: number; name_en: string } | null = null;
        if (stage1.brand_match) {
          matchedBrand =
            brands.find(
              (brand) =>
                brand.name_en?.trim().toLowerCase() ===
                stage1.brand_match!.trim().toLowerCase(),
            ) ?? null;
        }

        const nameEn =
          matchedBrand?.name_en?.trim() ||
          stage1.suggested_brand?.name_en?.trim() ||
          stage1.brand_match?.trim() ||
          '';
        const nameAr =
          stage1.suggested_brand?.name_ar?.trim() || nameEn;

        const brandRequest = await this.catalogRequestRepo.save(
          this.catalogRequestRepo.create({
            type: 'brand',
            status: 'pending',
            submission_id: submission.id,
            requested_by: submission.created_by,
            payload: {
              mode: matchedBrand ? 'match' : 'create',
              matched_brand_id: matchedBrand?.id ?? null,
              name_en: nameEn,
              name_ar: nameAr,
            },
          }),
        );
        submission.brand_request_id = brandRequest.id;
        this.adminNotifications.publishCatalogRequestCreated(brandRequest.id);
      }

      // Category always requires admin approve / edit / reject — leaf only.
      submission.resolved_category_id = null;
      submission.category_request_id = null;
      submission.specs_request_id = null;
      {
        const parentIds = new Set(
          categoryNodes
            .map((node) => node.parent_id)
            .filter((pid): pid is number => typeof pid === 'number'),
        );

        let matchedLeaf: (typeof categoryNodes)[number] | null = null;
        if (stage1.category_match) {
          const node = categoryNodes.find(
            (candidate) => candidate.id === stage1.category_match,
          );
          if (node && !parentIds.has(node.id)) {
            matchedLeaf = node;
          }
        }

        const nameEn =
          matchedLeaf?.name_en?.trim() ||
          stage1.suggested_category?.name_en?.trim() ||
          '';
        const nameAr =
          matchedLeaf?.name_ar?.trim() ||
          stage1.suggested_category?.name_ar?.trim() ||
          nameEn;
        const parentId = matchedLeaf
          ? matchedLeaf.parent_id
          : (stage1.suggested_category?.parent_id ?? null);

        const categoryRequest = await this.catalogRequestRepo.save(
          this.catalogRequestRepo.create({
            type: 'category',
            status: 'pending',
            submission_id: submission.id,
            requested_by: submission.created_by,
            payload: {
              mode: matchedLeaf ? 'match' : 'create',
              matched_category_id: matchedLeaf?.id ?? null,
              name_en: nameEn,
              name_ar: nameAr,
              parent_id: parentId,
              reason:
                stage1.suggested_category?.reason ??
                (matchedLeaf ? 'AI matched an existing leaf category' : null),
            },
          }),
        );
        submission.category_request_id = categoryRequest.id;
        this.adminNotifications.publishCatalogRequestCreated(categoryRequest.id);
      }

      await this.submissionRepo.save(submission);
      // Stage 2 waits until both brand and category are approved.
      await this.recomputeStatus(submission.id);
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

    if (specifications.length === 0 && attributes.length === 0) {
      throw new BadRequestException(
        'This category has no specifications or attributes yet. Add them to the category first, then run AI mapping.',
      );
    }

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

    // Specs/attributes mapping always needs admin approve / reject.
    if (submission.specs_request_id) {
      await this.catalogRequestRepo.update(
        { id: submission.specs_request_id, status: 'pending' },
        {
          status: 'rejected',
          admin_notes: 'Superseded by a new AI mapping run',
          reviewed_at: new Date(),
        },
      );
    }

    const specsRequest = await this.catalogRequestRepo.save(
      this.catalogRequestRepo.create({
        type: 'specs',
        status: 'pending',
        submission_id: submission.id,
        requested_by: submission.created_by,
        payload: {
          mode: 'review',
          title_en: stage2.title_en ?? null,
          title_ar: stage2.title_ar ?? null,
          specifications: stage2.specifications ?? [],
          attributes: stage2.attributes ?? [],
        },
      }),
    );
    submission.specs_request_id = specsRequest.id;
    await this.submissionRepo.save(submission);
    this.adminNotifications.publishCatalogRequestCreated(specsRequest.id);
    await this.recomputeStatus(submission.id);

    return this.findOne(submission.id);
  }

  /**
   * Run Stage 2 only when brand + category are approved and the category
   * already has specs/attributes. Otherwise leave the submission blocked.
   */
  private async maybeRunStage2(id: number): Promise<void> {
    const submission = await this.submissionRepo.findOne({ where: { id } });
    if (!submission) {
      return;
    }
    if (!submission.resolved_brand_id || !submission.resolved_category_id) {
      await this.recomputeStatus(id);
      return;
    }

    const hasCatalog = await this.categoryHasSpecsOrAttributes(
      submission.resolved_category_id,
    );
    if (hasCatalog) {
      await this.runStage2(id);
    } else {
      await this.recomputeStatus(id);
    }
  }

  private async categoryHasSpecsOrAttributes(
    categoryId: number,
  ): Promise<boolean> {
    const [specifications, attributes] = await Promise.all([
      this.specificationsService.findAll([categoryId]),
      this.attributesService.findAll([categoryId]),
    ]);
    return specifications.length > 0 || attributes.length > 0;
  }

  private async isLeafCategory(categoryId: number): Promise<boolean> {
    const childCount = await this.categoryRepo.count({
      where: { parent_id: categoryId },
    });
    return childCount === 0;
  }

  // ─────── Called by CatalogRequestsService on approval ───────

  async onBrandResolved(submissionId: number, brandId: number): Promise<void> {
    await this.submissionRepo.update(submissionId, {
      resolved_brand_id: brandId,
    });
    await this.maybeRunStage2(submissionId);
  }

  async onCategoryResolved(
    submissionId: number,
    categoryId: number,
  ): Promise<void> {
    if (!(await this.isLeafCategory(categoryId))) {
      throw new BadRequestException(
        'Approved category must be a leaf category (no subcategories).',
      );
    }
    await this.submissionRepo.update(submissionId, {
      resolved_category_id: categoryId,
    });
    await this.maybeRunStage2(submissionId);
  }

  async onSpecsResolved(submissionId: number): Promise<void> {
    await this.recomputeStatus(submissionId);
  }

  /**
   * Backfill pending brand/category approval requests for submissions that
   * were auto-resolved by an older Stage 1 path. Clears premature resolved
   * ids so admin must explicitly approve / edit / reject.
   */
  private async ensureApprovalRequests(id: number): Promise<void> {
    const submission = await this.submissionRepo.findOne({ where: { id } });
    if (!submission || submission.status === 'materialized') {
      return;
    }

    const stage1 = (
      submission.ai_result as Record<string, unknown> | null
    )?.stage1 as
      | {
          brand_match?: string | null;
          suggested_brand?: { name_en?: string; name_ar?: string } | null;
          category_match?: number | null;
          suggested_category?: {
            name_en?: string;
            name_ar?: string;
            parent_id?: number | null;
            reason?: string;
          } | null;
        }
      | undefined;

    if (!submission.brand_request_id) {
      let nameEn =
        stage1?.suggested_brand?.name_en?.trim() ||
        stage1?.brand_match?.trim() ||
        '';
      let nameAr = stage1?.suggested_brand?.name_ar?.trim() || nameEn;
      let matchedBrandId: number | null = null;

      if (submission.resolved_brand_id) {
        const brand = await this.brandRepo.findOne({
          where: { id: submission.resolved_brand_id },
        });
        if (brand) {
          matchedBrandId = brand.id;
          nameEn = brand.name_en;
          nameAr = brand.name_ar || brand.name_en;
        }
      }

      const brandRequest = await this.catalogRequestRepo.save(
        this.catalogRequestRepo.create({
          type: 'brand',
          status: 'pending',
          submission_id: submission.id,
          requested_by: submission.created_by,
          payload: {
            mode: matchedBrandId ? 'match' : 'create',
            matched_brand_id: matchedBrandId,
            name_en: nameEn,
            name_ar: nameAr,
          },
        }),
      );
      submission.brand_request_id = brandRequest.id;
      submission.resolved_brand_id = null;
      this.adminNotifications.publishCatalogRequestCreated(brandRequest.id);
    }

    if (!submission.category_request_id) {
      let nameEn = stage1?.suggested_category?.name_en?.trim() || '';
      let nameAr = stage1?.suggested_category?.name_ar?.trim() || nameEn;
      let parentId = stage1?.suggested_category?.parent_id ?? null;
      let matchedCategoryId: number | null = null;

      if (submission.resolved_category_id) {
        const category = await this.categoryRepo.findOne({
          where: { id: submission.resolved_category_id },
        });
        if (category) {
          matchedCategoryId = category.id;
          nameEn = category.name_en;
          nameAr = category.name_ar || category.name_en;
          parentId = category.parent_id ?? null;
        }
      }

      const categoryRequest = await this.catalogRequestRepo.save(
        this.catalogRequestRepo.create({
          type: 'category',
          status: 'pending',
          submission_id: submission.id,
          requested_by: submission.created_by,
          payload: {
            mode: matchedCategoryId ? 'match' : 'create',
            matched_category_id: matchedCategoryId,
            name_en: nameEn,
            name_ar: nameAr,
            parent_id: parentId,
            reason: stage1?.suggested_category?.reason ?? null,
          },
        }),
      );
      submission.category_request_id = categoryRequest.id;
      submission.resolved_category_id = null;
      this.adminNotifications.publishCatalogRequestCreated(categoryRequest.id);
    }

    await this.submissionRepo.save(submission);
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

    const [brandRequest, categoryRequest, specsRequest] = await Promise.all([
      submission.brand_request_id
        ? this.catalogRequestRepo.findOne({
            where: { id: submission.brand_request_id },
          })
        : Promise.resolve(null),
      submission.category_request_id
        ? this.catalogRequestRepo.findOne({
            where: { id: submission.category_request_id },
          })
        : Promise.resolve(null),
      submission.specs_request_id
        ? this.catalogRequestRepo.findOne({
            where: { id: submission.specs_request_id },
          })
        : Promise.resolve(null),
    ]);

    const stage2 = (submission.ai_result as Record<string, unknown> | null)
      ?.stage2 as Stage2Result | undefined;
    const stage2Done = Boolean(stage2);

    // Backfill a specs approval request for older submissions that already
    // have Stage 2 output but never got a specs request row.
    let effectiveSpecsRequest = specsRequest;
    if (stage2Done && !submission.specs_request_id) {
      effectiveSpecsRequest = await this.catalogRequestRepo.save(
        this.catalogRequestRepo.create({
          type: 'specs',
          status: 'pending',
          submission_id: submission.id,
          requested_by: submission.created_by,
          payload: {
            mode: 'review',
            title_en: stage2?.title_en ?? null,
            title_ar: stage2?.title_ar ?? null,
            specifications: stage2?.specifications ?? [],
            attributes: stage2?.attributes ?? [],
          },
        }),
      );
      submission.specs_request_id = effectiveSpecsRequest.id;
      this.adminNotifications.publishCatalogRequestCreated(
        effectiveSpecsRequest.id,
      );
    }

    const brandBlocked =
      !submission.resolved_brand_id ||
      brandRequest?.status === 'pending' ||
      brandRequest?.status === 'rejected';
    const categoryBlocked =
      !submission.resolved_category_id ||
      categoryRequest?.status === 'pending' ||
      categoryRequest?.status === 'rejected';
    const specsBlocked =
      !effectiveSpecsRequest ||
      effectiveSpecsRequest.status === 'pending' ||
      effectiveSpecsRequest.status === 'rejected';

    let status: VendorProductSubmission['status'];
    if (brandBlocked) {
      status = 'awaiting_brand';
    } else if (categoryBlocked) {
      status = 'awaiting_category';
    } else if (!stage2Done) {
      status = 'awaiting_category_specs';
    } else if (specsBlocked) {
      status = 'awaiting_specs_approval';
    } else {
      status = 'ready';
    }

    submission.status = status;
    await this.submissionRepo.save(submission);
  }

  // ─────────────────────── Materialize ───────────────────────

  async materialize(id: number, userId?: number): Promise<{ product_id: number }> {
    await this.ensureApprovalRequests(id);
    await this.recomputeStatus(id);

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
        `Submission is not ready to materialize (status: ${submission.status}). Approve brand, category, and specs first.`,
      );
    }
    if (!submission.resolved_brand_id) {
      throw new BadRequestException('Submission has no approved brand.');
    }
    if (!submission.resolved_category_id) {
      throw new BadRequestException('Submission has no resolved category.');
    }
    if (!(await this.isLeafCategory(submission.resolved_category_id))) {
      throw new BadRequestException(
        'Resolved category must be a leaf category (no subcategories).',
      );
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
      sale_price: submission.sale_price ?? undefined,
      original_vendor_price: submission.price,
      original_vendor_sale_price: submission.sale_price ?? undefined,
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

    // Admin list: backfill approval requests for older auto-matched rows.
    if (!vendorId) {
      for (const row of data) {
        if (
          row.status !== 'materialized' &&
          row.status !== 'rejected' &&
          (!row.brand_request_id ||
            !row.category_request_id ||
            ((row.ai_result as Record<string, unknown> | null)?.stage2 &&
              !row.specs_request_id))
        ) {
          await this.ensureApprovalRequests(row.id);
          await this.recomputeStatus(row.id);
        }
      }
      const refreshed = await this.submissionRepo.find({
        where,
        relations: { media: { media: true } },
        order: { created_at: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });
      return {
        data: refreshed,
        meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      };
    }

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
