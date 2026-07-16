import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BrandsService } from '../brands/brands.service';
import { CategoriesService } from '../categories/categories.service';
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
    const nameEn = (dto.name_en ?? (payload.name_en as string) ?? '').trim();
    const nameAr = (dto.name_ar ?? (payload.name_ar as string) ?? '').trim();
    if (!nameEn || !nameAr) {
      throw new BadRequestException(
        'Both English and Arabic names are required to approve.',
      );
    }

    let resultEntityId: number;

    if (request.type === 'brand') {
      const brand = await this.brandsService.create({
        name_en: nameEn,
        name_ar: nameAr,
      });
      resultEntityId = brand.id;
      if (request.submission_id) {
        await this.submissionsService.onBrandResolved(
          request.submission_id,
          resultEntityId,
        );
      }
    } else {
      const parentId =
        dto.parent_id !== undefined
          ? dto.parent_id
          : ((payload.parent_id as number | null) ?? null);
      const category = await this.categoriesService.create({
        name_en: nameEn,
        name_ar: nameAr,
        parent_id: parentId ?? undefined,
      });
      resultEntityId = category.id;
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
    request.payload = { ...payload, name_en: nameEn, name_ar: nameAr };

    return this.catalogRequestRepo.save(request);
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

    // The linked submission stays blocked in its awaiting_* state until an
    // admin resolves the brand/category manually.
    return this.catalogRequestRepo.save(request);
  }
}
