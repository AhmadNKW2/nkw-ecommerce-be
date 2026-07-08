import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Specification } from './entities/specification.entity';
import { SpecificationValue } from './entities/specification-value.entity';
import { Category } from '../categories/entities/category.entity';
import { CreateSpecificationDto } from './dto/create-specification.dto';
import { UpdateSpecificationDto } from './dto/update-specification.dto';
import { ReorderSpecificationsDto } from './dto/reorder-specifications.dto';
import { ReorderSpecificationValuesDto } from './dto/reorder-specification-values.dto';
import { UpdateSpecificationValueDto } from './dto/update-specification-value.dto';
import {
  buildNormalizedValueSql,
  normalizeValueNameForUniqueness,
  sanitizeValueName,
} from '../common/utils/value-name-normalization.util';

@Injectable()
export class SpecificationsService {
  constructor(
    @InjectRepository(Specification)
    private specificationRepository: Repository<Specification>,
    @InjectRepository(SpecificationValue)
    private specificationValueRepository: Repository<SpecificationValue>,
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
  ) {}

  private normalizeCategoryIds(categoryIds?: number[]): number[] {
    return [
      ...new Set(
        (categoryIds ?? [])
          .map((categoryId) => Number(categoryId))
          .filter((categoryId) => Number.isInteger(categoryId) && categoryId > 0),
      ),
    ];
  }

  private sanitizeRequiredValueName(value: string, fieldName: string): string {
    const sanitizedValue = sanitizeValueName(value ?? '');

    if (!sanitizedValue) {
      throw new BadRequestException(`${fieldName} is required`);
    }

    return sanitizedValue;
  }

  private prepareSpecificationValuesPayload<
    T extends { value_en: string; value_ar: string },
  >(values: T[]): T[] {
    const seenEnglishNames = new Set<string>();
    const seenArabicNames = new Set<string>();

    return values.map((value) => {
      const sanitizedValueEn = this.sanitizeRequiredValueName(
        value.value_en,
        'value_en',
      );
      const sanitizedValueAr = this.sanitizeRequiredValueName(
        value.value_ar,
        'value_ar',
      );
      const normalizedValueEn = normalizeValueNameForUniqueness(sanitizedValueEn);
      const normalizedValueAr = normalizeValueNameForUniqueness(sanitizedValueAr);

      if (
        seenEnglishNames.has(normalizedValueEn) ||
        seenArabicNames.has(normalizedValueAr)
      ) {
        throw new ConflictException(
          'Duplicate specification values are not allowed within the same specification',
        );
      }

      seenEnglishNames.add(normalizedValueEn);
      seenArabicNames.add(normalizedValueAr);

      return {
        ...value,
        value_en: sanitizedValueEn,
        value_ar: sanitizedValueAr,
      };
    });
  }

  private async ensureSpecificationValueUnique(
    specificationId: number,
    valueEn: string,
    valueAr: string,
    excludeId?: number,
  ): Promise<void> {
    const query = this.specificationValueRepository
      .createQueryBuilder('value')
      .select('value.id', 'id')
      .where('value.specification_id = :specificationId', { specificationId })
      .andWhere(
        `(${buildNormalizedValueSql('value.value_en')} = :normalizedValueEn OR ${buildNormalizedValueSql('value.value_ar')} = :normalizedValueAr)`,
        {
          normalizedValueEn: normalizeValueNameForUniqueness(valueEn),
          normalizedValueAr: normalizeValueNameForUniqueness(valueAr),
        },
      );

    if (excludeId !== undefined) {
      query.andWhere('value.id != :excludeId', { excludeId });
    }

    const existingValue = await query.getRawOne();

    if (existingValue) {
      throw new ConflictException(
        'Specification value with this name already exists for this specification',
      );
    }
  }

  private async ensureSpecificationValueBelongsToSpecification(
    valueId: number,
    specificationId: number,
    errorMessage: string,
  ): Promise<void> {
    const parentValue = await this.specificationValueRepository.findOne({
      where: { id: valueId, specification_id: specificationId },
      select: {
        id: true
      },
    });

    if (!parentValue) {
      throw new NotFoundException(errorMessage);
    }
  }

