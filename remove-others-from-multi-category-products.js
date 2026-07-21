/**
 * Remove category "Others" (id 35) from products that have multiple categories
 * including Others. Also fixes products.category_id when it was set to Others.
 *
 * Usage:
 *   node remove-others-from-multi-category-products.js --dry-run
 *   node remove-others-from-multi-category-products.js
 */
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OTHERS_CATEGORY_ID = 35;
const JSON_EXPORT_PATH = path.join(__dirname, 'products-with-multiple-categories.json');

function resolveSslConfig() {
  const raw = String(process.env.DB_SSL || '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(raw)) {
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

async function findTargets(client) {
  const result = await client.query(
    `
    SELECT
      p.id AS product_id,
      p.category_id AS primary_category_id,
      array_agg(pc.category_id ORDER BY pc.category_id) AS all_category_ids,
      array_agg(c.name_en ORDER BY pc.category_id) AS all_category_names
    FROM products p
    JOIN product_categories pc ON pc.product_id = p.id
    JOIN categories c ON c.id = pc.category_id
    WHERE p.deleted_at IS NULL
    GROUP BY p.id, p.category_id
    HAVING COUNT(*) > 1
      AND $1 = ANY(array_agg(pc.category_id))
    ORDER BY p.id ASC
    `,
    [OTHERS_CATEGORY_ID],
  );
  return result.rows;
}

async function applyRemoval(client, productIds) {
  await client.query('BEGIN');
  try {
    // Fix primary category when it points at Others
    const primaryUpdate = await client.query(
      `
      UPDATE products p
      SET category_id = sub.next_category_id
      FROM (
        SELECT
          pc.product_id,
          MIN(pc.category_id) FILTER (WHERE pc.category_id <> $1) AS next_category_id
        FROM product_categories pc
        WHERE pc.product_id = ANY($2::int[])
        GROUP BY pc.product_id
      ) sub
      WHERE p.id = sub.product_id
        AND p.category_id = $1
        AND sub.next_category_id IS NOT NULL
      RETURNING p.id
      `,
      [OTHERS_CATEGORY_ID, productIds],
    );

    const deleted = await client.query(
      `
      DELETE FROM product_categories
      WHERE category_id = $1
        AND product_id = ANY($2::int[])
      RETURNING product_id
      `,
      [OTHERS_CATEGORY_ID, productIds],
    );

    await client.query('COMMIT');
    return {
      primaryFixed: primaryUpdate.rowCount,
      junctionDeleted: deleted.rowCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function updateJsonExport(productIds) {
  if (!fs.existsSync(JSON_EXPORT_PATH)) {
    console.log('JSON export not found, skipping local file update.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(JSON_EXPORT_PATH, 'utf8'));
  const idSet = new Set(productIds);
  let changed = 0;

  for (const product of data.products) {
    if (!idSet.has(product.product_id)) continue;
    const before = product.categories.length;
    product.categories = product.categories.filter(
      (c) => c.category_id !== OTHERS_CATEGORY_ID && c.name_en !== 'Others',
    );
    if (product.categories.length !== before) changed += 1;
  }

  // Drop products that no longer have multiple categories after removal
  data.products = data.products.filter((p) => p.categories.length > 1);
  data.total = data.products.length;

  fs.writeFileSync(JSON_EXPORT_PATH, JSON.stringify(data, null, 2) + '\n');
  console.log(`Updated ${JSON_EXPORT_PATH}: removed Others from ${changed} products; total now ${data.total}`);
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const client = createClient();
  await client.connect();

  try {
    const targets = await findTargets(client);
    console.log(`Found ${targets.length} multi-category products that include Others (id ${OTHERS_CATEGORY_ID})`);

    if (!targets.length) {
      return;
    }

    console.table(
      targets.slice(0, 20).map((row) => ({
        product_id: row.product_id,
        primary_category_id: row.primary_category_id,
        categories: row.all_category_names.join(', '),
      })),
    );
    if (targets.length > 20) {
      console.log(`... and ${targets.length - 20} more`);
    }

    if (dryRun) {
      console.log('Dry run only — no changes applied.');
      return;
    }

    const productIds = targets.map((t) => Number(t.product_id));
    const result = await applyRemoval(client, productIds);
    console.log('Done:', result);

    // Verify none remain
    const remaining = await findTargets(client);
    console.log(`Remaining multi-category products with Others: ${remaining.length}`);

    updateJsonExport(productIds);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
