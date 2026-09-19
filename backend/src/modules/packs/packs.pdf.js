/*
 * Renewal pack → PDF.
 *
 * A cover page with the contents list, then every section in the template's
 * running order: heading, blurb, its figures, its tables. Empty sections are
 * printed too, greyed, with the note about what would fill them — a market
 * reading the PDF sees the same shape as the screen.
 */

import PDFDocument from 'pdfkit';
import { MONEY, PERCENT, NUMBER } from './packs.present.js';

const INK = '#16323b';
const SOFT = '#5b7079';
const TEAL = '#0d5c75';
const GREEN = '#1e7a5a';
const ZEBRA = '#eaf4f8';
const RULE = '#d8e2e6';

const MARGIN = 40;

/* The built-in fonts encode WinAnsi: Latin-1 plus a handful of typographic
   characters (dashes, curly quotes, bullet, ellipsis). Anything else — an
   arrow, a refresh glyph — draws as noise, so map or drop it. */
const WINANSI_EXTRAS = '\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0152\u0153\u0160\u0161\u0178\u017D\u017E\u0192\u02C6\u02DC';
const safe = (s) => String(s ?? '')
  .replace(/[→➔⇒]/g, '-')
  .replace(new RegExp(`[^\\x00-\\xFF${WINANSI_EXTRAS}]`, 'g'), '');

const fmtValue = (value, type) => {
  if (value == null || value === '') return '—';
  if ([MONEY, PERCENT, NUMBER].includes(type)) {
    const n = Number(String(value).replace(/[^0-9.-]/g, ''));
    if (Number.isFinite(n)) {
      const str = n.toLocaleString('en-US', { maximumFractionDigits: type === MONEY ? 0 : 2 });
      return type === PERCENT ? `${str}%` : str;
    }
  }
  return safe(value);
};

/** Room left on the page, and a new page when there is not enough. */
function ensure(doc, needed) {
  const bottom = doc.page.height - MARGIN;
  if (doc.y + needed > bottom) doc.addPage();
}

function sectionHeading(doc, index, section, width) {
  ensure(doc, 80);
  doc.x = MARGIN;
  doc.moveDown(0.6);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(12)
    .text(safe(`${index}. ${section.title}`), MARGIN, doc.y, { width });
  doc.fillColor(SOFT).font('Helvetica-Oblique').fontSize(8.5)
    .text(safe(section.blurb), MARGIN, doc.y, { width });
  doc.moveTo(MARGIN, doc.y + 3).lineTo(MARGIN + width, doc.y + 3).strokeColor(RULE).lineWidth(0.7).stroke();
  doc.moveDown(0.6);
  doc.x = MARGIN;
  doc.fillColor(INK).font('Helvetica').fontSize(9);
}

/** Two label/value columns per row. A long value grows its row rather than
    running into the pair beside it. */
function facts(doc, list, width) {
  const colWidth = width / 2;
  const labelWidth = colWidth * 0.5;
  const valueWidth = colWidth - labelWidth - 8;

  for (let i = 0; i < list.length; i += 2) {
    const pair = [list[i], list[i + 1]].filter(Boolean);
    doc.font('Helvetica-Bold').fontSize(9);
    const height = Math.max(14, ...pair.map((f) => (
      doc.heightOfString(fmtValue(f.value, f.type), { width: valueWidth }) + 3
    )));
    ensure(doc, height + 4);
    const top = doc.y;
    pair.forEach((f, column) => {
      const x = MARGIN + column * colWidth;
      doc.fillColor(SOFT).font('Helvetica').fontSize(8)
        .text(safe(f.label), x, top, { width: labelWidth - 6, lineBreak: false, ellipsis: true });
      doc.fillColor(INK).font('Helvetica-Bold').fontSize(9)
        .text(fmtValue(f.value, f.type), x + labelWidth, top, { width: valueWidth });
    });
    doc.y = top + height;
  }
  doc.x = MARGIN;
  doc.moveDown(0.4);
}

