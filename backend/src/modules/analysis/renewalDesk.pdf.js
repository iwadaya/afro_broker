/*
 * The verified renewal summary as the two-page PDF that goes to market with
 * the cedant's own pack, and the layer schedule with the loss experience as
 * a second, shorter document. Both are rendered from the analysis result the
 * broker signed off — the same figures, the same flags where the packs were
 * silent — so what the market reads is what the broker verified.
 */

import PDFDocument from 'pdfkit';

const INK = '#16323b';
const SOFT = '#5b7079';
const GREEN = '#1e7a5a';
const RULE = '#d8e2e6';
const ZEBRA = '#eaf4f8';
const MARGIN = 44;

/* The built-in fonts encode WinAnsi: Latin-1 plus a handful of typographic
   characters. Anything else draws as noise, so map or drop it. */
const WINANSI_EXTRAS = '–—‘’‚“”„†‡•…‰‹›€™ŒœŠšŸŽžƒˆ˜';
const safe = (s) => String(s ?? '')
  .replace(/[→➔⇒]/g, '-')
  .replace(new RegExp(`[^\\x00-\\xFF${WINANSI_EXTRAS}]`, 'g'), '');

const clean = (v) => String(v ?? '').trim();
/** A figure, or the flag where the packs were silent — never a guess. */
const figure = (v) => (clean(v) ? safe(v) : 'not in the pack');

function fmtStamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: MARGIN, layout: 'portrait', bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    build(doc);
    // Footer on every page once the count is known.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.fillColor(SOFT).font('Helvetica').fontSize(8)
        .text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN, doc.page.height - MARGIN + 10, {
          width: doc.page.width - MARGIN * 2, align: 'right', lineBreak: false,
        });
    }
    doc.end();
  });
}

const width = (doc) => doc.page.width - MARGIN * 2;

function ensure(doc, needed) {
  if (doc.y + needed > doc.page.height - MARGIN) doc.addPage();
}

function heading(doc, text) {
  ensure(doc, 60);
  doc.moveDown(0.8);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(10.5).text(safe(text).toUpperCase(), MARGIN, doc.y, { characterSpacing: 1 });
  doc.moveTo(MARGIN, doc.y + 3).lineTo(MARGIN + width(doc), doc.y + 3).strokeColor(RULE).lineWidth(0.7).stroke();
  doc.moveDown(0.7);
  doc.fillColor(INK).font('Helvetica').fontSize(9.5);
}

/** A table drawn with fixed column widths; `align` per column, r = right. */
function table(doc, columns, rows) {
  const w = width(doc);
  const total = columns.reduce((t, c) => t + c.w, 0);
  const xs = [];
  let x = MARGIN;
  for (const c of columns) { xs.push(x); x += (c.w / total) * w; }
  const cellW = (i) => (columns[i].w / total) * w - 6;
  const rowH = 16;

  ensure(doc, rowH * 2);
  let y = doc.y;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(SOFT);
  columns.forEach((c, i) => doc.text(safe(c.label).toUpperCase(), xs[i] + 3, y + 3, { width: cellW(i), align: c.align === 'r' ? 'right' : 'left', lineBreak: false }));
  y += rowH;
  doc.moveTo(MARGIN, y).lineTo(MARGIN + w, y).strokeColor(RULE).lineWidth(0.6).stroke();
  doc.font('Helvetica').fontSize(9).fillColor(INK);
  rows.forEach((r, ri) => {
    if (y + rowH > doc.page.height - MARGIN) { doc.addPage(); y = doc.y; }
    if (ri % 2 === 1) doc.rect(MARGIN, y, w, rowH).fill(ZEBRA).fillColor(INK);
    r.forEach((cell, i) => {
      const missing = cell === 'not in the pack';
      doc.fillColor(missing ? SOFT : INK).font(missing ? 'Helvetica-Oblique' : 'Helvetica')
        .text(safe(cell), xs[i] + 3, y + 4, { width: cellW(i), align: columns[i].align === 'r' ? 'right' : 'left', lineBreak: false });
    });
    y += rowH;
  });
  doc.fillColor(INK).font('Helvetica');
  doc.y = y + 6;
  doc.x = MARGIN;
}