  private async validateSpecificationDefinitionParent(
    parentSpecificationId?: number | null,
    parentValueId?: number | null,
  ): Promise<void> {
    if (
      (parentValueId !== undefined && parentValueId !== null) &&
      (parentSpecificationId === undefined || parentSpecificationId === null)
    ) {
      throw new BadRequestException(
        'parent_value_id cannot be set without parent_id',
      );
    }

    if (
      parentSpecificationId === undefined ||
      parentSpecificationId === null
    ) {
      return;
    }

    const parentSpecification = await this.specificationRepository.findOne({
      where: { id: parentSpecificationId },
      select: {
        id: true
      },
    });

    if (!parentSpecification) {
      throw new NotFoundException(
        `Parent specification with ID ${parentSpecificationId} not found`,
      );
    }

    if (parentValueId === undefined || parentValueId === null) {
      return;
    }

    await this.ensureSpecificationValueBelongsToSpecification(
      parentValueId,
      parentSpecificationId,
      'parent_value_id must belong to the parent specification',
    );
  }

  private async validateSpecificationValuesForParent(
    parentSpecificationId: number | null | undefined,
    values: Array<{ parent_value_id?: number | null }>,
  ): Promise<void> {
    if (
      parentSpecificationId === undefined ||
      parentSpecificationId === null ||
      values.length === 0
    ) {
      return;
    }

    for (const value of values) {
      if (value.parent_value_id === undefined || value.parent_value_id === null) {
        throw new BadRequestException(
          'Every value of a child specification must define parent_value_id',
        );
      }

      await this.ensureSpecificationValueBelongsToSpecification(
        value.parent_value_id,
        parentSpecificationId,
        'Specification value parent_value_id must belong to the parent specification',
      );
    }
  }

  private async validateExistingSpecificationValuesForParent(
    specificationId: number,
    parentSpecificationId?: number | null,
  ): Promise<void> {
    if (
      parentSpecificationId === undefined ||
      parentSpecificationId === null
    ) {
      return;
    }

    const values = await this.specificationValueRepository.find({
      where: { specification_id: specificationId },
      select: {
        id: true,
        parent_value_id: true
      },
    });

    for (const value of values) {
      if (value.parent_value_id === undefined || value.parent_value_id === null) {
        throw new BadRequestException(
          'All existing values of a child specification must define parent_value_id',
        );
      }

      await this.ensureSpecificationValueBelongsToSpecification(
        value.parent_value_id,
        parentSpecificationId,
        'Specification value parent_value_id must belong to the parent specification',
      );
    }
  }

  private async validateSpecificationParentValueForSpecification(
    specification: Pick<Specification, 'id' | 'parent_id'>,
    parentValueId?: number | null,
    currentValueId?: number,
  ): Promise<void> {
    if (currentValueId !== undefined && parentValueId === currentValueId) {
      throw new BadRequestException(
        'parent_value_id cannot reference the same specification value',
      );
    }

    const isChildSpecification =
      specification.parent_id !== undefined && specification.parent_id !== null;

    if (
      isChildSpecification &&
      (parentValueId === undefined || parentValueId === null)
    ) {
      throw new BadRequestException(
        'parent_value_id is required for values of a child specification',
      );
    }

    if (parentValueId === undefined || parentValueId === null) {
      return;
    }

    await this.ensureSpecificationValueBelongsToSpecification(
      parentValueId,
      isChildSpecification ? specification.parent_id : specification.id,
      isChildSpecification
        ? 'Parent specification value was not found for the parent specification'
        : 'Parent specification value was not found for this specification',
    );
  }

  private async validateSpecificationParentValue(
    specificationId: number,
    parentValueId?: number | null,
    currentValueId?: number,
  ): Promise<void> {
    const specification = await this.specificationRepository.findOne({
      where: { id: specificationId },
      select: {
        id: true,
        parent_id: true
      },
    });

    if (!specification) {
      throw new NotFoundException(
        `Specification with ID ${specificationId} not found`,
      );
    }

    await this.validateSpecificationParentValueForSpecification(
      specification,
      parentValueId,
      currentValueId,
    );
  }

