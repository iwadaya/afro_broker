/**
 * Experience shaping — turns raw bordereau rows into the exhibits a reinsurer
 * expects in a renewal pack: premiums and claims by underwriting year, the
 * large-loss table, cat losses and the risk profile.
 *
 * Column names are matched with the same heuristic as ingest: lowercase the
 * header and strip non-letters, then compare against known aliases. Rows that
 * carry no recognisable underwriting year fall under year `null` (shown as
 * "unallocated") rather than being dropped, so totals always reconcile.
 */

import { toNumber } from '../lib/csv.js';

export const DEFAULT_LARGE_LOSS_THRESHOLD = 250000;
export const LARGE_LOSS_TABLE_LIMIT = 20;

const round2 = (n) => Math.round(n * 100) / 100;

const norm = (key) => key.toLowerCase().replace(/[^a-z]/g, '');

/** Find the first matching column of `row` among alias names; return raw value. */
function pickRaw(row, names) {
  for (const key of Object.keys(row)) {
    if (names.includes(norm(key))) return row[key];
  }
  return undefined;
}

function pickNumber(row, names) {
  return toNumber(pickRaw(row, names));
}

function pickText(row, names) {
  const v = pickRaw(row, names);
  return v == null ? '' : String(v).trim();
}

const YEAR_COLUMNS = ['uwyear', 'underwritingyear', 'uy', 'uwy', 'yoa', 'yearofaccount', 'treatyyear', 'year'];

/** Underwriting year of a row, or null when absent/unparseable. */
export function pickYear(row) {
  const raw = pickText(row, YEAR_COLUMNS);
  if (!raw) return null;
  const m = raw.match(/(19|20)\d{2}/);
  return m ? Number(m[0]) : null;
}

// premiumceded first: on canonical (template-mapped) rows the premium ceded to
// the treaty is the bordereau's premium, not the 100% gross.
const PREMIUM_COLUMNS = ['premiumceded', 'premium', 'grosspremium', 'gwp', 'subjectpremium'];
const PAID_COLUMNS = ['paid', 'paidloss', 'paidamount'];
const OUTSTANDING_COLUMNS = ['outstanding', 'reserve', 'osr', 'casereserve'];
const INCURRED_COLUMNS = ['incurred', 'incurredloss'];

function claimAmounts(row) {
  const paid = pickNumber(row, PAID_COLUMNS);
  const outstanding = pickNumber(row, OUTSTANDING_COLUMNS);
  const incurred = pickNumber(row, INCURRED_COLUMNS) || paid + outstanding;
  return { paid, outstanding, incurred };
}

const CAT_FLAG_COLUMNS = ['cat', 'iscat', 'catflag'];
const CAT_CODE_COLUMNS = ['catcode', 'catevent', 'eventcode', 'catref'];

/** A claims row counts as cat when a cat flag is truthy or a cat code is set. */
export function isCatRow(row) {
  const flag = pickText(row, CAT_FLAG_COLUMNS).toLowerCase();
  if (['y', 'yes', 'true', '1', 'cat'].includes(flag)) return true;
  return pickText(row, CAT_CODE_COLUMNS) !== '';
}

function sortYears(map) {
  // Numeric years ascending; the unallocated bucket (null) last.
  return [...map.entries()]
    .sort(([a], [b]) => (a == null) - (b == null) || a - b)
    .map(([year, v]) => ({ year, ...v }));
}

