/*
 * Renewal pack → Excel workbook.
 *
 * A cover sheet, then one sheet per template section in the pack's running
 * order — including the sections with nothing behind them, which carry their
 * "what would fill this" note. The styling follows the Universe pack theme
 * (gradient title bar, header row, zebra body, frozen panes, fit-to-width
 * print setup) so a pack out of Afro-Asian sits alongside the modelling tool's
 * own exports.
 */

import ExcelJS from 'exceljs';
import { MONEY, PERCENT, NUMBER, DATE } from './packs.present.js';

const T = {
  font: 'Calibri',
  white: 'FFFFFFFF',
  ink: 'FF16323B',
  inkSoft: 'FF5B7079',
  teal: 'FF0D5C75',
  green: 'FF2F8F6B',
  headerBg: 'FF1E7A5A',
  zebraA: 'FFEAF4F8',
  zebraB: 'FFEFF7F1',
  grid: 'FFD8E2E6',
  fmtMoney: '#,##0;[Red]-#,##0',
  fmtPct: '0.00"%"',
  fmtInt: '#,##0',
  fmtNum: '#,##0.0000',
  fmtDate: 'dd-mmm-yyyy',
};

const thin = () => ({ style: 'thin', color: { argb: T.grid } });
const allThin = () => ({ top: thin(), left: thin(), bottom: thin(), right: thin() });

const numFmt = (type) => ({
  [MONEY]: T.fmtMoney, [PERCENT]: T.fmtPct, [NUMBER]: T.fmtInt, [DATE]: T.fmtDate,
}[type]);

