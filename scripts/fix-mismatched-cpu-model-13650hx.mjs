/**
 * Create CPU Model "13650HX" if missing and re-point products whose titles
 * say 13650HX but were AI-matched to a different CPU Model value.
 */
import 'dotenv/config';
import pg from 'pg';

const PRODUCT_IDS = [4205, 1831, 2866, 2893, 4641];
const CPU_MODEL_SPEC_ID = 25;
const CORE_I7_PARENT_VALUE_ID = 139;
const TARGET_VALUE = '13650HX';

const client = new pg.Client({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false },
});

async function ensureCpuModelValue() {
  const existing = await client.query(
    `
      SELECT id, value_en, parent_value_id
      FROM specification_values
      WHERE specification_id = $1
        AND lower(value_en) = lower($2)
      LIMIT 1
    `,
    [CPU_MODEL_SPEC_ID, TARGET_VALUE],
  );

  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const sort = await client.query(
    `
      SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort
      FROM specification_values
      WHERE specification_id = $1
    `,
    [CPU_MODEL_SPEC_ID],
  );

  const inserted = await client.query(
    `
      INSERT INTO specification_values (
        specification_id,
        value_en,
        value_ar,
        parent_value_id,
        sort_order,
        is_active,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $2, $3, $4, true, NOW(), NOW())
      RETURNING id, value_en, parent_value_id
    `,
    [
      CPU_MODEL_SPEC_ID,
      TARGET_VALUE,
      CORE_I7_PARENT_VALUE_ID,
      sort.rows[0].next_sort,
    ],
  );

  return inserted.rows[0];
}

async function main() {
  await client.connect();

  const before = await client.query(
    `
      SELECT
        p.id,
        p.name_en,
        sv.id AS value_id,
        sv.value_en
      FROM products p
      JOIN product_specification_values psv ON psv.product_id = p.id
      JOIN specification_values sv ON sv.id = psv.specification_value_id
      JOIN specifications s ON s.id = sv.specification_id
      WHERE p.id = ANY($1::int[])
        AND s.name_en = 'CPU Model'
      ORDER BY p.id
    `,
    [PRODUCT_IDS],
  );

  console.log('BEFORE:', JSON.stringify(before.rows, null, 2));

  const cpuModel = await ensureCpuModelValue();
  console.log('TARGET_VALUE:', cpuModel);

  const updated = await client.query(
    `
      UPDATE product_specification_values AS psv
      SET specification_value_id = $1,
          updated_at = NOW()
      FROM specification_values AS sv
      JOIN specifications AS s ON s.id = sv.specification_id
      WHERE psv.specification_value_id = sv.id
        AND psv.product_id = ANY($2::int[])
        AND s.name_en = 'CPU Model'
        AND sv.id <> $1
      RETURNING psv.product_id, psv.specification_value_id
    `,
    [cpuModel.id, PRODUCT_IDS],
  );

  console.log('UPDATED_ROWS:', JSON.stringify(updated.rows, null, 2));

  const after = await client.query(
    `
      SELECT
        p.id,
        p.name_en,
        sv.id AS value_id,
        sv.value_en
      FROM products p
      JOIN product_specification_values psv ON psv.product_id = p.id
      JOIN specification_values sv ON sv.id = psv.specification_value_id
      JOIN specifications s ON s.id = sv.specification_id
      WHERE p.id = ANY($1::int[])
        AND s.name_en = 'CPU Model'
      ORDER BY p.id
    `,
    [PRODUCT_IDS],
  );

  console.log('AFTER:', JSON.stringify(after.rows, null, 2));

  const stillWrong = after.rows.filter(
    (row) => !String(row.value_en).toLowerCase().includes('13650'),
  );
  if (stillWrong.length) {
    throw new Error(
      `Some products still have wrong CPU Model: ${JSON.stringify(stillWrong)}`,
    );
  }

  await client.end();
  console.log('DB_FIX_OK', { productIds: PRODUCT_IDS, valueId: cpuModel.id });
}

main().catch(async (error) => {
  console.error(error);
  try {
    await client.end();
  } catch {
    // ignore
  }
  process.exit(1);
});
