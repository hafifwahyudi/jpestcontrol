const express = require('express');
const multer  = require('multer');
const { run, get, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadImage } = require('../services/storage');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) return cb(new Error('Hanya file gambar yang diizinkan'));
    cb(null, true);
  },
});

// POST /api/submissions
router.post('/', requireAuth, upload.array('evidence_images', 10), async (req, res) => {
  try {
    const formData    = JSON.parse(req.body.form_data || '{}');
    const signatureB64 = req.body.signature_b64 || null;
    const imageUrls   = [];

    if (req.files?.length) {
      for (const file of req.files) {
        const url = await uploadImage(file.buffer, 'pest-control/evidence');
        imageUrls.push(url);
      }
    }

    const result = await run(
      `INSERT INTO submissions (form_data, signature_b64, image_urls, submitted_by) VALUES (?, ?, ?, ?)`,
      [JSON.stringify(formData), signatureB64, JSON.stringify(imageUrls), req.user.id]
    );

    res.status(201).json({ ok: true, id: result.lastID, image_urls: imageUrls });
  } catch (err) {
    console.error('[submissions POST]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/submissions — paginated list
router.get('/', requireAuth, async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  const search    = req.query.search;
  const dateFrom  = req.query.date_from; // YYYY-MM-DD
  const dateTo    = req.query.date_to;   // YYYY-MM-DD
  let rows, totalRow;

  // Build dynamic WHERE clauses
  const conditions = [];
  const params = [];

  if (search) {
    conditions.push(`s.form_data LIKE ?`);
    params.push(`%${search}%`);
  }
  if (dateFrom) {
    conditions.push(`json_extract(s.form_data, '$.tanggal') >= ?`);
    params.push(dateFrom);
  }
  if (dateTo) {
    conditions.push(`json_extract(s.form_data, '$.tanggal') <= ?`);
    params.push(dateTo);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const baseQuery = `FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by ${where}`;

  rows     = await all(`SELECT s.id, s.form_data, s.image_urls, s.created_at, u.username, u.full_name ${baseQuery} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  totalRow = await get(`SELECT COUNT(*) as c ${baseQuery}`, params);

  const total = totalRow?.c || 0;
  rows = rows.map(r => ({ ...r, form_data: JSON.parse(r.form_data), image_urls: JSON.parse(r.image_urls || '[]') }));
  res.json({ ok: true, data: rows, total, page, limit, pages: Math.ceil(total / limit) });
});

// GET /api/submissions/:id
router.get('/:id', requireAuth, async (req, res) => {
  const row = await get(`SELECT s.*, u.username, u.full_name FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = ?`, [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
  row.form_data  = JSON.parse(row.form_data);
  row.image_urls = JSON.parse(row.image_urls || '[]');
  delete row.signature_b64;
  res.json({ ok: true, data: row });
});

// GET /api/submissions/:id/signature
router.get('/:id/signature', requireAuth, async (req, res) => {
  const row = await get('SELECT signature_b64 FROM submissions WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json({ ok: true, signature_b64: row.signature_b64 });
});

// DELETE /api/submissions/:id
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const result = await run('DELETE FROM submissions WHERE id = ?', [req.params.id]);
  if (result.changes === 0) return res.status(404).json({ error: 'Tidak ditemukan' });
  res.json({ ok: true, message: 'Submission dihapus' });
});

module.exports = router;
