const jwt = require('jsonwebtoken');
const { get } = require('../database');

async function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ error: 'Unauthorized — silakan login' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const user = await get('SELECT id, username, role, full_name FROM users WHERE id = ?', [payload.id]);
    if (!user) return res.status(401).json({ error: 'User tidak ditemukan' });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesi habis — silakan login kembali' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Hanya admin yang diizinkan' });
  next();
}

module.exports = { requireAuth, requireAdmin };
