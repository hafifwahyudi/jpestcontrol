const express = require('express');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { get, all } = require('../database');
const { requireAuth } = require('../middleware/auth');
const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

const router = express.Router();

// ── Shared token helpers (7-day expiring public PDF links) ───────────────────
const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateToken(id, timestamp) {
  const secret = process.env.JWT_SECRET || 'jpc_secret';
  return crypto.createHmac('sha256', secret)
    .update(`${id}:${timestamp}`)
    .digest('hex')
    .substring(0, 32);
}

function verifyToken(id, timestamp, token) {
  if (!token || !timestamp) return false;
  const ts = parseInt(timestamp);
  if (isNaN(ts) || Date.now() - ts > TOKEN_EXPIRY_MS) return false;
  return generateToken(id, timestamp) === token;
}

const PESTS = ['tikus', 'kecoa', 'semut', 'rayap', 'nyamuk', 'lalat', 'laba2', 'kutu'];
const PEST_LABELS = { tikus: 'Tikus', kecoa: 'Kecoa', semut: 'Semut', rayap: 'Rayap', nyamuk: 'Nyamuk', lalat: 'Lalat', laba2: 'Laba-laba', kutu: 'Kutu' };


function fetchImageBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Shared helper: ensure we don't draw below bottom margin ─────────────────
function ensureSpace(doc, y, needed) {
  const bottom = doc.page.height - 80;
  if (y + needed > bottom) {
    doc.addPage();
    return 45;
  }
  return y;
}

