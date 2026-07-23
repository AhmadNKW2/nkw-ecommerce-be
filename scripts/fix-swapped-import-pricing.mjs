import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'c:/Projects/ordonsooq/ordonsooq-be/.env' });

const APPLY = process.argv.includes('--apply');
const ROUNDING_STEP = 1;
const NUMERIC_TOLERANCE = 0.000001;

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

function getObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : null;
}

function firstDefinedValue(values) {
  return values.find((value) => value !== undefined);
}

function isMissingPrice(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    return !value.trim() || value.trim().toLowerCase() === 'none';
  }

  const objectValue = getObject(value);
  return objectValue ? isMissingPrice(objectValue.translate) : false;
}

function normalizePriceValue(value) {
  if (typeof value === 'number') return value;

  const objectValue = getObject(value);
  const candidate =
    objectValue?.translate !== undefined && objectValue.translate !== null
      ? objectValue.translate
      : value;

  if (typeof candidate === 'number') return candidate;
  if (typeof candidate !== 'string') {
    throw new Error(`Invalid price value: ${String(candidate)}`);
  }

  const parsed = Number(candidate.trim().replace(/,/g, ''));
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid price value: ${candidate}`);
  }

  return parsed;
}

function resolveOriginalPricing(inputJson) {
  const rawPayload = getObject(inputJson) ?? {};
  const nestedData = getObject(rawPayload.data);
  const payload = nestedData
    ? { ...rawPayload, ...nestedData }
    : { ...rawPayload };

  const newPrice = firstDefinedValue([
    payload.new_price,
    payload.sale_price,
    payload.price,
  ]);
  const oldPrice = firstDefinedValue([
    payload.old_price,
    payload.sale_price !== undefined ? payload.price : undefined,
  ]);
  const explicitPrice = firstDefinedValue([payload.price, newPrice]);
  const explicitSalePrice = firstDefinedValue([payload.sale_price]);

  if (explicitPrice !== undefined && explicitSalePrice !== undefined) {
    return {
      originalVendorPrice: normalizePriceValue(explicitPrice),
      originalVendorSalePrice: normalizePriceValue(explicitSalePrice),
    };
  }

  if (!isMissingPrice(oldPrice)) {
    return {
      originalVendorPrice: normalizePriceValue(oldPrice),
      originalVendorSalePrice: normalizePriceValue(newPrice),
    };
  }

  return {
    originalVendorPrice: normalizePriceValue(newPrice),
    originalVendorSalePrice: null,
  };
}

function normalizeIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  const normalized = [...new Set(ids.map(Number).filter((id) => id > 0))];
  return normalized.length > 0 ? normalized : null;
}

function isRuleMatch(rule, product) {
  const vendorIds = normalizeIds(rule.vendor_ids);
  if (vendorIds && !vendorIds.includes(Number(product.vendor_id))) return false;

  const brandIds = normalizeIds(rule.brand_ids);
  if (brandIds && !brandIds.includes(Number(product.brand_id))) return false;

  const categoryIds = normalizeIds(rule.category_ids);
  if (
    categoryIds &&
    !categoryIds.some((categoryId) => product.category_ids.includes(categoryId))
  ) {
    return false;
  }

  const originalPrice = Number(product.expected.originalVendorPrice);
  const condition = rule.price_condition ?? 'between';
  const min = rule.min_product_price === null ? null : Number(rule.min_product_price);
  const max = rule.max_product_price === null ? null : Number(rule.max_product_price);

  if (condition === 'any' || (min === null && max === null)) return true;
  if (condition === 'more_than') return min !== null && originalPrice > min;
  if (condition === 'less_than') return max !== null && originalPrice < max;

  return (
    originalPrice >= (min ?? Number.NEGATIVE_INFINITY) &&
    originalPrice <= (max ?? Number.POSITIVE_INFINITY)
  );
}

function specificityScore(rule) {
  let score = 0;
  const vendorIds = normalizeIds(rule.vendor_ids);
  const brandIds = normalizeIds(rule.brand_ids);
  const categoryIds = normalizeIds(rule.category_ids);

  if (vendorIds) score += 1_000_000 * vendorIds.length;
  if (brandIds) score += 100_000 * brandIds.length;
  if (categoryIds) score += 10_000 * categoryIds.length;

  const condition = rule.price_condition ?? 'between';
  if (condition === 'between') {
    const min = rule.min_product_price === null
      ? Number.NEGATIVE_INFINITY
      : Number(rule.min_product_price);
    const max = rule.max_product_price === null
      ? Number.POSITIVE_INFINITY
      : Number(rule.max_product_price);
    const rangeWidth = max - min;
    if (Number.isFinite(rangeWidth) && rangeWidth > 0) {
      score += Math.round(10_000 / (rangeWidth + 1));
    }
    score += 1_000;
  } else if (condition === 'more_than' || condition === 'less_than') {
    score += 500;
  }

  return score;
}

function roundManagedPrice(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const whole = Math.trunc(value);
  // Compare at 6 decimal places so 100.000001 is detected despite float noise.
  const fractionMicros = Math.round(value * 1_000_000) - whole * 1_000_000;

  // Any point from 0.000001 and above → add 1 and settle on .00
  if (fractionMicros >= 1) {
    return whole + 1;
  }

  return whole;
}

function calculateManagedPrice(sourcePrice, rule) {
  if (!rule) return roundManagedPrice(sourcePrice);
  const percentage = Number(rule.percentage);
  const multiplier =
    rule.adjustment_type === 'increase'
      ? 1 + percentage / 100
      : 1 - percentage / 100;
  return roundManagedPrice(sourcePrice * multiplier);
}

function calculatePricing(product, activeRules) {
  const rule = activeRules
    .filter((candidate) => isRuleMatch(candidate, product))
    .sort((left, right) => {
      const scoreDifference = specificityScore(right) - specificityScore(left);
      return scoreDifference || Number(left.id) - Number(right.id);
    })[0] ?? null;

  const price = calculateManagedPrice(product.expected.originalVendorPrice, rule);
  const rawSalePrice =
    product.expected.originalVendorSalePrice === null
      ? null
      : calculateManagedPrice(product.expected.originalVendorSalePrice, rule);
  const salePrice =
    rawSalePrice === null
      ? null
      : rawSalePrice < price
        ? rawSalePrice
        : roundManagedPrice(price - ROUNDING_STEP) || null;

  return { price, salePrice, ruleId: rule?.id ?? null };
}

function pricesEqual(left, right) {
  return Math.abs(Number(left) - Number(right)) < NUMERIC_TOLERANCE;
}

await client.connect();

try {
  const [productsResult, rulesResult] = await Promise.all([
    client.query(`
      SELECT
        product.id,
        product.vendor_id,
        product.brand_id,
        product.original_vendor_price,
        product.original_vendor_sale_price,
        product_input_json.input_json,
        COALESCE(
          array_agg(DISTINCT product_categories.category_id)
            FILTER (WHERE product_categories.category_id IS NOT NULL),
          ARRAY[]::integer[]
        ) AS category_ids
      FROM products AS product
      INNER JOIN product_input_jsons AS product_input_json
        ON product_input_json.product_id = product.id
      LEFT JOIN product_categories
        ON product_categories.product_id = product.id
      WHERE product.deleted_at IS NULL
      GROUP BY product.id, product_input_json.input_json
      ORDER BY product.id
    `),
    client.query(`
      SELECT id, percentage, adjustment_type, price_condition,
             min_product_price, max_product_price,
             vendor_ids, brand_ids, category_ids
      FROM product_price_rules
      WHERE is_active = true
      ORDER BY id
    `),
  ]);

  const candidates = [];
  const errors = [];

  for (const row of productsResult.rows) {
    try {
      const expected = resolveOriginalPricing(row.input_json);
      if (expected.originalVendorSalePrice === null) continue;

      const currentRegular = row.original_vendor_price;
      const currentSale = row.original_vendor_sale_price;
      if (
        currentRegular === null ||
        currentSale === null ||
        !pricesEqual(currentRegular, expected.originalVendorSalePrice) ||
        !pricesEqual(currentSale, expected.originalVendorPrice)
      ) {
        continue;
      }

      candidates.push({
        id: Number(row.id),
        vendor_id: row.vendor_id === null ? null : Number(row.vendor_id),
        brand_id: row.brand_id === null ? null : Number(row.brand_id),
        category_ids: row.category_ids.map(Number),
        expected,
      });
    } catch (error) {
      errors.push({ id: Number(row.id), error: String(error.message ?? error) });
    }
  }

  const plannedChanges = candidates.map((candidate) => ({
    ...candidate,
    pricing: calculatePricing(candidate, rulesResult.rows),
  }));

  if (!APPLY) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          scanned_products_with_input_json: productsResult.rowCount,
          exact_swapped_pairs: plannedChanges.length,
          unparseable_input_jsons: errors.length,
          sample: plannedChanges.slice(0, 25).map((change) => ({
            product_id: change.id,
            original_vendor_price: change.expected.originalVendorPrice,
            original_vendor_sale_price: change.expected.originalVendorSalePrice,
            price: change.pricing.price,
            sale_price: change.pricing.salePrice,
            applied_rule_id: change.pricing.ruleId,
          })),
          errors: errors.slice(0, 25),
        },
        null,
        2,
      ),
    );
    process.exitCode = 0;
  } else {
    await client.query('BEGIN');
    try {
      for (const change of plannedChanges) {
        await client.query(
          `
            UPDATE products
            SET
              original_vendor_price = $2,
              original_vendor_sale_price = $3,
              price = $4,
              sale_price = $5
            WHERE id = $1
          `,
          [
            change.id,
            change.expected.originalVendorPrice,
            change.expected.originalVendorSalePrice,
            change.pricing.price,
            change.pricing.salePrice,
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    console.log(
      JSON.stringify(
        {
          applied: true,
          updated_products: plannedChanges.length,
          skipped_unparseable_input_jsons: errors.length,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await client.end();
}
