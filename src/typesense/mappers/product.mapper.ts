import { Product } from '../../products/entities/product.entity';
import { stripHtml, normalizeArabic } from '../utils/text-normalize';

type TypesenseProductDocument = Record<
  string,
  string | number | boolean | number[] | string[] | null
>;

type TypesenseProductMapperOptions = {
  attributeValueIds?: number[];
  specificationValueIds?: number[];
};

function toNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePositiveIntegers(values?: number[]): number[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [
    ...new Set(
      values.filter((value) => Number.isInteger(value) && value > 0),
    ),
  ];
}

export function mapProductToTypesenseDoc(
  product: Product,
  options: TypesenseProductMapperOptions = {},
): TypesenseProductDocument {
  const categoryIds = new Set<number>();

  if (Array.isArray(product.productCategories)) {
    for (const productCategory of product.productCategories) {
      const parsedCategoryId = Number(productCategory.category_id);
      if (Number.isInteger(parsedCategoryId) && parsedCategoryId > 0) {
        categoryIds.add(parsedCategoryId);
      }
    }
  }

  const primaryCategoryId = Number(product.category_id);
  if (Number.isInteger(primaryCategoryId) && primaryCategoryId > 0) {
    categoryIds.add(primaryCategoryId);
  }

  const attributeValueIds = normalizePositiveIntegers(options.attributeValueIds);
  const specificationValueIds = normalizePositiveIntegers(
    options.specificationValueIds ??
      (Array.isArray(product.specifications)
        ? product.specifications.map((entry) => Number(entry.specification_value_id))
        : []),
  );

  const price = toNumber(product.price, 0);
  const salePrice =
    product.sale_price === null || product.sale_price === undefined
      ? null
      : toNumber(product.sale_price, 0);
  const effectivePrice =
    salePrice !== null && salePrice > 0 && salePrice < price ? salePrice : price;
  const categoryNamesEn = new Set<string>();
  const categoryNamesAr = new Set<string>();
  if (Array.isArray(product.productCategories)) {
    for (const productCategory of product.productCategories) {
      const nameEn = productCategory?.category?.name_en?.trim();
      const nameAr = productCategory?.category?.name_ar?.trim();
      if (nameEn) categoryNamesEn.add(nameEn);
      if (nameAr) categoryNamesAr.add(normalizeArabic(nameAr));
    }
  }
  if (product.category?.name_en?.trim()) {
    categoryNamesEn.add(product.category.name_en.trim());
  }
  if (product.category?.name_ar?.trim()) {
    categoryNamesAr.add(normalizeArabic(product.category.name_ar.trim()));
  }

  return {
    id: String(product.id),
    name_en: product.name_en ?? '',
    name_ar: normalizeArabic(product.name_ar ?? ''),
    short_description_en: stripHtml(product.short_description_en),
    short_description_ar: normalizeArabic(stripHtml(product.short_description_ar)),
    long_description_en: stripHtml(product.long_description_en),
    long_description_ar: normalizeArabic(stripHtml(product.long_description_ar)),
    sku: product.sku ?? '',
    slug: product.slug ?? '',
    status: product.status ?? '',
    visible: Boolean(product.visible),
    brand_id: product.brand_id ?? null,
    brand_name_en: product.brand?.name_en?.trim() ?? '',
    brand_name_ar: normalizeArabic(product.brand?.name_ar?.trim() ?? ''),
    vendor_id: product.vendor_id ?? null,
    category_ids: Array.from(categoryIds),
    category_names_en: Array.from(categoryNamesEn),
    category_names_ar: Array.from(categoryNamesAr),
    attributes_values_ids: attributeValueIds,
    specifications_values_ids: specificationValueIds,
    is_out_of_stock: Boolean(product.is_out_of_stock),
    price,
    sale_price: salePrice,
    effective_price: effectivePrice,
    average_rating: toNumber(product.average_rating, 0),
    created_at_ts: Math.floor(new Date(product.created_at).getTime() / 1000),
  };
}
