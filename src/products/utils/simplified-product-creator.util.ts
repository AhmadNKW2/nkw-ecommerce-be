import { BadRequestException } from '@nestjs/common';
import { UserRole } from '../../users/entities/user.entity';
import { ProductStatus } from '../entities/product.entity';
import { CreateProductDto } from '../dto/create-product.dto';
import {
  AdminAccess,
  ProductFormAccessKey,
  PRODUCT_FORM_ACCESS_KEYS,
} from '../../users/admin-access.constants';
import { hasAdminAccess, resolveAdminAccess } from '../../users/utils/admin-access.util';

export type ProductCreatorContext = {
  role?: string;
  authSource?: 'user' | 'vendor';
  vendorId?: number | null;
  adminAccess?: Partial<AdminAccess> | null;
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

function canUseProductFormStep(
  user: ProductCreatorContext | null | undefined,
  key: ProductFormAccessKey,
): boolean {
  if (!user?.role) {
    return true;
  }

  return hasAdminAccess(
    {
      role: user.role as UserRole,
      adminAccess: user.adminAccess as AdminAccess | null | undefined,
    },
    key,
  );
}

export function validateAndNormalizeSimplifiedCreateDto(
  dto: CreateProductDto,
  user?: ProductCreatorContext | null,
): CreateProductDto {
  const errors: string[] = [];
  const allowBasic = canUseProductFormStep(user, 'product_form_basic');
  const allowAttributes = canUseProductFormStep(user, 'product_form_attributes');
  const allowSpecifications = canUseProductFormStep(
    user,
    'product_form_specifications',
  );
  const allowStock = canUseProductFormStep(user, 'product_form_stock');
  const allowPricing = canUseProductFormStep(user, 'product_pricing');
  const allowWeight = canUseProductFormStep(
    user,
    'product_form_weight_dimensions',
  );
  const allowMedia = canUseProductFormStep(user, 'product_form_media');
  const allowAttachments = canUseProductFormStep(
    user,
    'product_form_attachments',
  );
  const allowCatalogFields = allowAttributes || allowSpecifications;

  if (allowBasic) {
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
  }

  if (
    allowPricing &&
    (dto.price === undefined || dto.price === null || Number.isNaN(Number(dto.price)))
  ) {
    errors.push('price is required');
  }

  if (allowMedia && !dto.media?.length) {
    errors.push('At least one media item is required');
  }

  if (errors.length) {
    throw new BadRequestException(errors.join('; '));
  }

  const vendorId = resolveCreatorVendorId(user) ?? dto.vendor_id ?? null;
  if (!vendorId) {
    throw new BadRequestException('Vendor is required for this product');
  }

  const next: CreateProductDto = {
    ...dto,
    vendor_id: vendorId,
    category_ids: allowCatalogFields ? dto.category_ids ?? [] : [],
    brand_id: allowCatalogFields ? dto.brand_id : undefined,
    attributes: allowAttributes ? dto.attributes : undefined,
    specifications: allowSpecifications ? dto.specifications : undefined,
    attachments: allowAttachments ? dto.attachments : undefined,
    linked_product_ids: undefined,
    tags: undefined,
    short_description_en:
      dto.short_description_en?.trim() || dto.name_en?.trim() || '',
    short_description_ar:
      dto.short_description_ar?.trim() || dto.name_ar?.trim() || '',
    status: resolveSimplifiedProductStatus(user),
    visible: dto.visible ?? false,
    quantity: allowStock ? (dto.quantity ?? 0) : 0,
  };

  if (!allowPricing) {
    delete next.price;
    delete next.sale_price;
    delete next.cost;
    delete next.original_vendor_price;
    delete next.original_vendor_sale_price;
    delete next.original_price;
    delete next.original_sale_price;
  }

  if (!allowWeight) {
    delete next.weight;
    delete next.length;
    delete next.width;
    delete next.height;
    delete next.weight_unit;
  }

  if (!allowMedia) {
    delete next.media;
  }

  return next;
}

/** Used by callers that need the resolved step flags for a creator. */
export function resolveProductFormAccess(
  user?: ProductCreatorContext | null,
): Record<ProductFormAccessKey, boolean> {
  if (!user?.role) {
    return PRODUCT_FORM_ACCESS_KEYS.reduce(
      (acc, key) => {
        acc[key] = true;
        return acc;
      },
      {} as Record<ProductFormAccessKey, boolean>,
    );
  }

  const access = resolveAdminAccess({
    role: user.role as UserRole,
    adminAccess: user.adminAccess as AdminAccess | null | undefined,
  });

  return PRODUCT_FORM_ACCESS_KEYS.reduce(
    (acc, key) => {
      acc[key] = access[key];
      return acc;
    },
    {} as Record<ProductFormAccessKey, boolean>,
  );
}
