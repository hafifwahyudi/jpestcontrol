const express = require('express');
const { run, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// Rate limit sederhana untuk endpoint publik (10 kiriman / 10 menit / IP)
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(req.ip) || []).filter(t => now - t < win);
  if (arr.length >= 10) return res.status(429).json({ error: 'Terlalu banyak pengiriman. Coba lagi beberapa menit lagi.' });
  arr.push(now); hits.set(req.ip, arr);
  next();
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await run(`
    CREATE TABLE IF NOT EXISTS order_requests (
      id          INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      jenis_permintaan VARCHAR(255),
      nama        VARCHAR(255) NOT NULL,
      telepon     VARCHAR(50)  NOT NULL,
      alamat      TEXT NOT NULL,
      bangunan    VARCHAR(100),
      luas        VARCHAR(100),
      hama        VARCHAR(255),
      keterangan  TEXT,
      status      VARCHAR(50) NOT NULL DEFAULT 'Baru',
      created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4
  `);
  tableReady = true;
}

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

// PUBLIC: POST /api/pesanan
router.post('/', rateLimit, async (req, res) => {
  try {
    await ensureTable();
    const b = req.body || {};
    const nama = clean(b.nama, 255), telepon = clean(b.telepon, 50), alamat = clean(b.alamat, 1000);
    if (!nama || !telepon || !alamat)
      return res.status(400).json({ error: 'Nama, telepon, dan alamat wajib diisi.' });

    const r = await run(
      `INSERT INTO order_requests (jenis_permintaan, nama, telepon, alamat, bangunan, luas, hama, keterangan)
       VALUES (?,?,?,?,?,?,?,?)`,
      [clean(b.jenis_permintaan, 255), nama, telepon, alamat, clean(b.bangunan, 100),
       clean(b.luas, 100), clean(b.hama, 255), clean(b.keterangan, 3000)]
    );
    res.json({ ok: true, id: r.lastID });
  } catch (err) {
    console.error('[pesanan POST]', err);
    res.status(500).json({ error: 'Gagal menyimpan data: ' + err.message });
  }
});

const STATUS = ['Baru', 'Dihubungi', 'Survey Dijadwalkan', 'Selesai', 'Batal'];

// ADMIN: GET /api/pesanan
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTable();
    const cond = [], params = [];
    if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
    if (req.query.search) {
      cond.push('(nama LIKE ? OR telepon LIKE ? OR alamat LIKE ? OR hama LIKE ?)');
      const s = `%${req.query.search}%`; params.push(s, s, s, s);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = await all(`SELECT * FROM order_requests ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json({ ok: true, statuses: STATUS, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: PUT /api/pesanan/:id (ubah status)
router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTable();
    if (!STATUS.includes(req.body.status)) return res.status(400).json({ error: 'Status tidak valid' });
    const r = await run('UPDATE order_requests SET status = ? WHERE id = ?', [req.body.status, req.params.id]);
    if (!r.changes) return res.status(404).json({ error: 'Data tidak ditemukan' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: DELETE /api/pesanan/:id
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await ensureTable();
    await run('DELETE FROM order_requests WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;