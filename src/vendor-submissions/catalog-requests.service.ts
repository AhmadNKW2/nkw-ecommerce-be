import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrandsService } from '../brands/brands.service';
import { Brand, BrandStatus } from '../brands/entities/brand.entity';
import { CategoriesService } from '../categories/categories.service';
import { Category, CategoryStatus } from '../categories/entities/category.entity';
import {
  ApproveCatalogRequestDto,
  ListCatalogRequestsDto,
  RejectCatalogRequestDto,
} from './dto/catalog-request.dto';
import { CatalogRequest } from './entities/catalog-request.entity';
import { VendorSubmissionsService } from './vendor-submissions.service';

@Injectable()
export class CatalogRequestsService {
  private readonly logger = new Logger(CatalogRequestsService.name);

  constructor(
    @InjectRepository(CatalogRequest)
    private readonly catalogRequestRepo: Repository<CatalogRequest>,
    @InjectRepository(Brand)
    private readonly brandRepo: Repository<Brand>,
    @InjectRepository(Category)
    private readonly categoryRepo: Repository<Category>,
    private readonly brandsService: BrandsService,
    private readonly categoriesService: CategoriesService,
    private readonly submissionsService: VendorSubmissionsService,
  ) {}

  async list(dto: ListCatalogRequestsDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const where: Record<string, unknown> = {};
    if (dto.type) {
      where.type = dto.type;
    }
    if (dto.status) {
      where.status = dto.status;
    }

    const [data, total] = await this.catalogRequestRepo.findAndCount({
      where,
      order: { created_at: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async countPending(): Promise<number> {
    return this.catalogRequestRepo.count({ where: { status: 'pending' } });
  }

  async findOne(id: number): Promise<CatalogRequest> {
    const request = await this.catalogRequestRepo.findOne({ where: { id } });
    if (!request) {
      throw new NotFoundException('Catalog request not found');
    }
    return request;
  }

  async approve(
    id: number,
    dto: ApproveCatalogRequestDto,
    reviewerId?: number,
  ): Promise<CatalogRequest> {
    const request = await this.findOne(id);
    if (request.status !== 'pending') {
      throw new BadRequestException(
        `Request already ${request.status}; cannot approve.`,
      );
    }

    const payload = (request.payload ?? {}) as Record<string, unknown>;

    if (request.type === 'specs') {
      request.status = 'approved';
      request.reviewed_by = reviewerId ?? null;
      request.reviewed_at = new Date();
      if (dto.admin_notes !== undefined) {
        request.admin_notes = dto.admin_notes;
      }
      const saved = await this.catalogRequestRepo.save(request);
      if (request.submission_id) {
        await this.submissionsService.onSpecsResolved(request.submission_id);
      }
      return saved;
    }

    const nameEn = (dto.name_en ?? (payload.name_en as string) ?? '').trim();
    const nameAr = (dto.name_ar ?? (payload.name_ar as string) ?? '').trim();

    let resultEntityId: number;

    if (request.type === 'brand') {
      resultEntityId = await this.resolveBrandApproval(payload, dto, nameEn, nameAr);
      if (request.submission_id) {
        await this.submissionsService.onBrandResolved(
          request.submission_id,
          resultEntityId,
        );
      }
    } else {
      resultEntityId = await this.resolveCategoryApproval(
        payload,
        dto,
        nameEn,
        nameAr,
      );
      if (request.submission_id) {
        await this.submissionsService.onCategoryResolved(
          request.submission_id,
          resultEntityId,
        );
      }
    }

    request.status = 'approved';
    request.result_entity_id = resultEntityId;
    request.reviewed_by = reviewerId ?? null;
    request.reviewed_at = new Date();
    if (dto.admin_notes !== undefined) {
      request.admin_notes = dto.admin_notes;
    }
    request.payload = {
      ...payload,
      name_en: nameEn || (payload.name_en as string) || null,
      name_ar: nameAr || (payload.name_ar as string) || null,
    };

    return this.catalogRequestRepo.save(request);
  }

  private async resolveBrandApproval(
    payload: Record<string, unknown>,
    dto: ApproveCatalogRequestDto,
    nameEn: string,
    nameAr: string,
  ): Promise<number> {
    const matchedId = Number(payload.matched_brand_id);
    const hasMatch = Number.isInteger(matchedId) && matchedId > 0;
    const forceCreate = dto.create_new === true;
    const existingId =
      dto.existing_entity_id !== undefined && dto.existing_entity_id !== null
        ? Number(dto.existing_entity_id)
        : hasMatch && !forceCreate
          ? matchedId
          : null;

    if (existingId && Number.isInteger(existingId) && existingId > 0) {
      const brand = await this.brandRepo.findOne({
        where: { id: existingId, status: BrandStatus.ACTIVE },
      });
      if (!brand) {
        throw new BadRequestException(
          `Brand #${existingId} not found or inactive.`,
        );
      }
      return brand.id;
    }

    if (!nameEn || !nameAr) {
      throw new BadRequestException(
        'Both English and Arabic names are required to create a brand.',
      );
    }

    const brand = await this.brandsService.create({
      name_en: nameEn,
      name_ar: nameAr,
    });
    return brand.id;
  }

  private async resolveCategoryApproval(
    payload: Record<string, unknown>,
    dto: ApproveCatalogRequestDto,
    nameEn: string,
    nameAr: string,
  ): Promise<number> {
    const matchedId = Number(payload.matched_category_id);
    const hasMatch = Number.isInteger(matchedId) && matchedId > 0;
    const forceCreate = dto.create_new === true;
    const existingId =
      dto.existing_entity_id !== undefined && dto.existing_entity_id !== null
        ? Number(dto.existing_entity_id)
        : hasMatch && !forceCreate
          ? matchedId
          : null;

    if (existingId && Number.isInteger(existingId) && existingId > 0) {
      const category = await this.categoryRepo.findOne({
        where: { id: existingId, status: CategoryStatus.ACTIVE },
      });
      if (!category) {
        throw new BadRequestException(
          `Category #${existingId} not found or inactive.`,
        );
      }
      const childCount = await this.categoryRepo.count({
        where: { parent_id: existingId },
      });
      if (childCount > 0) {
        throw new BadRequestException(
          'Approved category must be a leaf category (no subcategories).',
        );
      }
      return category.id;
    }

    if (!nameEn || !nameAr) {
      throw new BadRequestException(
        'Both English and Arabic names are required to create a category.',
      );
    }

    const parentId =
      dto.parent_id !== undefined
        ? dto.parent_id
        : ((payload.parent_id as number | null) ?? null);
    const category = await this.categoriesService.create({
      name_en: nameEn,
      name_ar: nameAr,
      parent_id: parentId ?? undefined,
    });
    return category.id;
  }

  async reject(
    id: number,
    dto: RejectCatalogRequestDto,
    reviewerId?: number,
  ): Promise<CatalogRequest> {
    const request = await this.findOne(id);
    if (request.status !== 'pending') {
      throw new BadRequestException(
        `Request already ${request.status}; cannot reject.`,
      );
    }

    request.status = 'rejected';
    request.reviewed_by = reviewerId ?? null;
    request.reviewed_at = new Date();
    if (dto.admin_notes !== undefined) {
      request.admin_notes = dto.admin_notes;
    }

    // The linked submission stays blocked until an admin resolves it.
    return this.catalogRequestRepo.save(request);
  }
}
