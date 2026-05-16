const { Client } = require('pg');
require('dotenv').config();

const REVIEW_STATUS = 'review';
const PREVIEW_LIMIT = 20;
const ORIGINAL_VENDOR_CATEGORY_KEYS = new Set([
  'original_vendor_categories',
  'originalVendorCategories',
  'vendor_categories',
  'vendorCategories',
  'original_vendor_category_id',
  'originalVendorCategoryId',
  'vendor_category_id',
  'vendorCategoryId',
  'original_vendor_category_name',
  'originalVendorCategoryName',
  'vendor_category_name',
  'vendorCategoryName',
  'original_vendor_category',
  'originalVendorCategory',
  'vendor_category',
  'vendorCategory',
]);

function printUsage() {
  console.log(`Usage: node clear-review-original-vendor-categories.js [options]

Options:
  --dry-run                 Show counts and previews without updating the database
  --help, -h                Show this help message

Examples:
  node clear-review-original-vendor-categories.js --dry-run
  node clear-review-original-vendor-categories.js
  pnpm run clear:review-original-vendor-categories -- --dry-run`);
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--') {
      continue;
    }

    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function resolveSslConfig() {
  const rawValue = process.env.DB_SSL?.trim().toLowerCase();

  if (rawValue && ['false', '0', 'off', 'no'].includes(rawValue)) {
    return false;
  }

  return { rejectUnauthorized: false };
}

function createClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: resolveSslConfig(),
  });
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getPreviewOriginalVendorCategoryIds(categories) {
  if (!Array.isArray(categories)) {
    return [];
  }

  return categories
    .map((category) => {
      if (isPlainObject(category)) {
        const rawId = Number(category.id);
        return Number.isInteger(rawId) && rawId > 0 ? rawId : null;
      }

      const rawId = Number(category);
      return Number.isInteger(rawId) && rawId > 0 ? rawId : null;
    })
    .filter((id) => id !== null);
}

function scrubOriginalVendorCategoryMetadata(value) {
  if (Array.isArray(value)) {
    let changed = false;
    const nextArray = value.map((entry) => {
      const nextEntry = scrubOriginalVendorCategoryMetadata(entry);

      if (nextEntry !== entry) {
        changed = true;
      }

      return nextEntry;
    });

    return changed ? nextArray : value;
  }

  if (!isPlainObject(value)) {
    return value;
  }

  let changed = false;
  const nextValue = {};

  for (const [key, entry] of Object.entries(value)) {
    if (ORIGINAL_VENDOR_CATEGORY_KEYS.has(key)) {
      changed = true;
      continue;
    }

    const nextEntry = scrubOriginalVendorCategoryMetadata(entry);

    if (nextEntry !== entry) {
      changed = true;
    }

    nextValue[key] = nextEntry;
  }

  return changed ? nextValue : value;
}

function buildProductsNeedingCleanupQuery() {
  return {
    text: `
      SELECT
        p.id,
        p.name_en,
        p.sku,
        p.vendor_id,
        p.category_id,
        p.original_vendor_categories,
        p.original_vendor_category_id,
        p.original_vendor_category_name
      FROM products p
      WHERE p.status = $1
        AND (
          jsonb_array_length(COALESCE(p.original_vendor_categories, '[]'::jsonb)) > 0
          OR p.original_vendor_category_id IS NOT NULL
          OR p.original_vendor_category_name IS NOT NULL
        )
      ORDER BY p.id ASC
    `,
    values: [REVIEW_STATUS],
  };
}

async function findProductsNeedingCleanup(client) {
  const query = buildProductsNeedingCleanupQuery();
  const result = await client.query(query.text, query.values);
  return result.rows;
}

async function findInputJsonRowsToScrub(client) {
  const result = await client.query(
    `
      SELECT pij.id, pij.product_id, pij.input_json
      FROM product_input_jsons pij
      INNER JOIN products p ON p.id = pij.product_id
      WHERE p.status = $1
        AND CAST(pij.input_json AS text) ~* 'original_vendor_category|originalVendorCategory|vendor_category|vendorCategory'
      ORDER BY pij.product_id ASC
    `,
    [REVIEW_STATUS],
  );

  return result.rows
    .map((row) => {
      const cleanedInputJson = scrubOriginalVendorCategoryMetadata(
        row.input_json,
      );

      if (cleanedInputJson === row.input_json) {
        return null;
      }

      return {
        id: Number(row.id),
        product_id: Number(row.product_id),
        input_json: row.input_json,
        cleanedInputJson,
      };
    })
    .filter((row) => row !== null);
}

