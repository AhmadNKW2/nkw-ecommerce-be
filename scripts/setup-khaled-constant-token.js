/**
 * Ensure Khaled constant_token_admin has a persisted access token in DB.
 * Usage: node scripts/setup-khaled-constant-token.js
 */

const { Client } = require('pg');
require('dotenv').config();

const KHALED_EMAIL = process.env.CONSTANT_TOKEN_ADMIN_EMAIL || 'khaled@ordonsooq.com';

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

  const columns = await client.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'constant_access_token'
  `);

  if (!columns.rows.length) {
    await client.query(
      `ALTER TABLE users ADD COLUMN constant_access_token text NULL`,
    );
    console.log('Added users.constant_access_token column');
  }

  const users = await client.query(
    `SELECT id, email, role, constant_access_token
     FROM users
     WHERE email = $1`,
    [KHALED_EMAIL.toLowerCase()],
  );

  if (!users.rows.length) {
    throw new Error(`User not found: ${KHALED_EMAIL}`);
  }

  const user = users.rows[0];
  if (user.role !== 'constant_token_admin') {
    throw new Error(`User ${KHALED_EMAIL} is role=${user.role}, expected constant_token_admin`);
  }

  if (user.constant_access_token) {
    console.log('Khaled already has a persisted constant token');
    console.log('User ID:', user.id);
    console.log('Token prefix:', user.constant_access_token.slice(0, 32) + '...');
    await client.end();
    return;
  }

  const API = (process.env.API_ORIGIN || 'https://api.ordonsooq.com').replace(/\/$/, '');
  const password = process.env.CONSTANT_TOKEN_ADMIN_PASSWORD || 'Khaled@Password';
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: KHALED_EMAIL, password }),
  });
  const loginBody = await loginRes.json();
  if (!loginBody.success) {
    throw new Error(`Login failed: ${JSON.stringify(loginBody)}`);
  }

  const token = loginBody.data.access_token;
  await client.query(
    `UPDATE users SET constant_access_token = $1, "updatedAt" = NOW() WHERE id = $2`,
    [token, user.id],
  );

  console.log('Persisted Khaled constant access token');
  console.log('User ID:', user.id);
  console.log('Email:', user.email);
  console.log('Token prefix:', token.slice(0, 32) + '...');

  await client.end();
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