  private async syncCategoriesForSpecification(
    specificationId: number,
    categoryIds: number[],
  ): Promise<void> {
    const normalizedCategoryIds = this.normalizeCategoryIds(categoryIds);

    if (normalizedCategoryIds.length > 0) {
      const categories = await this.categoryRepository.find({
        where: { id: In(normalizedCategoryIds) },
        select: {
          id: true
        },
      });

      if (categories.length !== normalizedCategoryIds.length) {
        throw new NotFoundException('One or more categories not found');
      }
    }

    const relation = this.specificationRepository
      .createQueryBuilder()
      .relation(Specification, 'categories')
      .of(specificationId);

    const currentCategories = (await relation.loadMany()) as Category[];
    await relation.addAndRemove(
      normalizedCategoryIds,
      currentCategories.map((category) => category.id),
    );
  }

  private async attachCategoriesToSpecifications(
    specifications: Specification[],
  ): Promise<void> {
    if (specifications.length === 0) {
      return;
    }

    const categoryRelations = await this.specificationRepository.find({
      where: { id: In(specifications.map((specification) => specification.id)) },
      relations: {
        categories: true
      },
    });

    const categoriesBySpecificationId = new Map(
      categoryRelations.map((specification) => [
        specification.id,
        [...(specification.categories ?? [])].sort(
          (left, right) => left.sortOrder - right.sortOrder || left.id - right.id,
        ),
      ]),
    );

    specifications.forEach((specification) => {
      specification.categories = categoriesBySpecificationId.get(specification.id) ?? [];
    });
  }

  async create(createSpecificationDto: CreateSpecificationDto): Promise<Specification> {
    const existing = await this.specificationRepository.findOne({
      where: { name_en: createSpecificationDto.name_en },
    });

    if (existing) {
      throw new ConflictException('Specification with this name already exists');
    }

    const { category_ids, values: valuesDto, ...specificationData } = createSpecificationDto;
    const preparedValues = valuesDto
      ? this.prepareSpecificationValuesPayload(valuesDto)
      : [];

    await this.validateSpecificationDefinitionParent(
      createSpecificationDto.parent_id,
      createSpecificationDto.parent_value_id,
    );
    await this.validateSpecificationValuesForParent(
      createSpecificationDto.parent_id,
      preparedValues,
    );

    const maxSortOrder = await this.specificationRepository
      .createQueryBuilder('specification')
      .select('MAX(specification.sort_order)', 'max')
      .getRawOne();
    const nextSortOrder = (maxSortOrder?.max ?? -1) + 1;

    const specification = this.specificationRepository.create({
      ...specificationData,
      sort_order: nextSortOrder,
    });

    const savedSpecification = await this.specificationRepository.save(specification);

    if (category_ids) {
      await this.syncCategoriesForSpecification(savedSpecification.id, category_ids);
    }

    if (preparedValues.length > 0) {
      const values = preparedValues.map((value, index) =>
        this.specificationValueRepository.create({
          ...value,
          specification: savedSpecification,
          sort_order: value.sort_order ?? index,
        }),
      );
      await this.specificationValueRepository.save(values);
    }

    return this.findOne(savedSpecification.id);
  }