/** Column widths: numeric columns get a fixed share, text columns the rest. */
function columnWidths(table, width) {
  const weights = table.columns.map((c) => ([MONEY, PERCENT, NUMBER].includes(c.type) ? 1 : 1.6));
  const total = weights.reduce((a, w) => a + w, 0);
  return weights.map((w) => (w / total) * width);
}

function tableBlock(doc, table, width) {
  const widths = columnWidths(table, width);
  const rowHeight = 15;

  const header = () => {
    ensure(doc, rowHeight * 3);
    const top = doc.y;
    doc.rect(MARGIN, top, width, rowHeight).fill(GREEN);
    let x = MARGIN;
    table.columns.forEach((c, i) => {
      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(7.5)
        .text(safe(c.label).toUpperCase(), x + 4, top + 4.5, {
          width: widths[i] - 8,
          align: [MONEY, PERCENT, NUMBER].includes(c.type) ? 'right' : 'left',
          lineBreak: false,
          ellipsis: true,
        });
      x += widths[i];
    });
    doc.y = top + rowHeight;
  };

  if (table.title) {
    ensure(doc, 24);
    doc.fillColor(TEAL).font('Helvetica-Bold').fontSize(9).text(safe(table.title), MARGIN, doc.y, { width });
    doc.moveDown(0.2);
  }
  header();

  doc.x = MARGIN;
  table.rows.forEach((r, i) => {
    if (doc.y + rowHeight > doc.page.height - MARGIN) {
      doc.addPage();
      header();
    }
    const top = doc.y;
    if (i % 2 === 0) doc.rect(MARGIN, top, width, rowHeight).fill(ZEBRA);
    let x = MARGIN;
    table.columns.forEach((c, ci) => {
      doc.fillColor(INK).font('Helvetica').fontSize(8)
        .text(fmtValue(r[c.key], c.type), x + 4, top + 4, {
          width: widths[ci] - 8,
          align: [MONEY, PERCENT, NUMBER].includes(c.type) ? 'right' : 'left',
          lineBreak: false,
          ellipsis: true,
        });
      x += widths[ci];
    });
    doc.y = top + rowHeight;
  });
  doc.x = MARGIN;
  doc.moveDown(0.6);
}

function coverPage(doc, pack, width) {
  doc.rect(0, 0, doc.page.width, 120).fill(TEAL);
  doc.rect(0, 0, doc.page.width, 120).fillOpacity(0.25).fill(GREEN);
  doc.fillOpacity(1);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('AFRO-ASIAN INSURANCE SERVICES', MARGIN, 34);
  doc.font('Helvetica').fontSize(13)
    .text(safe(`${pack.reference} — Renewal Pack v${pack.version}`), MARGIN, 68);
  doc.fontSize(9).fillColor(ZEBRA)
    .text(safe(`${pack.basis_label} · ${pack.placement.class || ''}`), MARGIN, 90);

  doc.y = 150;
  doc.fillColor(INK);
  facts(doc, [
    { label: 'Cedant', value: pack.placement.cedant || '—' },
    { label: 'Class of business', value: pack.placement.cob || pack.placement.class || '—' },
    { label: 'Treaty type', value: pack.placement.treaty_type || '—' },
    { label: 'Period', value: `${String(pack.placement.inception || '').slice(0, 10)} to ${String(pack.placement.expiry || '').slice(0, 10)}` },
    { label: 'Currency', value: pack.currency },
    { label: 'Pack status', value: pack.status },
    { label: 'Template version', value: `v${pack.template_version}` },
    { label: 'Generated', value: String(pack.generated_at || '').slice(0, 19).replace('T', ' ') },
    { label: 'Sections', value: `${pack.summary.sections_filled} of ${pack.summary.sections_total} carry data` },
    ...(pack.summary.required_total ? [{
      label: 'Tracker',
      value: `${pack.summary.required_filled} of ${pack.summary.required_total} required sections filled${pack.summary.missing_required?.length ? ` — missing: ${pack.summary.missing_required.join(', ')}` : ''}`,
    }] : []),
  ], width);

  doc.moveDown(0.8);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(11).text('Contents', MARGIN, doc.y, { width });
  doc.moveDown(0.3);
  pack.sections.forEach((s, i) => {
    ensure(doc, 14);
    const top = doc.y;
    doc.fillColor(s.status === 'filled' ? INK : SOFT)
      .font(s.status === 'filled' ? 'Helvetica' : 'Helvetica-Oblique').fontSize(9)
      .text(safe(`${i + 1}.  ${s.title}`), MARGIN, top, { width: width * 0.6, lineBreak: false });
    doc.fillColor(SOFT).fontSize(8)
      .text(s.status === 'filled' ? 'included' : 'empty', MARGIN + width * 0.6, top + 1, {
        width: width * 0.4, align: 'right', lineBreak: false,
      });
    doc.y = top + 13;
  });

  // The checklist of screens as it stood when the version was created:
  // a table with one Yes/No column per class of business.
  if (pack.screens) {
    const s = pack.screens;
    doc.moveDown(0.8);
    ensure(doc, 60);
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(11)
      .text('Screens with data', MARGIN, doc.y, { width });
    doc.fillColor(SOFT).font('Helvetica-Oblique').fontSize(8.5)
      .text(safe(`${s.filled} of ${s.total} screens held data when this version was created`
        + (s.required_missing.length ? ` — required without data: ${s.required_missing.join(', ')}` : '')
        + (s.rows.some((r) => r.screen.endsWith(' *')) ? '. * required for the quoting structure.' : '.')), MARGIN, doc.y, { width });
    doc.moveDown(0.3);
    tableBlock(doc, { title: null, columns: s.columns, rows: s.rows }, width);
  }
}

