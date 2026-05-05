const express = require('express');
const { run, get, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/surveys — list all surveys ──────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const conditions = [];
    const params = [];

    if (req.user.role !== 'admin') {
      conditions.push('sv.submitted_by = ?');
      params.push(req.user.id);
    }
    if (search) {
      conditions.push('sv.nama_calon_pelanggan LIKE ?');
      params.push(`%${search}%`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await all(
      `SELECT sv.id, sv.nama_calon_pelanggan, sv.waktu_kunjungan, sv.hama,
              sv.created_at, sv.updated_at,
              u.username, u.full_name
       FROM surveys sv
       LEFT JOIN users u ON u.id = sv.submitted_by
       ${where}
       ORDER BY sv.created_at DESC`,
      params
    );
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[surveys GET]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/surveys/:id ──────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const row = await get(
      `SELECT sv.*, u.username, u.full_name
       FROM surveys sv LEFT JOIN users u ON u.id = sv.submitted_by
       WHERE sv.id = ?`,
      [req.params.id]
    );
    if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (req.user.role !== 'admin' && row.submitted_by !== req.user.id)
      return res.status(403).json({ error: 'Akses ditolak' });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/surveys ─────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nama_calon_pelanggan, waktu_kunjungan, hama, signature_b64 } = req.body;
    if (!nama_calon_pelanggan || !waktu_kunjungan) {
      return res.status(400).json({ error: 'Nama dan waktu kunjungan wajib diisi' });
    }
    const result = await run(
      `INSERT INTO surveys (nama_calon_pelanggan, waktu_kunjungan, hama, signature_b64, submitted_by)
       VALUES (?, ?, ?, ?, ?)`,
      [nama_calon_pelanggan, waktu_kunjungan, JSON.stringify(hama || []), signature_b64 || null, req.user.id]
    );
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (e) {
    console.error('[surveys POST]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/surveys/:id ───────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await run('DELETE FROM surveys WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json({ ok: true, message: 'Survey dihapus' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