/** A number when the cell is numeric, the raw value otherwise. */
function cellValue(value, type) {
  if (value == null || value === '') return null;
  if ([MONEY, PERCENT, NUMBER].includes(type)) {
    const n = Number(String(value).replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

/** Gradient title bar across rows 1–3; returns the header row index. */
function titleBar(ws, ncols, title, subtitle) {
  const width = Math.max(ncols, 3);
  ws.mergeCells(1, 1, 2, width);
  const t = ws.getCell(1, 1);
  t.value = {
    richText: [
      { text: 'AFRO-ASIAN INSURANCE SERVICES', font: { name: T.font, size: 16, bold: true, color: { argb: T.white } } },
      { text: `    ${title || ''}`, font: { name: T.font, size: 13, color: { argb: T.zebraA } } },
    ],
  };
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  t.fill = {
    type: 'gradient',
    gradient: 'angle',
    degree: 0,
    stops: [{ position: 0, color: { argb: T.teal } }, { position: 1, color: { argb: T.green } }],
  };
  ws.getRow(1).height = 22;
  ws.getRow(2).height = 14;

  ws.mergeCells(3, 1, 3, width);
  const s = ws.getCell(3, 1);
  s.value = subtitle || '';
  s.font = { name: T.font, size: 9, italic: true, color: { argb: T.inkSoft } };
  s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  s.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF4F9FA' } };
  ws.getRow(3).height = 16;
  return 4;
}

function headerRow(ws, rowIdx, ncols) {
  const r = ws.getRow(rowIdx);
  r.height = 24;
  for (let c = 1; c <= ncols; c += 1) {
    const cell = ws.getCell(rowIdx, c);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.headerBg } };
    cell.font = { name: T.font, size: 10.5, bold: true, color: { argb: T.white } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = allThin();
  }
}

function zebra(ws, firstData, lastData, ncols) {
  for (let rr = firstData; rr <= lastData; rr += 1) {
    const fill = (rr - firstData) % 2 === 0 ? T.zebraA : T.zebraB;
    for (let c = 1; c <= ncols; c += 1) {
      const cell = ws.getCell(rr, c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.font = { name: T.font, size: 10, color: { argb: T.ink } };
      cell.border = allThin();
    }
  }
}

function finishSheet(ws, headerRowIdx, generated) {
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headerRowIdx, showGridLines: false }];
  ws.pageSetup = {
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    printTitlesRow: `1:${headerRowIdx}`,
  };
  ws.headerFooter = {
    oddFooter: `&L&"Calibri"&8 Afro-Asian — renewal pack ${generated} &RPage &P of &N`,
  };
}

/** Excel tab names: ≤31 chars, no []:*?/\\, and unique within the workbook. */
function tabName(title, used) {
  const base = title.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || 'Section';
  let name = base;
  let n = 2;
  while (used.has(name)) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(name);
  return name;
}

function coverSheet(wb, pack) {
  const ws = wb.addWorksheet('Cover');
  ws.getColumn(1).width = 4;
  ws.getColumn(2).width = 34;
  ws.getColumn(3).width = 64;

  ws.mergeCells(2, 2, 4, 3);
  const t = ws.getCell(2, 2);
  t.value = {
    richText: [
      { text: 'AFRO-ASIAN INSURANCE SERVICES\n', font: { name: T.font, size: 26, bold: true, color: { argb: T.white } } },
      { text: `${pack.reference} — Renewal Pack v${pack.version}`, font: { name: T.font, size: 14, color: { argb: T.zebraA } } },
    ],
  };
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 2, wrapText: true };
  t.fill = {
    type: 'gradient',
    gradient: 'angle',
    degree: 0,
    stops: [{ position: 0, color: { argb: T.teal } }, { position: 1, color: { argb: T.green } }],
  };
  [2, 3, 4].forEach((r) => { ws.getRow(r).height = 30; });

  const req = pack.summary.required_total
    ? `${pack.summary.required_filled} of ${pack.summary.required_total} required sections filled${pack.summary.missing_required?.length ? ` — missing: ${pack.summary.missing_required.join(', ')}` : ' — ready'}`
    : null;
  const lines = [
    ['Cedant', pack.placement.cedant
      || pack.sections.find((s) => ['info_page', 'treaty_detail'].includes(s.key))?.facts?.find((f) => f.label === 'Cedant')?.value || ''],
    ['Class', pack.placement.cob || pack.placement.class || ''],
    ['Treaty type', pack.placement.treaty_type || ''],
    ['Period', `${String(pack.placement.inception || '').slice(0, 10)} → ${String(pack.placement.expiry || '').slice(0, 10)}`],
    ['Currency', pack.currency],
    ['Basis', pack.basis_label],
    ['Pack version', `v${pack.version} · ${pack.status}`],
    ['Template version', `v${pack.template_version}`],
    ['Generated', String(pack.generated_at || '').slice(0, 19).replace('T', ' ')],
    ['Sections', `${pack.summary.sections_filled} of ${pack.summary.sections_total} carry data — every section is present either way`],
    ...(req ? [['Tracker', req]] : []),
    ...(pack.screens ? [['Screens', `${pack.screens.filled} of ${pack.screens.total} screens held data when this version was created${pack.screens.missing.length ? ` — without data: ${pack.screens.missing.join(', ')}` : ' — every screen filled'}`]] : []),
  ];
  let row = 6;
  for (const [label, value] of lines) {
    const a = ws.getCell(row, 2);
    a.value = label;
    a.font = { name: T.font, bold: true, color: { argb: T.teal } };
    const b = ws.getCell(row, 3);
    b.value = value;
    b.font = { name: T.font, color: { argb: T.ink } };
    row += 1;
  }

  const contentsRow = row + 1;
  ws.getCell(contentsRow, 2).value = 'Contents';
  ws.getCell(contentsRow, 2).font = { name: T.font, size: 12, bold: true, color: { argb: T.headerBg } };
  let rr = contentsRow + 1;
  pack.sections.forEach((s, i) => {
    const a = ws.getCell(rr, 2);
    const b = ws.getCell(rr, 3);
    a.value = `${i + 1}.  ${s.title}`;
    b.value = s.status === 'filled' ? s.blurb : `Empty — ${s.note}`;
    const fill = i % 2 === 0 ? T.zebraA : T.zebraB;
    [a, b].forEach((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      c.font = { name: T.font, size: 10, color: { argb: s.status === 'filled' ? T.ink : T.inkSoft }, italic: s.status !== 'filled' };
      c.alignment = { vertical: 'middle' };
    });
    rr += 1;
  });
  ws.views = [{ showGridLines: false }];
}