/** The pack as a PDF buffer. */
export function packToPdf(pack) {
  return new Promise((resolve, reject) => {
    // bufferPages keeps every page addressable, so the footer can carry
    // "page N of M" once the total is known.
    const doc = new PDFDocument({
      size: 'A4', margin: MARGIN, layout: 'portrait', autoFirstPage: false, bufferPages: true,
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.addPage();
    const width = doc.page.width - MARGIN * 2;
    coverPage(doc, pack, width);

    pack.sections.forEach((section, i) => {
      sectionHeading(doc, i + 1, section, width);
      if (section.status !== 'filled') {
        doc.fillColor(SOFT).font('Helvetica-Oblique').fontSize(9)
          .text(safe(`No data — ${section.note}`), MARGIN, doc.y, { width });
        doc.moveDown(0.4);
        return;
      }
      if (section.facts.length) facts(doc, section.facts, width);
      for (const t of section.tables) tableBlock(doc, t, width);
    });

    // Page numbers, once the page count is known. Writing into the bottom
    // margin would otherwise push pdfkit into adding a page per footer, so the
    // margin is dropped for the duration of each write.
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      // Standard page header on every page after the branded cover: the
      // broker lockup with cedant, class of business, treaty type and the
      // currency of the data.
      if (i > range.start && pack.header) {
        const top = doc.page.margins.top;
        doc.page.margins.top = 0;
        doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(7.5)
          .text('AFRO-ASIAN INSURANCE SERVICES', MARGIN, 16, { lineBreak: false });
        doc.fillColor(SOFT).font('Helvetica').fontSize(7.5)
          .text(safe(pack.header), MARGIN + 60, 16, { width: width - 60, align: 'right', lineBreak: false });
        doc.moveTo(MARGIN, 28).lineTo(MARGIN + width, 28).strokeColor(RULE).lineWidth(0.5).stroke();
        doc.page.margins.top = top;
      }
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.fillColor(SOFT).font('Helvetica').fontSize(7.5)
        .text(
          safe(`${pack.reference} · Renewal Pack v${pack.version} · page ${i - range.start + 1} of ${range.count}`),
          MARGIN, doc.page.height - 28, { width, align: 'center', lineBreak: false },
        );
      doc.page.margins.bottom = bottom;
    }
    doc.flushPages();
    doc.end();
  });
}