function factGrid(doc, facts) {
  const w = width(doc);
  const colW = w / 4;
  const rowH = 34;
  ensure(doc, rowH * Math.ceil(facts.length / 4) + 10);
  const top = doc.y;
  facts.forEach(([k, v], i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = MARGIN + col * colW;
    const y = top + row * rowH;
    doc.rect(x, y, colW, rowH).strokeColor(RULE).lineWidth(0.5).stroke();
    doc.fillColor(SOFT).font('Helvetica-Bold').fontSize(6.5).text(safe(k).toUpperCase(), x + 6, y + 6, { width: colW - 12, lineBreak: false, characterSpacing: 0.8 });
    const val = figure(v);
    doc.fillColor(val === 'not in the pack' ? SOFT : INK).font(val === 'not in the pack' ? 'Helvetica-Oblique' : 'Helvetica-Bold').fontSize(9.5)
      .text(val, x + 6, y + 17, { width: colW - 12, lineBreak: false });
  });
  doc.y = top + rowH * Math.ceil(facts.length / 4) + 10;
  doc.x = MARGIN;
  doc.fillColor(INK).font('Helvetica').fontSize(9.5);
}

function layerRows(result) {
  return (result.layers || []).map((l) => [
    figure(l.name), figure(l.cover), figure(l.deposit_premium), figure(l.rol), figure(l.reinstatements), figure(l.expiring_line),
  ]);
}
const LAYER_COLUMNS = [
  { label: 'Layer', w: 1.1 }, { label: 'Cover', w: 2 }, { label: 'Deposit premium', w: 1.6, align: 'r' },
  { label: 'ROL', w: 0.9, align: 'r' }, { label: 'Reinstatements', w: 1.5 }, { label: 'Expiring line', w: 1.5, align: 'r' },
];
const EXPERIENCE_COLUMNS = [
  { label: 'Year', w: 1 }, { label: 'Premium', w: 1.6, align: 'r' }, { label: 'Incurred', w: 1.6, align: 'r' }, { label: 'LR', w: 1, align: 'r' },
];
const experienceRows = (result) => (result.experience || []).map((e) => [figure(e.year), figure(e.premium), figure(e.incurred), figure(e.loss_ratio)]);

function titleBlock(doc, { analysis, kicker, verifiedBy }) {
  const prog = analysis.result?.programme || {};
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(8).text(safe(kicker).toUpperCase(), { characterSpacing: 1.2 });
  doc.moveDown(0.4);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(safe(analysis.cedant_name));
  doc.font('Helvetica').fontSize(12).fillColor(SOFT)
    .text(safe(clean(prog.treaty_name) || `${analysis.treaty_type} — ${analysis.class_of_business}`));
  doc.moveDown(0.3);
  const meta = [
    analysis.analysed_at ? `Drafted ${fmtStamp(analysis.analysed_at)}` : null,
    verifiedBy ? `Verified by ${verifiedBy}${analysis.verified_at ? ` ${fmtStamp(analysis.verified_at)}` : ''}` : 'Unverified draft',
  ].filter(Boolean).join('  ·  ');
  doc.fontSize(8.5).fillColor(SOFT).text(safe(meta));
  doc.moveTo(MARGIN, doc.y + 6).lineTo(MARGIN + width(doc), doc.y + 6).strokeColor(RULE).lineWidth(0.8).stroke();
  doc.moveDown(1.2);
  doc.fillColor(INK).font('Helvetica').fontSize(9.5);
}