  async findAll(categoryIds?: number[]): Promise<Specification[]> {
    const query = this.specificationRepository
      .createQueryBuilder('specification')
      .leftJoinAndSelect('specification.values', 'values')
      .leftJoin('specification.categories', 'categories');

    if (categoryIds && categoryIds.length > 0) {
      query.where(
        '(categories.id IN (:...categoryIds) OR specification.for_all_categories = :allCats)',
        { categoryIds, allCats: true },
      );
    }

    const specifications = await query
      .orderBy('specification.sort_order', 'ASC')
      .addOrderBy('specification.created_at', 'DESC')
      .addOrderBy('values.sort_order', 'ASC')
      .getMany();

    const specificationMap = new Map<number, Specification>();
    specifications.forEach((spec) => specificationMap.set(spec.id, spec));

    specifications.forEach((spec) => {
      let level = 0;
      let parentId = spec.parent_id;
      let depth = 0;
      const MAX_DEPTH = 20;

      while (parentId && specificationMap.has(parentId) && depth < MAX_DEPTH) {
        level++;
        parentId = specificationMap.get(parentId)!.parent_id;
        depth++;
      }

      spec.level = level;
      if (spec.values) {
        spec.values.forEach((val) => (val.level = level));
      }
    });

    await this.attachCategoriesToSpecifications(specifications);

    return specifications;
  }

  async findOne(id: number): Promise<Specification> {
    const specification = await this.specificationRepository
      .createQueryBuilder('specification')
      .leftJoinAndSelect('specification.values', 'values')
      .where('specification.id = :id', { id })
      .orderBy('values.sort_order', 'ASC')
      .getOne();

    if (!specification) {
      throw new NotFoundException(`Specification with ID ${id} not found`);
    }

    let level = 0;
    let currentId: number | null = specification.parent_id;
    const MAX_DEPTH = 20;
    let depth = 0;

    while (currentId && depth < MAX_DEPTH) {
      level++;
      const parent = await this.specificationRepository.findOne({
        where: { id: currentId },
        select: {
          id: true,
          parent_id: true
        },
      });
      currentId = parent ? parent.parent_id : null;
      depth++;
    }

    specification.level = level;
    if (specification.values) {
      specification.values.forEach((val) => (val.level = level));
    }

    await this.attachCategoriesToSpecifications([specification]);

    return specification;
  }

  async update(
    id: number,
    updateSpecificationDto: UpdateSpecificationDto,
  ): Promise<Specification> {
    const specification = await this.specificationRepository.findOne({ where: { id } });

    if (!specification) {
      throw new NotFoundException(`Specification with ID ${id} not found`);
    }

    if (
      updateSpecificationDto.name_en &&
      updateSpecificationDto.name_en !== specification.name_en
    ) {
      const existing = await this.specificationRepository.findOne({
        where: { name_en: updateSpecificationDto.name_en },
      });
      if (existing) {
        throw new ConflictException('Specification with this name already exists');
      }
    }

    const nextParentId =
      updateSpecificationDto.parent_id !== undefined
        ? updateSpecificationDto.parent_id
        : specification.parent_id;
    const nextParentValueId =
      updateSpecificationDto.parent_value_id !== undefined
        ? updateSpecificationDto.parent_value_id
        : specification.parent_value_id;

    await this.validateSpecificationDefinitionParent(
      nextParentId,
      nextParentValueId,
    );
    await this.validateExistingSpecificationValuesForParent(id, nextParentId);

    const { category_ids, ...specificationData } = updateSpecificationDto;

    Object.assign(specification, specificationData);
    await this.specificationRepository.save(specification);

    if (category_ids !== undefined) {
      await this.syncCategoriesForSpecification(id, category_ids);
    }

    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    const specification = await this.findOne(id);
    await this.specificationRepository.remove(specification);
  }

  async addValue(
    specificationId: number,
    valueEn: string,
    valueAr: string,
    parentValueId?: number,
  ): Promise<SpecificationValue> {
    const specification = await this.specificationRepository.findOne({
      where: { id: specificationId },
    });

    if (!specification) {
      throw new NotFoundException(`Specification with ID ${specificationId} not found`);
    }

    const sanitizedValueEn = this.sanitizeRequiredValueName(valueEn, 'value_en');
    const sanitizedValueAr = this.sanitizeRequiredValueName(valueAr, 'value_ar');

    await this.validateSpecificationParentValueForSpecification(
      specification,
      parentValueId,
    );

    await this.ensureSpecificationValueUnique(
      specificationId,
      sanitizedValueEn,
      sanitizedValueAr,
    );

    const maxSortOrder = await this.specificationValueRepository
      .createQueryBuilder('value')
      .select('MAX(value.sort_order)', 'max')
      .where('value.specification_id = :specificationId', { specificationId })
      .getRawOne();
    const nextSortOrder = (maxSortOrder?.max ?? -1) + 1;

    const specificationValue = this.specificationValueRepository.create({
      specification_id: specificationId,
      value_en: sanitizedValueEn,
      value_ar: sanitizedValueAr,
      parent_value_id: parentValueId,
      sort_order: nextSortOrder,
    });

    return await this.specificationValueRepository.save(specificationValue);
  }

