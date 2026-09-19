/*
 * A renewal pack workbook, opened sheet by sheet.
 *
 * The Negotiation tab shows the pack the markets are quoting on as the Excel
 * it went to them as — not a re-rendering of the snapshot, but the stored
 * file itself, read back and laid out sheet by sheet. Every cell comes
 * through as Excel would show it (its number format applied, a date as a
 * date), with the merged ranges that make the title bars, so what is on the
 * screen is what the underwriter opened.
 */

import * as XLSX from 'xlsx';

/** Rows past this stay in the file: a bordereau sheet can run to thousands. */
export const MAX_ROWS = 2000;

/** One cell as the screen shows it: its text, and what kind of value it holds. */
function cellOf(cell) {
  // 'z' is a stub Excel writes for a styled-but-empty cell.
  if (!cell || cell.t === 'z') return null;
  const text = cell.w != null ? cell.w : XLSX.utils.format_cell(cell);
  if (text == null || text === '') return null;
  return { w: String(text), t: cell.t };
}

function sheetOf(ws, name) {
  const ref = ws['!ref'];
  if (!ref) return { name, rows: [], merges: [], row_count: 0, col_count: 0, truncated: false };
  const range = XLSX.utils.decode_range(ref);
  // Excel shows the sheet from A1 whatever the first filled cell, and merges
  // are addressed from there too — so the grid starts at the origin.
  const rowCount = range.e.r + 1;
  const colCount = range.e.c + 1;
  const last = Math.min(range.e.r, MAX_ROWS - 1);
  const rows = [];
  for (let r = 0; r <= last; r += 1) {
    const row = [];
    for (let c = 0; c <= range.e.c; c += 1) {
      row.push(cellOf(ws[XLSX.utils.encode_cell({ r, c })]));
    }
    rows.push(row);
  }
  const merges = (ws['!merges'] || [])
    .filter((m) => m.s.r <= last)
    .map((m) => ({
      r: m.s.r,
      c: m.s.c,
      rows: Math.min(m.e.r, last) - m.s.r + 1,
      cols: m.e.c - m.s.c + 1,
    }));
  return { name, rows, merges, row_count: rowCount, col_count: colCount, truncated: rowCount > rows.length };
}

/**
 * Every sheet of a workbook, in the order Excel shows them.
 *
 * @param {Buffer} buffer  the .xlsx bytes
 * @returns {{ name, rows, merges, row_count, col_count, truncated }[]}
 *   `rows` is row-major: each cell `{ w, t }` — the text as formatted and its
 *   type ('s' text, 'n' number, 'd' date, 'b' boolean) — or null when empty.
 *   `merges` are the merged ranges as `{ r, c, rows, cols }` from the top-left.
 */
export function readWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  return wb.SheetNames.map((name) => sheetOf(wb.Sheets[name], name));
}
