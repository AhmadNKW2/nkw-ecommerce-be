import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'c:/Projects/ordonsooq/ordonsooq-be/.env' });

const APPLY = process.argv.includes('--apply');
const CITY_CENTER_VENDOR_ID = 1;
const CITY_CENTER_INCREASE_PERCENT = 2;

function roundManagedProductPrice(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }

  const whole = Math.trunc(value);
  const fractionMicros = Math.round(value * 1_000_000) - whole * 1_000_000;
  if (fractionMicros >= 1) {
    return whole + 1;
  }
  return whole;
}

function ensureSaleBelowPrice(price, salePrice) {
  if (salePrice === null || salePrice === undefined) {
    return null;
  }
  if (salePrice < price) {
    return salePrice;
  }
  const forced = roundManagedProductPrice(price - 1);
  return forced > 0 && forced < price ? forced : null;
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const vendor = await client.query(
  `SELECT id, name_en FROM vendors WHERE id = $1`,
  [CITY_CENTER_VENDOR_ID],
);
if (!vendor.rows[0]) {
  throw new Error(`City Center vendor id ${CITY_CENTER_VENDOR_ID} not found`);
}
console.log('VENDOR', vendor.rows[0]);

const products = await client.query(`
  SELECT
    id,
    vendor_id,
    price,
    sale_price,
    original_vendor_price,
    original_vendor_sale_price,
    reference_link
  FROM products
  WHERE
    reference_link ILIKE '%citycenter.jo%'
    OR reference_link ILIKE '%www.citycenter%'
    OR CAST(reference_links AS text) ILIKE '%citycenter.jo%'
    OR CAST(reference_links AS text) ILIKE '%www.citycenter%'
  ORDER BY id
`);

console.log('MATCHED_PRODUCTS', products.rows.length);

let alreadyCorrectVendor = 0;
let needsVendor = 0;
let needsPrice = 0;
const changes = [];

for (const row of products.rows) {
  const originalPrice =
    toFiniteNumber(row.original_vendor_price) ?? toFiniteNumber(row.price);
  const originalSale = toFiniteNumber(row.original_vendor_sale_price);

  if (originalPrice === null || originalPrice <= 0) {
    continue;
  }

  const nextPrice = roundManagedProductPrice(
    originalPrice * (1 + CITY_CENTER_INCREASE_PERCENT / 100),
  );
  const rawSale =
    originalSale === null
      ? null
      : roundManagedProductPrice(
          originalSale * (1 + CITY_CENTER_INCREASE_PERCENT / 100),
        );
  const nextSale = ensureSaleBelowPrice(nextPrice, rawSale);

  const currentPrice = toFiniteNumber(row.price);
  const currentSale = toFiniteNumber(row.sale_price);
  const vendorOk = Number(row.vendor_id) === CITY_CENTER_VENDOR_ID;
  const priceOk = currentPrice === nextPrice;
  const saleOk =
    (currentSale === null && nextSale === null) || currentSale === nextSale;

  if (vendorOk) alreadyCorrectVendor += 1;
  else needsVendor += 1;
  if (!priceOk || !saleOk) needsPrice += 1;

  if (!vendorOk || !priceOk || !saleOk) {
    changes.push({
      id: row.id,
      vendor_id: CITY_CENTER_VENDOR_ID,
      price: nextPrice,
      sale_price: nextSale,
      from: {
        vendor_id: row.vendor_id,
        price: currentPrice,
        sale_price: currentSale,
        original_vendor_price: originalPrice,
      },
    });
  }
}

console.log({
  alreadyCorrectVendor,
  needsVendor,
  needsPrice,
  willUpdate: changes.length,
  sample: changes.slice(0, 5),
});

if (!APPLY) {
  console.log('Dry run only. Re-run with --apply to update.');
  await client.end();
  process.exit(0);
}

await client.query('BEGIN');
try {
  let updated = 0;
  for (const change of changes) {
    await client.query(
      `
      UPDATE products
      SET
        vendor_id = $2,
        price = $3,
        sale_price = $4,
        updated_at = NOW()
      WHERE id = $1
    `,
      [change.id, change.vendor_id, change.price, change.sale_price],
    );
    updated += 1;
  }
  await client.query('COMMIT');
  console.log('UPDATED', updated);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
}

const after = await client.query(`
  SELECT
    COUNT(*) FILTER (WHERE vendor_id = $1)::int AS citycenter_vendor,
    COUNT(*) FILTER (WHERE vendor_id IS NULL)::int AS still_missing,
    COUNT(*)::int AS total_citycenter_links
  FROM products
  WHERE
    reference_link ILIKE '%citycenter.jo%'
    OR reference_link ILIKE '%www.citycenter%'
    OR CAST(reference_links AS text) ILIKE '%citycenter.jo%'
    OR CAST(reference_links AS text) ILIKE '%www.citycenter%'
`, [CITY_CENTER_VENDOR_ID]);
console.log('AFTER', after.rows[0]);

await client.end();
