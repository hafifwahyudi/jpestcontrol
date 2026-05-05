const express = require('express');
const PDFDocument = require('pdfkit');
const { run, get, all } = require('../database');
const { requireAuth, requireAdmin } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/treatment-cards ──────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const conditions = [];
    const params = [];
    if (req.user.role !== 'admin') {
      conditions.push('tc.submitted_by = ?');
      params.push(req.user.id);
    }
    if (search) {
      conditions.push('tc.nama_client LIKE ?');
      params.push(`%${search}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await all(`
      SELECT tc.id, tc.nama_client, tc.alamat, tc.contact_person,
             tc.periode_kontrak, tc.no_card, tc.jenis_layanan, tc.jenis_treatment,
             tc.tipe, tc.contract_type, tc.frekuensi, tc.created_at, tc.updated_at,
             u.username, u.full_name,
             (SELECT COUNT(*) FROM treatment_card_entries e WHERE e.card_id = tc.id) as entry_count
      FROM treatment_cards tc
      LEFT JOIN users u ON u.id = tc.submitted_by
      ${where}
      ORDER BY tc.created_at DESC
    `, params);
    res.json({ ok: true, data: rows });
  } catch (e) {
    console.error('[treatment-cards GET]', e);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/treatment-cards/:id ──────────────────────────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    if (req.params.id === 'pdf') return; // skip, handled below
    const card = await get(`
      SELECT tc.*, u.username, u.full_name
      FROM treatment_cards tc LEFT JOIN users u ON u.id = tc.submitted_by
      WHERE tc.id = ?
    `, [req.params.id]);
    if (!card) return res.status(404).json({ error: 'Tidak ditemukan' });
    const entries = await all(
      'SELECT * FROM treatment_card_entries WHERE card_id = ? ORDER BY no_visit ASC',
      [req.params.id]
    );
    res.json({ ok: true, data: card, entries });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/treatment-cards ─────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { nama_client, alamat, contact_person, periode_kontrak, no_card,
            jenis_layanan, jenis_treatment, tipe, contract_type, frekuensi } = req.body;
    const result = await run(`
      INSERT INTO treatment_cards
        (nama_client, alamat, contact_person, periode_kontrak, no_card,
         jenis_layanan, jenis_treatment, tipe, contract_type, frekuensi, submitted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [nama_client, alamat, contact_person, periode_kontrak, no_card,
        jenis_layanan, jenis_treatment, JSON.stringify(tipe || []),
        contract_type, frekuensi, req.user.id]);
    res.status(201).json({ ok: true, id: result.lastID });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/treatment-cards/:id ──────────────────────────────────────────────
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const existing = await get('SELECT id, submitted_by FROM treatment_cards WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (req.user.role !== 'admin' && existing.submitted_by !== req.user.id)
      return res.status(403).json({ error: 'Akses ditolak' });
    const { nama_client, alamat, contact_person, periode_kontrak, no_card,
            jenis_layanan, jenis_treatment, tipe, contract_type, frekuensi } = req.body;
    await run(`
      UPDATE treatment_cards SET
        nama_client=?, alamat=?, contact_person=?, periode_kontrak=?, no_card=?,
        jenis_layanan=?, jenis_treatment=?, tipe=?, contract_type=?, frekuensi=?,
        updated_at=NOW()
      WHERE id=?
    `, [nama_client, alamat, contact_person, periode_kontrak, no_card,
        jenis_layanan, jenis_treatment, JSON.stringify(tipe || []),
        contract_type, frekuensi, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/treatment-cards/:id ───────────────────────────────────────────
router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await run('DELETE FROM treatment_card_entries WHERE card_id = ?', [req.params.id]);
    const result = await run('DELETE FROM treatment_cards WHERE id = ?', [req.params.id]);
    if (result.changes === 0) return res.status(404).json({ error: 'Tidak ditemukan' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/treatment-cards/:id/entries ─────────────────────────────────────
router.post('/:id/entries', requireAuth, async (req, res) => {
  try {
    const card = await get('SELECT id, submitted_by FROM treatment_cards WHERE id = ?', [req.params.id]);
    if (!card) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
    const { no_visit, tanggal, teknisi, time_in, time_out,
            area_treatment, jenis_treatment, paraf_b64 } = req.body;
    const existing = await get(
      'SELECT id FROM treatment_card_entries WHERE card_id = ? AND no_visit = ?',
      [req.params.id, no_visit]
    );
    if (existing) {
      await run(`
        UPDATE treatment_card_entries SET
          tanggal=?, teknisi=?, time_in=?, time_out=?,
          area_treatment=?, jenis_treatment=?, paraf_b64=?
        WHERE id=?
      `, [tanggal, teknisi, time_in, time_out,
          area_treatment, jenis_treatment, paraf_b64 || null, existing.id]);
      res.json({ ok: true, id: existing.id, updated: true });
    } else {
      const result = await run(`
        INSERT INTO treatment_card_entries
          (card_id, no_visit, tanggal, teknisi, time_in, time_out,
           area_treatment, jenis_treatment, paraf_b64)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [req.params.id, no_visit, tanggal, teknisi, time_in, time_out,
          area_treatment, jenis_treatment, paraf_b64 || null]);
      res.status(201).json({ ok: true, id: result.lastID });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/treatment-cards/:id/entries/:eid ──────────────────────────────
router.delete('/:id/entries/:eid', requireAuth, async (req, res) => {
  try {
    const card = await get('SELECT submitted_by FROM treatment_cards WHERE id = ?', [req.params.id]);
    if (!card) return res.status(404).json({ error: 'Tidak ditemukan' });
    if (req.user.role !== 'admin' && card.submitted_by !== req.user.id)
      return res.status(403).json({ error: 'Akses ditolak' });
    const result = await run(
      'DELETE FROM treatment_card_entries WHERE id = ? AND card_id = ?',
      [req.params.eid, req.params.id]
    );
    if (result.changes === 0) return res.status(404).json({ error: 'Entry tidak ditemukan' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PDF Generator — Treatment Card (2 pages: visits 1-12 & 13-26)
// ─────────────────────────────────────────────────────────────────────────────
function buildTreatmentCardPdf(doc, card, entries) {
  const entryMap = {};
  entries.forEach(e => { entryMap[e.no_visit] = e; });

  let tipeArr = [];
  try { tipeArr = JSON.parse(card.tipe || '[]'); } catch (_) {}

  const ML = 36, MR = 36, MT = 30;
  const PW = doc.page.width;
  const PH = doc.page.height;
  const W  = PW - ML - MR; // ~523

  // Column widths
  const C_NO  = 25;
  const C_TGL = 78;
  const C_TEK = 82;
  const C_AREA= 220;
  const C_JNS = 72;
  const C_PAR = W - C_NO - C_TGL - C_TEK - C_AREA - C_JNS;

  const RH_MAIN = 14;
  const RH_SUB  = 11;
  const RH_VISIT= RH_MAIN + RH_SUB + RH_SUB;

  const BLK = '#000000', WHT = '#ffffff', LGT = '#f5f5f5';

  // ── Draw table column header ──────────────────────────────────────────────
  function drawTableHeader(y) {
    doc.rect(ML, y, W, 20).fillAndStroke('#000000', '#000000');
    doc.fillColor(WHT).font('Helvetica-Bold').fontSize(7.5);
    let x = ML;
    const cy = y + 6;
    doc.text('No',              x+1,  cy, { width: C_NO-2,  align: 'center' }); x += C_NO;
    doc.text('Tgl',             x+1,  cy, { width: C_TGL-2, align: 'center' }); x += C_TGL;
    doc.text('Teknisi',         x+1,  cy, { width: C_TEK-2, align: 'center' }); x += C_TEK;
    doc.text('Area Treatment',  x+1,  cy, { width: C_AREA-2,align: 'center' }); x += C_AREA;
    doc.text('Jenis\nTreatment',x+1, y+1, { width: C_JNS-2, align: 'center', lineBreak: true }); x += C_JNS;
    doc.text('Paraf\nClient',   x+1, y+1, { width: C_PAR-2, align: 'center', lineBreak: true });
    return y + 20;
  }

  // ── Draw one visit row (3 sub-rows) ──────────────────────────────────────
  function drawVisitRow(y, vNo, entry) {
    const H = RH_VISIT;
    // Outer rect
    doc.rect(ML, y, W, H).stroke(BLK);

    // Vertical lines
    let x = ML + C_NO;
    doc.moveTo(x, y).lineTo(x, y+H).stroke(BLK); x += C_TGL;
    doc.moveTo(x, y).lineTo(x, y+H).stroke(BLK); x += C_TEK;
    doc.moveTo(x, y).lineTo(x, y+H).stroke(BLK); x += C_AREA;
    doc.moveTo(x, y).lineTo(x, y+H).stroke(BLK); x += C_JNS;
    doc.moveTo(x, y).lineTo(x, y+H).stroke(BLK);

    // Horizontal lines in No+Tgl area only
    const hx0 = ML;
    const hx1 = ML + C_NO + C_TGL;
    doc.moveTo(hx0, y+RH_MAIN).lineTo(hx1, y+RH_MAIN).stroke(BLK);
    doc.moveTo(hx0, y+RH_MAIN+RH_SUB).lineTo(hx1, y+RH_MAIN+RH_SUB).stroke(BLK);

    // Visit number
    doc.fillColor(BLK).font('Helvetica-Bold').fontSize(8)
       .text(String(vNo), ML+2, y+2, { width: C_NO-4, align: 'left' });

    // In / Out labels
    doc.font('Helvetica').fontSize(6.5);
    doc.text('In',  ML+C_NO+2, y+RH_MAIN+2);
    doc.text('Out', ML+C_NO+2, y+RH_MAIN+RH_SUB+2);
    doc.text(':',   ML+C_NO+14, y+RH_MAIN+2);
    doc.text(':',   ML+C_NO+14, y+RH_MAIN+RH_SUB+2);

    if (!entry) return y + H;

    doc.font('Helvetica').fontSize(7).fillColor(BLK);

    // Date
    const tglStr = entry.tanggal
      ? new Date(entry.tanggal).toLocaleDateString('id-ID', { day:'2-digit', month:'2-digit', year:'2-digit' })
      : '';
    if (tglStr) doc.text(tglStr, ML+C_NO+2, y+2, { width: C_TGL-4 });

    // Time In/Out
    const xTime = ML + C_NO + 22;
    if (entry.time_in)  doc.text(entry.time_in,  xTime, y+RH_MAIN+2,     { width: C_TGL-24 });
    if (entry.time_out) doc.text(entry.time_out, xTime, y+RH_MAIN+RH_SUB+2, { width: C_TGL-24 });

    // Teknisi
    const xTek = ML + C_NO + C_TGL;
    if (entry.teknisi) doc.fontSize(7).text(entry.teknisi, xTek+2, y+2, { width: C_TEK-4, lineBreak: false });

    // Area Treatment
    const xArea = xTek + C_TEK;
    if (entry.area_treatment) doc.fontSize(7).text(entry.area_treatment, xArea+2, y+2, { width: C_AREA-4, lineBreak: false });

    // Jenis Treatment
    const xJns = xArea + C_AREA;
    if (entry.jenis_treatment) doc.fontSize(6.5).text(entry.jenis_treatment, xJns+2, y+2, { width: C_JNS-4, lineBreak: false });

    // Paraf signature
    const xPar = xJns + C_JNS;
    if (entry.paraf_b64 && entry.paraf_b64.length > 100) {
      try {
        const buf = Buffer.from(entry.paraf_b64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
        doc.image(buf, xPar+1, y+1, { fit: [C_PAR-2, H-2] });
      } catch (_) {}
    }

    return y + H;
  }

  // ── Page footer ───────────────────────────────────────────────────────────
  function drawFooter() {
    const fy = PH - 38;
    doc.fillColor(BLK).font('Helvetica').fontSize(7.5)
       .text('Prevention . Sanitation . Treatment Control', ML, fy, { width: W, align: 'center' })
       .text('Jember Pest Control : Jl. Kasuari No. 22 Jember - Jawa Timur', ML, fy+12, { width: W, align: 'center' });
  }

  // ══════════════════════════════════════════════════════════════════
  // PAGE 1 — Header info + visits 1–12
  // ══════════════════════════════════════════════════════════════════
  let y = MT;

  // Title
  doc.fillColor(BLK).font('Helvetica-Bold').fontSize(16)
     .text('Treatment Card', ML, y, { width: W, align: 'center' });
  y += 22;
  doc.font('Helvetica').fontSize(9)
     .text('Jember Pest Control', ML, y, { width: W, align: 'center' });
  y += 16;

  // Info layout: left 58%, right 42%
  const INFO_L = Math.round(W * 0.57);
  const INFO_R = W - INFO_L;
  const LX = ML, RX = ML + INFO_L;
  const INFO_Y = y;
  const FIELD_H = 14;
  const LABEL_W = 82;

  const infoFields = [
    ['Nama Client',      card.nama_client || ''],
    ['Alamat',           card.alamat || ''],
    ['Contact Person',   card.contact_person || ''],
    ['Periode Kontrak',  card.periode_kontrak || ''],
    ['No',               card.no_card || ''],
    ['Jenis Layanan',    card.jenis_layanan || ''],
    ['Jenis Treatment',  card.jenis_treatment || ''],
  ];

  doc.font('Helvetica').fontSize(7.5).fillColor(BLK);
  infoFields.forEach(([lbl, val], i) => {
    const fy2 = INFO_Y + i * FIELD_H;
    doc.text(lbl,  LX+2,         fy2+2, { width: LABEL_W });
    doc.text(':',  LX+LABEL_W+2, fy2+2);
    if (val) doc.text(val, LX+LABEL_W+10, fy2+2, { width: INFO_L - LABEL_W - 14 });
    // underline
    doc.strokeColor('#cccccc').moveTo(LX+LABEL_W+10, fy2+FIELD_H-2).lineTo(LX+INFO_L-2, fy2+FIELD_H-2).stroke();
  });
  doc.strokeColor(BLK);

  // Right boxes
  const BOX_H = 14;
  const BOX_W = INFO_R - 2;

  // Row 1: PC RC TC SP
  const tipeOptions = ['PC', 'RC', 'TC', 'SP'];
  doc.rect(RX, INFO_Y, BOX_W, BOX_H).stroke(BLK);
  tipeOptions.forEach((t, i) => {
    const cx = RX + (BOX_W / 4) * i + 10;
    const cy2 = INFO_Y + BOX_H / 2;
    if (tipeArr.includes(t)) doc.circle(cx, cy2, 4).fill(BLK);
    else doc.circle(cx, cy2, 4).stroke(BLK);
    doc.fillColor(BLK).font('Helvetica').fontSize(7.5)
       .text(t, cx+6, INFO_Y+3, { width: 20 });
  });

  // Row 2: Kontrak / Job
  doc.rect(RX, INFO_Y+BOX_H, BOX_W, BOX_H).stroke(BLK);
  const halvesW = BOX_W / 2;
  [['kontrak','Kontrak'], ['job','Job']].forEach(([key, lbl], i) => {
    const cx = RX + halvesW * i + 8;
    const cy2 = INFO_Y + BOX_H + BOX_H / 2;
    if (card.contract_type === key) doc.circle(cx, cy2, 4).fill(BLK);
    else doc.circle(cx, cy2, 4).stroke(BLK);
    doc.fillColor(BLK).font('Helvetica').fontSize(7.5)
       .text(lbl, cx+6, INFO_Y+BOX_H+3, { width: halvesW-14 });
  });

  // Row 3: Frekuensi
  doc.rect(RX, INFO_Y+BOX_H*2, BOX_W, BOX_H).stroke(BLK);
  doc.fillColor(BLK).font('Helvetica').fontSize(7.5)
     .text(`Frekuensi Layanan :  ${card.frekuensi || 'X'}/ Bulan`, RX+4, INFO_Y+BOX_H*2+3, { width: BOX_W-6 });

  // Row 4: empty box
  doc.rect(RX, INFO_Y+BOX_H*3, BOX_W, BOX_H).stroke(BLK);

  // Outer border for info
  const infoH = infoFields.length * FIELD_H + 4;
  doc.rect(LX, INFO_Y, W, infoH).stroke(BLK);

  y = INFO_Y + Math.max(infoH, BOX_H * 4) + 6;

  // Table visits 1–12
  y = drawTableHeader(y);
  for (let i = 1; i <= 12; i++) y = drawVisitRow(y, i, entryMap[i]);
  drawFooter();

  // ══════════════════════════════════════════════════════════════════
  // PAGE 2 — Visits 13–26
  // ══════════════════════════════════════════════════════════════════
  doc.addPage();
  y = MT;
  y = drawTableHeader(y);
  for (let i = 13; i <= 26; i++) y = drawVisitRow(y, i, entryMap[i]);
  drawFooter();
}

// ── GET /api/treatment-cards/:id/pdf ─────────────────────────────────────────
router.get('/:id/pdf', requireAuth, async (req, res) => {
  try {
    const card = await get('SELECT * FROM treatment_cards WHERE id = ?', [req.params.id]);
    if (!card) return res.status(404).json({ error: 'Kartu tidak ditemukan' });
    const entries = await all(
      'SELECT * FROM treatment_card_entries WHERE card_id = ? ORDER BY no_visit ASC',
      [req.params.id]
    );
    const doc = new PDFDocument({ size: 'A4', margin: 0, autoFirstPage: true, bufferPages: false });
    const bufs = [];
    doc.on('data', d => bufs.push(d));
    doc.on('end', () => {
      const pdfBuf = Buffer.concat(bufs);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="treatment-card-${card.id}.pdf"`);
      res.setHeader('Content-Length', pdfBuf.length);
      res.end(pdfBuf);
    });
    doc.on('error', err => { if (!res.headersSent) res.status(500).json({ error: 'Gagal membuat PDF' }); });
    buildTreatmentCardPdf(doc, card, entries);
    doc.end();
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
