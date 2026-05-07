import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, Like } from 'typeorm';
import { Vendor, VendorStatus } from './entities/vendor.entity';
import { CreateVendorDto } from './dto/create-vendor.dto';
import { UpdateVendorDto } from './dto/update-vendor.dto';
import {
  RestoreVendorDto,
  PermanentDeleteVendorDto,
} from './dto/archive-vendor.dto';
import { ReorderVendorsDto } from './dto/reorder-vendors.dto';
import { Product, ProductStatus } from '../products/entities/product.entity';
import { FilterProductDto } from '../products/dto/filter-product.dto';
import { ProductsService } from '../products/products.service';
import { R2StorageService } from '../common/services/r2-storage.service';
import {
  getNormalizedProductChanges,
  ProductChangesDto,
} from '../common/dto/product-changes.dto';
import {
  getPrimaryMediaUrl,
  hydrateProductMedia,
} from '../products/utils/product-media.util';
import { Category } from '../categories/entities/category.entity';
import { VendorCategory } from './entities/vendor-category.entity';
import { CreateVendorCategoryDto } from './dto/create-vendor-category.dto';
import {
  ReplaceVendorCategoriesTreeDto,
  ReplaceVendorCategoryTreeNodeDto,
} from './dto/replace-vendor-categories-tree.dto';
import { UpdateVendorCategoryDto } from './dto/update-vendor-category.dto';

interface NormalizedVendorCategoryTreeNode {
  title: string;
  reference_link: string;
  category_ids: number[];
  children: NormalizedVendorCategoryTreeNode[];
}

export interface SerializedVendorCategory {
  id: number;
  title: string;
  reference_link: string;
  vendor_id: number;
  parent_id: number | null;
  category_ids: number[];
  sort_order: number;
  categories: Category[];
  children: SerializedVendorCategory[];
  created_at: Date;
  updated_at: Date;
}

export type SerializedVendorCategoryListItem = Omit<
  SerializedVendorCategory,
  'children' | 'sort_order'
>;

@Injectable()
export class VendorsService {
  private readonly logger = new Logger(VendorsService.name);

  constructor(
    @InjectRepository(Vendor)
    private vendorRepository: Repository<Vendor>,
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    private r2StorageService: R2StorageService,
    private readonly productsService: ProductsService,
    @InjectRepository(VendorCategory)
    private vendorCategoryRepository: Repository<VendorCategory>,
  ) {}

  private async ensureVendorExists(vendorId: number): Promise<Vendor> {
    const vendor = await this.vendorRepository.findOne({
      where: { id: vendorId },
    });

    if (!vendor) {
      throw new NotFoundException(`Vendor with ID ${vendorId} not found`);
    }

    return vendor;
  }

  private normalizeVendorCategoryIds(
    categoryIds?: number[],
  ): number[] {
    return [
      ...new Set(
        (categoryIds ?? [])
          .map((value) => Number(value))
          .filter((value) => Number.isInteger(value) && value > 0),
      ),
    ];
  }

  private normalizeVendorCategoryTreePayload(
    nodes: ReplaceVendorCategoryTreeNodeDto[],
    pathPrefix = 'categories',
  ): {
    nodes: NormalizedVendorCategoryTreeNode[];
    categoryIds: number[];
  } {
    const categoryIds = new Set<number>();
    const normalizedNodes = nodes.map((node, index) => {
      const path = `${pathPrefix}[${index}]`;
      const title = typeof node.title === 'string' ? node.title.trim() : '';
      const referenceLink =
        typeof node.reference_link === 'string'
          ? node.reference_link.trim()
          : '';

      if (!title) {
        throw new BadRequestException(`${path}.title is required`);
      }

      if (!referenceLink) {
        throw new BadRequestException(`${path}.reference_link is required`);
      }

      const normalizedCategoryIds = this.normalizeVendorCategoryIds(
        node.category_ids,
      );
      normalizedCategoryIds.forEach((categoryId) => categoryIds.add(categoryId));

      const childResult = this.normalizeVendorCategoryTreePayload(
        node.children ?? [],
        `${path}.children`,
      );
      childResult.categoryIds.forEach((categoryId) => categoryIds.add(categoryId));

      return {
        title,
        reference_link: referenceLink,
        category_ids: normalizedCategoryIds,
        children: childResult.nodes,
      };
    });

    return {
      nodes: normalizedNodes,
      categoryIds: [...categoryIds],
    };
  }

