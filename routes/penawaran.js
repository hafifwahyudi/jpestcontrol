const express = require('express');
const PDFDocument = require('pdfkit');
const { run, get, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/penawaran ────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const conditions = [];
    const params = [];
    if (req.user.role !== 'admin') {
      conditions.push('p.submitted_by = ?');
      params.push(req.user.id);
    }
    if (search) {
      conditions.push('(p.nama_pelanggan LIKE ? OR p.alamat LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await all(`
      SELECT p.id, p.nama_pelanggan, p.alamat, p.jenis_layanan,
             p.harga, p.keterangan, p.signature_b64, p.created_at,
             u.username, u.full_name
      FROM penawaran p
      LEFT JOIN users u ON u.id = p.submitted_by
      ${where}
      ORDER BY p.created_at DESC
    `, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[penawaran GET]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/penawaran/:id ────────────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (req.params.id === 'pdf') return;
    const row = await get(`
      SELECT p.*, u.username, u.full_name
      FROM penawaran p LEFT JOIN users u ON u.id = p.submitted_by
      WHERE p.id = ?
    `, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/penawaran ───────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nama_pelanggan, alamat, jenis_layanan, harga_items, keterangan, signature_b64 } = req.body;
    const result = await run(`
      INSERT INTO penawaran (nama_pelanggan, alamat, jenis_layanan, harga_items, keterangan, signature_b64, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [nama_pelanggan, alamat, jenis_layanan, JSON.stringify(harga_items || []),
        keterangan || null, signature_b64 || null, req.user.id]);
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/penawaran/:id ─────────────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await run('DELETE FROM penawaran WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PDF Generator — Form Penawaran
// ─────────────────────────────────────────────────────────────────────────────
function buildPenawaranPdf(doc, data) {
  const ML = 48, MR = 48, MT = 40;
  const PW = doc.page.width;
  const PH = doc.page.height;
  const W  = PW - ML - MR;
  const BLK = '#000000';
  const GREEN_DARK = '#1a4a2e';
  const GREEN_MED  = '#2d7a4f';
  const GREEN_LIGHT = '#e8f5ed';

  let hargaItems = [];
  try { hargaItems = JSON.parse(data.harga_items || '[]'); } catch (_) {}

  // ── Header band ─────────────────────────────────────────────────────────
  doc.rect(0, 0, PW, 90).fill(GREEN_DARK);
  doc.rect(0, 88, PW, 4).fill('#3ddc84');

  // Company name
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22)
     .text('JEMBER PEST CONTROL', ML, 20, { width: W * 0.65 });
  doc.fillColor('#a8e6c1').font('Helvetica').fontSize(9)
     .text('Prevention · Sanitation · Treatment Control', ML, 46, { width: W * 0.65 });
  doc.fillColor('#c5f0d6').font('Helvetica').fontSize(7.5)
     .text('Jl. Kasuari No. 22 Jember – Jawa Timur', ML, 60, { width: W * 0.65 })
     .text('Telp/WA: (0331) 000-0000', ML, 72, { width: W * 0.65 });

  // "PENAWARAN" stamp on right
  doc.rect(PW - MR - 105, 18, 105, 58).fill(GREEN_MED);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(14)
     .text('PENAWARAN', PW - MR - 105, 30, { width: 105, align: 'center' });
  doc.fillColor('#a8e6c1').font('Helvetica').fontSize(8.5)
     .text('HARGA JASA', PW - MR - 105, 50, { width: 105, align: 'center' });

  let y = 108;

  // ── Nomor & Tanggal ─────────────────────────────────────────────────────
  const now = new Date();
  const bulanId = ['Januari','Februari','Maret','April','Mei','Juni','Juli',
                   'Agustus','September','Oktober','November','Desember'];
  const tglStr = `${now.getDate()} ${bulanId[now.getMonth()]} ${now.getFullYear()}`;
  const noDoc = `JPC/${String(data.id).padStart(4,'0')}/${now.getFullYear()}`;

  const smallLabelW = 100;
  doc.fillColor(BLK).font('Helvetica').fontSize(9);
  doc.text('Nomor', ML, y, { width: smallLabelW });
  doc.text(`:  ${noDoc}`, ML + smallLabelW, y);
  y += 14;
  doc.text('Tanggal', ML, y, { width: smallLabelW });
  doc.text(`:  ${tglStr}`, ML + smallLabelW, y);
  y += 22;

  // ── Calon Pelanggan box ─────────────────────────────────────────────────
  doc.rect(ML, y, W, 56).stroke(GREEN_MED);
  doc.rect(ML, y, W, 18).fill(GREEN_MED);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5)
     .text('DATA CALON PELANGGAN', ML + 8, y + 5);
  y += 18;

  const labelCol = 80;
  doc.fillColor(BLK).font('Helvetica').fontSize(9);
  doc.text('Nama', ML + 8, y + 3, { width: labelCol });
  doc.text(':  ' + (data.nama_pelanggan || ''), ML + 8 + labelCol, y + 3, { width: W - labelCol - 16 });
  y += 18;
  doc.text('Alamat', ML + 8, y + 3, { width: labelCol });
  doc.text(':  ' + (data.alamat || ''), ML + 8 + labelCol, y + 3, { width: W - labelCol - 16, lineBreak: false });
  y += 20 + 10;

  // ── Jenis Layanan ───────────────────────────────────────────────────────
  doc.rect(ML, y, W, 18).fill(GREEN_MED);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5)
     .text('JENIS LAYANAN', ML + 8, y + 5);
  y += 18;

  const allLayanan = ['Rodent Control','Pest Control','Termite Control','Pest & Termite Control','Spesial Pest Control'];
  const selectedLayanan = (data.jenis_layanan || '').split(',').map(s => s.trim()).filter(Boolean);

  const chipW = (W - 20) / 3;
  doc.rect(ML, y, W, 38).stroke(GREEN_MED);
  allLayanan.forEach((lyr, idx) => {
    const col = idx % 3;
    const row = Math.floor(idx / 3);
    const cx = ML + 10 + col * chipW;
    const cy = y + 6 + row * 18;
    const isSelected = selectedLayanan.includes(lyr);
    if (isSelected) {
      doc.rect(cx - 2, cy - 2, chipW - 6, 15).fill('#3ddc84');
      doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(8)
         .text(lyr, cx + 14, cy + 1, { width: chipW - 22, lineBreak: false });
    } else {
      doc.fillColor(BLK).font('Helvetica').fontSize(8)
         .text(lyr, cx + 14, cy + 1, { width: chipW - 22, lineBreak: false });
    }
    // Checkbox
    doc.rect(cx, cy + 1, 9, 9).stroke(isSelected ? GREEN_MED : '#999');
    if (isSelected) {
      doc.fillColor(GREEN_MED).font('Helvetica-Bold').fontSize(8)
         .text('✓', cx + 1, cy, { width: 9, align: 'center' });
    }
  });
  y += 40;

  // ── Tabel Harga ─────────────────────────────────────────────────────────
  y += 6;
  doc.rect(ML, y, W, 18).fill(GREEN_MED);
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(8.5)
     .text('RINCIAN PENAWARAN HARGA', ML + 8, y + 5);
  y += 18;

  // Table header row
  const colNo   = 28;
  const colDesc = W - colNo - 120 - 90;
  const colQty  = 90;
  const colHarga= 120;

  doc.rect(ML, y, W, 16).fill('#f0f9f4');
  doc.rect(ML, y, W, 16).stroke(GREEN_MED);

  doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(8);
  doc.text('No', ML + 4, y + 4, { width: colNo - 8, align: 'center' });
  doc.text('Uraian / Keterangan', ML + colNo + 4, y + 4, { width: colDesc - 8 });
  doc.text('Qty / Frekuensi', ML + colNo + colDesc + 4, y + 4, { width: colQty - 8 });
  doc.text('Harga', ML + colNo + colDesc + colQty + 4, y + 4, { width: colHarga - 8, align: 'right' });

  // Vertical separators in header
  let vx = ML + colNo;
  [colDesc, colQty, colHarga].forEach(cw => {
    doc.moveTo(vx, y).lineTo(vx, y + 16).stroke(GREEN_MED);
    vx += cw;
  });

  y += 16;

  // Data rows
  let totalHarga = 0;
  if (hargaItems.length === 0) {
    hargaItems = [{ uraian: '', qty: '', harga: 0 }];
  }
  hargaItems.forEach((item, idx) => {
    const rowH = 18;
    const bg = idx % 2 === 0 ? '#fff' : '#f9fcfb';
    doc.rect(ML, y, W, rowH).fill(bg);
    doc.rect(ML, y, W, rowH).stroke('#dde8e2');

    doc.fillColor(BLK).font('Helvetica').fontSize(8.5);
    doc.text(String(idx + 1), ML + 4, y + 4, { width: colNo - 8, align: 'center' });
    doc.text(item.uraian || '', ML + colNo + 4, y + 4, { width: colDesc - 8, lineBreak: false });
    doc.text(item.qty || '', ML + colNo + colDesc + 4, y + 4, { width: colQty - 8, lineBreak: false });

    const hargaNum = parseFloat(item.harga) || 0;
    totalHarga += hargaNum;
    const hargaFormatted = 'Rp ' + hargaNum.toLocaleString('id-ID');
    doc.text(hargaFormatted, ML + colNo + colDesc + colQty + 4, y + 4, { width: colHarga - 8, align: 'right' });

    let vx2 = ML + colNo;
    [colDesc, colQty, colHarga].forEach(cw => {
      doc.moveTo(vx2, y).lineTo(vx2, y + rowH).stroke('#dde8e2');
      vx2 += cw;
    });
    y += rowH;
  });

  // Total row
  doc.rect(ML, y, W, 20).fill(GREEN_LIGHT);
  doc.rect(ML, y, W, 20).stroke(GREEN_MED);
  doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(9);
  doc.text('TOTAL', ML + 4, y + 5, { width: colNo + colDesc + colQty - 8 });
  const totalStr = 'Rp ' + totalHarga.toLocaleString('id-ID');
  doc.text(totalStr, ML + colNo + colDesc + colQty + 4, y + 5, { width: colHarga - 8, align: 'right' });
  y += 20;

  // ── Keterangan / Catatan ─────────────────────────────────────────────────
  if (data.keterangan) {
    y += 10;
    doc.fillColor(BLK).font('Helvetica-Bold').fontSize(8.5).text('Catatan:', ML, y);
    y += 13;
    doc.font('Helvetica').fontSize(8.5).fillColor('#444')
       .text(data.keterangan, ML, y, { width: W, lineBreak: true });
    const approxLines = Math.ceil(data.keterangan.length / 80);
    y += approxLines * 12 + 4;
  }

  // ── Tanda Tangan (TTD perusahaan) ───────────────────────────────────────
  const sigH = 90;
  const sigW = 180;
  y += 16;

  // Left: pelanggan placeholder
  const leftSigX = ML;
  doc.fillColor(BLK).font('Helvetica').fontSize(8.5)
     .text('Hormat kami,', leftSigX, y, { width: sigW, align: 'center' });
  y += 14;
  doc.fillColor(GREEN_DARK).font('Helvetica-Bold').fontSize(8.5)
     .text('Jember Pest Control', leftSigX, y, { width: sigW, align: 'center' });
  y += 10;

  if (data.signature_b64 && data.signature_b64.length > 100) {
    try {
      const buf = Buffer.from(data.signature_b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      doc.image(buf, leftSigX + 20, y, { fit: [sigW - 40, sigH - 10] });
    } catch (_) {}
  }

  const ttdY = y + sigH;
  doc.rect(leftSigX, ttdY, sigW, 0.5).fill('#ccc');
  doc.fillColor('#555').font('Helvetica').fontSize(8)
     .text('(Authorized Signature)', leftSigX, ttdY + 4, { width: sigW, align: 'center' });

  // Right: menyetujui
  const rightSigX = ML + W - sigW;
  const rightSigY = y - 24;
  doc.fillColor(BLK).font('Helvetica').fontSize(8.5)
     .text('Menyetujui,', rightSigX, rightSigY, { width: sigW, align: 'center' });
  const sigBoxH = sigH + 30;
  doc.rect(rightSigX, rightSigY + 14, sigW, sigBoxH).stroke('#ccc');
  doc.fillColor('#aaa').font('Helvetica').fontSize(7.5)
     .text('Tanda Tangan Pelanggan', rightSigX, rightSigY + 14 + sigBoxH + 4, { width: sigW, align: 'center' });

  // ── Footer ───────────────────────────────────────────────────────────────
  const fy = PH - 36;
  doc.rect(0, fy - 8, PW, 1).fill('#3ddc84');
  doc.fillColor(GREEN_DARK).font('Helvetica').fontSize(7.5)
     .text('Prevention · Sanitation · Treatment Control | Jl. Kasuari No. 22 Jember – Jawa Timur',
           ML, fy, { width: W, align: 'center' });
}

// ── GET /api/penawaran/:id/pdf ─────────────────────────────────────────────────
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const data = await get('SELECT * FROM penawaran WHERE id = ?', [req.params.id]);
    if (!data) return res.status(404).json({ error: 'Tidak ditemukan' });
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true });
    const bufs = [];
    doc.on('data', d => bufs.push(d));
    doc.on('end', () => {
      const pdfBuf = Buffer.concat(bufs);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="penawaran-${data.id}.pdf"`);
      res.setHeader('Content-Length', pdfBuf.length);
      res.end(pdfBuf);
    });
    buildPenawaranPdf(doc, data);
    doc.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
