const express = require('express');
const bcrypt = require('bcryptjs');
const { get, all, run } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// All routes require admin
router.use(requireAuth, requireAdmin);

// GET /api/users — list all karyawan
router.get('/', async (req, res) => {
  try {
    const rows = await all(`
      SELECT id, username, full_name, role, created_at
      FROM users ORDER BY created_at DESC
    `);
    res.json({ ok: true, data: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/users — create karyawan
router.post('/', async (req, res) => {
  const { username, password, full_name, role = 'karyawan' } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
  if (!['karyawan', 'admin'].includes(role)) return res.status(400).json({ error: 'Role tidak valid' });

  const existing = await get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) return res.status(409).json({ error: 'Username sudah digunakan' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const result = await run(
      `INSERT INTO users (username, password_hash, role, full_name) VALUES (?, ?, ?, ?) RETURNING id`,
      [username, hash, role, full_name || '']
    );
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/users/:id — edit user (name, role, optional new password)
router.put('/:id', async (req, res) => {
  const { full_name, role, password } = req.body;
  const { id } = req.params;

  const user = await get('SELECT id FROM users WHERE id = ?', [id]);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  try {
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });
      const hash = bcrypt.hashSync(password, 10);
      await run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
    }
    if (full_name !== undefined || role !== undefined) {
      const fields = [], params = [];
      if (full_name !== undefined) { fields.push('full_name = ?'); params.push(full_name); }
      if (role !== undefined) {
        if (!['karyawan', 'admin'].includes(role)) return res.status(400).json({ error: 'Role tidak valid' });
        fields.push('role = ?'); params.push(role);
      }
      if (fields.length) await run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, [...params, id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/users/:id — remove user (cannot delete yourself)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  if (parseInt(id) === req.user.id) return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri' });

  const result = await run('DELETE FROM users WHERE id = ?', [id]);
  if (result.changes === 0) return res.status(404).json({ error: 'User tidak ditemukan' });
  res.json({ ok: true });
});

module.exports = router;
