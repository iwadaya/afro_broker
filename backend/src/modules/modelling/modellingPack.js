// The standardised renewal pack of the modelling data — everything entered on
// the modelling screens, one sheet per screen per class of business, with a
// cover — and the AI analysis of the same data: a digest of every screen goes
// to the model, which returns a summary, highlights, gaps and a per-class
// read. Neither does arithmetic the screens have not already done.
import ExcelJS from 'exceljs';
import { completeJson } from '../../lib/llm.js';
import { prepareDocuments } from '../analysis/renewalPack.llm.js';

/* ── Screens, in the wizards' running order ── */
export const SCREEN_TITLES = [
  ['triangle_premium', 'Premium Triangle'],
  ['triangle_paid', 'Claims Paid Triangle'],
  ['triangle_os', 'OS Claims Triangle'],
  ['triangle_incurred', 'Incurred Triangle'],
  ['straight_stats', 'Straight Stats'],
  ['np_premiums', 'Premiums Table'],
  ['large_losses', 'Large Loss List'],
  ['loss_selection_large', 'Large Loss Selection'],
  ['np_large_ldf', 'Large Loss Dev Factors'],
  ['cat_losses', 'Cat Loss List'],
  ['loss_selection_cat', 'Cat Loss Selection'],
  ['np_cat_ldf', 'Cat Loss Dev Factors'],
  ['dev_factors_premium', 'Premium Dev Factors'],
  ['dev_factors_paid', 'Paid Claims Dev Factors'],
  ['dev_factors_os', 'OS Claims Dev Factors'],
  ['dev_factors_incurred', 'Incurred Dev Factors'],
  ['np_excess_dev', 'Excess Dev Factors'],
  ['np_historical', 'Historical Performance'],
  ['projected_summary', 'Projected Summary'],
  ['quick_summary', 'Quick Summary'],
  ['risk_profile', 'Risk Profile'],
  ['claims_profile', 'Claims Profile'],
  ['cresta', 'CRESTA Aggregates'],
  ['event_loss_tables', 'Event Loss Tables'],
];
const TITLE_OF = new Map(SCREEN_TITLES);
const ORDER_OF = new Map(SCREEN_TITLES.map(([k], i) => [k, i]));
/** Sections that are not screens (the stored AI summary itself). */
export const AI_SUMMARY_SECTION = 'ai_summary';
/** The stored cross-check of the screens against the uploaded raw data. */
export const CROSSCHECK_SECTION = 'ai_crosscheck';
const SKIP = new Set([AI_SUMMARY_SECTION, CROSSCHECK_SECTION]);

/** A class of business as a section-key suffix — the frontend's cobSlug. */
export const cobSlug = (cob) => String(cob || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const humanise = (s) => String(s || '')
  .replace(/[_-]+/g, ' ')
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/\b\w/g, (c) => c.toUpperCase())
  .trim();

/** The classes of business a placement's class string names ("Property / Motor Quota Share"). */
export function classesOf(placementClass, treatyTypes = []) {
  const s = String(placementClass || '').trim();
  if (!s) return [];
  const words = s.split(/\s+/);
  // The treaty type is the trailing words that match a known type name; strip
  // the longest match, else the last word.
  let cobPart = s;
  const names = [...treatyTypes].sort((a, b) => b.length - a.length);
  const hit = names.find((n) => s.toLowerCase().endsWith(n.toLowerCase()));
  if (hit) cobPart = s.slice(0, s.length - hit.length).trim();
  else cobPart = words.slice(0, -1).join(' ');
  return cobPart.split(' / ').map((c) => c.trim()).filter(Boolean);
}

/**
 * Group the stored sections by class of business and screen:
 *   { classes: [{ name, slug, screens: [{ key, title, data }] }], unscoped }
 * A `key:slug` section belongs to that class; a plain key belongs to the
 * first class (the section a single-class treaty wrote), or to "All classes"
 * when the placement names none.
 */
