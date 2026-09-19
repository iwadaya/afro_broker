import * as XLSX from 'xlsx';
import { parseCsv } from './csv.js';
import { ValidationError } from './errors.js';

const MAX_ROWS = 5000;

const isoDate = (d) => d.toISOString().slice(0, 10);

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return isoDate(v);
  return String(v).trim();
};

/** Wrap header + row arrays into the common table shape, dropping blank
    rows/columns and capping runaway sheets. */
function toTable(name, headerRow, rowArrays) {
  const keep = headerRow.map((h, i) => cellText(h) !== '' || rowArrays.some((r) => cellText(r[i]) !== ''));
  const headers = headerRow.map((h, i) => cellText(h) || `Column ${i + 1}`).filter((_, i) => keep[i]);
  const rows = rowArrays
    .map((r) => headerRow.map((_, i) => cellText(r[i])).filter((_, i) => keep[i]))
    .filter((r) => r.some((v) => v !== ''))
    .slice(0, MAX_ROWS)
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
  return { name, headers, rows, row_count: rows.length };
}

/** Sheets often carry a title/blank banner above the real header — take the
    first row where most cells are filled and none look numeric. */
function findHeaderRow(rowArrays) {
  for (let i = 0; i < Math.min(rowArrays.length, 10); i += 1) {
    const cells = rowArrays[i].map(cellText).filter((v) => v !== '');
    if (cells.length >= 2 && cells.every((v) => Number.isNaN(Number(v.replace(/[,\s]/g, ''))))) return i;
  }
  return 0;
}

export function parseXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map((name) => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: true });
    if (grid.length === 0) return null;
    const h = findHeaderRow(grid);
    return toTable(name, grid[h], grid.slice(h + 1));
  }).filter((t) => t && t.headers.length > 0);
}

export function parseCsvTable(text, name = 'CSV') {
  const rows = parseCsv(text).slice(0, MAX_ROWS);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  return [{ name, headers, rows, row_count: rows.length }];
}

/** PDF bordereaux: pdf-parse v2 reconstructs tables from page geometry; when
    a page has no detectable table we fall back to splitting text lines on
    2+ space runs so at least a rough grid reaches the preview. */
export async function parsePdf(buffer) {
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getTable();
    const tables = [];
    for (const page of result.pages || []) {
      for (const grid of page.tables || []) {
        if (!Array.isArray(grid) || grid.length < 2) continue;
        const h = findHeaderRow(grid);
        tables.push(toTable(`Page ${page.num} table ${tables.length + 1}`, grid[h], grid.slice(h + 1)));
      }
    }
    if (tables.length > 0) return tables.filter((t) => t.headers.length > 0);

    const text = await parser.getText();
    const lines = (text.text || '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() !== '');
    const grid = lines.map((l) => l.split(/\s{2,}/));
    const width = Math.max(0, ...grid.map((r) => r.length));
    if (width < 2 || grid.length < 2) throw new ValidationError('No tabular data found in PDF');
    const h = findHeaderRow(grid);
    return [toTable('PDF text', grid[h], grid.slice(h + 1))];
  } finally {
    await parser.destroy();
  }
}

/**
 * Plain text out of an uploaded document — for prose, not tables. Slips arrive
 * as PDF exports or as text pasted out of Word; a .docx is a zip we have no
 * reader for, so it is refused with the way round it.
 */
export async function extractDocumentText(filename, base64) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const buffer = Buffer.from(base64, 'base64');
  if (ext === 'pdf') {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy();
    }
  }
  if (ext === 'txt' || ext === 'md' || ext === 'text') return buffer.toString('utf8');
  if (ext === 'doc' || ext === 'docx') {
    throw new ValidationError(
      'Word documents cannot be read directly — save the slip as PDF, or paste its text',
    );
  }
  throw new ValidationError(`Unsupported file type .${ext} — use pdf or txt, or paste the text`);
}

/** Parse an uploaded bordereau file into tables based on its extension. */
export async function parseUpload(filename, base64) {
  const buffer = Buffer.from(base64, 'base64');
  const ext = (filename || '').toLowerCase().split('.').pop();
  if (ext === 'xlsx' || ext === 'xls' || ext === 'xlsm') return parseXlsx(buffer);
  if (ext === 'pdf') return parsePdf(buffer);
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    const text = buffer.toString('utf8');
    return parseCsvTable(ext === 'tsv' ? text.replace(/\t/g, ',') : text, filename);
  }
  throw new ValidationError(`Unsupported file type .${ext} — use xlsx, csv or pdf`);
}
