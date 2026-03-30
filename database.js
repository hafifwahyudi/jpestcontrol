const mysql  = require('mysql2/promise');
const bcrypt = require('bcryptjs');

// ── Connection pool ───────────────────────────────────────────────────────────
const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,          // mysql://user:pass@host:3306/dbname
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function run(sql, params = []) {
  const [result] = await pool.query(sql, params);
  return {
    lastID:  result.insertId    ?? null,
    changes: result.affectedRows ?? 0,
  };
}

async function get(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows[0] ?? null;
}

async function all(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// ── Schema init ───────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      username      VARCHAR(100) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role          VARCHAR(50)  NOT NULL DEFAULT 'technician',
      full_name     VARCHAR(255),
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS submissions (
      id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      form_data     LONGTEXT NOT NULL,
      signature_b64 LONGTEXT,
      image_urls    TEXT,
      submitted_by  INT,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP NULL DEFAULT NULL
    ) CHARACTER SET utf8mb4
  `);

  // Seed default admin
  const existing = await get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!existing) {
    const hash = bcrypt.hashSync('jemberpest2024$#', 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'admin', 'Administrator')`,
      ['admin', hash]
    );
    console.log('✅ Default admin created → admin / jemberpest2024$#');
  }

  // Seed example karyawan
  const existingKaryawan = await get('SELECT id FROM users WHERE username = ?', ['karyawan1']);
  if (!existingKaryawan) {
    const hash = bcrypt.hashSync('karyawan123', 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'karyawan', 'Budi Santoso')`,
      ['karyawan1', hash]
    );
    console.log('✅ Example karyawan created → karyawan1 / karyawan123');
  }

  console.log('✅ Database ready (MySQL)');
}

module.exports = { pool, initDb, run, get, all };