export function organiseSections(sections, cobNames = []) {
  const classes = new Map();
  const nameOfSlug = new Map(cobNames.map((c) => [cobSlug(c), c]));
  const ensure = (slug, name) => {
    if (!classes.has(slug)) classes.set(slug, { name, slug, screens: new Map() });
    return classes.get(slug);
  };
  for (const name of cobNames) ensure(cobSlug(name), name);
  const firstSlug = cobNames.length ? cobSlug(cobNames[0]) : 'all';
  for (const [section, entry] of Object.entries(sections || {})) {
    const [key, slug] = section.split(':');
    if (SKIP.has(key)) continue;
    const data = entry?.data ?? entry;
    if (data == null || (typeof data === 'object' && Object.keys(data).length === 0)) continue;
    const cls = slug
      ? ensure(slug, nameOfSlug.get(slug) || humanise(slug))
      : ensure(firstSlug, cobNames[0] || 'All classes');
    // A scoped section wins over the plain one for the first class.
    if (!slug && cls.screens.has(key)) continue;
    cls.screens.set(key, { key, title: TITLE_OF.get(key) || humanise(key), data, updated_at: entry?.updated_at || null });
  }
  const byOrder = (a, b) => (ORDER_OF.get(a.key) ?? 99) - (ORDER_OF.get(b.key) ?? 99) || a.key.localeCompare(b.key);
  return [...classes.values()].map((c) => ({ ...c, screens: [...c.screens.values()].sort(byOrder) }));
}