/** Summarise parsed rows into the bordereau `summary` JSONB by type. */
export function summariseBordereau(type, rows, { largeLossThreshold = DEFAULT_LARGE_LOSS_THRESHOLD } = {}) {
  if (type === 'premium') {
    const byYear = new Map();
    let premium = 0;
    for (const row of rows) {
      const amount = pickNumber(row, PREMIUM_COLUMNS);
      premium += amount;
      const year = pickYear(row);
      const bucket = byYear.get(year) || { premium: 0 };
      bucket.premium = round2(bucket.premium + amount);
      byYear.set(year, bucket);
    }
    return { row_count: rows.length, premium: round2(premium), by_year: sortYears(byYear) };
  }

  if (type === 'risk_profile') {
    const bands = rows.map((row) => ({
      band: pickText(row, ['band', 'suminsuredband', 'siband', 'range', 'bracket']) || 'unbanded',
      risks: pickNumber(row, ['risks', 'numberofrisks', 'policies', 'policycount', 'count', 'norisks']),
      tsi: round2(pickNumber(row, ['tsi', 'totalsuminsured', 'suminsured', 'totalsi', 'aggregate'])),
      premium: round2(pickNumber(row, PREMIUM_COLUMNS)),
    }));
    return {
      row_count: rows.length,
      bands,
      risks: bands.reduce((a, b) => a + b.risks, 0),
      tsi: round2(bands.reduce((a, b) => a + b.tsi, 0)),
      premium: round2(bands.reduce((a, b) => a + b.premium, 0)),
    };
  }

  // claims
  const byYear = new Map();
  const largeLosses = [];
  const totals = { paid: 0, outstanding: 0, incurred: 0 };
  const cat = { count: 0, incurred: 0 };

  for (const row of rows) {
    const { paid, outstanding, incurred } = claimAmounts(row);
    const year = pickYear(row);
    totals.paid += paid;
    totals.outstanding += outstanding;
    totals.incurred += incurred;

    const bucket = byYear.get(year) || { paid: 0, outstanding: 0, incurred: 0, count: 0 };
    bucket.paid = round2(bucket.paid + paid);
    bucket.outstanding = round2(bucket.outstanding + outstanding);
    bucket.incurred = round2(bucket.incurred + incurred);
    bucket.count += 1;
    byYear.set(year, bucket);

    const catRow = isCatRow(row);
    if (catRow) {
      cat.count += 1;
      cat.incurred = round2(cat.incurred + incurred);
    }
    if (incurred >= largeLossThreshold) {
      largeLosses.push({
        year,
        claim_ref: pickText(row, ['claimref', 'claimno', 'claimnumber', 'claimid', 'ref']),
        insured: pickText(row, ['insured', 'insuredname', 'risk', 'riskname']),
        loss_date: pickText(row, ['lossdate', 'dateofloss', 'dol', 'date']),
        cause: pickText(row, ['peril', 'cause', 'causeofloss', 'event', 'description']),
        cat: catRow,
        paid: round2(paid),
        outstanding: round2(outstanding),
        incurred: round2(incurred),
      });
    }
  }
  largeLosses.sort((a, b) => b.incurred - a.incurred);

  return {
    row_count: rows.length,
    paid: round2(totals.paid),
    outstanding: round2(totals.outstanding),
    incurred: round2(totals.incurred),
    by_year: sortYears(byYear),
    large_losses: largeLosses,
    large_loss_threshold: largeLossThreshold,
    cat,
  };
}

function mergeYearBuckets(target, entries, fields) {
  for (const entry of entries || []) {
    const bucket = target.get(entry.year) ||
      Object.fromEntries([...fields, 'count'].map((f) => [f, 0]));
    for (const f of fields) bucket[f] = round2(bucket[f] + (entry[f] || 0));
    bucket.count += entry.count || 0;
    target.set(entry.year, bucket);
  }
}

/**
 * Aggregate every bordereau on a placement into the pack-ready experience view:
 * an underwriting-year table (premium vs claims with loss ratios), the combined
 * large-loss table, cat totals and the risk profile.
 * @param {{type: string, summary: object}[]} bordereaux
 */
export function aggregateExperience(bordereaux) {
  const premiumYears = new Map();
  const claimYears = new Map();
  const largeLosses = [];
  const cat = { count: 0, incurred: 0 };
  let premium = 0; let paid = 0; let outstanding = 0; let incurred = 0;
  let riskProfile = null;

  for (const b of bordereaux) {
    const s = b.summary || {};
    if (b.type === 'premium') {
      premium += s.premium || 0;
      mergeYearBuckets(premiumYears, s.by_year, ['premium']);
    } else if (b.type === 'claims') {
      paid += s.paid || 0;
      outstanding += s.outstanding || 0;
      incurred += s.incurred || 0;
      mergeYearBuckets(claimYears, s.by_year, ['paid', 'outstanding', 'incurred']);
      largeLosses.push(...(s.large_losses || []));
      cat.count += s.cat?.count || 0;
      cat.incurred = round2(cat.incurred + (s.cat?.incurred || 0));
    } else if (b.type === 'risk_profile') {
      // Latest risk profile wins (callers pass bordereaux in created order).
      riskProfile = { bands: s.bands || [], risks: s.risks || 0, tsi: s.tsi || 0, premium: s.premium || 0 };
    }
  }

  const years = [...new Set([...premiumYears.keys(), ...claimYears.keys()])]
    .sort((a, b) => (a == null) - (b == null) || a - b)
    .map((year) => {
      const p = premiumYears.get(year)?.premium || 0;
      const c = claimYears.get(year) || { paid: 0, outstanding: 0, incurred: 0, count: 0 };
      return {
        year,
        premium: round2(p),
        paid: c.paid,
        outstanding: c.outstanding,
        incurred: c.incurred,
        claim_count: c.count,
        loss_ratio_pct: p > 0 ? round2((c.incurred / p) * 100) : null,
      };
    });

  largeLosses.sort((a, b) => b.incurred - a.incurred);

  return {
    premium: round2(premium),
    paid: round2(paid),
    outstanding: round2(outstanding),
    incurred: round2(incurred),
    loss_ratio_pct: premium > 0 ? round2((incurred / premium) * 100) : null,
    by_year: years,
    large_losses: largeLosses.slice(0, LARGE_LOSS_TABLE_LIMIT),
    large_loss_count: largeLosses.length,
    cat,
    risk_profile: riskProfile,
  };
}
