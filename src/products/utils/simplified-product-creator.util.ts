import { BadRequestException } from '@nestjs/common';
import { UserRole } from '../../users/entities/user.entity';
import { ProductStatus } from '../entities/product.entity';
import { CreateProductDto } from '../dto/create-product.dto';

export type ProductCreatorContext = {
  role?: string;
  authSource?: 'user' | 'vendor';
  vendorId?: number | null;
};

export function isSimplifiedProductCreator(
  user?: ProductCreatorContext | null,
): boolean {
  if (!user?.role) {
    return false;
  }

  return (
    user.role === UserRole.VENDOR_ADMIN ||
    user.role === UserRole.STORE_ADMIN ||
    user.authSource === 'vendor'
  );
}

export function resolveSimplifiedProductStatus(
  user?: ProductCreatorContext | null,
): ProductStatus {
  if (user?.role === UserRole.STORE_ADMIN) {
    return ProductStatus.STORE;
  }

  return ProductStatus.VENDOR;
}

export function resolveCreatorVendorId(
  user?: ProductCreatorContext | null,
): number | null {
  if (user?.vendorId && Number.isInteger(user.vendorId) && user.vendorId > 0) {
    return user.vendorId;
  }

  return null;
}

export function validateAndNormalizeSimplifiedCreateDto(
  dto: CreateProductDto,
  user?: ProductCreatorContext | null,
): CreateProductDto {
  const errors: string[] = [];

  if (!dto.name_en?.trim()) {
    errors.push('name_en is required');
  }
  if (!dto.name_ar?.trim()) {
    errors.push('name_ar is required');
  }
  if (!dto.long_description_en?.trim()) {
    errors.push('long_description_en is required');
  }
  if (!dto.long_description_ar?.trim()) {
    errors.push('long_description_ar is required');
  }
  if (dto.price === undefined || dto.price === null || Number.isNaN(Number(dto.price))) {
    errors.push('price is required');
  }
  if (!dto.media?.length) {
    errors.push('At least one media item is required');
  }

  if (errors.length) {
    throw new BadRequestException(errors.join('; '));
  }

  const vendorId = resolveCreatorVendorId(user) ?? dto.vendor_id ?? null;
  if (!vendorId) {
    throw new BadRequestException('Vendor is required for this product');
  }

  return {
    ...dto,
    vendor_id: vendorId,
    category_ids: [],
    brand_id: undefined,
    attributes: undefined,
    specifications: undefined,
    attachments: undefined,
    linked_product_ids: undefined,
    tags: undefined,
    short_description_en: dto.short_description_en?.trim() || dto.name_en.trim(),
    short_description_ar: dto.short_description_ar?.trim() || dto.name_ar.trim(),
    status: resolveSimplifiedProductStatus(user),
    visible: dto.visible ?? false,
    quantity: dto.quantity ?? 0,
  };
}
