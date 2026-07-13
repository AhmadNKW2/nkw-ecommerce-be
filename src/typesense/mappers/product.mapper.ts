import { Product } from '../../products/entities/product.entity';
import {
  arabicDisplayValue,
  arabicSearchValue,
  stripHtml,
} from '../utils/text-normalize';

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

function mapArabicTextPair(raw: string | null | undefined): {
  display: string;
  search: string;
} {
  const display = arabicDisplayValue(raw);
  return {
    display,
    search: arabicSearchValue(display),
  };
}

function mapArabicHtmlPair(html: string | null | undefined): {
  display: string;
  search: string;
} {
  const display = stripHtml(html);
  return {
    display,
    search: arabicSearchValue(display),
  };
}

function getPrimaryImageUrl(product: Product): string {
  const productMedia = Array.isArray((product as any).productMedia)
    ? [...(product as any).productMedia]
    : [];

  const imageMedia = productMedia
    .filter((entry: any) => {
      const url = entry?.media?.url;
      const type = entry?.media?.type;
      return typeof url === 'string' && url.trim() && type !== 'video' && type !== 'document';
    })
    .sort((left: any, right: any) => {
      const primaryDelta =
        Number(Boolean(right?.is_primary)) - Number(Boolean(left?.is_primary));
      if (primaryDelta !== 0) return primaryDelta;
      const sortDelta = Number(left?.sort_order ?? 0) - Number(right?.sort_order ?? 0);
      if (sortDelta !== 0) return sortDelta;
      return Number(left?.media?.id ?? 0) - Number(right?.media?.id ?? 0);
    });

  return imageMedia[0]?.media?.url?.trim() ?? '';
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
  const categoryNamesArNorm = new Set<string>();

  if (Array.isArray(product.productCategories)) {
    for (const productCategory of product.productCategories) {
      const nameEn = productCategory?.category?.name_en?.trim();
      const nameAr = productCategory?.category?.name_ar?.trim();
      if (nameEn) categoryNamesEn.add(nameEn);
      if (nameAr) {
        categoryNamesAr.add(nameAr);
        categoryNamesArNorm.add(arabicSearchValue(nameAr));
      }
    }
  }

  if (product.category?.name_en?.trim()) {
    categoryNamesEn.add(product.category.name_en.trim());
  }

  if (product.category?.name_ar?.trim()) {
    const nameAr = product.category.name_ar.trim();
    categoryNamesAr.add(nameAr);
    categoryNamesArNorm.add(arabicSearchValue(nameAr));
  }

  const nameAr = mapArabicTextPair(product.name_ar);
  const shortDescriptionAr = mapArabicHtmlPair(product.short_description_ar);
  const longDescriptionAr = mapArabicHtmlPair(product.long_description_ar);
  const brandNameAr = mapArabicTextPair(product.brand?.name_ar);

  return {
    id: String(product.id),
    name_en: product.name_en ?? '',
    name_ar: nameAr.display,
    name_ar_norm: nameAr.search,
    short_description_en: stripHtml(product.short_description_en),
    short_description_ar: shortDescriptionAr.display,
    short_description_ar_norm: shortDescriptionAr.search,
    long_description_en: stripHtml(product.long_description_en),
    long_description_ar: longDescriptionAr.display,
    long_description_ar_norm: longDescriptionAr.search,
    sku: product.sku ?? '',
    slug: product.slug ?? '',
    primary_image_url: getPrimaryImageUrl(product),
    status: product.status ?? '',
    visible: Boolean(product.visible),
    brand_id: product.brand_id ?? null,
    brand_name_en: product.brand?.name_en?.trim() ?? '',
    brand_name_ar: brandNameAr.display,
    brand_name_ar_norm: brandNameAr.search,
    vendor_id: product.vendor_id ?? null,
    category_ids: Array.from(categoryIds),
    category_names_en: Array.from(categoryNamesEn),
    category_names_ar: Array.from(categoryNamesAr),
    category_names_ar_norm: Array.from(categoryNamesArNorm),
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
