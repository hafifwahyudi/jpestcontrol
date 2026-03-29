const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const { run, get, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadImage } = require('../services/storage');

function generateToken(id, timestamp) {
  const secret = process.env.JWT_SECRET || 'jpc_secret';
  return crypto.createHmac('sha256', secret)
    .update(`${id}:${timestamp}`)
    .digest('hex')
    .substring(0, 32);
}

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
    cb(null, true);
  },
});

const ROMAN = ['','I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII'];

// ── GET /api/submissions/next-no ─────────────────────────────────────────────
router.get('/next-no', requireAuth, async (req, res) => {
  try {
    const row  = await get('SELECT COUNT(*) as c FROM submissions');
    const count = parseInt(row?.c ?? row?.count ?? 0) + 1;
    const now  = new Date();
    const no   = `${String(count).padStart(3,'0')}/SS-JPC/${ROMAN[now.getMonth()+1]}/${now.getFullYear()}`;
    res.json({ ok: true, no });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/submissions ─────────────────────────────────────────────────────

router.post('/', requireAuth, upload.array('evidence_images', 10), async (req, res) => {
  try {
    const formData     = JSON.parse(req.body.form_data || '{}');
    const signatureB64 = req.body.signature_b64 || null;
    const imageUrls    = [];

    if (req.files?.length) {
      for (const file of req.files) {
        const url = await uploadImage(file.buffer, 'pest-control/evidence');
        imageUrls.push(url);
      }
    }

    const result = await run(
      `INSERT INTO submissions (form_data, signature_b64, image_urls, submitted_by) VALUES (?, ?, ?, ?) RETURNING id`,
      [JSON.stringify(formData), signatureB64, JSON.stringify(imageUrls), req.user.id]
    );

    res.status(201).json({ ok: true, id: result.lastID, image_urls: imageUrls });
  } catch (err) {
    console.error('[submissions POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/submissions — paginated list (karyawan only sees their own) ──────
router.get('/', requireAuth, async (req, res) => {
  const page    = Math.max(1, parseInt(req.query.page)  || 1);
  const limit   = Math.min(50, parseInt(req.query.limit) || 20);
  const offset  = (page - 1) * limit;
  const search  = req.query.search;
  const dateFrom = req.query.date_from;
  const dateTo   = req.query.date_to;

  const conditions = [];
  const params = [];

  // Karyawan hanya bisa lihat submission milik sendiri
  if (req.user.role !== 'admin') {
    conditions.push(`s.submitted_by = ?`);
    params.push(req.user.id);
  }
  if (search)   { conditions.push(`s.form_data ILIKE ?`); params.push(`%${search}%`); }
  if (dateFrom) { conditions.push(`(s.form_data::json)->>'tanggal' >= ?`); params.push(dateFrom); }
  if (dateTo)   { conditions.push(`(s.form_data::json)->>'tanggal' <= ?`); params.push(dateTo); }

  const where     = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const baseQuery = `FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by ${where}`;

  const rows     = await all(`SELECT s.id, s.form_data, s.image_urls, s.created_at, s.updated_at, u.username, u.full_name ${baseQuery} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const totalRow = await get(`SELECT COUNT(*) as c ${baseQuery}`, params);

  const total  = parseInt(totalRow?.c ?? totalRow?.count ?? 0);
  const mapped = rows.map(r => ({ ...r, form_data: JSON.parse(r.form_data), image_urls: JSON.parse(r.image_urls || '[]') }));
  res.json({ ok: true, data: mapped, total, page, limit, pages: Math.ceil(total / limit) });
});

// ── GET /api/submissions/:id ──────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  const row = await get(`SELECT s.*, u.username, u.full_name FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = ?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (req.user.role !== 'admin' && row.submitted_by !== req.user.id) return res.status(403).json({ error: 'Akses ditolak' });
  row.form_data  = JSON.parse(row.form_data);
  row.image_urls = JSON.parse(row.image_urls || '[]');
  delete row.signature_b64;
  res.json({ ok: true, data: row });
});

// ── GET /api/submissions/:id/signature ───────────────────────────────────────
router.get('/:id/signature', requireAuth, async (req, res) => {
  const row = await get('SELECT signature_b64, submitted_by FROM submissions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
  if (req.user.role !== 'admin' && row.submitted_by !== req.user.id) return res.status(403).json({ error: 'Akses ditolak' });
  res.json({ ok: true, signature_b64: row.signature_b64 });
});

// ── PUT /api/submissions/:id — edit ──────────────────────────────────────────
router.put('/:id', requireAuth, upload.array('evidence_images', 10), async (req, res) => {
  try {
    const existing = await get('SELECT * FROM submissions WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (req.user.role !== 'admin' && existing.submitted_by !== req.user.id) return res.status(403).json({ error: 'Akses ditolak' });

    const formData     = JSON.parse(req.body.form_data || existing.form_data);
    const signatureB64 = req.body.signature_b64 !== undefined ? (req.body.signature_b64 || null) : existing.signature_b64;

    // Start with existing images, then add new uploads
    let imageUrls = JSON.parse(existing.image_urls || '[]');
    if (req.files?.length) {
      for (const file of req.files) {
        const url = await uploadImage(file.buffer, 'pest-control/evidence');
        imageUrls.push(url);
      }
    }
    // Client can send kept_images to remove specific images
    if (req.body.kept_images) {
      imageUrls = JSON.parse(req.body.kept_images);
    }

    await run(
      `UPDATE submissions SET form_data = ?, signature_b64 = ?, image_urls = ?, updated_at = NOW() WHERE id = ?`,
      [JSON.stringify(formData), signatureB64, JSON.stringify(imageUrls), req.params.id]
    );


    res.json({ ok: true, image_urls: imageUrls });
  } catch (err) {
    console.error('[submissions PUT]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/submissions/:id ───────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const result = await run('DELETE FROM submissions WHERE id = ?', [req.params.id]);
  if (result.changes === 0) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json({ ok: true, message: 'Submission dihapus' });
});

// ── GET /api/submissions/:id/share-link ──────────────────────────────────────
router.get('/:id/share-link', requireAuth, async (req, res) => {
  const row = await get('SELECT id FROM submissions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
  const t     = Date.now();
  const token = generateToken(req.params.id, t);
  const base  = `${req.protocol}://${req.get('host')}`;
  const url   = `${base}/api/reports/${req.params.id}/public?token=${token}&t=${t}`;
  res.json({ ok: true, url, expires_in: '7 hari' });
});

module.exports = router;
