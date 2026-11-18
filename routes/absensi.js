const express = require('express');
const ExcelJS = require('exceljs');
const { get, all, run } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { uploadImage } = require('../services/storage');

const router = express.Router();
router.use(requireAuth);

// ── Waktu WIB (Asia/Jakarta) ──────────────────────────────────────────────────
function nowWIB() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date()).reduce((a, x) => (a[x.type] = x.value, a), {});
  const hh = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hh}:${p.minute}:${p.second}` };
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, rad = d => d * Math.PI / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const DEFAULT_SETTINGS = {
  shift_pagi_masuk: '08:00', shift_pagi_pulang: '16:00',
  shift_sore_masuk: '15:00', shift_sore_pulang: '23:00',
  toleransi_menit: '15', boleh_awal_menit: '120',
  office_lat: '', office_lng: '', office_radius: '100',
  wajib_foto: '1', wajib_gps: '1',
};
async function getSettings() {
  const rows = await all('SELECT k, v FROM attendance_settings');
  const s = { ...DEFAULT_SETTINGS };
  rows.forEach(r => { s[r.k] = r.v; });
  return s;
}

const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
function shiftInfo(s, shift) {
  const k = shift === 'sore' ? 'sore' : 'pagi';
  return { shift: k, masuk: s['shift_' + k + '_masuk'], pulang: s['shift_' + k + '_pulang'] };
}
async function userShift(userId) {
  const u = await get('SELECT shift FROM users WHERE id = ?', [userId]);
  return u && u.shift === 'sore' ? 'sore' : 'pagi';
}

async function saveSelfie(dataUrl, userId, tag) {
  if (!dataUrl) return null;
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) throw Object.assign(new Error('Format foto tidak valid'), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 3 * 1024 * 1024) throw Object.assign(new Error('Foto terlalu besar'), { status: 400 });
  return uploadImage(buf, 'pest-control/absensi', `abs_${userId}_${tag}_${Date.now()}.jpg`);
}

function parseGeo(body, required) {
  const lat = parseFloat(body.lat), lng = parseFloat(body.lng), acc = parseFloat(body.accuracy);
  const ok = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  if (!ok && required) throw Object.assign(new Error('Lokasi GPS wajib diaktifkan'), { status: 400 });
  return ok ? { lat, lng, acc: Number.isFinite(acc) ? Math.round(acc) : null } : { lat: null, lng: null, acc: null };
}

function wrap(fn) {
  return (req, res) => fn(req, res).catch(e => res.status(e.status || 500).json({ error: e.message }));
}

// ── GET /api/absensi/today — status hari ini + setting publik ────────────────
router.get('/today', wrap(async (req, res) => {
  const { date, time } = nowWIB();
  const s = await getSettings();
  const sh = shiftInfo(s, await userShift(req.user.id));
  const rec = await get('SELECT * FROM attendance WHERE user_id = ? AND tanggal = ?', [req.user.id, date]);
  res.json({
    ok: true, date, time, record: rec,
    settings: {
      shift: sh.shift, jam_masuk: sh.masuk, jam_pulang: sh.pulang, toleransi_menit: +s.toleransi_menit,
      office_set: !!(s.office_lat && s.office_lng), office_radius: +s.office_radius,
      wajib_foto: s.wajib_foto === '1', wajib_gps: s.wajib_gps === '1',
    },
  });
}));

// ── POST /api/absensi/masuk ──────────────────────────────────────────────────
router.post('/masuk', wrap(async (req, res) => {
  const { date, time } = nowWIB();
  const s = await getSettings();
  const b = req.body;

  if (await get('SELECT id FROM attendance WHERE user_id = ? AND tanggal = ?', [req.user.id, date]))
    return res.status(409).json({ error: 'Anda sudah absen hari ini' });

  const geo = parseGeo(b, s.wajib_gps === '1');
  if (s.wajib_foto === '1' && !b.foto) return res.status(400).json({ error: 'Foto selfie wajib diambil' });

  // Lokasi: kantor atau lapangan
  let lokasi = 'Lapangan', jarak = null;
  if (s.office_lat && s.office_lng && geo.lat !== null) {
    jarak = Math.round(haversine(geo.lat, geo.lng, +s.office_lat, +s.office_lng));
    if (jarak <= +s.office_radius) lokasi = 'Kantor';
  }
  const ket = (b.keterangan || '').toString().trim().slice(0, 500);
  if (lokasi === 'Lapangan' && !ket)
    return res.status(400).json({ error: 'Anda di luar kantor — isi lokasi/nama klien yang dikunjungi' });

  // Shift & terlambat
  const sh = shiftInfo(s, await userShift(req.user.id));
  const now = toMin(time.slice(0, 5));
  if (now < toMin(sh.masuk) - (+s.boleh_awal_menit || 0))
    return res.status(400).json({ error: `Shift ${sh.shift} mulai ${sh.masuk}. Absen dibuka ${s.boleh_awal_menit} menit sebelumnya.` });
  if (now > toMin(sh.pulang))
    return res.status(400).json({ error: `Shift ${sh.shift} sudah berakhir (${sh.pulang}). Hubungi admin untuk koreksi.` });
  const terlambat = now > toMin(sh.masuk) + (+s.toleransi_menit || 0);
  const status = terlambat ? 'Terlambat' : 'Hadir';

  const foto = await saveSelfie(b.foto, req.user.id, 'in');
  await run(
    `INSERT INTO attendance (user_id, tanggal, jam_masuk, status, lokasi_type, masuk_lat, masuk_lng,
       masuk_akurasi, masuk_jarak, masuk_foto, keterangan, device, shift)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [req.user.id, date, time, status, lokasi, geo.lat, geo.lng, geo.acc, jarak, foto, ket,
     (req.headers['user-agent'] || '').slice(0, 250), sh.shift]
  );
  res.status(201).json({ ok: true, status, lokasi, jam: time, jarak, shift: sh.shift });
}));

