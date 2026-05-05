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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nama          VARCHAR(255) NOT NULL,
      alamat        TEXT,
      no_hp         VARCHAR(50),
      created_by    INT,
      updated_by    INT,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP NULL DEFAULT NULL
    ) CHARACTER SET utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS surveys (
      id                   INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nama_calon_pelanggan VARCHAR(255) NOT NULL,
      waktu_kunjungan      DATETIME NOT NULL,
      hama                 TEXT,
      signature_b64        LONGTEXT,
      submitted_by         INT,
      created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at           TIMESTAMP NULL DEFAULT NULL
    ) CHARACTER SET utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS treatment_cards (
      id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      nama_client      VARCHAR(255),
      alamat           TEXT,
      contact_person   VARCHAR(255),
      periode_kontrak  VARCHAR(100),
      no_card          VARCHAR(100),
      jenis_layanan    VARCHAR(255),
      jenis_treatment  VARCHAR(255),
      tipe             TEXT,
      contract_type    VARCHAR(20),
      frekuensi        INT DEFAULT 1,
      submitted_by     INT,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       TIMESTAMP NULL DEFAULT NULL
    ) CHARACTER SET utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS treatment_card_entries (
      id               INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      card_id          INT NOT NULL,
      no_visit         INT NOT NULL,
      tanggal          DATE,
      teknisi          VARCHAR(255),
      time_in          VARCHAR(10),
      time_out         VARCHAR(10),
      area_treatment   TEXT,
      jenis_treatment  VARCHAR(255),
      paraf_b64        LONGTEXT,
      created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
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
