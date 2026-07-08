const { Client } = require('pg');

require('dotenv').config();

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

  return result.rowCount > 0;
}

async function main() {
  const client = createClient();

  await client.connect();

  try {
    const tagsEnExists = await columnExists(client, 'categories', 'tags_en');
    const tagsArExists = await columnExists(client, 'categories', 'tags_ar');

    if (tagsEnExists && tagsArExists) {
      console.log('categories.tags_en and categories.tags_ar already exist. Nothing to do.');
      return;
    }

    await client.query('BEGIN');

    if (!tagsEnExists) {
      await client.query(`
        ALTER TABLE "categories"
        ADD COLUMN IF NOT EXISTS "tags_en" text[] NOT NULL DEFAULT '{}'::text[]
      `);
      console.log('Added categories.tags_en');
    }

    if (!tagsArExists) {
      await client.query(`
        ALTER TABLE "categories"
        ADD COLUMN IF NOT EXISTS "tags_ar" text[] NOT NULL DEFAULT '{}'::text[]
      `);
      console.log('Added categories.tags_ar');
    }

    await client.query('COMMIT');
    console.log('Category tags columns migration completed successfully.');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    console.error('Category tags columns migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

void main();