/** The two-page renewal summary. */
export function summaryPdf({ analysis, verifiedBy }) {
  const result = analysis.result || {};
  const prog = result.programme || {};
  return render((doc) => {
    titleBlock(doc, { analysis, kicker: 'Renewal summary · 2 pages', verifiedBy });

    factGrid(doc, [
      ['Cedant', analysis.cedant_name], ['Class', analysis.class_of_business],
      ['Inception', prog.inception], ['Currency', prog.currency],
      ['Programme', prog.structure], ['Layers', prog.layer_count],
      ['EPI', prog.epi], ['Deposit premium', prog.deposit_premium],
    ]);

    heading(doc, 'Programme');
    doc.text(safe(clean(prog.prose) || 'No programme paragraph on this draft.'), { width: width(doc), lineGap: 2 });

    heading(doc, 'Layer schedule');
    if (layerRows(result).length) table(doc, LAYER_COLUMNS, layerRows(result));
    else doc.font('Helvetica-Oblique').fillColor(SOFT).text('No layer schedule in the packs.').fillColor(INK).font('Helvetica');

    doc.addPage();
    heading(doc, 'Changes on expiring');
    const changes = result.changes || [];
    if (!changes.length) doc.font('Helvetica-Oblique').fillColor(SOFT).text('No changes identified.').fillColor(INK).font('Helvetica');
    changes.forEach((c, i) => {
      ensure(doc, 30);
      doc.font('Helvetica-Bold').fillColor(GREEN).text(String(i + 1).padStart(2, '0'), MARGIN, doc.y, { continued: true, width: width(doc) });
      doc.font('Helvetica').fillColor(INK).text(`   ${safe(c.change)}`, { width: width(doc) - 20 });
      doc.moveDown(0.3);
    });

    heading(doc, 'Loss experience');
    if (experienceRows(result).length) table(doc, EXPERIENCE_COLUMNS, experienceRows(result));
    else doc.font('Helvetica-Oblique').fillColor(SOFT).text('No loss experience in the packs.').fillColor(INK).font('Helvetica');
    if (clean(result.experience_note)) {
      doc.fillColor(SOFT).fontSize(9).text(safe(result.experience_note), { width: width(doc) }).fillColor(INK).fontSize(9.5);
    }

    const flags = result.flags?.length ? result.flags : (result.data_quality || []).map((claim) => ({ kind: 'check', claim, source: '' }));
    if (flags.length) {
      heading(doc, 'Flagged for review');
      for (const f of flags) {
        ensure(doc, 30);
        doc.font('Helvetica-Bold').fillColor(SOFT).fontSize(8).text(safe(f.kind).toUpperCase(), { continued: true });
        doc.font('Helvetica').fillColor(INK).fontSize(9.5).text(`   ${safe(f.claim)}`, { width: width(doc) });
        if (clean(f.source)) doc.fillColor(SOFT).fontSize(8.5).text(safe(f.source), MARGIN + 14, doc.y, { width: width(doc) - 14 }).fillColor(INK).fontSize(9.5);
        doc.x = MARGIN;
        doc.moveDown(0.3);
      }
    }
  });
}

/** The layer schedule and loss experience on their own. */
export function schedulePdf({ analysis, verifiedBy }) {
  const result = analysis.result || {};
  return render((doc) => {
    titleBlock(doc, { analysis, kicker: 'Layer schedule and loss experience', verifiedBy });
    heading(doc, 'Layer schedule');
    if (layerRows(result).length) table(doc, LAYER_COLUMNS, layerRows(result));
    else doc.font('Helvetica-Oblique').fillColor(SOFT).text('No layer schedule in the packs.').fillColor(INK).font('Helvetica');
    heading(doc, 'Loss experience');
    if (experienceRows(result).length) table(doc, EXPERIENCE_COLUMNS, experienceRows(result));
    else doc.font('Helvetica-Oblique').fillColor(SOFT).text('No loss experience in the packs.').fillColor(INK).font('Helvetica');
    if (clean(result.experience_note)) {
      doc.fillColor(SOFT).fontSize(9).text(safe(result.experience_note), { width: width(doc) }).fillColor(INK).fontSize(9.5);
    }
  });
}

/** A filename that says what the attachment is and whose. */
export function deskFilename(analysis, kind) {
  const slug = String(analysis.cedant_name || 'renewal').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  return kind === 'schedule' ? `${slug}_layer_schedule.pdf` : `${slug}_renewal_summary_verified.pdf`;
}