  async removeValue(valueId: number): Promise<void> {
    const value = await this.specificationValueRepository.findOne({
      where: { id: valueId },
    });

    if (!value) {
      throw new NotFoundException(
        `Specification value with ID ${valueId} not found`,
      );
    }

    await this.specificationValueRepository.remove(value);
  }

  async updateValue(
    valueId: number,
    updateDto: UpdateSpecificationValueDto,
  ): Promise<SpecificationValue> {
    const value = await this.specificationValueRepository.findOne({
      where: { id: valueId },
    });

    if (!value) {
      throw new NotFoundException(
        `Specification value with ID ${valueId} not found`,
      );
    }

    const nextValueEn =
      updateDto.value_en !== undefined
        ? this.sanitizeRequiredValueName(updateDto.value_en, 'value_en')
        : this.sanitizeRequiredValueName(value.value_en, 'value_en');
    const nextValueAr =
      updateDto.value_ar !== undefined
        ? this.sanitizeRequiredValueName(updateDto.value_ar, 'value_ar')
        : this.sanitizeRequiredValueName(value.value_ar, 'value_ar');
    const nextParentValueId =
      updateDto.parent_value_id !== undefined
        ? updateDto.parent_value_id
        : value.parent_value_id;

    const specification = await this.specificationRepository.findOne({
      where: { id: value.specification_id },
      select: {
        id: true,
        parent_id: true
      },
    });

    if (!specification) {
      throw new NotFoundException(
        `Specification with ID ${value.specification_id} not found`,
      );
    }

    await this.validateSpecificationParentValueForSpecification(
      specification,
      nextParentValueId,
      valueId,
    );

    await this.ensureSpecificationValueUnique(
      value.specification_id,
      nextValueEn,
      nextValueAr,
      valueId,
    );

    if (updateDto.value_en !== undefined) {
      updateDto.value_en = nextValueEn;
    }

    if (updateDto.value_ar !== undefined) {
      updateDto.value_ar = nextValueAr;
    }

    Object.assign(value, updateDto);
    return await this.specificationValueRepository.save(value);
  }

  async reorderSpecifications(
    reorderDto: ReorderSpecificationsDto,
  ): Promise<Specification[]> {
    const specificationIds = reorderDto.specifications.map((spec) => spec.id);
    const specifications = await this.specificationRepository.find({
      where: { id: In(specificationIds) },
    });

    if (specifications.length !== specificationIds.length) {
      throw new NotFoundException('One or more specifications not found');
    }

    const updatePromises = reorderDto.specifications.map((spec) =>
      this.specificationRepository.update(spec.id, { sort_order: spec.sort_order }),
    );

    await Promise.all(updatePromises);

    return this.findAll();
  }

  async reorderSpecificationValues(
    specificationId: number,
    reorderDto: ReorderSpecificationValuesDto,
  ): Promise<Specification> {
    const specification = await this.findOne(specificationId);

    const valueIds = reorderDto.values.map((val) => val.id);
    const values = await this.specificationValueRepository.find({
      where: { id: In(valueIds), specification_id: specificationId },
    });

    if (values.length !== valueIds.length) {
      throw new NotFoundException(
        'One or more specification values not found or do not belong to this specification',
      );
    }

    const updatePromises = reorderDto.values.map((val) =>
      this.specificationValueRepository.update(val.id, {
        sort_order: val.sort_order,
      }),
    );

    await Promise.all(updatePromises);

    return this.findOne(specificationId);
  }
}
