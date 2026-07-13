/**
 * Apply all known schema fixes for production/staging databases.
 * Safe to run multiple times — uses IF NOT EXISTS / idempotent checks.
 *
 * Usage: node scripts/ensure-schema.cjs
 */

require('dotenv').config();
const { Client } = require('pg');

function createClient() {
  return new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: String(process.env.DB_PASSWORD),
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });
}

async function columnExists(client, tableName, columnName) {
  const result = await client.query(
    `
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1
    `,
    [tableName, columnName],
  );
  return result.rows.length > 0;
}

async function tableExists(client, tableName) {
  const result = await client.query(
    `SELECT to_regclass($1) AS table_name`,
    [`public.${tableName}`],
  );
  return Boolean(result.rows[0]?.table_name);
}

async function addColumnIfMissing(client, tableName, columnName, definition) {
  if (await columnExists(client, tableName, columnName)) {
    console.log(`  skip ${tableName}.${columnName} (exists)`);
    return;
  }

  await client.query(
    `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`,
  );
  console.log(`  added ${tableName}.${columnName}`);
}

async function ensureUsersColumns(client) {
  console.log('users columns');
  await addColumnIfMissing(client, 'users', 'admin_access', 'jsonb NULL');
  await addColumnIfMissing(client, 'users', 'constant_access_token', 'text NULL');
  await addColumnIfMissing(client, 'users', 'vendor_id', 'integer NULL');
}

async function ensureVendorsColumns(client) {
  console.log('vendors columns');
  await addColumnIfMissing(client, 'vendors', 'password', 'text NULL');
}

async function ensureProductAttachmentsTable(client) {
  console.log('product_attachments table');
  if (await tableExists(client, 'product_attachments')) {
    console.log('  skip product_attachments (exists)');
    return;
  }

  await client.query(`
    CREATE TABLE product_attachments (
      id SERIAL PRIMARY KEY,
      product_id integer NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      media_id integer NOT NULL REFERENCES media(id) ON DELETE CASCADE,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      CONSTRAINT uq_product_attachments_product_media UNIQUE (product_id, media_id)
    )
  `);
  await client.query(`
    CREATE INDEX idx_product_attachments_product_id
    ON product_attachments (product_id)
  `);
  await client.query(`
    CREATE INDEX idx_product_attachments_media_id
    ON product_attachments (media_id)
  `);
  await client.query(`
    CREATE INDEX idx_product_attachments_product_sort
    ON product_attachments (product_id, sort_order)
  `);
  console.log('  created product_attachments');
}

async function ensureProductFieldTogglesColumns(client) {
  console.log('product_field_toggles columns');
  if (!(await tableExists(client, 'product_field_toggles'))) {
    console.log('  skip (table missing — backend will create on startup)');
    return;
  }

  const booleanColumns = [
    ['vendors_enabled', 'true'],
    ['ratings_enabled', 'true'],
    ['attributes_enabled', 'true'],
    ['specifications_enabled', 'true'],
    ['weight_and_dimensions_enabled', 'true'],
    ['partners_enabled', 'true'],
    ['cashback_enabled', 'true'],
    ['banners_enabled', 'true'],
    ['import_ai_products_enabled', 'true'],
    ['linked_products_enabled', 'true'],
    ['reference_links_enabled', 'true'],
    ['easy_purchase_enabled', 'false'],
    ['cart_sidebar_button_enabled', 'true'],
    ['popup_enabled', 'true'],
    ['product_status_enabled', 'true'],
    ['product_files_enabled', 'true'],
    ['pricing_view_enabled', 'true'],
    ['reference_link_visible_admin', 'true'],
    ['meta_title_visible_admin', 'true'],
    ['meta_description_visible_admin', 'true'],
  ];

  for (const [name, defaultValue] of booleanColumns) {
    await addColumnIfMissing(
      client,
      'product_field_toggles',
      name,
      `boolean NOT NULL DEFAULT ${defaultValue}`,
    );
  }
}

