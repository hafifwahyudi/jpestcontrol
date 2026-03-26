const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH  = path.join(DATA_DIR, 'app.db');

let db;

function getDb() {
  if (!db) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) console.error('DB open error:', err);
    });
  }
  return db;
}

// Promisified helpers
function run(sql, params = []) {
  return new Promise((res, rej) => {
    getDb().run(sql, params, function(err) {
      if (err) rej(err); else res({ lastID: this.lastID, changes: this.changes });
    });
  });
}
function get(sql, params = []) {
  return new Promise((res, rej) => {
    getDb().get(sql, params, (err, row) => { if (err) rej(err); else res(row); });
  });
}
function all(sql, params = []) {
  return new Promise((res, rej) => {
    getDb().all(sql, params, (err, rows) => { if (err) rej(err); else res(rows); });
  });
}

async function initDb() {
  getDb(); // ensure opened

  await run(`PRAGMA foreign_keys = ON`);

  await run(`CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE,
    password_hash TEXT    NOT NULL,
    role          TEXT    NOT NULL DEFAULT 'technician',
    full_name     TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  await run(`CREATE TABLE IF NOT EXISTS submissions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    form_data     TEXT    NOT NULL,
    signature_b64 TEXT,
    image_urls    TEXT    NOT NULL DEFAULT '[]',
    submitted_by  INTEGER REFERENCES users(id),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  )`);

  const existing = await get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!existing) {
    const hash = bcrypt.hashSync('jemberpest2024', 10);
    await run(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'admin', 'Administrator')`,
      ['admin', hash]
    );
    console.log('✅ Default admin created → admin / jemberpest2024');
  }

  const existingKaryawan = await get('SELECT id FROM users WHERE username = ?', ['karyawan1']);
  if (!existingKaryawan) {
    const hash = bcrypt.hashSync('karyawan123', 10);
    await run(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, 'karyawan', 'Budi Santoso')`,
      ['karyawan1', hash]
    );
    console.log('✅ Example karyawan created → karyawan1 / karyawan123');
  }

  console.log(`✅ Database ready at ${DB_PATH}`);
}

module.exports = { getDb, initDb, run, get, all };