  private async validateVendorCategoryCategoryIds(
    categoryIds: number[],
  ): Promise<void> {
    if (categoryIds.length === 0) {
      return;
    }

    const categories = await this.categoriesRepository.find({
      where: { id: In(categoryIds) },
      select: ['id'],
    });

    if (categories.length !== categoryIds.length) {
      throw new NotFoundException('One or more mapped categories were not found');
    }
  }

  private async ensureVendorCategoryParent(
    vendorId: number,
    parentId?: number | null,
    currentId?: number,
  ): Promise<void> {
    if (parentId === undefined || parentId === null) {
      return;
    }

    if (currentId && parentId === currentId) {
      throw new BadRequestException(
        'parent_id cannot reference the same vendor category',
      );
    }

    const parent = await this.vendorCategoryRepository.findOne({
      where: { id: parentId, vendor_id: vendorId },
      select: ['id'],
    });

    if (!parent) {
      throw new NotFoundException(
        'Parent vendor category was not found for this vendor',
      );
    }

    if (!currentId) {
      return;
    }

    const nodes = await this.vendorCategoryRepository.find({
      where: { vendor_id: vendorId },
      select: ['id', 'parent_id'],
    });
    const parentById = new Map(
      nodes.map((node) => [node.id, node.parent_id ?? null]),
    );

    let nextParentId: number | null = parentId;
    let guard = 0;
    while (nextParentId !== null && guard <= nodes.length) {
      if (nextParentId === currentId) {
        throw new BadRequestException(
          'parent_id would create a cycle in the vendor category tree',
        );
      }

      nextParentId = parentById.get(nextParentId) ?? null;
      guard += 1;
    }
  }

  private async getNextVendorCategorySortOrder(
    vendorId: number,
    parentId?: number | null,
  ): Promise<number> {
    const queryBuilder = this.vendorCategoryRepository
      .createQueryBuilder('vendorCategory')
      .select('MAX(vendorCategory.sort_order)', 'max')
      .where('vendorCategory.vendor_id = :vendorId', { vendorId });

    if (parentId === undefined || parentId === null) {
      queryBuilder.andWhere('vendorCategory.parent_id IS NULL');
    } else {
      queryBuilder.andWhere('vendorCategory.parent_id = :parentId', {
        parentId,
      });
    }

    const maxSortOrder = await queryBuilder.getRawOne();
    return (maxSortOrder?.max ?? -1) + 1;
  }

  private async syncVendorCategoryMappings(
    vendorCategoryId: number,
    categoryIds: number[],
  ): Promise<void> {
    const relation = this.vendorCategoryRepository
      .createQueryBuilder()
      .relation(VendorCategory, 'categories')
      .of(vendorCategoryId);

    const currentCategories = (await relation.loadMany()) as Category[];
    await relation.addAndRemove(
      categoryIds,
      currentCategories.map((category) => category.id),
    );
  }

  private async createVendorCategoryTreeNodes(
    vendorCategoryRepository: Repository<VendorCategory>,
    vendorId: number,
    nodes: NormalizedVendorCategoryTreeNode[],
    parentId: number | null,
  ): Promise<void> {
    for (const [index, node] of nodes.entries()) {
      const vendorCategory = vendorCategoryRepository.create({
        vendor_id: vendorId,
        title: node.title,
        reference_link: node.reference_link,
        parent_id: parentId,
        sort_order: index,
      });

      const savedVendorCategory = await vendorCategoryRepository.save(vendorCategory);

      if (node.category_ids.length > 0) {
        await vendorCategoryRepository
          .createQueryBuilder()
          .relation(VendorCategory, 'categories')
          .of(savedVendorCategory.id)
          .add(node.category_ids);
      }

      await this.createVendorCategoryTreeNodes(
        vendorCategoryRepository,
        vendorId,
        node.children,
        savedVendorCategory.id,
      );
    }
  }

  private async findVendorCategoryEntity(
    vendorId: number,
    vendorCategoryId: number,
  ): Promise<VendorCategory> {
    const vendorCategory = await this.vendorCategoryRepository.findOne({
      where: { id: vendorCategoryId, vendor_id: vendorId },
      relations: ['categories'],
    });

    if (!vendorCategory) {
      throw new NotFoundException('Vendor category not found');
    }

    return vendorCategory;
  }