/* ── Rendering a screen's JSON as tables ── */

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isPrimitive = (v) => v == null || ['string', 'number', 'boolean'].includes(typeof v);
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '' && /^-?[\d,]*\.?\d+%?$/.test(v.trim())) {
    const n = Number(v.replace(/[,%]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
const cellOf = (v) => {
  if (v == null) return null;
  const n = num(v);
  if (n != null && typeof v !== 'boolean') return n;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (isPrimitive(v)) return String(v);
  return JSON.stringify(v);
};

/** A triangle's cells ({ origin_year, dev_months | dev_year, cum_value, variant? }) pivoted into grids per variant. */
const isTriangleCells = (cells) => Array.isArray(cells) && cells.length > 0
  && cells[0]?.origin_year != null && (cells[0]?.dev_months != null || cells[0]?.dev_year != null);
function triangleGrids(cells) {
  const months = cells[0]?.dev_months != null;
  const devOf = (c) => Number(months ? c.dev_months : c.dev_year);
  const variants = new Map();
  for (const c of cells) {
    const v = c.variant || 'MODIFIED';
    if (!variants.has(v)) variants.set(v, []);
    variants.get(v).push(c);
  }
  return [...variants.entries()].map(([variant, rows]) => {
    const origins = [...new Set(rows.map((c) => Number(c.origin_year)))].sort((a, b) => a - b);
    const devs = [...new Set(rows.map(devOf))].sort((a, b) => a - b);
    const grid = new Map(rows.map((c) => [`${c.origin_year}|${devOf(c)}`, num(c.cum_value ?? c.value)]));
    return {
      title: `${variant === 'ACTUAL' ? 'Actual' : 'Modified'} triangle — cumulative by origin year × development year`,
      headers: ['Origin year', ...devs.map((d) => (months ? `${d} months` : `Dev ${d}`))],
      rows: origins.map((o) => [o, ...devs.map((d) => grid.get(`${o}|${d}`) ?? null)]),
    };
  });
}

/**
 * Flatten a screen's JSON into blocks: { title, headers, rows } tables and
 * { title, facts: [[label, value]] } fact lists, recursively — arrays of
 * objects become tables, scalars become facts, nested objects sub-blocks.
 */
export function blocksOf(data, title = '') {
  const blocks = [];
  if (Array.isArray(data)) {
    if (data.length && data.every(isObj)) {
      const headers = [];
      for (const r of data) for (const k of Object.keys(r)) if (!headers.includes(k)) headers.push(k);
      blocks.push({ title, headers: headers.map(humanise), rows: data.map((r) => headers.map((h) => cellOf(r[h]))) });
    } else if (data.length) {
      blocks.push({ title, headers: ['Value'], rows: data.map((v) => [cellOf(v)]) });
    }
    return blocks;
  }
  if (!isObj(data)) {
    if (data != null) blocks.push({ title, facts: [['Value', cellOf(data)]] });
    return blocks;
  }
  if (isTriangleCells(data.cells)) {
    for (const g of triangleGrids(data.cells)) blocks.push({ ...g, title: title ? `${title} — ${g.title}` : g.title });
    const rest = { ...data };
    delete rest.cells;
    if (Object.keys(rest).length) blocks.push(...blocksOf(rest, title ? `${title} — settings` : 'Settings'));
    return blocks;
  }
  const facts = [];
  const nested = [];
  for (const [k, v] of Object.entries(data)) {
    if (isPrimitive(v)) facts.push([humanise(k), cellOf(v)]);
    else nested.push([k, v]);
  }
  if (facts.length) blocks.push({ title: title || 'Details', facts });
  for (const [k, v] of nested) blocks.push(...blocksOf(v, title ? `${title} — ${humanise(k)}` : humanise(k)));
  return blocks;
}

/* ── The workbook ── */
const T = {
  font: 'Calibri', white: 'FFFFFFFF', ink: 'FF16323B', inkSoft: 'FF5B7079',
  teal: 'FF0D5C75', green: 'FF2F8F6B', headerBg: 'FF1E7A5A', zebraA: 'FFEAF4F8', zebraB: 'FFEFF7F1', grid: 'FFD8E2E6',
};
const thin = () => ({ style: 'thin', color: { argb: T.grid } });
const allThin = () => ({ top: thin(), left: thin(), bottom: thin(), right: thin() });

function titleBar(ws, ncols, title, subtitle) {
  const width = Math.max(ncols, 4);
  ws.mergeCells(1, 1, 2, width);
  const t = ws.getCell(1, 1);
  t.value = {
    richText: [
      { text: 'AFRO-ASIAN INSURANCE SERVICES', font: { name: T.font, size: 16, bold: true, color: { argb: T.white } } },
      { text: `    ${title}`, font: { name: T.font, size: 13, color: { argb: T.zebraA } } },
    ],
  };
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  t.fill = { type: 'gradient', gradient: 'angle', degree: 0, stops: [{ position: 0, color: { argb: T.teal } }, { position: 1, color: { argb: T.green } }] };
  ws.getRow(1).height = 22;
  ws.getRow(2).height = 14;
  ws.mergeCells(3, 1, 3, width);
  const s = ws.getCell(3, 1);
  s.value = subtitle || '';
  s.font = { name: T.font, size: 9, italic: true, color: { argb: T.inkSoft } };
  s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1, wrapText: true };
  ws.getRow(3).height = 16;
  return 4;
}

function tabName(title, used) {
  const base = title.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').slice(0, 31).trim() || 'Sheet';
  let name = base;
  let n = 2;
  while (used.has(name.toLowerCase())) {
    const suffix = ` ${n}`;
    name = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  used.add(name.toLowerCase());
  return name;
}

/** Write blocks down a sheet from `row`; returns the next free row and the widest table. */
function writeBlocks(ws, blocks, startRow) {
  let row = startRow;
  let width = 2;
  for (const b of blocks) {
    if (b.title) {
      const c = ws.getCell(row, 1);
      c.value = b.title;
      c.font = { name: T.font, size: 11, bold: true, color: { argb: T.teal } };
      row += 1;
    }
    if (b.facts) {
      for (const [label, value] of b.facts) {
        ws.getCell(row, 1).value = label;
        ws.getCell(row, 1).font = { name: T.font, size: 10, bold: true, color: { argb: T.inkSoft } };
        const v = ws.getCell(row, 2);
        v.value = value;
        v.font = { name: T.font, size: 10, color: { argb: T.ink } };
        if (typeof value === 'number') v.numFmt = '#,##0.####';
        row += 1;
      }
      row += 1;
      continue;
    }
    const ncols = b.headers.length;
    width = Math.max(width, ncols);
    b.headers.forEach((h, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = h;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: T.headerBg } };
      c.font = { name: T.font, size: 10, bold: true, color: { argb: T.white } };
      c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      c.border = allThin();
    });
    row += 1;
    b.rows.forEach((r, ri) => {
      const fill = ri % 2 === 0 ? T.zebraA : T.zebraB;
      r.forEach((v, i) => {
        const c = ws.getCell(row, i + 1);
        c.value = v;
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        c.font = { name: T.font, size: 10, color: { argb: T.ink } };
        c.border = allThin();
        if (typeof v === 'number') { c.numFmt = '#,##0.####'; c.alignment = { horizontal: 'right' }; }
      });
      row += 1;
    });
    row += 1;
  }
  return { row, width };
}

function sizeColumns(ws, width) {
  for (let c = 1; c <= Math.max(width, 4); c += 1) {
    ws.getColumn(c).width = c === 1 ? 26 : 16;
  }
}

/**
 * Build the standardised modelling pack: a Cover sheet (placement, classes,
 * the screens carried, the AI summary if one has been run), then one sheet
 * per class of business per screen in the wizards' running order.
 */
export async function buildModellingWorkbook({ placement, classes, aiSummary, crosscheck = null, generatedAt = new Date() }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Afro-Asian';
  wb.created = generatedAt;
  const used = new Set();
  const stamp = generatedAt.toISOString().slice(0, 10);

  const cover = wb.addWorksheet(tabName('Cover', used));
  let row = titleBar(cover, 4, 'Renewal pack — modelling data', `Standardised pack · generated ${stamp} · a sheet per screen per class of business`);
  const facts = [
    ['Reference', placement.reference], ['Cedant', placement.cedant_name || ''], ['Class', placement.class],
    ['Currency', placement.currency], ['Period', `${String(placement.inception).slice(0, 10)} → ${String(placement.expiry).slice(0, 10)}`],
    ['Classes of business', classes.map((c) => c.name).join(', ') || '—'],
    ['Sheets', String(classes.reduce((n, c) => n + c.screens.length, 0))],
  ];
  ({ row } = writeBlocks(cover, [{ title: 'Placement', facts }], row));
  const contents = classes.flatMap((c) => c.screens.map((s) => [c.name, s.title, s.updated_at ? String(s.updated_at).slice(0, 10) : '']));
  ({ row } = writeBlocks(cover, [{ title: 'Contents', headers: ['Class of business', 'Screen', 'Last saved'], rows: contents }], row));
  if (aiSummary?.summary) {
    const blocks = [{ title: 'AI analysis', facts: [['Summary', aiSummary.summary]] }];
    if (aiSummary.highlights?.length) blocks.push({ title: 'Highlights', headers: ['Highlight'], rows: aiSummary.highlights.map((h) => [h]) });
    if (aiSummary.data_gaps?.length) blocks.push({ title: 'Data gaps', headers: ['Gap'], rows: aiSummary.data_gaps.map((h) => [h]) });
    if (aiSummary.per_class?.length) blocks.push({ title: 'By class of business', headers: ['Class', 'Read'], rows: aiSummary.per_class.map((p) => [p.class, p.summary]) });
    ({ row } = writeBlocks(cover, blocks, row));
  }
  if (crosscheck?.summary) {
    const blocks = [{ title: 'AI cross-check against the raw data', facts: [['Summary', crosscheck.summary], ['Raw data', (crosscheck.documents || []).join(', ') || '—']] }];
    if (crosscheck.discrepancies?.length) {
      blocks.push({
        title: 'Discrepancies', headers: ['Severity', 'Class', 'Screen', 'Item', 'On screen', 'In raw data', 'Note'],
        rows: crosscheck.discrepancies.map((d) => [d.severity, d.class, d.screen, d.item, d.screen_value, d.raw_value, d.note]),
      });
    }
    if (crosscheck.consistent?.length) blocks.push({ title: 'Consistent', headers: ['Check'], rows: crosscheck.consistent.map((h) => [h]) });
    if (crosscheck.unverified?.length) blocks.push({ title: 'Not verifiable', headers: ['Item'], rows: crosscheck.unverified.map((h) => [h]) });
    ({ row } = writeBlocks(cover, blocks, row));
  }
  sizeColumns(cover, 7);
  if (aiSummary?.summary || crosscheck?.summary) {
    cover.getColumn(2).width = 90;
    cover.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
  }
  cover.views = [{ showGridLines: false }];

  for (const cls of classes) {
    for (const screen of cls.screens) {
      const ws = wb.addWorksheet(tabName(`${cls.name} · ${screen.title}`, used));
      const start = titleBar(ws, 6, `${screen.title} — ${cls.name}`, `${placement.reference} · ${cls.name} · ${screen.title}${screen.updated_at ? ` · saved ${String(screen.updated_at).slice(0, 10)}` : ''}`);
      const { width } = writeBlocks(ws, blocksOf(screen.data), start);
      sizeColumns(ws, width);
      ws.views = [{ state: 'frozen', ySplit: 3, showGridLines: false }];
      ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ── The AI analysis ── */

/** A compact, bounded digest of every screen's data for the model. */
export function digestOf(classes, limit = 14000) {
  const lines = [];
  for (const cls of classes) {
    lines.push(`## Class of business: ${cls.name}`);
    if (!cls.screens.length) { lines.push('(no screen data entered)'); continue; }
    for (const s of cls.screens) {
      lines.push(`### ${s.title}`);
      for (const b of blocksOf(s.data)) {
        if (b.facts) {
          lines.push(`${b.title ? `${b.title}: ` : ''}${b.facts.map(([k, v]) => `${k}=${v ?? '—'}`).join('; ')}`);
        } else {
          lines.push(`${b.title || 'Table'} — ${b.rows.length} row(s); columns: ${b.headers.join(', ')}`);
          const totals = b.headers.map((h, i) => {
            const nums = b.rows.map((r) => r[i]).filter((v) => typeof v === 'number');
            return nums.length ? `${h} total ${nums.reduce((a, c) => a + c, 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}` : null;
          }).filter(Boolean);
          if (totals.length) lines.push(`  totals: ${totals.slice(0, 8).join('; ')}`);
          for (const r of b.rows.slice(0, 12)) lines.push(`  ${r.map((v) => (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : (v ?? '—'))).join(' | ')}`);
          if (b.rows.length > 12) lines.push(`  … ${b.rows.length - 12} more row(s)`);
        }
      }
    }
  }
  let text = lines.join('\n');
  if (text.length > limit) text = `${text.slice(0, limit)}\n… (digest truncated)`;
  return text;
}

export const MODELLING_ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'highlights', 'data_gaps', 'per_class'],
  properties: {
    summary: { type: 'string', description: 'The renewal pack in a few paragraphs: experience, exposure, what the figures say about the treaty.' },
    highlights: { type: 'array', items: { type: 'string' }, description: 'The points a reinsurer would want first.' },
    data_gaps: { type: 'array', items: { type: 'string' }, description: 'Screens or figures missing or thin.' },
    per_class: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['class', 'summary'],
        properties: { class: { type: 'string' }, summary: { type: 'string' } },
      },
    },
  },
};