function printSelectionSummary(products, inputJsonRows) {
  console.log('Review original vendor category cleanup');
  console.log('Matched product rows:', products.length);
  console.log('Matched product_input_json rows:', inputJsonRows.length);

  if (products.length > 0) {
    const preview = products.slice(0, PREVIEW_LIMIT).map((product) => ({
      id: product.id,
      sku: product.sku,
      name_en: product.name_en,
      vendor_id: product.vendor_id,
      category_id: product.category_id,
      original_vendor_category_ids: getPreviewOriginalVendorCategoryIds(
        product.original_vendor_categories,
      ).join(', '),
      original_vendor_category_id: product.original_vendor_category_id,
      original_vendor_category_name: product.original_vendor_category_name,
    }));

    console.table(preview);

    if (products.length > PREVIEW_LIMIT) {
      console.log(`Product preview limited to first ${PREVIEW_LIMIT} rows.`);
    }
  }

  if (inputJsonRows.length > 0) {
    const preview = inputJsonRows.slice(0, PREVIEW_LIMIT).map((row) => ({
      input_json_id: row.id,
      product_id: row.product_id,
    }));

    console.table(preview);

    if (inputJsonRows.length > PREVIEW_LIMIT) {
      console.log(`Input JSON preview limited to first ${PREVIEW_LIMIT} rows.`);
    }
  }
}

async function clearReviewOriginalVendorCategories(options = {}) {
  const client = createClient();

  try {
    await client.connect();

    const normalizedOptions = {
      dryRun: Boolean(options.dryRun),
    };
    const products = await findProductsNeedingCleanup(client);
    const inputJsonRows = await findInputJsonRowsToScrub(client);

    printSelectionSummary(products, inputJsonRows);

    if (
      normalizedOptions.dryRun ||
      (products.length === 0 && inputJsonRows.length === 0)
    ) {
      return {
        dryRun: normalizedOptions.dryRun,
        matchedProductRows: products.length,
        matchedInputJsonRows: inputJsonRows.length,
      };
    }

    await client.query('BEGIN');

    let updatedProductRows = 0;

    if (products.length > 0) {
      const productIds = products.map((product) => Number(product.id));
      const updateProductsResult = await client.query(
        `
          UPDATE products
          SET
            original_vendor_categories = '[]'::jsonb,
            original_vendor_category_id = NULL,
            original_vendor_category_name = NULL
          WHERE id = ANY($1::int[])
        `,
        [productIds],
      );

      updatedProductRows = updateProductsResult.rowCount;
    }

    let updatedInputJsonRows = 0;

    for (const row of inputJsonRows) {
      const updateInputJsonResult = await client.query(
        `
          UPDATE product_input_jsons
          SET
            input_json = $1::jsonb,
            updated_at = NOW()
          WHERE id = $2
            AND input_json IS DISTINCT FROM $1::jsonb
        `,
        [JSON.stringify(row.cleanedInputJson), row.id],
      );

      updatedInputJsonRows += updateInputJsonResult.rowCount;
    }

    await client.query('COMMIT');

    const remainingProducts = await findProductsNeedingCleanup(client);
    const remainingInputJsonRows = await findInputJsonRowsToScrub(client);
    const summary = {
      updatedProductRows,
      updatedInputJsonRows,
      remainingProductRows: remainingProducts.length,
      remainingInputJsonRows: remainingInputJsonRows.length,
    };

    console.log('Cleanup completed.');
    console.table(summary);

    return summary;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures after a connection-level error.
    }

    throw error;
  } finally {
    await client.end();
  }
}

async function runCli() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      printUsage();
      return;
    }

    await clearReviewOriginalVendorCategories(options);
  } catch (error) {
    console.error(
      'Clear review original vendor categories failed:',
      error.message,
    );
    printUsage();
    process.exitCode = 1;
  }
}

module.exports = {
  clearReviewOriginalVendorCategories,
  parseArgs,
  scrubOriginalVendorCategoryMetadata,
};

if (require.main === module) {
  runCli();
}