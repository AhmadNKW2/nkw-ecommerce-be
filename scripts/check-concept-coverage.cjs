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

  const total = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM products
    WHERE status IN ('active', 'updated', 'review')
  `);
  const concepts = await client.query(`SELECT COUNT(*)::int AS count FROM term_groups`);
  const referenced = await client.query(`
    SELECT COUNT(DISTINCT unnest_id)::int AS count
    FROM (
      SELECT unnest(reference_product_ids) AS unnest_id
      FROM term_groups
    ) t
  `);
  const unreferenced = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM products p
    WHERE p.status IN ('active', 'updated', 'review')
      AND NOT EXISTS (
        SELECT 1 FROM term_groups tg
        WHERE p.id = ANY(tg.reference_product_ids)
      )
  `);
  const sample = await client.query(`
    SELECT p.id, p.name_en
    FROM products p
    WHERE p.status IN ('active', 'updated', 'review')
      AND NOT EXISTS (
        SELECT 1 FROM term_groups tg
        WHERE p.id = ANY(tg.reference_product_ids)
      )
    ORDER BY p.id
    LIMIT 15
  `);

  console.log(
    JSON.stringify(
      {
        total_products: total.rows[0].count,
        concept_groups: concepts.rows[0].count,
        referenced_products: referenced.rows[0].count,
        unreferenced_products: unreferenced.rows[0].count,
        sample_unreferenced: sample.rows,
      },
      null,
      2,
    ),
  );

  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