function sectionSheet(wb, pack, section, used) {
  const ws = wb.addWorksheet(tabName(section.title, used));
  const widest = Math.max(3, ...section.tables.map((t) => t.columns.length));
  // Every sheet's subtitle carries the standard page header — cedant, class,
  // treaty type and the currency of the data — ahead of the section blurb.
  const subtitle = [pack.header, section.blurb].filter(Boolean).join('   —   ');
  const headerIdx = titleBar(ws, widest, `${section.title} · ${pack.reference} v${pack.version}`, subtitle);
  let row = headerIdx;

  if (section.status !== 'filled') {
    const cell = ws.getCell(row, 1);
    cell.value = `No data — ${section.note}`;
    cell.font = { name: T.font, italic: true, color: { argb: T.inkSoft } };
    ws.getColumn(1).width = 90;
    finishSheet(ws, headerIdx - 1, String(pack.generated_at || '').slice(0, 10));
    return;
  }

  if (section.facts.length) {
    ws.getCell(row, 1).value = 'Figure';
    ws.getCell(row, 2).value = 'Value';
    headerRow(ws, row, 2);
    const first = row + 1;
    section.facts.forEach((f, i) => {
      ws.getCell(first + i, 1).value = f.label;
      const cell = ws.getCell(first + i, 2);
      cell.value = cellValue(f.value, f.type);
      const fmt = numFmt(f.type);
      if (fmt) cell.numFmt = fmt;
    });
    zebra(ws, first, first + section.facts.length - 1, 2);
    row = first + section.facts.length + 1;
  }

  for (const t of section.tables) {
    const ncols = t.columns.length;
    const titleCell = ws.getCell(row, 1);
    titleCell.value = t.title;
    titleCell.font = { name: T.font, size: 11, bold: true, color: { argb: T.headerBg } };
    row += 1;

    ws.getRow(row).values = t.columns.map((c) => c.label);
    headerRow(ws, row, ncols);
    const first = row + 1;
    t.rows.forEach((r, i) => {
      t.columns.forEach((c, ci) => {
        const cell = ws.getCell(first + i, ci + 1);
        cell.value = cellValue(r[c.key], c.type);
        const fmt = numFmt(c.type);
        if (fmt) cell.numFmt = fmt;
      });
    });
    zebra(ws, first, first + t.rows.length - 1, ncols);
    row = first + t.rows.length + 1;
  }

  // Column widths from the longest cell in each column, within reason.
  const maxCols = Math.max(2, ...section.tables.map((t) => t.columns.length));
  for (let c = 1; c <= maxCols; c += 1) {
    let width = 12;
    ws.getColumn(c).eachCell({ includeEmpty: false }, (cell) => {
      const v = cell.value;
      const len = typeof v === 'object' && v?.richText
        ? 20
        : String(v ?? '').length;
      width = Math.max(width, Math.min(len + 4, 46));
    });
    ws.getColumn(c).width = width;
  }
  finishSheet(ws, headerIdx, String(pack.generated_at || '').slice(0, 10));
}

/** The checklist of screens: which held data when the version was created,
    one column per class of business. Sits right after the cover. */
function screensSheet(wb, pack) {
  const s = pack.screens;
  const ws = wb.addWorksheet('Screens');
  const ncols = s.columns.length;
  const status = `${s.filled} of ${s.total} screens held data`
    + (s.required_missing.length ? ` — required without data: ${s.required_missing.join(', ')}` : '')
    + (s.rows.some((r) => r.screen.endsWith(' *')) ? '   (* required for the quoting structure)' : '');
  const headerIdx = titleBar(ws, ncols, `Screens · ${pack.reference} v${pack.version}`, [pack.header, status].filter(Boolean).join('   —   '));
  ws.getRow(headerIdx).values = s.columns.map((c) => c.label);
  headerRow(ws, headerIdx, ncols);
  const first = headerIdx + 1;
  s.rows.forEach((r, i) => {
    s.columns.forEach((c, ci) => {
      const cell = ws.getCell(first + i, ci + 1);
      const v = r[c.key];
      cell.value = v === 'Yes' ? '✓' : v === 'No' ? '—' : v;
      if (ci >= 2) cell.alignment = { horizontal: 'center' };
    });
  });
  zebra(ws, first, first + s.rows.length - 1, ncols);
  ws.getColumn(1).width = 18;
  ws.getColumn(2).width = 30;
  for (let c = 3; c <= ncols; c += 1) ws.getColumn(c).width = Math.max(10, Math.min(s.columns[c - 1].label.length + 4, 30));
  finishSheet(ws, headerIdx, String(pack.generated_at || '').slice(0, 10));
}

/** The pack as an .xlsx buffer. */
export async function packToXlsx(pack) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Afro-Asian';
  wb.created = new Date(pack.generated_at || Date.now());
  coverSheet(wb, pack);
  if (pack.screens) screensSheet(wb, pack);
  const used = new Set(['Cover', 'Screens']);
  for (const section of pack.sections) sectionSheet(wb, pack, section, used);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