  private async loadVendorCategoryEntities(
    vendorIds: number[],
  ): Promise<VendorCategory[]> {
    if (vendorIds.length === 0) {
      return [];
    }

    return this.vendorCategoryRepository.find({
      where: { vendor_id: In(vendorIds) },
      relations: ['categories'],
      order: { sort_order: 'ASC', id: 'ASC' },
    });
  }

  private serializeVendorCategory(
    vendorCategory: VendorCategory,
  ): SerializedVendorCategory {
    const categories = [...(vendorCategory.categories ?? [])].sort(
      (left, right) => left.id - right.id,
    );

    return {
      id: vendorCategory.id,
      title: vendorCategory.title,
      reference_link: vendorCategory.reference_link,
      vendor_id: vendorCategory.vendor_id,
      parent_id: vendorCategory.parent_id,
      category_ids: categories.map((category) => category.id),
      sort_order: vendorCategory.sort_order,
      categories,
      children: [],
      created_at: vendorCategory.created_at,
      updated_at: vendorCategory.updated_at,
    };
  }

  private buildVendorCategoryTree(
    vendorCategories: VendorCategory[],
  ): SerializedVendorCategory[] {
    const sortedVendorCategories = [...vendorCategories].sort(
      (left, right) => left.sort_order - right.sort_order || left.id - right.id,
    );
    const serializedById = new Map(
      sortedVendorCategories.map((vendorCategory) => [
        vendorCategory.id,
        this.serializeVendorCategory(vendorCategory),
      ]),
    );
    const roots: SerializedVendorCategory[] = [];

    for (const vendorCategory of sortedVendorCategories) {
      const serialized = serializedById.get(vendorCategory.id);
      if (!serialized) {
        continue;
      }

      if (
        vendorCategory.parent_id !== null &&
        vendorCategory.parent_id !== undefined &&
        serializedById.has(vendorCategory.parent_id)
      ) {
        serializedById.get(vendorCategory.parent_id)?.children.push(serialized);
        continue;
      }

      roots.push(serialized);
    }

    return roots;
  }

  private serializeVendorCategoryListItem(
    vendorCategory: SerializedVendorCategory,
  ): SerializedVendorCategoryListItem {
    return {
      id: vendorCategory.id,
      title: vendorCategory.title,
      reference_link: vendorCategory.reference_link,
      vendor_id: vendorCategory.vendor_id,
      parent_id: vendorCategory.parent_id,
      category_ids: vendorCategory.category_ids,
      categories: vendorCategory.categories,
      created_at: vendorCategory.created_at,
      updated_at: vendorCategory.updated_at,
    };
  }

  private flattenVendorCategoryTreeByDepth(
    vendorCategories: SerializedVendorCategory[],
  ): SerializedVendorCategoryListItem[] {
    const categoriesByDepth = new Map<number, SerializedVendorCategoryListItem[]>();
    let maxDepth = 0;

    const visit = (
      vendorCategory: SerializedVendorCategory,
      depth: number,
    ): void => {
      maxDepth = Math.max(maxDepth, depth);
      const bucket = categoriesByDepth.get(depth) ?? [];
      bucket.push(this.serializeVendorCategoryListItem(vendorCategory));
      categoriesByDepth.set(depth, bucket);

      for (const child of vendorCategory.children) {
        visit(child, depth + 1);
      }
    };

    for (const vendorCategory of vendorCategories) {
      visit(vendorCategory, 0);
    }

    const flattenedCategories: SerializedVendorCategoryListItem[] = [];
    for (let depth = maxDepth; depth >= 0; depth -= 1) {
      flattenedCategories.push(...(categoriesByDepth.get(depth) ?? []));
    }

    return flattenedCategories;
  }

  private findVendorCategoryNode(
    vendorCategories: SerializedVendorCategory[],
    vendorCategoryId: number,
  ): SerializedVendorCategory | null {
    for (const vendorCategory of vendorCategories) {
      if (vendorCategory.id === vendorCategoryId) {
        return vendorCategory;
      }

      const childMatch = this.findVendorCategoryNode(
        vendorCategory.children,
        vendorCategoryId,
      );
      if (childMatch) {
        return childMatch;
      }
    }

    return null;
  }

