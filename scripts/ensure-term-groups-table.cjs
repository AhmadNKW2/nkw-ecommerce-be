require('dotenv').config();
const { Client } = require('pg');

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: String(process.env.DB_PASSWORD),
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

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
    );
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_term_groups_source_product_id
    ON term_groups (source_product_id);
  `);

  await client.query(`
    ALTER TABLE term_groups
    ADD COLUMN IF NOT EXISTS concept_key varchar(160),
    ADD COLUMN IF NOT EXISTS concept_label_en varchar(255),
    ADD COLUMN IF NOT EXISTS concept_label_ar varchar(255),
    ADD COLUMN IF NOT EXISTS reference_product_ids integer[] NOT NULL DEFAULT '{}';
  `);

  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_term_groups_concept_key
    ON term_groups (concept_key)
    WHERE concept_key IS NOT NULL;
  `);

  console.log('term_groups table is ready');
  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
