const path = require('path');
const { Client } = require('pg');
const bcrypt = require('bcrypt');
const { config: loadEnv } = require('dotenv');

loadEnv({ path: path.join(__dirname, '../../.env'), override: true });

function loadConfig() {
  const configPath = path.join(__dirname, 'config.js');

  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    return require(configPath);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') {
      console.error(
        'Missing config.js. Copy config.example.js to config.js and set email + newPassword.',
      );
      process.exit(1);
    }

    throw error;
  }
}

function getDatabaseConfig() {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    return {
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('sslmode=require')
        ? { rejectUnauthorized: false }
        : undefined,
    };
  }

  const host = process.env.DB_HOST;
  const port = Number(process.env.DB_PORT || 5432);
  const user = process.env.DB_USERNAME;
  const password = process.env.DB_PASSWORD;
  const database = process.env.DB_NAME;

  if (!host || !user || !password || !database) {
    console.error(
      'Database config missing. Set DATABASE_URL or DB_HOST/DB_USERNAME/DB_PASSWORD/DB_NAME in ordonsooq-be/.env',
    );
    process.exit(1);
  }

  return {
    host,
    port,
    user,
    password,
    database,
    ssl: host.includes('neon.tech') ? { rejectUnauthorized: false } : undefined,
  };
}

async function resetPassword() {
  const { email, newPassword } = loadConfig();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const password = String(newPassword || '');

  if (!normalizedEmail) {
    console.error('config.js: email is required.');
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('config.js: newPassword must be at least 8 characters.');
    process.exit(1);
  }

  const client = new Client(getDatabaseConfig());

  try {
    await client.connect();

    const existing = await client.query(
      'SELECT id, email, "firstName", "lastName", role FROM users WHERE LOWER(email) = $1 LIMIT 1',
      [normalizedEmail],
    );

    if (existing.rowCount === 0) {
      console.error(`No user found for email: ${normalizedEmail}`);
      process.exit(1);
    }

    const user = existing.rows[0];
    const hashedPassword = await bcrypt.hash(password, 10);

    await client.query(
      'UPDATE users SET password = $1, "updatedAt" = NOW() WHERE id = $2',
      [hashedPassword, user.id],
    );

    console.log('Password updated successfully.');
    console.log(`User #${user.id}: ${user.email} (${user.firstName} ${user.lastName}, role=${user.role})`);
  } finally {
    await client.end();
  }
}

resetPassword().catch((error) => {
  console.error('Reset password failed:', error.message || error);
  process.exit(1);
});