export function buildAnalysisPrompt({ placement, classes }) {
  return [
    `Placement ${placement.reference} — cedant ${placement.cedant_name || 'unknown'}; class "${placement.class}"; currency ${placement.currency}; period ${String(placement.inception).slice(0, 10)} to ${String(placement.expiry).slice(0, 10)}.`,
    `Classes of business: ${classes.map((c) => c.name).join(', ') || 'not split'}.`,
    '',
    'Below is everything entered on the modelling screens (triangles, straight stats, loss lists and selections, dev factors, profiles, exposure, premiums), per class of business. Figures are as entered by the broker; do not recompute them.',
    '',
    digestOf(classes),
  ].join('\n');
}

const SYSTEM = [
  'You are a senior treaty reinsurance analyst writing the analytical summary of a renewal pack for reinsurers.',
  'Read the modelling data per class of business and describe the account: premium and claims development, loss experience (large and cat), loss ratios where the figures allow, exposure (profiles, CRESTA, event loss tables), and what stands out for the renewal.',
  'Be concrete and cite the figures you rely on. Flag thin or missing data as gaps rather than guessing. Never invent numbers.',
].join(' ');

/** Run the analysis. Returns { provider, model, data }; throws LlmUnavailableError. */
export async function analyseModelling({ placement, classes }, clients = {}) {
  const prompt = buildAnalysisPrompt({ placement, classes });
  return completeJson({
    system: SYSTEM, prompt, schema: MODELLING_ANALYSIS_SCHEMA, schemaName: 'modelling_pack_analysis', maxTokens: 6000,
  }, clients);
}

