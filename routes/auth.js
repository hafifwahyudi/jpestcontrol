const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { get, run } = require('../database');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: 8 * 60 * 60 * 1000,
  secure: process.env.NODE_ENV === 'production',
};


router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });

  const user = await get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) return res.status(401).json({ error: 'Kredensial tidak valid' });
  if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'Kredensial tidak valid' });

  const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.cookie('token', token, COOKIE_OPTIONS);
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, full_name: user.full_name } });
});

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) return res.status(400).json({ error: 'Kedua field wajib diisi' });
  if (new_password.length < 6) return res.status(400).json({ error: 'Password minimal 6 karakter' });

  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!bcrypt.compareSync(current_password, user.password_hash)) return res.status(401).json({ error: 'Password saat ini salah' });

  const hash = bcrypt.hashSync(new_password, 10);
  await run('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.user.id]);
  res.json({ ok: true, message: 'Password berhasil diubah' });
});

module.exports = router;
