import { Brand } from '../../brands/entities/brand.entity';
import { Category, CategoryStatus } from '../../categories/entities/category.entity';
import { Vendor } from '../../vendors/entities/vendor.entity';

export type PublicCategoryView = {
  id: number;
  slug: string | null;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  meta_title_en: string | null;
  meta_title_ar: string | null;
  meta_description_en: string | null;
  meta_description_ar: string | null;
  image: string | null;
  children: PublicCategoryView[];
};

export type PublicBrandView = {
  id: number;
  slug: string | null;
  name_en: string;
  name_ar: string;
  description_en?: string | null;
  description_ar?: string | null;
  meta_title_en?: string | null;
  meta_title_ar?: string | null;
  meta_description_en?: string | null;
  meta_description_ar?: string | null;
  logo?: string | null;
};

export type PublicVendorView = {
  id: number;
  slug: string | null;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  meta_title_en: string | null;
  meta_title_ar: string | null;
  meta_description_en: string | null;
  meta_description_ar: string | null;
  logo: string | null;
};

function isPublicCategory(category: Category): boolean {
  return category.visible !== false && category.status === CategoryStatus.ACTIVE;
}

export function serializePublicCategory(category: Category): PublicCategoryView {
  const children = (category.children ?? [])
    .filter(isPublicCategory)
    .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0))
    .map((child) => serializePublicCategory(child));

  return {
    id: category.id,
    slug: category.slug ?? null,
    name_en: category.name_en,
    name_ar: category.name_ar,
    description_en: category.description_en ?? null,
    description_ar: category.description_ar ?? null,
    meta_title_en: category.meta_title_en ?? null,
    meta_title_ar: category.meta_title_ar ?? null,
    meta_description_en: category.meta_description_en ?? null,
    meta_description_ar: category.meta_description_ar ?? null,
    image: category.image ?? null,
    children,
  };
}

export function serializePublicBrand(brand: Brand): PublicBrandView {
  return {
    id: brand.id,
    slug: brand.slug ?? null,
    name_en: brand.name_en,
    name_ar: brand.name_ar,
    description_en: brand.description_en ?? null,
    description_ar: brand.description_ar ?? null,
    meta_title_en: brand.meta_title_en ?? null,
    meta_title_ar: brand.meta_title_ar ?? null,
    meta_description_en: brand.meta_description_en ?? null,
    meta_description_ar: brand.meta_description_ar ?? null,
    logo: brand.logo ?? null,
  };
}

export function serializePublicVendor(vendor: Vendor): PublicVendorView {
  return {
    id: vendor.id,
    slug: vendor.slug ?? null,
    name_en: vendor.name_en,
    name_ar: vendor.name_ar,
    description_en: vendor.description_en ?? null,
    description_ar: vendor.description_ar ?? null,
    meta_title_en: vendor.meta_title_en ?? null,
    meta_title_ar: vendor.meta_title_ar ?? null,
    meta_description_en: vendor.meta_description_en ?? null,
    meta_description_ar: vendor.meta_description_ar ?? null,
    logo: vendor.logo ?? null,
  };
}