/* ── The cross-check of the screens against the uploaded raw data ── */

export const CROSSCHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'consistent', 'discrepancies', 'unverified', 'data_quality'],
  properties: {
    summary: { type: 'string', description: 'Whether the screens agree with the raw data, in a few paragraphs, with the material differences first.' },
    consistent: { type: 'array', items: { type: 'string' }, description: 'Figures on the screens that the raw data confirms, with the values.' },
    discrepancies: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['class', 'screen', 'item', 'screen_value', 'raw_value', 'severity', 'note'],
        properties: {
          class: { type: 'string', description: 'Class of business, or "all".' },
          screen: { type: 'string', description: 'The modelling screen (Premium Triangle, Large Loss List, …).' },
          item: { type: 'string', description: 'The figure or row that differs (origin year, loss, total…).' },
          screen_value: { type: 'string' },
          raw_value: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          note: { type: 'string', description: 'What the difference is and the likely cause.' },
        },
      },
    },
    unverified: { type: 'array', items: { type: 'string' }, description: 'Screens or figures the raw data does not cover.' },
    data_quality: { type: 'array', items: { type: 'string' }, description: 'Unreadable uploads, gaps, ambiguous columns.' },
  },
};

const CROSSCHECK_SYSTEM = [
  'You are a senior treaty reinsurance analyst auditing a renewal pack before it goes to reinsurers.',
  'You are given (a) everything the broker entered on the modelling screens, per class of business, and (b) the cedant\'s raw data files the screens were meant to be built from — loss runs, premium listings, bordereaux, profiles.',
  'Cross-check the screens against the raw data: recompute totals, triangles, loss lists and profiles from the raw data where it allows, and compare them to what is on the screens.',
  'Report every material difference with both values, the class and the screen; confirm what agrees; say what the raw data does not cover rather than guessing.',
  'Never invent numbers. Be precise about units and years; treat small rounding differences as low severity.',
].join(' ');

