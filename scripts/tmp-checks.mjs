import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: 'c:/Projects/ordonsooq/ordonsooq-be/.env' });

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

const dup = await client.query(`
  SELECT slug, COUNT(*)::int AS cnt, ARRAY_AGG(id ORDER BY id) AS ids
  FROM products
  WHERE deleted_at IS NULL
    AND slug IS NOT NULL
    AND btrim(slug) <> ''
  GROUP BY slug
  HAVING COUNT(*) > 1
  ORDER BY cnt DESC, slug ASC
`);

const missing = await client.query(`
  SELECT id, slug, price, sale_price, original_vendor_price, original_vendor_sale_price
  FROM products
  WHERE deleted_at IS NULL
    AND (original_vendor_price IS NULL OR original_vendor_price = 0)
  ORDER BY id ASC
`);

console.log(JSON.stringify({
  duplicate_slug_group_count: dup.rowCount,
  duplicate_slug_groups: dup.rows,
  missing_original_price_rows: missing.rows,
}, null, 2));

await client.end();