// ════════════════════════════════════════════════════════════════════════════
// Helper: build all pages for one slip into an existing PDFDocument
// Returns the final y-position (unused, but kept for API consistency)
// ════════════════════════════════════════════════════════════════════════════
async function buildSlipPages(doc, row, isFirst) {
  if (!isFirst) doc.addPage();

  const fd   = JSON.parse(row.form_data || '{}');
  const imgs = JSON.parse(row.image_urls || '[]');

  const chk = (v) => v ? '[X]' : '[ ]';
  const PRI = '#1a4a2e', SEC = '#2d7a4f', GRY = '#555555', LGT = '#f0f7f4';
  const W = doc.page.width - 90;

  // ── HEADER ──────────────────────────────────────────────────────────
  doc.rect(45, 45, W, 72).fill(PRI);
  doc.fillColor('white').fontSize(18).font('Helvetica-Bold').text('SLIP SERVICE', 55, 52);
  doc.fontSize(9).font('Helvetica')
     .text('CV. KASUARI INVESTAMA - Jember Pest Control', 55, 74)
     .text('Jl. Kasuari No. 22, Gebang-Patrang-Jember', 55, 86)
     .text('Telp/WA: 082 332 173 442 | jemberpestcontrol@gmail.com | www.jemberpest.co.id', 55, 98);
  const rightX = 45 + W - 150;
  doc.fillColor('#ccffcc').fontSize(9).font('Helvetica-Bold')
     .text(`No: ${fd.no || '-'}`, rightX, 52, { width: 145, align: 'right' })
     .text(`Tgl: ${fd.tanggal || '-'}`, rightX, 64, { width: 145, align: 'right' });
  let y = 130;

  const section = (title) => {
    doc.rect(45, y, W, 18).fill(SEC);
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(title, 52, y + 4);
    y += 22;
  };

  // ── CLIENT INFO ──────────────────────────────────────────────────────
  section('INFORMASI CLIENT');
  doc.rect(45, y, W, 40).fill(LGT);
  doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold')
     .text('Nama Client', 50, y + 4).text('Alamat', 50, y + 20)
     .text('Tanggal', 320, y + 4).text('No. Slip', 320, y + 20);
  doc.fillColor('#111').fontSize(9).font('Helvetica')
     .text(fd.nama_client || '-', 130, y + 4, { width: 180 })
     .text(fd.alamat || '-', 130, y + 20, { width: 180 })
     .text(fd.tanggal || '-', 395, y + 4)
     .text(fd.no || '-', 395, y + 20);
  y += 48;

  // ── LAPORAN KUNJUNGAN ────────────────────────────────────────────────
  y = ensureSpace(doc, y, 70); section('LAPORAN KUNJUNGAN');
  const half = Math.floor(W / 2) - 5;
  doc.rect(45, y, half, 22).fill(LGT); doc.rect(45 + half + 10, y, half, 22).fill(LGT);
  doc.fillColor('#111').fontSize(9).font('Helvetica')
     .text(`${chk(fd.one_time_treatment)} One Time Treatment`, 52, y + 6)
     .text(`${chk(fd.reguler_treatment)} Reguler Treatment`, 52 + half + 10, y + 6);
  y += 30;
  doc.rect(45, y, half, 28).fill(LGT); doc.rect(45 + half + 10, y, half, 28).fill(LGT);
  doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold')
     .text('Waktu Masuk (In)', 52, y + 4).text('Waktu Keluar (Out)', 52 + half + 10, y + 4);
  doc.fillColor('#111').fontSize(10).font('Helvetica-Bold')
     .text(fd.time_in || '--:--', 52, y + 14).text(fd.time_out || '--:--', 52 + half + 10, y + 14);
  y += 36;

  // ── SASARAN & METODE ─────────────────────────────────────────────────
  y = ensureSpace(doc, y, 90); section('SASARAN & METODE');
  const pests1 = ['tikus', 'kecoa', 'semut', 'rayap'];
  const pests2 = ['nyamuk', 'lalat', 'laba2', 'kutu'];
  const rowH = 16, ph = pests1.length * rowH + 12;
  doc.rect(45, y, half, ph).fill(LGT); doc.rect(45 + half + 10, y, half, ph).fill(LGT);
  doc.fillColor('#a0c8a0').fontSize(8).font('Helvetica-Bold')
     .text('Hama', 52, y + 4).text('Metode', 130, y + 4)
     .text('Hama', 52 + half + 10, y + 4).text('Metode', 130 + half + 10, y + 4);
  pests1.forEach((p, i) => {
    doc.fillColor('#111').fontSize(8.5).font('Helvetica')
       .text(`${chk(fd[`pest_${p}`])} ${PEST_LABELS[p]}`, 52, y + 4 + (i + 1) * rowH)
       .text(fd[`method_${p}`] || '-', 130, y + 4 + (i + 1) * rowH, { width: half - 90 });
  });
  pests2.forEach((p, i) => {
    doc.fillColor('#111').fontSize(8.5).font('Helvetica')
       .text(`${chk(fd[`pest_${p}`])} ${PEST_LABELS[p]}`, 52 + half + 10, y + 4 + (i + 1) * rowH)
       .text(fd[`method_${p}`] || '-', 130 + half + 10, y + 4 + (i + 1) * rowH, { width: half - 90 });
  });
  y += ph + 8;

  // ── MONITORING ───────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 100); section('JUMLAH MONITORING');
  [['1. Rat Box (Umpan Racun dgn Box)', fd.rat_box],
   ['2. Glue Trapping (Lem)', fd.glue_trapping],
   ['3. Glue Trapping Tambahan', fd.glue_tambahan],
   ['4. Perangkap Masal', fd.perangkap_masal]].forEach(([label, val]) => {
    doc.rect(45, y, W, 16).fill(LGT);
    doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold').text(label, 52, y + 4, { width: W - 80 });
    doc.fillColor('#111').fontSize(9).font('Helvetica-Bold').text(`${val || 0} titik`, 45 + W - 70, y + 4, { width: 65, align: 'right' });
    y += 18;
  });
  y += 6;

  // ── CHEMICAL ─────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 80); section('BAHAN AKTIF CHEMICAL');
  doc.rect(45, y, W, 16).fill('#c8e6c0');
  doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold')
     .text('Bahan Aktif', 52, y + 4).text('Dosis Pemakaian', 45 + W - 155, y + 4);
  y += 16;
  [[fd.chemical1_name, fd.chemical1_dose],
   [fd.chemical2_name, fd.chemical2_dose],
   [fd.chemical3_name, fd.chemical3_dose],
   [fd.chemical4_name, fd.chemical4_dose]].forEach(([name, dose], idx) => {
    if (!name && !dose) return;
    doc.rect(45, y, W, 18).fill(LGT);
    doc.fillColor('#111').fontSize(9).font('Helvetica')
       .text(`${idx + 1}. ${name || '-'}`, 52, y + 4, { width: W - 200 })
       .text(dose || '-', 45 + W - 155, y + 4, { width: 150 });
    y += 20;
  });
  y += 6;

  // ── REKOMENDASI ──────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 110); section('REKOMENDASI');
  const recs = [
    ['Tumpukan Barang', 'Melakukan rotasi minimal 1 kali / 3 bulan & ditata dengan rapi'],
    ['Kondisi Pintu/Plafon', 'Menutup lubang akses jika ada, tertutup dengan rapat'],
    ['Sisa Makanan', 'Tidak berserakan'],
    ['Genangan Air', 'Hindari adanya genangan air di area'],
    ['Sampah', 'Di bungkus dengan plastik & ditaruh di dalam tempatnya'],
  ];
  doc.rect(45, y, W, recs.length * 17 + 8).fill(LGT);
  recs.forEach(([point, rec], i) => {
    doc.fillColor(SEC).fontSize(8).font('Helvetica-Bold').text(`• ${point}`, 52, y + 4 + i * 17, { width: 140 });
    doc.fillColor('#333').fontSize(8).font('Helvetica').text(rec, 200, y + 4 + i * 17, { width: W - 160 });
  });
  y += recs.length * 17 + 14;

  // ── CATATAN ──────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 80); section('CATATAN');
  const catatanText = fd.catatan || '(tidak ada catatan)';
  const catatanH = Math.max(60, doc.heightOfString(catatanText, { width: W - 20 }) + 16);
  doc.rect(45, y, W, catatanH).fill(LGT);
  doc.fillColor('#333').fontSize(9).font('Helvetica').text(catatanText, 52, y + 8, { width: W - 20 });
  y += catatanH + 8;

  // ── SIGNATURE ────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 120); section('TANDA TANGAN CLIENT');
  const sigH = 110;
  doc.rect(45, y, W, sigH).fill(LGT);
  if (row.signature_b64 && row.signature_b64.length > 100) {
    try {
      const sigBuf = Buffer.from(row.signature_b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(sigBuf, 52, y + 6, { fit: [220, sigH - 14], align: 'left' });
    } catch (_) {}
  }
  doc.fillColor(GRY).fontSize(8.5).font('Helvetica-Bold')
     .text('Nama    :', 45 + W - 210, y + 30)
     .text('Telepon :', 45 + W - 210, y + 50);
  doc.fillColor('#111').fontSize(9).font('Helvetica')
     .text(fd.client_nama || '-', 45 + W - 130, y + 30)
     .text(fd.client_telp || '-', 45 + W - 130, y + 50);
  y += sigH + 8;

  // ── EVIDENCE PHOTOS ──────────────────────────────────────────────────
  if (imgs.length > 0) {
    y = ensureSpace(doc, y, 40); section('FOTO BUKTI PEKERJAAN');
    const imgSize = 155, perRow = Math.floor(W / (imgSize + 10));
    let col = 0, rowStartY = y;
    for (const url of imgs) {
      try {
        const buf = await fetchImageBuffer(url);
        if (col === 0) { rowStartY = ensureSpace(doc, rowStartY, imgSize + 30); doc.rect(45, rowStartY, W, imgSize + 20).fill(LGT); }
        doc.image(buf, 45 + col * (imgSize + 10), rowStartY + 10, { fit: [imgSize, imgSize] });
        col++;
        if (col >= perRow) { col = 0; rowStartY += imgSize + 22; }
      } catch (_) {}
    }
    y = rowStartY + imgSize + 26;
  }

  return y;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/reports/export/pdf-merge  —  Bulk merged PDF
// Query params: date_from, date_to, search (all optional)
// ════════════════════════════════════════════════════════════════════════════
router.get('/export/pdf-merge', requireAuth, async (req, res) => {
  const { date_from, date_to, search } = req.query;

  // Build dynamic WHERE
  const conditions = [];
  const params = [];
  if (search)    { conditions.push(`s.form_data LIKE ?`); params.push(`%${search}%`); }
  if (date_from) { conditions.push(`JSON_UNQUOTE(JSON_EXTRACT(s.form_data, '$.tanggal')) >= ?`); params.push(date_from); }
  if (date_to)   { conditions.push(`JSON_UNQUOTE(JSON_EXTRACT(s.form_data, '$.tanggal')) <= ?`); params.push(date_to); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  let rows;
  try {
    rows = await all(`
      SELECT s.*, u.full_name as tech_name, u.username
      FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
      ${where}
      ORDER BY JSON_UNQUOTE(JSON_EXTRACT(s.form_data, '$.tanggal')) ASC, s.id ASC
    `, params);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!rows.length) return res.status(404).json({ error: 'Tidak ada data ditemukan' });

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, bufferPages: true });
  const bufs = [];
  doc.on('data', d => bufs.push(d));
  doc.on('end', () => {
    // Add footer to all pages
    const PRI = '#1a4a2e';
    const W = doc.page.width - 90;
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const fY = doc.page.height - 36;
      doc.rect(45, fY - 6, W, 28).fill(PRI);
      doc.fillColor('white').fontSize(7.5).font('Helvetica')
         .text('Jember Pest Control | www.jemberpest.co.id | 082 332 173 442', 52, fY)
         .text(`Dicetak: ${new Date().toLocaleString('id-ID')} | Hal. ${i + 1}/${pageCount}`, 52, fY + 11);
    }
    const pdfBuf = Buffer.concat(bufs);
    const label = date_from && date_to ? `${date_from}_sd_${date_to}` : `semua_${Date.now()}`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="slip-service-gabungan-${label}.pdf"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  });
  doc.on('error', err => { if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat PDF' }); });

  for (let i = 0; i < rows.length; i++) {
    await buildSlipPages(doc, rows[i], i === 0);
  }
  doc.end();
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/reports/:id  —  PDF individual slip
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id', requireAuth, async (req, res) => {
  if (req.params.id === 'export') return; // let express fall through to export route

  let row;
  try {
    row = await get(`
      SELECT s.*, u.full_name as tech_name, u.username
      FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
      WHERE s.id = ?
    `, [req.params.id]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }

  if (!row) return res.status(404).json({ error: 'Submission tidak ditemukan' });

  const fd  = JSON.parse(row.form_data || '{}');
  const imgs = JSON.parse(row.image_urls || '[]');

  // PDFKit — use ASCII-safe chars only (avoid ☑/☐ — unsupported in Helvetica)
  const chk = (v) => v ? '[X]' : '[ ]';

  const PRI = '#1a4a2e';
  const SEC = '#2d7a4f';
  const GRY = '#555555';
  const LGT = '#f0f7f4';

  const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, bufferPages: true });
  const W = doc.page.width - 90; // 525

  // Collect chunks into buffer then send — avoids partial-send issues
  const bufs = [];
  doc.on('data', d => bufs.push(d));
  doc.on('end', () => {
    const pdfBuf = Buffer.concat(bufs);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="slip-service-${row.id}.pdf"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  });
  doc.on('error', err => {
    console.error('[PDF error]', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat PDF' });
  });

  // ── HEADER BLOCK ────────────────────────────────────────────────────
  doc.rect(45, 45, W, 72).fill(PRI);
  doc.fillColor('white').fontSize(18).font('Helvetica-Bold').text('SLIP SERVICE', 55, 52);
  doc.fontSize(9).font('Helvetica')
     .text('CV. KASUARI INVESTAMA - Jember Pest Control', 55, 74)
     .text('Jl. Kasuari No. 22, Gebang-Patrang-Jember', 55, 86)
     .text('Telp/WA: 082 332 173 442 | jemberpestcontrol@gmail.com | www.jemberpest.co.id', 55, 98);

  const rightX = 45 + W - 150;
  doc.fillColor('#ccffcc').fontSize(9).font('Helvetica-Bold')
     .text(`No: ${fd.no || '-'}`, rightX, 52, { width: 145, align: 'right' })
     .text(`Tgl: ${fd.tanggal || '-'}`, rightX, 64, { width: 145, align: 'right' });

  let y = 130;

  // ── Section helper ──────────────────────────────────────────────────
  const section = (title) => {
    doc.rect(45, y, W, 18).fill(SEC);
    doc.fillColor('white').fontSize(10).font('Helvetica-Bold').text(title, 52, y + 4);
    y += 22;
  };

  // ── CLIENT INFO ─────────────────────────────────────────────────────
  section('INFORMASI CLIENT');
  doc.rect(45, y, W, 40).fill(LGT);
  doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold')
     .text('Nama Client', 50, y + 4).text('Alamat', 50, y + 20)
     .text('Tanggal', 320, y + 4).text('No. Slip', 320, y + 20);
  doc.fillColor('#111').fontSize(9).font('Helvetica')
     .text(fd.nama_client || '-', 130, y + 4, { width: 180 })
     .text(fd.alamat || '-', 130, y + 20, { width: 180 })
     .text(fd.tanggal || '-', 395, y + 4)
     .text(fd.no || '-', 395, y + 20);
  y += 48;

  // ── LAPORAN KUNJUNGAN ────────────────────────────────────────────────
  y = ensureSpace(doc, y, 70);
  section('LAPORAN KUNJUNGAN');
  const half = Math.floor(W / 2) - 5;
  doc.rect(45, y, half, 22).fill(LGT);
  doc.rect(45 + half + 10, y, half, 22).fill(LGT);
  doc.fillColor('#111').fontSize(9).font('Helvetica')
     .text(`${chk(fd.one_time_treatment)} One Time Treatment`, 52, y + 6)
     .text(`${chk(fd.reguler_treatment)} Reguler Treatment`, 52 + half + 10, y + 6);
  y += 30;

  doc.rect(45, y, half, 28).fill(LGT);
  doc.rect(45 + half + 10, y, half, 28).fill(LGT);
  doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold')
     .text('Waktu Masuk (In)', 52, y + 4).text('Waktu Keluar (Out)', 52 + half + 10, y + 4);
  doc.fillColor('#111').fontSize(10).font('Helvetica-Bold')
     .text(fd.time_in || '--:--', 52, y + 14).text(fd.time_out || '--:--', 52 + half + 10, y + 14);
  y += 36;

  // ── SASARAN & METODE ─────────────────────────────────────────────────
  y = ensureSpace(doc, y, 90);
  section('SASARAN & METODE');
  const pests1 = ['tikus', 'kecoa', 'semut', 'rayap'];
  const pests2 = ['nyamuk', 'lalat', 'laba2', 'kutu'];
  const rowH = 16;
  const ph = pests1.length * rowH + 12;

  doc.rect(45, y, half, ph).fill(LGT);
  doc.rect(45 + half + 10, y, half, ph).fill(LGT);
  doc.fillColor('#a0c8a0').fontSize(8).font('Helvetica-Bold')
     .text('Hama', 52, y + 4).text('Metode', 130, y + 4)
     .text('Hama', 52 + half + 10, y + 4).text('Metode', 130 + half + 10, y + 4);

  pests1.forEach((p, i) => {
    doc.fillColor('#111').fontSize(8.5).font('Helvetica')
       .text(`${chk(fd[`pest_${p}`])} ${PEST_LABELS[p]}`, 52, y + 4 + (i + 1) * rowH)
       .text(fd[`method_${p}`] || '-', 130, y + 4 + (i + 1) * rowH, { width: half - 90 });
  });
  pests2.forEach((p, i) => {
    doc.fillColor('#111').fontSize(8.5).font('Helvetica')
       .text(`${chk(fd[`pest_${p}`])} ${PEST_LABELS[p]}`, 52 + half + 10, y + 4 + (i + 1) * rowH)
       .text(fd[`method_${p}`] || '-', 130 + half + 10, y + 4 + (i + 1) * rowH, { width: half - 90 });
  });
  y += ph + 8;

  // ── MONITORING ───────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 100);
  section('JUMLAH MONITORING');
  const monitors = [
    ['1. Rat Box (Umpan Racun dgn Box)', fd.rat_box],
    ['2. Glue Trapping (Lem)', fd.glue_trapping],
    ['3. Glue Trapping Tambahan', fd.glue_tambahan],
    ['4. Perangkap Masal', fd.perangkap_masal],
  ];
  monitors.forEach(([label, val]) => {
    doc.rect(45, y, W, 16).fill(LGT);
    doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold').text(label, 52, y + 4, { width: W - 80 });
    doc.fillColor('#111').fontSize(9).font('Helvetica-Bold').text(`${val || 0} titik`, 45 + W - 70, y + 4, { width: 65, align: 'right' });
    y += 18;
  });
  y += 6;

  // ── CHEMICAL ─────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 80);
  section('BAHAN AKTIF CHEMICAL');
  doc.rect(45, y, W, 16).fill('#c8e6c0');
  doc.fillColor(GRY).fontSize(8).font('Helvetica-Bold')
     .text('Bahan Aktif', 52, y + 4).text('Dosis Pemakaian', 45 + W - 155, y + 4);
  y += 16;
  [[fd.chemical1_name, fd.chemical1_dose], [fd.chemical2_name, fd.chemical2_dose]].forEach(([name, dose], idx) => {
    doc.rect(45, y, W, 18).fill(LGT);
    doc.fillColor('#111').fontSize(9).font('Helvetica')
       .text(`${idx + 1}. ${name || '-'}`, 52, y + 4, { width: W - 200 })
       .text(dose || '-', 45 + W - 155, y + 4, { width: 150 });
    y += 20;
  });
  y += 6;

  // ── REKOMENDASI ──────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 110);
  section('REKOMENDASI');
  const recs = [
    ['Tumpukan Barang', 'Melakukan rotasi minimal 1 kali / 3 bulan & ditata dengan rapi'],
    ['Kondisi Pintu/Plafon', 'Menutup lubang akses jika ada, tertutup dengan rapat'],
    ['Sisa Makanan', 'Tidak berserakan'],
    ['Genangan Air', 'Hindari adanya genangan air di area'],
    ['Sampah', 'Di bungkus dengan plastik & ditaruh di dalam tempatnya'],
  ];
  doc.rect(45, y, W, recs.length * 17 + 8).fill(LGT);
  recs.forEach(([point, rec], i) => {
    doc.fillColor(SEC).fontSize(8).font('Helvetica-Bold').text(`• ${point}`, 52, y + 4 + i * 17, { width: 140 });
    doc.fillColor('#333').fontSize(8).font('Helvetica').text(rec, 200, y + 4 + i * 17, { width: W - 160 });
  });
  y += recs.length * 17 + 14;

  // ── CATATAN ──────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 80);
  section('CATATAN');
  const catatanText = fd.catatan || '(tidak ada catatan)';
  const catatanH = Math.max(60, doc.heightOfString(catatanText, { width: W - 20 }) + 16);
  doc.rect(45, y, W, catatanH).fill(LGT);
  doc.fillColor('#333').fontSize(9).font('Helvetica').text(catatanText, 52, y + 8, { width: W - 20 });
  y += catatanH + 8;

  // ── SIGNATURE ────────────────────────────────────────────────────────
  y = ensureSpace(doc, y, 120);
  section('TANDA TANGAN CLIENT');
  const sigH = 110;
  doc.rect(45, y, W, sigH).fill(LGT);

  if (row.signature_b64 && row.signature_b64.length > 100) {
    try {
      const sigData = row.signature_b64.replace(/^data:image\/\w+;base64,/, '');
      const sigBuf = Buffer.from(sigData, 'base64');
      doc.image(sigBuf, 52, y + 6, { fit: [220, sigH - 14], align: 'left' });
    } catch (_) {}
  }

  doc.fillColor(GRY).fontSize(8.5).font('Helvetica-Bold')
     .text('Nama    :', 45 + W - 210, y + 30)
     .text('Telepon :', 45 + W - 210, y + 50);
  doc.fillColor('#111').fontSize(9).font('Helvetica')
     .text(fd.client_nama || '-', 45 + W - 130, y + 30)
     .text(fd.client_telp || '-', 45 + W - 130, y + 50);
  y += sigH + 8;

  // ── EVIDENCE PHOTOS ──────────────────────────────────────────────────
  if (imgs.length > 0) {
    y = ensureSpace(doc, y, 40);
    section('FOTO BUKTI PEKERJAAN');

    const imgSize = 155;
    const perRow = Math.floor(W / (imgSize + 10));
    let col = 0;
    let rowStartY = y;

    for (const url of imgs) {
      try {
        const buf = await fetchImageBuffer(url);
        if (col === 0) {
          rowStartY = ensureSpace(doc, rowStartY, imgSize + 30);
          doc.rect(45, rowStartY, W, imgSize + 20).fill(LGT);
        }
        const x = 45 + col * (imgSize + 10);
        doc.image(buf, x, rowStartY + 10, { fit: [imgSize, imgSize] });
        col++;
        if (col >= perRow) { col = 0; rowStartY += imgSize + 22; }
      } catch (_) { /* skip failed */ }
    }
    y = rowStartY + imgSize + 26;
  }

  // ── FOOTER ───────────────────────────────────────────────────────────
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    const fY = doc.page.height - 36;
    doc.rect(45, fY - 6, W, 28).fill(PRI);
    doc.fillColor('white').fontSize(7.5).font('Helvetica')
       .text('Jember Pest Control | www.jemberpest.co.id | 082 332 173 442', 52, fY)
       .text(`Report #${row.id} | Dicetak: ${new Date().toLocaleString('id-ID')} | Oleh: ${row.tech_name || row.username || '-'} | Hal. ${i + 1}/${pageCount}`, 52, fY + 11);
  }

  doc.end();
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/reports/export/excel  —  Bulk Excel all submissions
// ════════════════════════════════════════════════════════════════════════════
router.get('/export/excel', requireAuth, async (req, res) => {
  const rows = await all(`
    SELECT s.*, u.full_name as tech_name, u.username
    FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
    ORDER BY s.created_at DESC
  `);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Jember Pest Control';
  wb.lastModifiedBy = 'System';
  wb.created = new Date();

  // ── Sheet 1: Ringkasan ────────────────────────────────────────────────
  const ws = wb.addWorksheet('Ringkasan Submissions', { views: [{ state: 'frozen', ySplit: 4 }] });

  // Company header
  ws.mergeCells('A1:R1');
  ws.getCell('A1').value = 'JEMBER PEST CONTROL — CV. KASUARI INVESTAMA';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4a2e' } };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 28;

  ws.mergeCells('A2:R2');
  ws.getCell('A2').value = `Jl. Kasuari No. 22, Gebang-Patrang-Jember | Telp/WA: 082 332 173 442 | Dicetak: ${new Date().toLocaleString('id-ID')}`;
  ws.getCell('A2').font = { size: 9, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A2').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2d7a4f' } };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getRow(2).height = 18;

  ws.addRow([]); // spacer

  const headers = [
    '#', 'Tanggal', 'No. Slip', 'Nama Client', 'Alamat',
    'Jenis Kunjungan', 'Waktu Masuk', 'Waktu Keluar',
    'Sasaran Hama', 'Rat Box', 'Glue Trapping', 'Glue Tambahan', 'Perangkap Masal',
    'Chemical 1', 'Dosis 1', 'Chemical 2', 'Dosis 2',
    'Catatan', 'Nama Client (TTD)', 'Telp Client', 'Foto Count',
    'Disubmit Oleh', 'Waktu Submit',
  ];
  ws.addRow(headers);

  const hRow = ws.lastRow;
  hRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 9 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4a2e' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF4caf80' } } };
  });
  ws.getRow(4).height = 30;

  rows.forEach((row, idx) => {
    const fd = JSON.parse(row.form_data || '{}');
    const imgUrls = JSON.parse(row.image_urls || '[]');
    const activePests = PESTS.filter(p => fd[`pest_${p}`]).map(p => `${PEST_LABELS[p]}(${fd[`method_${p}`] || '-'})`).join(', ');
    const visitType = [fd.one_time_treatment && 'One Time', fd.reguler_treatment && 'Reguler'].filter(Boolean).join(', ') || '-';

    const r = ws.addRow([
      idx + 1,
      fd.tanggal || '-',
      fd.no || '-',
      fd.nama_client || '-',
      fd.alamat || '-',
      visitType,
      fd.time_in || '-',
      fd.time_out || '-',
      activePests || '-',
      Number(fd.rat_box) || 0,
      Number(fd.glue_trapping) || 0,
      Number(fd.glue_tambahan) || 0,
      Number(fd.perangkap_masal) || 0,
      fd.chemical1_name || '-',
      fd.chemical1_dose || '-',
      fd.chemical2_name || '-',
      fd.chemical2_dose || '-',
      fd.catatan || '-',
      fd.client_nama || '-',
      fd.client_telp || '-',
      imgUrls.length,
      row.tech_name || row.username || '-',
      row.created_at,
    ]);
    r.eachCell({ includeEmpty: false }, cell => {
      cell.alignment = { vertical: 'top', wrapText: false };
      cell.border = { bottom: { style: 'hair', color: { argb: 'FFdde8e2' } } };
      if (cell.col >= 10 && cell.col <= 13) {
        cell.numFmt = '0';
        cell.alignment = { horizontal: 'center' };
      }
    });
    if (idx % 2 === 1) {
      r.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F7F5' } };
      });
    }
    r.height = 18;
  });

  // Column widths
  const colWidths = [5, 12, 18, 25, 35, 18, 11, 11, 45, 10, 13, 13, 14, 20, 14, 20, 14, 40, 22, 16, 8, 20, 22];
  colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  // Auto-filter
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };

  // ── Sheet 2: Foto Bukti (links per submission) ─────────────────────
  const wsImg = wb.addWorksheet('Foto Bukti');
  wsImg.mergeCells('A1:D1');
  wsImg.getCell('A1').value = 'DAFTAR FOTO BUKTI PEKERJAAN';
  wsImg.getCell('A1').font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  wsImg.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4a2e' } };
  wsImg.getCell('A1').alignment = { horizontal: 'center' };
  wsImg.getRow(1).height = 24;

  wsImg.addRow(['#Sub', 'Client', 'Tanggal', 'URL Foto']);
  wsImg.lastRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2d7a4f' } };
  });

  rows.forEach(row => {
    const fd = JSON.parse(row.form_data || '{}');
    const imgUrls = JSON.parse(row.image_urls || '[]');
    imgUrls.forEach(url => {
      const r = wsImg.addRow([row.id, fd.nama_client || '-', fd.tanggal || '-', url]);
      // Make URL clickable
      r.getCell(4).value = { text: url, hyperlink: url };
      r.getCell(4).font = { color: { argb: 'FF2c5a9e' }, underline: true };
    });
  });
  wsImg.getColumn(4).width = 80;
  wsImg.getColumn(1).width = 8; wsImg.getColumn(2).width = 28; wsImg.getColumn(3).width = 14;

  // ── Send ──────────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="slip-service-export-${Date.now()}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/reports/:id/excel  —  single submission Excel
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/excel', requireAuth, async (req, res) => {
  let row;
  try {
    row = await get(`
      SELECT s.*, u.full_name as tech_name, u.username
      FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by
      WHERE s.id = ?
    `, [req.params.id]);
  } catch (e) { return res.status(500).json({ error: e.message }); }

  if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });

  const fd = JSON.parse(row.form_data || '{}');
  const imgUrls = JSON.parse(row.image_urls || '[]');
  const activePests = PESTS.filter(p => fd[`pest_${p}`]).map(p => `${PEST_LABELS[p]} (${fd[`method_${p}`] || '-'})`);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Slip Service');

  // Header branding
  ws.mergeCells('A1:C1');
  ws.getCell('A1').value = 'SLIP SERVICE — JEMBER PEST CONTROL';
  ws.getCell('A1').font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a4a2e' } };
  ws.getCell('A1').alignment = { horizontal: 'center' };
  ws.getRow(1).height = 26;

  const addSection = (title) => {
    ws.addRow([]);
    const r = ws.addRow([title]);
    r.getCell(1).font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2d7a4f' } };
    ws.mergeCells(`A${r.number}:C${r.number}`);
    r.height = 20;
  };

  const addField = (label, value) => {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { bold: true, size: 9, color: { argb: 'FF555555' } };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F7F4' } };
    r.getCell(2).font = { size: 9 };
    ws.mergeCells(`B${r.number}:C${r.number}`);
  };

  addSection('INFORMASI LAYANAN');
  addField('No. Slip', fd.no || '-');
  addField('Tanggal', fd.tanggal || '-');
  addField('Nama Client', fd.nama_client || '-');
  addField('Alamat', fd.alamat || '-');

  addSection('KUNJUNGAN & WAKTU');
  addField('Jenis Kunjungan', [fd.one_time_treatment && 'One Time Treatment', fd.reguler_treatment && 'Reguler Treatment'].filter(Boolean).join(', ') || '-');
  addField('Waktu Masuk', fd.time_in || '-');
  addField('Waktu Keluar', fd.time_out || '-');

  addSection('SASARAN & METODE');
  PESTS.forEach(p => {
    if (fd[`pest_${p}`]) addField(PEST_LABELS[p], fd[`method_${p}`] || '-');
  });
  if (!PESTS.some(p => fd[`pest_${p}`])) addField('(tidak ada sasaran)', '-');

  addSection('MONITORING');
  addField('Rat Box', `${fd.rat_box || 0} titik`);
  addField('Glue Trapping', `${fd.glue_trapping || 0} titik`);
  addField('Glue Tambahan', `${fd.glue_tambahan || 0} titik`);
  addField('Perangkap Masal', `${fd.perangkap_masal || 0} titik`);

  addSection('BAHAN AKTIF CHEMICAL');
  addField('Bahan Aktif 1', fd.chemical1_name || '-');
  addField('Dosis 1', fd.chemical1_dose || '-');
  addField('Bahan Aktif 2', fd.chemical2_name || '-');
  addField('Dosis 2', fd.chemical2_dose || '-');

  addSection('CATATAN');
  addField('Catatan', fd.catatan || '-');

  addSection('TANDA TANGAN CLIENT');
  addField('Nama', fd.client_nama || '-');
  addField('Telepon', fd.client_telp || '-');

  if (imgUrls.length > 0) {
    addSection('FOTO BUKTI (URL)');
    imgUrls.forEach((url, i) => {
      const r = ws.addRow([`Foto ${i + 1}`, url]);
      r.getCell(1).font = { bold: true, size: 9 };
      r.getCell(2).value = { text: url, hyperlink: url };
      r.getCell(2).font = { color: { argb: 'FF2c5a9e' }, underline: true, size: 9 };
      ws.mergeCells(`B${r.number}:C${r.number}`);
    });
  }

  addSection('META');
  addField('Disubmit Oleh', row.tech_name || row.username || '-');
  addField('Waktu Submit', row.created_at);
  addField('Report ID', `#${row.id}`);

  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 55;
  ws.getColumn(3).width = 12;

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="slip-service-${row.id}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});
// ════════════════════════════════════════════════════════════════════════════
// GET /api/reports/:id/public?token=xxx&t=timestamp  — Public PDF (no auth)
// ════════════════════════════════════════════════════════════════════════════
router.get('/:id/public', async (req, res) => {
  const { token, t } = req.query;
  const { id } = req.params;

  if (!verifyToken(id, t, token)) {
    return res.status(403).send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:60px">
        <h2>🔒 Link Tidak Valid atau Sudah Kadaluarsa</h2>
        <p>Link PDF ini hanya berlaku 7 hari. Minta link baru dari Jember Pest Control.</p>
      </body></html>
    `);
  }

  let row;
  try {
    row = await get(`SELECT s.*, u.full_name as tech_name FROM submissions s LEFT JOIN users u ON u.id = s.submitted_by WHERE s.id = ?`, [id]);
  } catch (e) {
    return res.status(500).send('Server error');
  }
  if (!row) return res.status(404).send('Slip tidak ditemukan');

  const doc  = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, bufferPages: true });
  const bufs = [];
  doc.on('data', d => bufs.push(d));
  doc.on('end', () => {
    const W = doc.page.width - 90;
    const PRI = '#1a4a2e';
    const pageCount = doc.bufferedPageRange().count;
    for (let i = 0; i < pageCount; i++) {
      doc.switchToPage(i);
      const fY = doc.page.height - 36;
      doc.rect(45, fY - 6, W, 28).fill(PRI);
      doc.fillColor('white').fontSize(7.5).font('Helvetica')
         .text('Jember Pest Control | www.jemberpest.co.id | 082 332 173 442', 52, fY)
         .text(`Dicetak: ${new Date().toLocaleString('id-ID')} | Hal. ${i + 1}/${pageCount}`, 52, fY + 11);
    }
    const pdfBuf = Buffer.concat(bufs);
    const fd = JSON.parse(row.form_data || '{}');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="slip-${fd.no || id}.pdf"`);
    res.setHeader('Content-Length', pdfBuf.length);
    res.end(pdfBuf);
  });

  await buildSlipPages(doc, row, true);
  doc.end();
});

module.exports = router;
module.exports.generateToken = generateToken;