// ── POST /api/absensi/pulang ─────────────────────────────────────────────────
router.post('/pulang', wrap(async (req, res) => {
  const { date, time } = nowWIB();
  const s = await getSettings();
  const b = req.body;
  const rec = await get('SELECT * FROM attendance WHERE user_id = ? AND tanggal = ?', [req.user.id, date]);
  if (!rec || !rec.jam_masuk) return res.status(400).json({ error: 'Anda belum absen masuk hari ini' });
  if (rec.jam_pulang) return res.status(409).json({ error: 'Anda sudah absen pulang' });

  const geo = parseGeo(b, s.wajib_gps === '1');
  if (s.wajib_foto === '1' && !b.foto) return res.status(400).json({ error: 'Foto selfie wajib diambil' });
  const foto = await saveSelfie(b.foto, req.user.id, 'out');
  const catatan = (b.catatan || '').toString().trim().slice(0, 1000);
  await run(
    `UPDATE attendance SET jam_pulang=?, pulang_lat=?, pulang_lng=?, pulang_akurasi=?, pulang_foto=?, catatan=? WHERE id=?`,
    [time, geo.lat, geo.lng, geo.acc, foto, catatan, rec.id]
  );
  const sh = shiftInfo(s, rec.shift || await userShift(req.user.id));
  const cepat = toMin(time.slice(0, 5)) < toMin(sh.pulang);
  const durasi = toMin(time.slice(0, 5)) - toMin(rec.jam_masuk.slice(0, 5));
  res.json({ ok: true, jam: time, pulang_cepat: cepat, jam_pulang_shift: sh.pulang, durasi_menit: durasi });
}));

// ── POST /api/absensi/izin — izin / sakit ────────────────────────────────────
router.post('/izin', wrap(async (req, res) => {
  const { date } = nowWIB();
  const { jenis, keterangan } = req.body;
  if (!['Izin', 'Sakit'].includes(jenis)) return res.status(400).json({ error: 'Jenis tidak valid' });
  if (!keterangan || !keterangan.trim()) return res.status(400).json({ error: 'Alasan wajib diisi' });
  if (await get('SELECT id FROM attendance WHERE user_id = ? AND tanggal = ?', [req.user.id, date]))
    return res.status(409).json({ error: 'Anda sudah memiliki catatan absensi hari ini' });
  const foto = await saveSelfie(req.body.foto, req.user.id, 'izin'); // bukti opsional (surat dokter)
  await run(
    `INSERT INTO attendance (user_id, tanggal, status, lokasi_type, keterangan, masuk_foto) VALUES (?,?,?,?,?,?)`,
    [req.user.id, date, jenis, '-', keterangan.trim().slice(0, 500), foto]
  );
  res.status(201).json({ ok: true });
}));

