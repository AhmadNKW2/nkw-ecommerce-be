const { Client } = require('pg');
const bcrypt = require('bcrypt');
require('dotenv').config();

const ADMIN = {
  email: 'ahmadnkw@outlook.com',
  password: 'Ahmad1998.',
  firstName: 'Ahmad',
  lastName: 'Admin',
  role: 'admin',
};

async function createAdmin() {
  const client = new Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    ssl: {
      rejectUnauthorized: false,
    },
  });

  try {
    await client.connect();
    console.log('Connected to database');

    const email = ADMIN.email.toLowerCase().trim();

    const existing = await client.query('SELECT id, email, role FROM users WHERE email = $1', [
      email,
    ]);

    if (existing.rows.length > 0) {
      console.log('Admin user already exists.');
      console.log('Email:', existing.rows[0].email);
      console.log('Role:', existing.rows[0].role);
      return;
    }

    const hashedPassword = await bcrypt.hash(ADMIN.password, 10);

    const result = await client.query(
      `INSERT INTO users ("firstName", "lastName", email, password, role, "isActive", "emailVerified", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
       RETURNING id, "firstName", "lastName", email, role`,
      [
        ADMIN.firstName,
        ADMIN.lastName,
        email,
        hashedPassword,
        ADMIN.role,
        true,
        true,
      ],
    );

    console.log('\nAdmin user created successfully.');
    console.log('ID:', result.rows[0].id);
    console.log('Name:', result.rows[0].firstName, result.rows[0].lastName);
    console.log('Email:', result.rows[0].email);
    console.log('Role:', result.rows[0].role);
  } catch (error) {
    console.error('Error creating admin user:', error.message);
    process.exitCode = 1;
  } finally {
    await client.end();
    console.log('Database connection closed');
  }
}

createAdmin();
