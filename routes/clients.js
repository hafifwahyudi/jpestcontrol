const express = require('express');
const { get, all, run } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(requireAuth);

// ── GET /api/clients — list all clients (with optional search) ────────────────
router.get('/', async (req, res) => {
  try {
    const search = req.query.search;
    let sql = `
      SELECT c.*, 
             u1.full_name as created_by_name, u1.username as created_by_username,
             u2.full_name as updated_by_name, u2.username as updated_by_username
      FROM clients c
      LEFT JOIN users u1 ON u1.id = c.created_by
      LEFT JOIN users u2 ON u2.id = c.updated_by
    `;
    const params = [];

    if (search) {
      sql += ` WHERE c.nama LIKE ? OR c.alamat LIKE ? OR c.no_hp LIKE ?`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    sql += ` ORDER BY c.nama ASC`;
    const rows = await all(sql, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/clients — create a new client ───────────────────────────────────
router.post('/', async (req, res) => {
  const { nama, alamat, no_hp } = req.body;
  if (!nama || !nama.trim()) return res.status(400).json({ error: 'Nama client wajib diisi' });

  try {
    const result = await run(
      `INSERT INTO clients (nama, alamat, no_hp, created_by) VALUES (?, ?, ?, ?)`,
      [nama.trim(), alamat?.trim() || '', no_hp?.trim() || '', req.user.id]
    );
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/clients/:id — update client ──────────────────────────────────────
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { nama, alamat, no_hp } = req.body;

  const client = await get('SELECT id FROM clients WHERE id = ?', [id]);
  if (!client) return res.status(404).json({ error: 'Client tidak ditemukan' });
  if (!nama || !nama.trim()) return res.status(400).json({ error: 'Nama client wajib diisi' });

  try {
    await run(
      `UPDATE clients SET nama = ?, alamat = ?, no_hp = ?, updated_by = ?, updated_at = NOW() WHERE id = ?`,
      [nama.trim(), alamat?.trim() || '', no_hp?.trim() || '', req.user.id, id]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/clients/:id — delete client ───────────────────────────────────
// Admin can delete any, karyawan can only delete their own
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const client = await get('SELECT id, created_by FROM clients WHERE id = ?', [id]);
  if (!client) return res.status(404).json({ error: 'Client tidak ditemukan' });

  // Karyawan can only delete clients they created
  if (req.user.role !== 'admin' && client.created_by !== req.user.id) {
    return res.status(403).json({ error: 'Anda hanya dapat menghapus client yang Anda buat' });
  }

  try {
    await run('DELETE FROM clients WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