// ── GET /api/absensi/riwayat?bulan=YYYY-MM — riwayat milik sendiri ───────────
router.get('/riwayat', wrap(async (req, res) => {
  const bulan = /^\d{4}-\d{2}$/.test(req.query.bulan || '') ? req.query.bulan : nowWIB().date.slice(0, 7);
  const rows = await all(
    'SELECT * FROM attendance WHERE user_id = ? AND tanggal LIKE ? ORDER BY tanggal DESC', [req.user.id, bulan + '-%']);
  res.json({ ok: true, data: rows });
}));

// ═════════════════════════ ADMIN ═════════════════════════════════════════════
const admin = express.Router();
admin.use(requireAdmin);

// GET /api/absensi/admin/harian?tanggal=YYYY-MM-DD — semua karyawan, termasuk yang belum absen
admin.get('/harian', wrap(async (req, res) => {
  const tanggal = /^\d{4}-\d{2}-\d{2}$/.test(req.query.tanggal || '') ? req.query.tanggal : nowWIB().date;
  const rows = await all(
    `SELECT u.id AS user_id, u.full_name, u.username, u.role, u.shift AS user_shift, a.id, a.shift, a.status, a.lokasi_type,
            a.jam_masuk, a.jam_pulang, a.masuk_lat, a.masuk_lng, a.masuk_akurasi, a.masuk_jarak,
            a.pulang_lat, a.pulang_lng, a.masuk_foto, a.pulang_foto, a.keterangan, a.catatan
     FROM users u LEFT JOIN attendance a ON a.user_id = u.id AND a.tanggal = ?
     ORDER BY u.full_name`, [tanggal]);
  const sum = { total: rows.length, hadir: 0, terlambat: 0, izin: 0, sakit: 0, belum: 0 };
  rows.forEach(r => {
    if (!r.status) sum.belum++;
    else if (r.status === 'Hadir') sum.hadir++;
    else if (r.status === 'Terlambat') sum.terlambat++;
    else if (r.status === 'Izin') sum.izin++;
    else if (r.status === 'Sakit') sum.sakit++;
  });
  res.json({ ok: true, tanggal, summary: sum, data: rows });
}));

async function rekapRows(bulan) {
  return all(
    `SELECT u.full_name, u.username, a.tanggal, a.shift, a.status, a.lokasi_type, a.jam_masuk, a.jam_pulang,
            a.keterangan, a.catatan, a.masuk_lat, a.masuk_lng
     FROM attendance a JOIN users u ON u.id = a.user_id
     WHERE a.tanggal LIKE ? ORDER BY u.full_name, a.tanggal`, [bulan + '-%']);
}

// GET /api/absensi/admin/rekap?bulan=YYYY-MM — rekap per karyawan
admin.get('/rekap', wrap(async (req, res) => {
  const bulan = /^\d{4}-\d{2}$/.test(req.query.bulan || '') ? req.query.bulan : nowWIB().date.slice(0, 7);
  const rows = await all(
    `SELECT u.id AS user_id, u.full_name, u.username,
        SUM(a.status='Hadir') AS hadir, SUM(a.status='Terlambat') AS terlambat,
        SUM(a.status='Izin') AS izin, SUM(a.status='Sakit') AS sakit,
        SUM(a.lokasi_type='Lapangan') AS lapangan
     FROM users u LEFT JOIN attendance a ON a.user_id = u.id AND a.tanggal LIKE ?
     GROUP BY u.id, u.full_name, u.username ORDER BY u.full_name`, [bulan + '-%']);
  res.json({ ok: true, bulan, data: rows });
}));