  private async attachVendorCategoryTrees(vendors: Vendor[]): Promise<Vendor[]> {
    const vendorIds = vendors.map((vendor) => vendor.id);
    const vendorCategories = await this.loadVendorCategoryEntities(vendorIds);
    const vendorCategoriesByVendorId = new Map<number, VendorCategory[]>();

    for (const vendorCategory of vendorCategories) {
      const bucket = vendorCategoriesByVendorId.get(vendorCategory.vendor_id) ?? [];
      bucket.push(vendorCategory);
      vendorCategoriesByVendorId.set(vendorCategory.vendor_id, bucket);
    }

    for (const vendor of vendors) {
      (
        vendor as unknown as {
          vendor_categories: SerializedVendorCategory[];
        }
      ).vendor_categories = this.buildVendorCategoryTree(
        vendorCategoriesByVendorId.get(vendor.id) ?? [],
      );
    }

    return vendors;
  }

  private slugify(text: string): string {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w\-]+/g, '')
      .replace(/\-\-+/g, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '');
  }

  private async generateUniqueSlug(
    name: string,
    currentId?: number,
  ): Promise<string> {
    const baseSlug = this.slugify(name);
    let finalSlug = baseSlug;
    let counter = 1;

    const existing = await this.vendorRepository.find({
      select: ['slug', 'id'],
      where: {
        slug: Like(`${baseSlug}%`),
      },
    });

    const isAvailable = (slug: string) => {
      const match = existing.find((v) => v.slug === slug);
      if (!match) return true;
      if (currentId && match.id === currentId) return true;
      return false;
    };

    while (!isAvailable(finalSlug)) {
      counter++;
      finalSlug = `${baseSlug}-${counter}`;
    }

    return finalSlug;
  }

  async create(
    createVendorDto: CreateVendorDto,
    logoUrl?: string,
  ): Promise<Vendor> {
    const existing = await this.vendorRepository.findOne({
      where: { name_en: createVendorDto.name_en },
    });

    if (existing) {
      throw new ConflictException('Vendor with this name already exists');
    }

    // Get max sort_order and add 1
    const maxSortOrder = await this.vendorRepository
      .createQueryBuilder('vendor')
      .select('MAX(vendor.sort_order)', 'max')
      .getRawOne();

    const nextSortOrder = (maxSortOrder?.max ?? -1) + 1;

    const { product_changes, ...vendorData } = createVendorDto;
    const slug = await this.generateUniqueSlug(vendorData.name_en);

    const vendor = this.vendorRepository.create({
      ...vendorData,
      slug,
      logo: logoUrl,
      sort_order: nextSortOrder,
    });
    const savedVendor = await this.vendorRepository.save(vendor);

    if (product_changes) {
      await this.applyProductChangesToVendor(savedVendor.id, product_changes);
    }

    return savedVendor;
  }

  private async applyProductChangesToVendor(
    vendorId: number,
    productChanges?: ProductChangesDto,
  ): Promise<void> {
    const {
      addProductIds,
      removeProductIds,
      conflictingProductIds,
    } = getNormalizedProductChanges(productChanges);

    if (conflictingProductIds.length > 0) {
      throw new BadRequestException(
        `product_changes contains the same product IDs in add_product_ids and remove_product_ids: ${conflictingProductIds.join(', ')}`,
      );
    }

    if (removeProductIds.length > 0) {
      await this.productsRepository.update(
        { id: In(removeProductIds), vendor_id: vendorId },
        { vendor_id: null as any },
      );
    }

    if (addProductIds.length > 0) {
      await this.productsRepository.update(
        { id: In(addProductIds), status: ProductStatus.ACTIVE },
        { vendor_id: vendorId },
      );
    }
  }

  async findAll(): Promise<Vendor[]> {
    const vendors = await this.vendorRepository.find({
      where: { status: VendorStatus.ACTIVE },
      relations: ['products'],
      order: { sort_order: 'ASC', created_at: 'DESC' },
    });

    return this.attachVendorCategoryTrees(vendors);
  }

  async findOne(id: number, productFilter?: FilterProductDto): Promise<Vendor> {
    const vendor = await this.ensureVendorExists(id);

    const productsResult = await this.productsService.findAll({
      ...productFilter,
      vendor_ids: [id],
      vendorId: undefined,
      vendor_id: undefined,
      limit: productFilter?.limit ?? 100,
    });
    (vendor as any).products = productsResult.data;
    (vendor as any).productsMeta = productsResult.meta;
    (vendor as any).vendor_categories = await this.findVendorCategoriesTree(id);

    return vendor;
  }

  async findOneBySlug(slug: string, productFilter?: FilterProductDto): Promise<Vendor> {
    const vendor = await this.vendorRepository.findOne({
      where: { slug },
    });

    if (!vendor) {
      throw new NotFoundException(`Vendor with slug ${slug} not found`);
    }

    const productsResult = await this.productsService.findAll({
      ...productFilter,
      vendor_ids: [vendor.id],
      vendorId: undefined,
      vendor_id: undefined,
      limit: productFilter?.limit ?? 100,
    });
    (vendor as any).products = productsResult.data;
    (vendor as any).productsMeta = productsResult.meta;
    (vendor as any).vendor_categories = await this.findVendorCategoriesTree(
      vendor.id,
    );

    return vendor;
  }

  async createVendorCategory(
    vendorId: number,
    createVendorCategoryDto: CreateVendorCategoryDto,
  ): Promise<SerializedVendorCategory> {
    await this.ensureVendorExists(vendorId);

    const categoryIds = this.normalizeVendorCategoryIds(
      createVendorCategoryDto.category_ids,
    );
    await this.validateVendorCategoryCategoryIds(categoryIds);
    await this.ensureVendorCategoryParent(
      vendorId,
      createVendorCategoryDto.parent_id ?? null,
    );

    const referenceLink = createVendorCategoryDto.reference_link.trim();

    const vendorCategory = this.vendorCategoryRepository.create({
      vendor_id: vendorId,
      title: createVendorCategoryDto.title.trim(),
      reference_link: referenceLink,
      parent_id: createVendorCategoryDto.parent_id ?? null,
      sort_order:
        createVendorCategoryDto.sort_order ??
        (await this.getNextVendorCategorySortOrder(
          vendorId,
          createVendorCategoryDto.parent_id ?? null,
        )),
    });

    const savedVendorCategory = await this.vendorCategoryRepository.save(
      vendorCategory,
    );
    await this.syncVendorCategoryMappings(savedVendorCategory.id, categoryIds);

    return this.findOneVendorCategory(vendorId, savedVendorCategory.id);
  }

  async findVendorCategories(
    vendorId: number,
  ): Promise<SerializedVendorCategoryListItem[]> {
    await this.ensureVendorExists(vendorId);

    const vendorCategories = await this.loadVendorCategoryEntities([vendorId]);
    return this.flattenVendorCategoryTreeByDepth(
      this.buildVendorCategoryTree(vendorCategories),
    );
  }

  async findVendorCategoriesTree(
    vendorId: number,
  ): Promise<SerializedVendorCategory[]> {
    await this.ensureVendorExists(vendorId);
    const vendorCategories = await this.loadVendorCategoryEntities([vendorId]);
    return this.buildVendorCategoryTree(vendorCategories);
  }

  async replaceVendorCategoriesTree(
    vendorId: number,
    replaceVendorCategoriesTreeDto: ReplaceVendorCategoriesTreeDto,
  ): Promise<SerializedVendorCategory[]> {
    await this.ensureVendorExists(vendorId);

    const { nodes, categoryIds } = this.normalizeVendorCategoryTreePayload(
      replaceVendorCategoriesTreeDto.categories,
    );
    await this.validateVendorCategoryCategoryIds(categoryIds);

    await this.vendorCategoryRepository.manager.transaction(async (manager) => {
      const vendorCategoryRepository = manager.getRepository(VendorCategory);

      await vendorCategoryRepository.delete({ vendor_id: vendorId });
      await this.createVendorCategoryTreeNodes(
        vendorCategoryRepository,
        vendorId,
        nodes,
        null,
      );
    });

    return this.findVendorCategoriesTree(vendorId);
  }

  async findOneVendorCategory(
    vendorId: number,
    vendorCategoryId: number,
  ): Promise<SerializedVendorCategory> {
    const vendorCategories = await this.findVendorCategoriesTree(vendorId);
    const vendorCategory = this.findVendorCategoryNode(
      vendorCategories,
      vendorCategoryId,
    );

    if (!vendorCategory) {
      throw new NotFoundException('Vendor category not found');
    }

    return vendorCategory;
  }

  async updateVendorCategory(
    vendorId: number,
    vendorCategoryId: number,
    updateVendorCategoryDto: UpdateVendorCategoryDto,
  ): Promise<SerializedVendorCategory> {
    await this.ensureVendorExists(vendorId);
    const vendorCategory = await this.findVendorCategoryEntity(
      vendorId,
      vendorCategoryId,
    );

    const nextCategoryIds = this.normalizeVendorCategoryIds(
      updateVendorCategoryDto.category_ids ??
        vendorCategory.categories?.map((category) => category.id),
    );
    await this.validateVendorCategoryCategoryIds(nextCategoryIds);

    const nextParentId =
      updateVendorCategoryDto.parent_id !== undefined
        ? updateVendorCategoryDto.parent_id
        : vendorCategory.parent_id;
    await this.ensureVendorCategoryParent(vendorId, nextParentId, vendorCategoryId);

    const nextReferenceLink = (
      updateVendorCategoryDto.reference_link ?? vendorCategory.reference_link
    ).trim();

    vendorCategory.title = (updateVendorCategoryDto.title ?? vendorCategory.title).trim();
    vendorCategory.reference_link = nextReferenceLink;
    vendorCategory.parent_id = nextParentId ?? null;
    vendorCategory.sort_order =
      updateVendorCategoryDto.sort_order ?? vendorCategory.sort_order;

    await this.vendorCategoryRepository.save(vendorCategory);
    await this.syncVendorCategoryMappings(vendorCategoryId, nextCategoryIds);

    return this.findOneVendorCategory(vendorId, vendorCategoryId);
  }

  async removeVendorCategory(
    vendorId: number,
    vendorCategoryId: number,
  ): Promise<{ message: string }> {
    const vendorCategory = await this.findVendorCategoryEntity(
      vendorId,
      vendorCategoryId,
    );
    await this.vendorCategoryRepository.remove(vendorCategory);

    return { message: 'Vendor category deleted successfully' };
  }

  async update(
    id: number,
    updateVendorDto: UpdateVendorDto,
    logoUrl?: string,
  ): Promise<Vendor> {
    const vendor = await this.findOne(id);
    const oldLogoUrl = vendor.logo;

    if (updateVendorDto.name_en && updateVendorDto.name_en !== vendor.name_en) {
      const existing = await this.vendorRepository.findOne({
        where: { name_en: updateVendorDto.name_en },
      });
      if (existing) {
        throw new ConflictException('Vendor with this name already exists');
      }
      vendor.slug = await this.generateUniqueSlug(updateVendorDto.name_en, id);
    }

    const { product_changes, ...updateData } = updateVendorDto;

    Object.assign(vendor, updateData);
    if (logoUrl) {
      vendor.logo = logoUrl;
    }
    const savedVendor = await this.vendorRepository.save(vendor);

    // Delete old logo from R2 if a new one was uploaded
    if (logoUrl && oldLogoUrl) {
      try {
        await this.r2StorageService.deleteFile(oldLogoUrl);
      } catch (error) {
        this.logger.warn(
          `Failed to delete old vendor logo: ${oldLogoUrl}`,
          error,
        );
      }
    }

    if (product_changes) {
      await this.applyProductChangesToVendor(id, product_changes);
    }

    return savedVendor;
  }

  // ========== LIFECYCLE MANAGEMENT ==========

  /**
   * Archive a vendor (soft delete)
   * All products from this vendor will also be archived
   */
  async archive(
    id: number,
    userId: number,
  ): Promise<{ message: string; archivedProducts: number }> {
    const vendor = await this.vendorRepository.findOne({
      where: { id, status: VendorStatus.ACTIVE },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found or already archived');
    }

    // Archive the vendor
    await this.vendorRepository.update(id, {
      status: VendorStatus.ARCHIVED,
      archived_at: new Date(),
      archived_by: userId,
    });

    // Archive all products from this vendor
    const productResult = await this.productsRepository.update(
      { vendor_id: id, status: ProductStatus.ACTIVE },
      {
        status: ProductStatus.ARCHIVED,
        archived_at: new Date(),
        archived_by: userId,
      },
    );

    return {
      message: `Vendor "${vendor.name_en}" archived successfully`,
      archivedProducts: productResult.affected || 0,
    };
  }

  /**
   * Restore an archived vendor
   * Options to restore all products, select specific products, or restore vendor only
   */
  async restore(
    id: number,
    restoreDto?: RestoreVendorDto,
  ): Promise<{
    message: string;
    restoredProducts: number;
    skippedProducts: number;
    skippedReason?: string;
  }> {
    const vendor = await this.vendorRepository.findOne({
      where: { id, status: VendorStatus.ARCHIVED },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found or not archived');
    }

    // Restore the vendor first
    vendor.status = VendorStatus.ACTIVE;
    vendor.archived_at = null;
    vendor.archived_by = null;
    await this.vendorRepository.save(vendor);

    let restoredProducts = 0;
    let skippedProducts = 0;
    let skippedReason: string | undefined;

    // Handle product restoration based on options
    if (restoreDto?.restoreAllProducts || restoreDto?.product_ids) {
      // Get archived products for this vendor
      let productsQuery = this.productsRepository
        .createQueryBuilder('product')
        .leftJoinAndSelect('product.productCategories', 'pc')
        .leftJoinAndSelect('pc.category', 'category')
        .where('product.vendor_id = :vendorId', { vendorId: id })
        .andWhere('product.status = :status', {
          status: ProductStatus.ARCHIVED,
        });

      // If specific product IDs provided, filter by them
      if (restoreDto.product_ids && restoreDto.product_ids.length > 0) {
        productsQuery = productsQuery.andWhere(
          'product.id IN (:...product_ids)',
          {
            product_ids: restoreDto.product_ids,
          },
        );
      }

      const products = await productsQuery.getMany();

      for (const product of products) {
        // Check if product has at least one active category
        const hasActiveCategory = product.productCategories?.some(
          (pc) => pc.category?.status === 'active',
        );

        if (!hasActiveCategory && product.productCategories?.length > 0) {
          skippedProducts++;
          skippedReason =
            'Some products skipped because all their categories are archived';
          continue;
        }

        // Restore the product
        product.status = ProductStatus.ACTIVE;
        product.archived_at = null;
        product.archived_by = null;
        await this.productsRepository.save(product);
        restoredProducts++;
      }
    }

    return {
      message: `Vendor "${vendor.name_en}" restored successfully`,
      restoredProducts,
      skippedProducts,
      skippedReason,
    };
  }

  /**
   * Find all archived vendors with their archived products included
   */
  async findArchived(): Promise<any[]> {
    const vendors = await this.vendorRepository.find({
      where: { status: VendorStatus.ARCHIVED },
      order: { archived_at: 'DESC' },
    });

    // Include archived products for each vendor with media
    const vendorsWithProducts = await Promise.all(
      vendors.map(async (vendor) => {
        const archivedProductsRaw = await this.productsRepository.find({
          where: { vendor_id: vendor.id, status: ProductStatus.ARCHIVED },
          select: [
            'id',
            'name_en',
            'name_ar',
            'sku',
            'archived_at',
            'archived_by',
          ],
          relations: ['productMedia', 'productMedia.media'],
        });

        // Map products to include image from primary media or first media
        const archivedProducts = archivedProductsRaw.map((product) => {
          const image = getPrimaryMediaUrl(product);
          const { media, productMedia, ...productData } =
            hydrateProductMedia(product, true) as any;
          return { ...productData, image };
        });

        return {
          ...vendor,
          archivedProducts,
        };
      }),
    );

    return vendorsWithProducts;
  }

  /**
   * Permanently delete a vendor (only if archived)
   * Must handle products: delete them or move to another vendor
   */
  async permanentDelete(
    id: number,
    options?: PermanentDeleteVendorDto,
  ): Promise<{ message: string }> {
    const vendor = await this.vendorRepository.findOne({
      where: { id, status: VendorStatus.ARCHIVED },
    });

    if (!vendor) {
      throw new NotFoundException(
        'Vendor not found or not archived. Only archived vendors can be permanently deleted.',
      );
    }

    // Count products
    const archivedProductCount = await this.productsRepository.count({
      where: { vendor_id: id, status: ProductStatus.ARCHIVED },
    });

    const activeProductCount = await this.productsRepository.count({
      where: { vendor_id: id, status: ProductStatus.ACTIVE },
    });

    // Active products cannot be permanently deleted
    if (activeProductCount > 0) {
      throw new BadRequestException(
        `Vendor has ${activeProductCount} active products. Archive them first before permanent deletion.`,
      );
    }

    if (archivedProductCount > 0) {
      if (!options?.deleteProducts && !options?.moveProductsToVendorId) {
        throw new BadRequestException(
          `Vendor has ${archivedProductCount} archived products. Choose one option:\n` +
            '1. Set deleteProducts=true to permanently delete all products\n' +
            '2. Set moveProductsToVendorId=<id> to move products to another vendor',
        );
      }

      if (options.deleteProducts && options.moveProductsToVendorId) {
        throw new BadRequestException(
          'Cannot use both deleteProducts and moveProductsToVendorId. Choose one option.',
        );
      }

      if (options.moveProductsToVendorId) {
        // Validate target vendor exists and is active
        const targetVendor = await this.vendorRepository.findOne({
          where: {
            id: options.moveProductsToVendorId,
            status: VendorStatus.ACTIVE,
          },
        });

        if (!targetVendor) {
          throw new BadRequestException(
            'Target vendor not found or is archived',
          );
        }

        // Move products to target vendor (keep them archived)
        await this.productsRepository.update(
          { vendor_id: id },
          { vendor_id: options.moveProductsToVendorId },
        );
      } else if (options.deleteProducts) {
        // Permanently delete all archived products
        await this.productsRepository.delete({
          vendor_id: id,
          status: ProductStatus.ARCHIVED,
        });
      }
    }

    const logoUrl = vendor.logo;

    // Perform hard delete of vendor
    await this.vendorRepository.delete(id);

    // Delete logo from R2
    if (logoUrl) {
      try {
        await this.r2StorageService.deleteFile(logoUrl);
      } catch (error) {
        this.logger.warn(`Failed to delete vendor logo: ${logoUrl}`, error);
      }
    }

    return { message: `Vendor "${vendor.name_en}" permanently deleted` };
  }

  /**
   * Reorder vendors
   */
  async reorder(dto: ReorderVendorsDto): Promise<{ message: string }> {
    const updates = dto.vendors.map((item) =>
      this.vendorRepository.update(item.id, { sort_order: item.sort_order }),
    );

    await Promise.all(updates);

    return { message: `${dto.vendors.length} vendors reordered successfully` };
  }

  // ========== PRODUCT ASSIGNMENT ==========

  /**
   * Assign products to this vendor
   */
  async assignProducts(
    vendorId: number,
    product_ids: number[],
  ): Promise<{ message: string; updated: number }> {
    // Validate vendor exists and is active
    const vendor = await this.vendorRepository.findOne({
      where: { id: vendorId, status: VendorStatus.ACTIVE },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found or is archived');
    }

    // Update products to assign this vendor
    const result = await this.productsRepository.update(
      { id: In(product_ids), status: ProductStatus.ACTIVE },
      { vendor_id: vendorId },
    );

    return {
      message: `${result.affected} products assigned to vendor "${vendor.name_en}"`,
      updated: result.affected || 0,
    };
  }

  /**
   * Remove products from this vendor (set vendor_id to null)
   */
  async removeProducts(
    vendorId: number,
    product_ids: number[],
  ): Promise<{ message: string; updated: number }> {
    // Validate vendor exists
    const vendor = await this.vendorRepository.findOne({
      where: { id: vendorId },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    // Remove vendor from products
    const result = await this.productsRepository.update(
      { id: In(product_ids), vendor_id: vendorId },
      { vendor_id: null as any },
    );

    return {
      message: `${result.affected} products removed from vendor "${vendor.name_en}"`,
      updated: result.affected || 0,
    };
  }

  /**
   * Get products for this vendor with vendor info
   */
  async getProducts(
    vendorId: number,
  ): Promise<{ vendor: Vendor; products: Product[] }> {
    const vendor = await this.vendorRepository.findOne({
      where: { id: vendorId },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    const products = await this.productsRepository.find({
      where: { vendor_id: vendorId, status: ProductStatus.ACTIVE },
      relations: [
        'media',
        'priceGroups',
        'productCategories',
        'productCategories.category',
      ],
      order: { created_at: 'DESC' },
    });

    return {
      vendor,
      products,
    };
  }

  /**
   * Get archived products for this vendor (for restore selection)
   */
  async getArchivedProducts(vendorId: number): Promise<{
    vendor: Vendor;
    products: any[];
  }> {
    const vendor = await this.vendorRepository.findOne({
      where: { id: vendorId },
    });

    if (!vendor) {
      throw new NotFoundException('Vendor not found');
    }

    const products = await this.productsRepository.find({
      where: { vendor_id: vendorId, status: ProductStatus.ARCHIVED },
      relations: [
        'media',
        'priceGroups',
        'productCategories',
        'productCategories.category',
      ],
      order: { archived_at: 'DESC' },
    });

    // Add canRestore flag based on category status
    const productsWithRestoreInfo = products.map((product) => {
      const hasActiveCategory = product.productCategories?.some(
        (pc) => pc.category?.status === 'active',
      );

      const { ...productData } = product;
      return {
        ...productData,
        canRestore:
          hasActiveCategory || product.productCategories?.length === 0,
        blockedReason:
          !hasActiveCategory && product.productCategories?.length > 0
            ? 'All categories are archived'
            : undefined,
      };
    });

    return {
      vendor,
      products: productsWithRestoreInfo,
    };
  }
}
