const { Client } = require('pg');
require('dotenv').config();

async function main() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  const result = await client.query(`
    SELECT id, email, "firstName", "lastName", role, "isActive"
    FROM users
    WHERE LOWER("firstName") LIKE '%khal%'
       OR LOWER("lastName") LIKE '%khal%'
       OR LOWER(email) LIKE '%khal%'
       OR role = 'constant_token_admin'
    ORDER BY id
  `);
  console.log(JSON.stringify(result.rows, null, 2));
  await client.end();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
