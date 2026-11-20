require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const { initDb } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // cPanel / LiteSpeed proxy

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Domain utama: host lain (www, domain lama) dialihkan ke sini.
// Matikan dengan CANONICAL_HOST=off di .env
const CANONICAL_HOST = (process.env.CANONICAL_HOST ?? 'localpestcontrol.id').trim().toLowerCase();
app.use((req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (!CANONICAL_HOST || CANONICAL_HOST === 'off' || !host || host === CANONICAL_HOST) return next();
  if (host === 'localhost' || /^[\d.]+$/.test(host) || host.startsWith('[')) return next(); // dev / akses via IP
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
});

// Nama lama / alias halaman
app.get(['/formulir-estimasi.html', '/formulir-estimasi'], (req, res) => res.redirect(302, '/formulir-pesanan.html'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'data', 'uploads')));


// Initialize database (jangan sampai gagal init mematikan seluruh server)
initDb().catch(err => console.error('[initDb] GAGAL:', err.code || '', err.message));

// Cek versi yang sedang berjalan: buka /api/health setelah deploy.
// Jika "fitur" belum memuat keluhan/absensi, aplikasi Node belum di-restart.
const STARTED_AT = new Date().toISOString();
app.get('/api/health', (req, res) => res.json({ ok: true, mulai: STARTED_AT, fitur: ['keluhan', 'absensi'] }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/submissions', require('./routes/submissions'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/users', require('./routes/users'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/surveys', require('./routes/surveys'));
app.use('/api/keluhan', require('./routes/keluhan'));
app.use('/api/absensi', require('./routes/absensi'));
app.use('/api/pesanan', require('./routes/pesanan'));

// API yang tidak dikenal → JSON 404 (bukan halaman HTML)
app.use('/api', (req, res) => res.status(404).json({ error: `Endpoint tidak ditemukan: ${req.method} ${req.originalUrl}` }));

// Catch-all: serve index.html for SPA-style navigation
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`\n✅ Jember Pest Control Form App running at http://localhost:${PORT}`);
  console.log(`   Default login → username: admin  password: jemberpest2024`);
  console.log(`   Change the password after first login!\n`);
});
