import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputPath = path.join(
  __dirname,
  'duplicate-reference-slug-products-export.json',
);

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const duplicateGroupsResult = await client.query(`
  SELECT
    product.vendor_id,
    v.name_en AS vendor_name,
    product.reference_slug,
    array_agg(product.id ORDER BY product.id) AS product_ids,
    COUNT(*)::int AS count
  FROM products product
  LEFT JOIN vendors v ON v.id = product.vendor_id
  WHERE product.deleted_at IS NULL
    AND product.reference_slug IS NOT NULL
    AND btrim(product.reference_slug) <> ''
    AND product.vendor_id IS NOT NULL
  GROUP BY product.vendor_id, v.name_en, product.reference_slug
  HAVING COUNT(*) > 1
  ORDER BY count DESC, product.reference_slug ASC
`);

const allDuplicateProductIds = duplicateGroupsResult.rows.flatMap((group) =>
  group.product_ids.map((id) => Number(id)),
);

const productsResult =
  allDuplicateProductIds.length === 0
    ? { rows: [] }
    : await client.query(
        `
      SELECT
        p.id,
        p.reference_slug,
        p.reference_link,
        p.vendor_id,
        v.name_en AS vendor_name,
        p.original_vendor_category_id,
        p.original_vendor_category_name,
        p.original_vendor_categories
      FROM products p
      LEFT JOIN vendors v ON v.id = p.vendor_id
      WHERE p.id = ANY($1::int[])
      ORDER BY p.vendor_id, p.reference_slug, p.id
    `,
        [allDuplicateProductIds],
      );

const productsById = new Map(
  productsResult.rows.map((row) => [Number(row.id), row]),
);

const groups = duplicateGroupsResult.rows.map((group) => {
  const productIds = group.product_ids.map((id) => Number(id)).sort((a, b) => a - b);
  const keeperProductId = productIds[0];
  const deletedProductIds = productIds.slice(1);

  return {
    vendor_id: Number(group.vendor_id),
    vendor_name: group.vendor_name,
    reference_slug: group.reference_slug,
    count: Number(group.count),
    keeper_product_id: keeperProductId,
    deleted_product_ids: deletedProductIds,
    products: productIds.map((productId) => {
      const product = productsById.get(productId);
      return {
        id: productId,
        would_be_deleted: productId !== keeperProductId,
        reference_slug: product?.reference_slug ?? null,
        reference_link: product?.reference_link ?? null,
        vendor_id: product?.vendor_id ?? null,
        vendor_name: product?.vendor_name ?? null,
        original_vendor_category_id: product?.original_vendor_category_id ?? null,
        original_vendor_category_name: product?.original_vendor_category_name ?? null,
        original_vendor_categories: product?.original_vendor_categories ?? [],
      };
    }),
  };
});

const productsToDelete = groups.flatMap((group) =>
  group.products.filter((product) => product.would_be_deleted),
);

const exportPayload = {
  generated_at: new Date().toISOString(),
  description:
    'Products in duplicate reference_slug groups (same vendor + same reference_slug). Merge keeps the lowest product ID and deletes the rest.',
  scope: 'vendor_id + reference_slug',
  duplicate_groups_count: groups.length,
  products_in_duplicate_groups: allDuplicateProductIds.length,
  products_that_would_be_deleted: productsToDelete.length,
  groups,
  products_to_delete: productsToDelete,
};

await fs.writeFile(outputPath, JSON.stringify(exportPayload, null, 2), 'utf8');

console.log(
  JSON.stringify(
    {
      output_file: outputPath,
      duplicate_groups_count: exportPayload.duplicate_groups_count,
      products_in_duplicate_groups: exportPayload.products_in_duplicate_groups,
      products_that_would_be_deleted: exportPayload.products_that_would_be_deleted,
    },
    null,
    2,
  ),
);

await client.end();
