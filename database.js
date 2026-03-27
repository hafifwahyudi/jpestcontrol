const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// ── Connection pool ───────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ── Auto-convert ? placeholders to $1, $2, ... ───────────────────────────────
function buildQuery(sql, params = []) {
  let i = 0;
  const text = sql.replace(/\?/g, () => `$${++i}`);
  return { text, values: params };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function run(sql, params = []) {
  const { text, values } = buildQuery(sql, params);
  const result = await pool.query(text, values);
  return {
    lastID: result.rows?.[0]?.id ?? null,
    changes: result.rowCount,
  };
}

async function get(sql, params = []) {
  const { text, values } = buildQuery(sql, params);
  const result = await pool.query(text, values);
  return result.rows[0] ?? null;
}

async function all(sql, params = []) {
  const { text, values } = buildQuery(sql, params);
  const result = await pool.query(text, values);
  return result.rows;
}

// ── Schema init ───────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      role          TEXT    NOT NULL DEFAULT 'technician',
      full_name     TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id            SERIAL PRIMARY KEY,
      form_data     TEXT    NOT NULL,
      signature_b64 TEXT,
      image_urls    TEXT    NOT NULL DEFAULT '[]',
      submitted_by  INTEGER REFERENCES users(id),
      created_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  // Seed default admin
  const existing = await get('SELECT id FROM users WHERE username = $1', ['admin']);
  if (!existing) {
    const hash = bcrypt.hashSync('jemberpest2024', 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES ($1, $2, 'admin', 'Administrator')`,
      ['admin', hash]
    );
    console.log('✅ Default admin created → admin / jemberpest2024');
  }

  // Seed example karyawan
  const existingKaryawan = await get('SELECT id FROM users WHERE username = $1', ['karyawan1']);
  if (!existingKaryawan) {
    const hash = bcrypt.hashSync('karyawan123', 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES ($1, $2, 'karyawan', 'Budi Santoso')`,
      ['karyawan1', hash]
    );
    console.log('✅ Example karyawan created → karyawan1 / karyawan123');
  }

  console.log('✅ Database ready (PostgreSQL)');
}

module.exports = { pool, initDb, run, get, all };