// GET /api/absensi/admin/export?bulan=YYYY-MM — Excel
admin.get('/export', wrap(async (req, res) => {
  const bulan = /^\d{4}-\d{2}$/.test(req.query.bulan || '') ? req.query.bulan : nowWIB().date.slice(0, 7);
  const rows = await rekapRows(bulan);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Absensi ' + bulan);
  ws.columns = [
    { header: 'Nama', key: 'nama', width: 25 }, { header: 'Tanggal', key: 'tanggal', width: 12 },
    { header: 'Shift', key: 'shift', width: 8 }, { header: 'Status', key: 'status', width: 12 }, { header: 'Lokasi', key: 'lokasi', width: 12 },
    { header: 'Jam Masuk', key: 'masuk', width: 11 }, { header: 'Jam Pulang', key: 'pulang', width: 11 },
    { header: 'Keterangan / Klien', key: 'ket', width: 40 }, { header: 'Catatan Pulang', key: 'cat', width: 40 },
    { header: 'Peta', key: 'peta', width: 45 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach(r => ws.addRow({
    nama: r.full_name || r.username, tanggal: r.tanggal, shift: r.shift, status: r.status, lokasi: r.lokasi_type,
    masuk: r.jam_masuk, pulang: r.jam_pulang, ket: r.keterangan, cat: r.catatan,
    peta: r.masuk_lat ? `https://maps.google.com/?q=${r.masuk_lat},${r.masuk_lng}` : '',
  }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="absensi-${bulan}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

// GET/PUT settings
admin.get('/settings', wrap(async (req, res) => res.json({ ok: true, data: await getSettings() })));
admin.put('/settings', wrap(async (req, res) => {
  const b = req.body, out = {};
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const k of ['shift_pagi_masuk', 'shift_pagi_pulang', 'shift_sore_masuk', 'shift_sore_pulang']) {
    if (b[k] !== undefined) { if (!hhmm.test(b[k])) return res.status(400).json({ error: 'Format jam tidak valid' }); out[k] = b[k]; }
  }
  ['toleransi_menit', 'boleh_awal_menit', 'office_radius'].forEach(k => {
    if (b[k] !== undefined) { const n = parseInt(b[k]); if (!(n >= 0)) return; out[k] = String(n); }
  });
  ['office_lat', 'office_lng'].forEach(k => {
    if (b[k] !== undefined) { const t = String(b[k]).trim(); if (t === '' || Number.isFinite(parseFloat(t))) out[k] = t; }
  });
  ['wajib_foto', 'wajib_gps'].forEach(k => { if (b[k] !== undefined) out[k] = b[k] ? '1' : '0'; });
  for (const [k, v] of Object.entries(out))
    await run('INSERT INTO attendance_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
  res.json({ ok: true });
}));

// PUT /api/absensi/admin/shift — tetapkan shift karyawan
admin.put('/shift', wrap(async (req, res) => {
  const { user_id, shift } = req.body;
  if (!['pagi', 'sore'].includes(shift)) return res.status(400).json({ error: 'Shift tidak valid' });
  await run('UPDATE users SET shift = ? WHERE id = ?', [shift, user_id]);
  res.json({ ok: true });
}));

// POST /api/absensi/admin/manual — admin input/koreksi absensi karyawan
admin.post('/manual', wrap(async (req, res) => {
  const { user_id, tanggal, status, jam_masuk, jam_pulang, keterangan } = req.body;
  if (!user_id || !/^\d{4}-\d{2}-\d{2}$/.test(tanggal || '')) return res.status(400).json({ error: 'Data tidak lengkap' });
  if (!['Hadir', 'Terlambat', 'Izin', 'Sakit', 'Alpa'].includes(status)) return res.status(400).json({ error: 'Status tidak valid' });
  const t = v => (/^\d{2}:\d{2}(:\d{2})?$/.test(v || '') ? (v.length === 5 ? v + ':00' : v) : null);
  await run(
    `INSERT INTO attendance (user_id, tanggal, status, lokasi_type, jam_masuk, jam_pulang, keterangan, shift)
     VALUES (?,?,?,?,?,?,?,(SELECT shift FROM users WHERE id = ?))
     ON DUPLICATE KEY UPDATE status=VALUES(status), jam_masuk=VALUES(jam_masuk), jam_pulang=VALUES(jam_pulang),
       keterangan=VALUES(keterangan)`,
    [user_id, tanggal, status, 'Manual', t(jam_masuk), t(jam_pulang), (keterangan || '[Input admin]').slice(0, 500), user_id]);
  res.json({ ok: true });
}));

admin.delete('/:id', wrap(async (req, res) => {
  await run('DELETE FROM attendance WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
}));

router.use('/admin', admin);
module.exports = router;
