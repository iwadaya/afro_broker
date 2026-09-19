/**
 * Minimal, dependency-free CSV parser. Handles quoted fields, escaped quotes
 * ("") and commas inside quotes. Returns an array of objects keyed by header.
 * For production-grade ingest this is where the Universe Gemini→OpenAI slip
 * pipeline would plug in; this covers clean tabular bordereaux.
 */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => { rows.push(record); record = []; };

  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushField();
      pushRecord();
    } else if (c === '\r') {
      // ignore; handled by \n
    } else {
      field += c;
    }
  }
  // trailing field/record
  if (field.length > 0 || record.length > 0) { pushField(); pushRecord(); }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])));
}

/** Coerce a string to number, tolerating thousands separators and currency. */
export function toNumber(v) {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[,\s$£€]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