export function buildCrosscheckPrompt({ placement, classes, documents, inline, unreadable }) {
  const lines = [
    `Placement ${placement.reference} — cedant ${placement.cedant_name || 'unknown'}; class "${placement.class}"; currency ${placement.currency}; period ${String(placement.inception).slice(0, 10)} to ${String(placement.expiry).slice(0, 10)}.`,
    `Classes of business: ${classes.map((c) => c.name).join(', ') || 'not split'}.`,
    `Raw data uploaded: ${documents.map((d) => `"${d.filename}"${d.note ? ` (${d.note})` : ''}`).join(', ')}.`,
  ];
  if (unreadable.length) {
    lines.push('These uploads are not machine-readable and could not be included — flag them under data_quality: '
      + unreadable.map((d) => `"${d.filename}" (${d.mime_type})`).join(', '));
  }
  lines.push('=== WHAT IS ON THE MODELLING SCREENS ===', digestOf(classes));
  lines.push('=== THE RAW DATA ===', ...inline);
  lines.push('Cross-check the screens against the raw data and report the summary, what is consistent, every discrepancy, what could not be verified, and data quality issues.');
  return lines.join('\n\n');
}

/**
 * Cross-check the screens against the raw data files. Returns
 * { provider, model, data }; throws LlmUnavailableError, or a 422 when no
 * upload is readable.
 */
export async function crosscheckModelling({ placement, classes, documents }, clients = {}) {
  const { attachments, inline, unreadable } = prepareDocuments(documents.map((d) => ({ ...d, role: 'raw data' })));
  if (attachments.length === 0 && inline.length === 0) {
    throw Object.assign(
      new Error('None of the uploaded raw data files are machine-readable. Upload Excel, CSV, PDF or image files.'),
      { status: 422, code: 'no_readable_documents' },
    );
  }
  const result = await completeJson({
    system: CROSSCHECK_SYSTEM,
    prompt: buildCrosscheckPrompt({ placement, classes, documents, inline, unreadable }),
    schema: CROSSCHECK_SCHEMA, schemaName: 'modelling_crosscheck', maxTokens: 8000, effort: 'high', attachments,
  }, clients);
  for (const d of unreadable) {
    result.data.data_quality.push(`"${d.filename}" (${d.mime_type}) could not be read by the AI — upload an Excel, CSV or PDF export.`);
  }
  return result;
}
