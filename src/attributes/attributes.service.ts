import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import { Attribute } from './entities/attribute.entity';
import { AttributeValue } from './entities/attribute-value.entity';
import { Category } from '../categories/entities/category.entity';
import { CreateAttributeDto } from './dto/create-attribute.dto';
import { UpdateAttributeDto } from './dto/update-attribute.dto';
import { ReorderAttributesDto } from './dto/reorder-attributes.dto';
import { ReorderAttributeValuesDto } from './dto/reorder-attribute-values.dto';
import { UpdateAttributeValueDto } from './dto/update-attribute-value.dto';
import {
  buildNormalizedValueSql,
  normalizeValueNameForUniqueness,
  sanitizeValueName,
} from '../common/utils/value-name-normalization.util';

@Injectable()
export class AttributesService {
  constructor(
    @InjectRepository(Attribute)
    private attributeRepository: Repository<Attribute>,
    @InjectRepository(AttributeValue)
    private attributeValueRepository: Repository<AttributeValue>,
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

  private prepareAttributeValuesPayload<
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
          'Duplicate attribute values are not allowed within the same attribute',
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

  private async ensureAttributeValueUnique(
    attributeId: number,
    valueEn: string,
    valueAr: string,
    excludeId?: number,
  ): Promise<void> {
    const query = this.attributeValueRepository
      .createQueryBuilder('value')
      .select('value.id', 'id')
      .where('value.attribute_id = :attributeId', { attributeId })
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
        'Attribute value with this name already exists for this attribute',
      );
    }
  }

  private async ensureAttributeValueBelongsToAttribute(
    valueId: number,
    attributeId: number,
    errorMessage: string,
  ): Promise<void> {
    const parentValue = await this.attributeValueRepository.findOne({
      where: { id: valueId, attribute_id: attributeId },
      select: {
        id: true
      },
    });

    if (!parentValue) {
      throw new NotFoundException(errorMessage);
    }
  }

  private async validateAttributeDefinitionParent(
    parentAttributeId?: number | null,
    parentValueId?: number | null,
  ): Promise<void> {
    if (
      (parentValueId !== undefined && parentValueId !== null) &&
      (parentAttributeId === undefined || parentAttributeId === null)
    ) {
      throw new BadRequestException(
        'parent_value_id cannot be set without parent_id',
      );
    }

    if (parentAttributeId === undefined || parentAttributeId === null) {
      return;
    }

    const parentAttribute = await this.attributeRepository.findOne({
      where: { id: parentAttributeId },
      select: {
        id: true
      },
    });

    if (!parentAttribute) {
      throw new NotFoundException(
        `Parent attribute with ID ${parentAttributeId} not found`,
      );
    }

    if (parentValueId === undefined || parentValueId === null) {
      return;
    }

    await this.ensureAttributeValueBelongsToAttribute(
      parentValueId,
      parentAttributeId,
      'parent_value_id must belong to the parent attribute',
    );
  }

  private async validateAttributeValuesForParent(
    parentAttributeId: number | null | undefined,
    values: Array<{ parent_value_id?: number | null }>,
  ): Promise<void> {
    if (
      parentAttributeId === undefined ||
      parentAttributeId === null ||
      values.length === 0
    ) {
      return;
    }

    for (const value of values) {
      if (value.parent_value_id === undefined || value.parent_value_id === null) {
        throw new BadRequestException(
          'Every value of a child attribute must define parent_value_id',
        );
      }

      await this.ensureAttributeValueBelongsToAttribute(
        value.parent_value_id,
        parentAttributeId,
        'Attribute value parent_value_id must belong to the parent attribute',
      );
    }
  }

  private async validateExistingAttributeValuesForParent(
    attributeId: number,
    parentAttributeId?: number | null,
  ): Promise<void> {
    if (parentAttributeId === undefined || parentAttributeId === null) {
      return;
    }

    const values = await this.attributeValueRepository.find({
      where: { attribute_id: attributeId },
      select: {
        id: true,
        parent_value_id: true
      },
    });

    for (const value of values) {
      if (value.parent_value_id === undefined || value.parent_value_id === null) {
        throw new BadRequestException(
          'All existing values of a child attribute must define parent_value_id',
        );
      }

      await this.ensureAttributeValueBelongsToAttribute(
        value.parent_value_id,
        parentAttributeId,
        'Attribute value parent_value_id must belong to the parent attribute',
      );
    }
  }

  private async validateAttributeParentValueForAttribute(
    attribute: Pick<Attribute, 'id' | 'parent_id'>,
    parentValueId?: number | null,
    currentValueId?: number,
  ): Promise<void> {
    if (currentValueId !== undefined && parentValueId === currentValueId) {
      throw new BadRequestException(
        'parent_value_id cannot reference the same attribute value',
      );
    }

    const isChildAttribute =
      attribute.parent_id !== undefined && attribute.parent_id !== null;

    if (isChildAttribute && (parentValueId === undefined || parentValueId === null)) {
      throw new BadRequestException(
        'parent_value_id is required for values of a child attribute',
      );
    }

    if (parentValueId === undefined || parentValueId === null) {
      return;
    }

    await this.ensureAttributeValueBelongsToAttribute(
      parentValueId,
      isChildAttribute ? attribute.parent_id : attribute.id,
      isChildAttribute
        ? 'Parent attribute value was not found for the parent attribute'
        : 'Parent attribute value was not found for this attribute',
    );
  }

  private async validateAttributeParentValue(
    attributeId: number,
    parentValueId?: number | null,
    currentValueId?: number,
  ): Promise<void> {
    const attribute = await this.attributeRepository.findOne({
      where: { id: attributeId },
      select: {
        id: true,
        parent_id: true
      },
    });

    if (!attribute) {
      throw new NotFoundException(`Attribute with ID ${attributeId} not found`);
    }

    await this.validateAttributeParentValueForAttribute(
      attribute,
      parentValueId,
      currentValueId,
    );
  }

  private async syncCategoriesForAttribute(
    attributeId: number,
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

    const relation = this.attributeRepository
      .createQueryBuilder()
      .relation(Attribute, 'categories')
      .of(attributeId);

    const currentCategories = (await relation.loadMany()) as Category[];
    await relation.addAndRemove(
      normalizedCategoryIds,
      currentCategories.map((category) => category.id),
    );
  }

  private async attachCategoriesToAttributes(
    attributes: Attribute[],
  ): Promise<void> {
    if (attributes.length === 0) {
      return;
    }

    const categoryRelations = await this.attributeRepository.find({
      where: { id: In(attributes.map((attribute) => attribute.id)) },
      relations: {
        categories: true
      },
    });

    const categoriesByAttributeId = new Map(
      categoryRelations.map((attribute) => [
        attribute.id,
        [...(attribute.categories ?? [])].sort(
          (left, right) => left.sortOrder - right.sortOrder || left.id - right.id,
        ),
      ]),
    );

    attributes.forEach((attribute) => {
      attribute.categories = categoriesByAttributeId.get(attribute.id) ?? [];
    });
  }

  async create(createAttributeDto: CreateAttributeDto): Promise<Attribute> {
    const existing = await this.attributeRepository.findOne({
      where: { name_en: createAttributeDto.name_en },
    });

    if (existing) {
      throw new ConflictException('Attribute with this name already exists');
    }

    // Assign sort_order to values if they exist
    // Destructure values to handle them separately to avoid "Cyclic dependency" error in TypeORM save
    const {
      values: valuesDto,
      category_ids,
      ...attributeData
    } = createAttributeDto;
    const preparedValues = valuesDto
      ? this.prepareAttributeValuesPayload(valuesDto)
      : [];

    await this.validateAttributeDefinitionParent(
      createAttributeDto.parent_id,
      createAttributeDto.parent_value_id,
    );
    await this.validateAttributeValuesForParent(
      createAttributeDto.parent_id,
      preparedValues,
    );

    // Get the max sort_order and assign the next one
    const maxSortOrder = await this.attributeRepository
      .createQueryBuilder('attribute')
      .select('MAX(attribute.sort_order)', 'max')
      .getRawOne();
    const nextSortOrder = (maxSortOrder?.max ?? -1) + 1;

    const attribute = this.attributeRepository.create({
      ...attributeData,
      sort_order: nextSortOrder,
    });

    const savedAttribute = await this.attributeRepository.save(attribute);

    if (preparedValues.length > 0) {
      const values = preparedValues.map((value, index) =>
        this.attributeValueRepository.create({
          ...value,
          attribute: savedAttribute, // Linking explicitly
          sort_order: value.sort_order ?? index,
        }),
      );
      await this.attributeValueRepository.save(values);
    }

    if (category_ids !== undefined) {
      await this.syncCategoriesForAttribute(savedAttribute.id, category_ids);
    }

    return this.findOne(savedAttribute.id);
  }

  async findAll(categoryIds?: number[]): Promise<Attribute[]> {
    const query = this.attributeRepository
      .createQueryBuilder('attribute')
      .leftJoinAndSelect('attribute.values', 'values')
      .leftJoin('attribute.categories', 'categories');

    if (categoryIds && categoryIds.length > 0) {
      query.where(
        '(categories.id IN (:...categoryIds) OR attribute.for_all_categories = :allCats)',
        { categoryIds, allCats: true },
      );
    }

    const attributes = await query
      .orderBy('attribute.sort_order', 'ASC')
      .addOrderBy('attribute.created_at', 'DESC')
      .addOrderBy('values.sort_order', 'ASC')
      .getMany();

    // Calculate levels in memory
    const attributeMap = new Map<number, Attribute>();
    attributes.forEach((attr) => attributeMap.set(attr.id, attr));

    attributes.forEach((attr) => {
      let level = 0;
      let parentId = attr.parent_id;
      let depth = 0;
      const MAX_DEPTH = 20; // Prevent infinite loops

      while (parentId && attributeMap.has(parentId) && depth < MAX_DEPTH) {
        level++;
        parentId = attributeMap.get(parentId)!.parent_id;
        depth++;
      }

      attr.level = level;
      if (attr.values) {
        attr.values.forEach((val) => (val.level = level));
      }
    });

    await this.attachCategoriesToAttributes(attributes);

    return attributes;
  }

  async findOne(id: number): Promise<Attribute> {
    const attribute = await this.attributeRepository
      .createQueryBuilder('attribute')
      .leftJoinAndSelect('attribute.values', 'values')
      .where('attribute.id = :id', { id })
      .orderBy('values.sort_order', 'ASC')
      .getOne();

    if (!attribute) {
      throw new NotFoundException(`Attribute with ID ${id} not found`);
    }

    // Calculate level by traversing up
    let level = 0;
    let currentId: number | null = attribute.parent_id;
    const MAX_DEPTH = 20;
    let depth = 0;

    while (currentId && depth < MAX_DEPTH) {
      level++;
      // Lightweight fetch to check parent
      const parent = await this.attributeRepository.findOne({
        where: { id: currentId },
        select: {
          id: true,
          parent_id: true
        },
      });
      currentId = parent ? parent.parent_id : null;
      depth++;
    }

    attribute.level = level;
    if (attribute.values) {
      attribute.values.forEach((val) => (val.level = level));
    }

    await this.attachCategoriesToAttributes([attribute]);

    return attribute;
  }

  async update(
    id: number,
    updateAttributeDto: UpdateAttributeDto,
  ): Promise<Attribute> {
    // Determine if we need to check unrelated fields or just updating scalar values.
    // To avoid "Cyclic dependency: AttributeValue", we do NOT load the relations here.
    const attribute = await this.attributeRepository.findOne({ where: { id } });

    if (!attribute) {
      throw new NotFoundException(`Attribute with ID ${id} not found`);
    }

    if (
      updateAttributeDto.name_en &&
      updateAttributeDto.name_en !== attribute.name_en
    ) {
      const existing = await this.attributeRepository.findOne({
        where: { name_en: updateAttributeDto.name_en },
      });
      if (existing) {
        throw new ConflictException('Attribute with this name already exists');
      }
    }

    const nextParentId =
      updateAttributeDto.parent_id !== undefined
        ? updateAttributeDto.parent_id
        : attribute.parent_id;
    const nextParentValueId =
      updateAttributeDto.parent_value_id !== undefined
        ? updateAttributeDto.parent_value_id
        : attribute.parent_value_id;

    await this.validateAttributeDefinitionParent(
      nextParentId,
      nextParentValueId,
    );
    await this.validateExistingAttributeValuesForParent(id, nextParentId);

    const { category_ids, values, ...attributeData } = updateAttributeDto;

    Object.assign(attribute, attributeData);
    await this.attributeRepository.save(attribute);

    if (category_ids !== undefined) {
      await this.syncCategoriesForAttribute(id, category_ids);
    }

    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    const attribute = await this.findOne(id);
    await this.attributeRepository.remove(attribute);
  }

  async addValue(
    attributeId: number,
    valueEn: string,
    valueAr: string,
    parentValueId?: number,
  ): Promise<AttributeValue> {
    // Check if attribute exists
    const attribute = await this.attributeRepository.findOne({
      where: { id: attributeId },
    });

    if (!attribute) {
      throw new NotFoundException(`Attribute with ID ${attributeId} not found`);
    }

    const sanitizedValueEn = this.sanitizeRequiredValueName(valueEn, 'value_en');
    const sanitizedValueAr = this.sanitizeRequiredValueName(valueAr, 'value_ar');

    await this.validateAttributeParentValueForAttribute(
      attribute,
      parentValueId,
    );

    await this.ensureAttributeValueUnique(
      attributeId,
      sanitizedValueEn,
      sanitizedValueAr,
    );

    // Get the max sort_order for this attribute's values
    const maxSortOrder = await this.attributeValueRepository
      .createQueryBuilder('value')
      .select('MAX(value.sort_order)', 'max')
      .where('value.attribute_id = :attributeId', { attributeId })
      .getRawOne();
    const nextSortOrder = (maxSortOrder?.max ?? -1) + 1;

    const attributeValue = this.attributeValueRepository.create({
      attribute_id: attributeId,
      value_en: sanitizedValueEn,
      value_ar: sanitizedValueAr,
      parent_value_id: parentValueId,
      sort_order: nextSortOrder,
    });

    return await this.attributeValueRepository.save(attributeValue);
  }

  async removeValue(valueId: number): Promise<void> {
    const value = await this.attributeValueRepository.findOne({
      where: { id: valueId },
    });

    if (!value) {
      throw new NotFoundException(
        `Attribute value with ID ${valueId} not found`,
      );
    }

    await this.attributeValueRepository.remove(value);
  }

  async updateValue(
    valueId: number,
    updateDto: UpdateAttributeValueDto,
  ): Promise<AttributeValue> {
    const value = await this.attributeValueRepository.findOne({
      where: { id: valueId },
    });

    if (!value) {
      throw new NotFoundException(
        `Attribute value with ID ${valueId} not found`,
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

    const attribute = await this.attributeRepository.findOne({
      where: { id: value.attribute_id },
      select: {
        id: true,
        parent_id: true
      },
    });

    if (!attribute) {
      throw new NotFoundException(
        `Attribute with ID ${value.attribute_id} not found`,
      );
    }

    await this.validateAttributeParentValueForAttribute(
      attribute,
      nextParentValueId,
      valueId,
    );

    await this.ensureAttributeValueUnique(
      value.attribute_id,
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
    return await this.attributeValueRepository.save(value);
  }

  async reorderAttributes(
    reorderDto: ReorderAttributesDto,
  ): Promise<Attribute[]> {
    const attributeIds = reorderDto.attributes.map((attr) => attr.id);
    const attributes = await this.attributeRepository.find({
      where: { id: In(attributeIds) },
    });

    if (attributes.length !== attributeIds.length) {
      throw new NotFoundException('One or more attributes not found');
    }

    const updatePromises = reorderDto.attributes.map((attr) =>
      this.attributeRepository.update(attr.id, { sort_order: attr.sort_order }),
    );

    await Promise.all(updatePromises);

    return this.findAll();
  }

  async reorderAttributeValues(
    attributeId: number,
    reorderDto: ReorderAttributeValuesDto,
  ): Promise<Attribute> {
    const attribute = await this.findOne(attributeId);

    const valueIds = reorderDto.values.map((val) => val.id);
    const values = await this.attributeValueRepository.find({
      where: { id: In(valueIds), attribute_id: attributeId },
    });

    if (values.length !== valueIds.length) {
      throw new NotFoundException(
        'One or more attribute values not found or do not belong to this attribute',
      );
    }

    const updatePromises = reorderDto.values.map((val) =>
      this.attributeValueRepository.update(val.id, {
        sort_order: val.sort_order,
      }),
    );

    await Promise.all(updatePromises);

    return this.findOne(attributeId);
  }
}