async function ensureProductsColumns(client) {
  console.log('products columns');
  await addColumnIfMissing(
    client,
    'products',
    'original_vendor_price',
    'decimal(10,2) NULL',
  );
  await addColumnIfMissing(
    client,
    'products',
    'original_vendor_sale_price',
    'decimal(10,2) NULL',
  );
  await addColumnIfMissing(
    client,
    'products',
    'weight_unit',
    "varchar(10) NOT NULL DEFAULT 'kg'",
  );
  await addColumnIfMissing(
    client,
    'products',
    'dimension_unit',
    "varchar(10) NOT NULL DEFAULT 'cm'",
  );
  await addColumnIfMissing(
    client,
    'products',
    'reference_slug',
    'varchar(255) NULL',
  );
  await addColumnIfMissing(
    client,
    'products',
    'reference_links',
    "jsonb NOT NULL DEFAULT '[]'::jsonb",
  );

  const backfillReferenceLinks = await client.query(`
    UPDATE products
    SET reference_links = jsonb_build_array(btrim(reference_link))
    WHERE reference_link IS NOT NULL
      AND btrim(reference_link) <> ''
      AND (
        reference_links IS NULL
        OR reference_links = '[]'::jsonb
      )
  `);
  if (backfillReferenceLinks.rowCount > 0) {
    console.log(`  backfilled reference_links for ${backfillReferenceLinks.rowCount} products`);
  }
}

async function ensureOrdersColumns(client) {
  console.log('orders columns');
  await addColumnIfMissing(
    client,
    'orders',
    'walletAppliedAmount',
    'decimal(10,2) NOT NULL DEFAULT 0',
  );
}

async function ensureTermGroupsTable(client) {
  console.log('term_groups table');
  await client.query(`
    CREATE TABLE IF NOT EXISTS term_groups (
      id SERIAL PRIMARY KEY,
      terms_en text[] NOT NULL DEFAULT '{}',
      terms_ar text[] NOT NULL DEFAULT '{}',
      concept_key varchar(160) NULL,
      concept_label_en varchar(255) NULL,
      concept_label_ar varchar(255) NULL,
      reference_product_ids integer[] NOT NULL DEFAULT '{}',
      source_product_id integer NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_term_groups_source_product_id
    ON term_groups (source_product_id)
  `);
  await client.query(`
    ALTER TABLE term_groups
    ADD COLUMN IF NOT EXISTS concept_key varchar(160),
    ADD COLUMN IF NOT EXISTS concept_label_en varchar(255),
    ADD COLUMN IF NOT EXISTS concept_label_ar varchar(255),
    ADD COLUMN IF NOT EXISTS reference_product_ids integer[] NOT NULL DEFAULT '{}'
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_term_groups_concept_key
    ON term_groups (concept_key)
    WHERE concept_key IS NOT NULL
  `);
  console.log('  term_groups ready');
}

async function verifySchema(client) {
  console.log('\nverification');
  const checks = [
    ['users', 'constant_access_token'],
    ['product_field_toggles', 'product_files_enabled'],
    ['product_attachments', null],
  ];

  for (const [table, column] of checks) {
    const hasTable = await tableExists(client, table);
    if (!hasTable) {
      throw new Error(`Missing table: ${table}`);
    }

    if (column) {
      const hasColumn = await columnExists(client, table, column);
      if (!hasColumn) {
        throw new Error(`Missing column: ${table}.${column}`);
      }
      console.log(`  ok ${table}.${column}`);
    } else {
      console.log(`  ok ${table}`);
    }
  }
}

async function main() {
  const client = createClient();
  await client.connect();
  console.log(`Connected to ${process.env.DB_NAME}@${process.env.DB_HOST}\n`);

  try {
    await ensureUsersColumns(client);
    await ensureVendorsColumns(client);
    await ensureProductAttachmentsTable(client);
    await ensureProductFieldTogglesColumns(client);
    await ensureProductsColumns(client);
    await ensureOrdersColumns(client);
    await ensureTermGroupsTable(client);
    await verifySchema(client);
    console.log('\nSchema ensure completed successfully.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('\nSchema ensure failed:', error.message);
  process.exit(1);
});
