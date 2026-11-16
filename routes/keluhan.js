const express = require('express');
const multer  = require('multer');
const { run, get, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadImage } = require('../services/storage');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
    cb(null, true);
  },
});

const SLA = {
  P1: { respon: '15 menit', selesai: '12 jam' },
  P2: { respon: '30 menit', selesai: '24 jam' },
  P3: { respon: '2 jam',    selesai: '48 jam' },
};
const STATUS = ['Baru', 'Dalam Penanganan', 'Dalam Pemantauan', 'Selesai & Klien Puas', 'Perlu Tindakan Lanjutan'];

// Simple in-memory rate limit for the public endpoint (5 submissions / 10 min / IP)
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(req.ip) || []).filter(t => now - t < win);
  if (arr.length >= 5) return res.status(429).json({ error: 'Terlalu banyak pengiriman. Coba lagi beberapa menit lagi.' });
  arr.push(now); hits.set(req.ip, arr);
  next();
}

let tableReady = false;
async function ensureTable() {
  if (tableReady) return;
  await run(`
    CREATE TABLE IF NOT EXISTS complaints (
      id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      ticket_no     VARCHAR(40) NOT NULL UNIQUE,
      nama          VARCHAR(255) NOT NULL,
      kontak        VARCHAR(50)  NOT NULL,
      alamat        TEXT NOT NULL,
      bangunan      VARCHAR(100),
      layanan       VARCHAR(100),
      hama          VARCHAR(255),
      level         VARCHAR(2) NOT NULL DEFAULT 'P2',
      deskripsi     TEXT NOT NULL,
      harapan       TEXT,
      teknisi_asal  VARCHAR(255),
      image_urls    TEXT,
      status        VARCHAR(50) NOT NULL DEFAULT 'Baru',
      tindakan      TEXT,
      penugasan     VARCHAR(255),
      followup_date DATE NULL,
      catatan_admin TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at    TIMESTAMP NULL DEFAULT NULL
    ) CHARACTER SET utf8mb4
  `);
  tableReady = true;
}

const clean = (v, max = 500) => String(v ?? '').trim().slice(0, max);

// ── PUBLIC: POST /api/keluhan ─────────────────────────────────────────────────
router.post('/', rateLimit, upload.array('foto', 5), async (req, res) => {
  try {
    await ensureTable();
    if (req.body.website) return res.json({ ok: true, ticket_no: 'LPC-KLU-OK' }); // honeypot

    const b = req.body;
    const nama = clean(b.nama, 255), kontak = clean(b.kontak, 50),
          alamat = clean(b.alamat, 1000), deskripsi = clean(b.deskripsi, 3000);
    if (!nama || !kontak || !alamat || !deskripsi)
      return res.status(400).json({ error: 'Nama, kontak, alamat, dan deskripsi keluhan wajib diisi.' });

    const level = ['P1', 'P2', 'P3'].includes(b.level) ? b.level : 'P2';

    const urls = [];
    for (const f of req.files || []) urls.push(await uploadImage(f.buffer, 'pest-control/keluhan', f.originalname));

    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const row = await get('SELECT COUNT(*) AS c FROM complaints WHERE ticket_no LIKE ?', [`LPC-KLU-${ymd}-%`]);
    const ticket = `LPC-KLU-${ymd}-${String(Number(row?.c || 0) + 1).padStart(3, '0')}`;

    await run(
      `INSERT INTO complaints (ticket_no, nama, kontak, alamat, bangunan, layanan, hama, level, deskripsi, harapan, teknisi_asal, image_urls)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [ticket, nama, kontak, alamat, clean(b.bangunan, 100), clean(b.layanan, 100), clean(b.hama, 255), level,
       deskripsi, clean(b.harapan, 1000), clean(b.teknisi_asal, 255), JSON.stringify(urls)]
    );
    res.status(201).json({ ok: true, ticket_no: ticket, sla: SLA[level] });
  } catch (err) {
    console.error('[keluhan POST]', err);
    res.status(500).json({ error: 'Gagal menyimpan keluhan: ' + err.message });
  }
});

// ── ADMIN: GET /api/keluhan ───────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureTable();
    const cond = [], params = [];
    if (req.query.status) { cond.push('status = ?'); params.push(req.query.status); }
    if (req.query.level)  { cond.push('level = ?');  params.push(req.query.level); }
    if (req.query.search) {
      cond.push('(nama LIKE ? OR ticket_no LIKE ? OR kontak LIKE ? OR deskripsi LIKE ?)');
      const s = `%${req.query.search}%`; params.push(s, s, s, s);
    }
    const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
    const rows = await all(`SELECT * FROM complaints ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json({ ok: true, sla: SLA, data: rows.map(r => ({ ...r, image_urls: JSON.parse(r.image_urls || '[]') })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── ADMIN: PUT /api/keluhan/:id (update penanganan) ───────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    await ensureTable();
    const b = req.body;
    if (b.status && !STATUS.includes(b.status)) return res.status(400).json({ error: 'Status tidak valid' });
    const r = await run(
      `UPDATE complaints SET status = COALESCE(?, status), level = COALESCE(?, level), tindakan = ?, penugasan = ?,
         followup_date = ?, catatan_admin = ?, teknisi_asal = COALESCE(?, teknisi_asal), updated_at = NOW() WHERE id = ?`,
      [b.status || null, ['P1', 'P2', 'P3'].includes(b.level) ? b.level : null, clean(b.tindakan, 3000), clean(b.penugasan, 255),
       b.followup_date || null, clean(b.catatan_admin, 3000), b.teknisi_asal != null ? clean(b.teknisi_asal, 255) : null, req.params.id]
    );
    if (!r.changes) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const r = await run('DELETE FROM complaints WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json({ ok: true });
});

// Multer / validation errors → JSON
router.use((err, req, res, next) => res.status(400).json({ error: err.message }));

module.exports = router;
module.exports.STATUS = STATUS;
