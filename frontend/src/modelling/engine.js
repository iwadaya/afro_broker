/* Modelling engine — the pure actuarial logic behind the placement modelling
   screens, ported from the Universe modelling tool's shared-logic modules
   (chainLadder, bornhuetterFerguson, straightProjections, lossCategoryAmounts,
   propTreatyEngine, the Quick Summary financial engine). No React, no fetch —
   every function takes plain data and returns plain data, so the screens stay
   thin and the arithmetic is testable from node. Formulas are kept verbatim:
   these numbers price treaties, so a "cleanup" here is a defect. */

/* ── Number parsing & formatting (Universe utils/format) ─────────────────── */

/** Flexible numeric parse: currency symbols, thousands separators, European
    decimals and accounting negatives all read; null when unparseable. */
export function parseFlexibleNumber(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/−/g, '-');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[%$£€¥]|\b(SAR|USD|EUR|GBP|AED|ZAR|CHF|JPY|AUD|CAD|SGD)\b/gi, '');
  s = s.replace(/[\s ]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  s = s.replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  if (Number.isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}

/** parseFlexibleNumber with a 0 default — the canonical `toN`. */
export function cn(v) {
  const n = parseFlexibleNumber(v);
  return n == null ? 0 : n;
}

/** Clean a typed value to a plain number string ('' stays ''). */
export function sanitizeNumber(v) {
  const n = parseFlexibleNumber(v);
  return n == null ? '' : String(n);
}

/** Comma-grouped display; '' for empty. */
export function fmtC(v) {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : parseFlexibleNumber(v);
  if (n == null || !Number.isFinite(n)) return String(v);
  return n.toLocaleString('en-US', { maximumFractionDigits: n % 1 === 0 ? 0 : 2 });
}

/** Comma-grouped display; '—' for empty (table cells). */
export function fmtOrEm(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export const fmt4 = (n) => (n == null || !Number.isFinite(Number(n)) ? '' : Number(n).toFixed(4));
/** Ratio → percent string, e.g. 0.652 → "65.2%". */
export const fPct = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${(Number(n) * 100).toFixed(d)}%`);
/** Percent points → string, e.g. 65.2 → "65.2%". */
export const fPts = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toFixed(d)}%`);

/** Normalise a date-ish string to yyyy-mm-dd for <input type=date>. */
export function dateInputValue(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.includes('T')) return s.split('T')[0];
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, a, b, y] = dmy;
    const day = parseInt(a, 10);
    const mon = parseInt(b, 10);
    if (day > 12 || mon <= 12) return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return `${y}-${String(day).padStart(2, '0')}-${String(mon).padStart(2, '0')}`;
  }
  const ymd = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return s;
}

/* ── Chain Ladder (Universe logic/chainLadder) ───────────────────────────── */

/** {origin_year, dev_months, cum_value}[] → { matrix, years, devPeriods }. */
export function buildMatrixFromCells(cells, startYear, numYears) {
  if (!Array.isArray(cells) || !cells.length) return null;
  if (startYear == null || numYears == null) {
    const yearsSet = new Set();
    const devsSet = new Set();
    cells.forEach((c) => { yearsSet.add(Number(c.origin_year)); devsSet.add(Number(c.dev_months)); });
    const years = Array.from(yearsSet).sort((a, b) => a - b);
    const devPeriods = Array.from(devsSet).sort((a, b) => a - b);
    const matrix = years.map(() => new Array(devPeriods.length).fill(null));
    cells.forEach((c) => {
      const r = years.indexOf(Number(c.origin_year));
      const col = devPeriods.indexOf(Number(c.dev_months));
      if (r >= 0 && col >= 0) matrix[r][col] = c.cum_value == null ? null : Number(c.cum_value) || 0;
    });
    return { matrix, years, devPeriods };
  }
  const years = Array.from({ length: numYears }, (_, i) => startYear + i);
  const devPeriods = Array.from({ length: numYears }, (_, i) => (i + 1) * 12);
  const matrix = years.map(() => new Array(devPeriods.length).fill(null));
  cells.forEach((c) => {
    const r = years.indexOf(c.origin_year);
    const col = devPeriods.indexOf(c.dev_months);
    if (r >= 0 && col >= 0) matrix[r][col] = c.cum_value == null ? null : Number(c.cum_value) || 0;
  });
  return { matrix, years, devPeriods };
}

export function calculateAgeToAgeFactors(matrix) {
  return matrix.map((row) => {
    const factors = [];
    for (let c = 0; c < row.length - 1; c++) {
      const cur = row[c];
      const next = row[c + 1];
      factors.push(cur != null && next != null && cur !== 0 ? next / cur : null);
    }
    return factors;
  });
}

/**
 * Age-to-age LDF pattern by weighted / simple / last3 / last5 averaging, with
 * per-cell exclusions ("r:c" keys) and thin-column warnings (<3 origin years).
 */
export function calculatePattern(matrix, factors, method = 'weighted', { excluded } = {}) {
  const width = matrix[0]?.length || 0;
  const pattern = [];
  const warnings = [];
  const isExcluded = excluded ? (r, c) => excluded.has(`${r}:${c}`) : () => false;
  for (let c = 0; c < width - 1; c++) {
    const validRows = [];
    for (let r = 0; r < matrix.length; r++) if (factors[r]?.[c] !== null && !isExcluded(r, c)) validRows.push(r);
    let rowsToUse = validRows;
    if (method === 'last3') rowsToUse = validRows.slice(-3);
    if (method === 'last5') rowsToUse = validRows.slice(-5);
    let ldf = 1.0;
    if (method === 'weighted') {
      let sumPrev = 0;
      let sumCur = 0;
      for (const r of rowsToUse) { sumPrev += matrix[r][c] || 0; sumCur += matrix[r][c + 1] || 0; }
      ldf = sumPrev !== 0 ? sumCur / sumPrev : 1.0;
    } else {
      let sum = 0;
      let cnt = 0;
      for (const r of rowsToUse) { sum += factors[r][c]; cnt++; }
      ldf = cnt > 0 ? sum / cnt : 1.0;
    }
    pattern.push(ldf);
    if (rowsToUse.length < 3) {
      warnings.push({
        column: c,
        devPeriod: `${(c + 1) * 12}→${(c + 2) * 12}`,
        contributingRows: rowsToUse.length,
        message: `LDF for ${(c + 1) * 12}→${(c + 2) * 12} months derived from only ${rowsToUse.length} origin year(s); minimum recommended is 3.`,
      });
    }
  }
  return { pattern, warnings };
}

/** LDFs + tail → CDFs (cdf[i] = pattern[i] × cdf[i+1]; cdf[N] = tail). */
export function calculateCdfs(pattern, tailFactor = 1.0) {
  const cdfs = new Array(pattern.length + 1).fill(1.0);
  cdfs[pattern.length] = tailFactor;
  for (let i = pattern.length - 1; i >= 0; i--) cdfs[i] = pattern[i] * cdfs[i + 1];
  return cdfs;
}

/** Project each origin year on the matrix to ultimate via the CDF at its
    latest diagonal. */
export function projectToUltimate(pattern, tailFactor, dataObj) {
  const cdfs = calculateCdfs(pattern, tailFactor);
  if (!dataObj || !Array.isArray(dataObj.matrix)) return { cdfs, projections: [] };
  const { matrix, years } = dataObj;
  const projections = (years || []).map((year, r) => {
    let latestVal = 0;
    let latestCol = -1;
    for (let c = (matrix[r]?.length || 0) - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latestVal = matrix[r][c]; latestCol = c; break; }
    }
    if (latestCol === -1) return { year, latest: 0, cdf: 1, ultimate: 0, ibnr: 0 };
    const cdf = cdfs[latestCol] || 1.0;
    const ultimate = latestVal * cdf;
    return { year, latest: latestVal, cdf, ultimate, ibnr: ultimate - latestVal };
  });
  return { cdfs, projections };
}

/** Exponential decay fit of a CDF curve (the "parametrized" factor set). */
export function fitExponentialCdfs(cdfs) {
  const xs = [];
  const ys = [];
  for (let i = 0; i < (cdfs?.length || 0); i++) {
    const v = Number(cdfs[i]);
    if (!Number.isFinite(v) || v <= 1.0000001) continue;
    xs.push(i + 1);
    ys.push(Math.log(v - 1));
  }
  if (xs.length < 2) return (cdfs || []).slice();
  const n = xs.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; sumXX += xs[i] * xs[i]; sumXY += xs[i] * ys[i]; }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return (cdfs || []).slice();
  const b = (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;
  const out = [];
  for (let i = 0; i < (cdfs?.length || 0); i++) out.push(1 + Math.exp(a + b * (i + 1)));
  if (cdfs?.length && Number(cdfs[cdfs.length - 1]) === 1) out[out.length - 1] = 1;
  return out;
}

export function deriveLdfsFromCdfs(cdfs) {
  const out = [];
  for (let i = 0; i < (cdfs?.length || 0) - 1; i++) {
    const a = Number(cdfs[i]);
    const b = Number(cdfs[i + 1]);
    out.push(Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);
  }
  return out;
}

/** The full chain-ladder bundle for one triangle: matrix → factors → averaged
    pattern → CDFs → exponential fit → per-year projections. */
export function buildCalcs(cells, { startYear, numDevYears, avgMethod, years, excluded }) {
  const d = buildMatrixFromCells(cells || [], startYear, numDevYears);
  if (!d) return null;
  const { matrix } = d;
  const factors = calculateAgeToAgeFactors(matrix);
  const { pattern, warnings: patternWarnings } = calculatePattern(matrix, factors, avgMethod, { excluded });
  const cdfs = calculateCdfs(pattern, 1.0);
  const paramCdfs = fitExponentialCdfs(cdfs);
  const paramLdfs = deriveLdfsFromCdfs(paramCdfs);
  const clProjections = years.map((yr, r) => {
    let latestVal = 0;
    let latestCol = -1;
    for (let c = matrix[r].length - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latestVal = matrix[r][c]; latestCol = c; break; }
    }
    const cdf = latestCol >= 0 ? cdfs[latestCol] || 1.0 : 1.0;
    return { year: yr, latest: latestVal, cdf, ultimate: latestVal * cdf, ibnr: latestVal * cdf - latestVal };
  });
  return { matrix, factors, pattern, patternWarnings, cdfs, paramLdfs, paramCdfs, clProjections };
}

/* ── Bornhuetter-Ferguson (Universe logic/bornhuetterFerguson) ───────────── */

export function calculateBF(clProjections, premiums, ielrs) {
  if (!clProjections || !Array.isArray(clProjections)) return [];
  return clProjections.map((row, i) => {
    const premium = premiums?.[i] || 0;
    const ielr = Array.isArray(ielrs) ? (ielrs[i] ?? 0) : (Number(ielrs) || 0);
    const aPrioriUltimate = premium * ielr;
    const cdf = row.cdf || 1.0;
    const percentReported = 1 / cdf;
    const percentUnreported = 1 - percentReported;
    const expectedIbnr = aPrioriUltimate * percentUnreported;
    const bfUltimate = row.latest + expectedIbnr;
    return {
      year: row.year, method: 'BF', latest: row.latest, cdf,
      premium, ielr, aPrioriUltimate, percentUnreported, expectedIbnr,
      ultimate: bfUltimate, lossRatio: premium > 0 ? bfUltimate / premium : 0,
    };
  });
}

/** Premium-flavoured BF: EPI × % achieved as the a priori volume. */
export function calculateBFPremium(clProjections, epis, percentAchieveds) {
  if (!clProjections || !Array.isArray(clProjections)) return [];
  return clProjections.map((row, i) => {
    const epi = epis?.[i] || 0;
    const pa = Array.isArray(percentAchieveds) ? (percentAchieveds[i] ?? 1) : (Number(percentAchieveds) || 0);
    const aPrioriUltimate = epi * pa;
    const cdf = row.cdf || 1.0;
    const percentUnachieved = 1 - 1 / cdf;
    const bfUnearned = aPrioriUltimate * percentUnachieved;
    const bfUltimate = row.latest + bfUnearned;
    return {
      year: row.year, method: 'BF', latest: row.latest, cdf,
      epi, percentAchieved: pa, aPrioriUltimate, percentUnachieved, bfUnearned,
      ultimate: bfUltimate, achievedRatio: epi > 0 ? bfUltimate / epi : 0,
    };
  });
}

/* ── Straight stats projection (Universe logic/straightProjections) ──────── */

/** Benchmark per-class LDF curves — placeholders until calibrated, and the UI
    must say so (IS_BENCHMARK_LDF). */
export const IS_BENCHMARK_LDF = true;

export const LDF_CONFIG = {
  PROPERTY_CAT: { label: 'Property — CAT', ldfs: [1.300, 1.080, 1.020, 1.005, 1.001], source: 'Internal benchmark — placeholder', reviewed: null },
  PROPERTY_NONCAT: { label: 'Property — non-CAT', ldfs: [1.250, 1.080, 1.025, 1.010, 1.005], source: 'Internal benchmark — placeholder', reviewed: null },
  ENGINEERING: { label: 'Engineering', ldfs: [1.400, 1.150, 1.060, 1.030, 1.015, 1.008, 1.003], source: 'Internal benchmark — placeholder', reviewed: null },
  LIABILITY: { label: 'Liability / Casualty', ldfs: [2.100, 1.450, 1.220, 1.130, 1.075, 1.045, 1.025, 1.010], source: 'Internal benchmark — placeholder', reviewed: null },
  MARINE: { label: 'Marine', ldfs: [1.180, 1.060, 1.020, 1.008, 1.003], source: 'Internal benchmark — placeholder', reviewed: null },
};
export const DEFAULT_LDF_KEY = 'PROPERTY_NONCAT';

const PREM_LDFS = [1.050, 1.015, 1.005, 1.000, 1.000, 1.000, 1.000, 1.000];

function buildCDFs(ldfs) {
  const n = ldfs.length;
  const cdf = new Array(n + 1).fill(1.0);
  for (let i = n - 1; i >= 0; i--) cdf[i] = cdf[i + 1] * ldfs[i];
  return cdf;
}
const PREM_CDFS = buildCDFs(PREM_LDFS);
const LDF_CDFS = Object.fromEntries(Object.entries(LDF_CONFIG).map(([key, cfg]) => [key, buildCDFs(cfg.ldfs)]));

function getCDF(cdfs, devIdx) {
  if (devIdx < 0) return 1.0;
  if (devIdx >= cdfs.length) return cdfs[cdfs.length - 1];
  return cdfs[devIdx];
}

/** [{year, premium, paid, os}] → per-year actual/ultimate premium and loss
    using the class's benchmark curve (newest year = least developed). */
export function projectStraightStats(stats, classKey = DEFAULT_LDF_KEY) {
  if (!stats || !stats.length) return [];
  const lossCDFs = LDF_CDFS[classKey] || LDF_CDFS[DEFAULT_LDF_KEY];
  const sorted = [...stats].sort((a, b) => a.year - b.year);
  const n = sorted.length;
  return sorted.map((row, i) => {
    const devIdx = n - 1 - i;
    const lossCDF = getCDF(lossCDFs, devIdx);
    const premCDF = getCDF(PREM_CDFS, devIdx);
    const prem = parseFloat(row.premium) || 0;
    const paid = parseFloat(row.paid) || 0;
    const os = parseFloat(row.os) || 0;
    const incurred = paid + os;
    return {
      year: Number(row.year),
      actPrem: prem,
      actLoss: incurred,
      ultPrem: prem * premCDF,
      ultLoss: incurred * lossCDF,
      devFactor: lossCDF,
      premDevFactor: premCDF,
    };
  });
}

/** LDF_CONFIG shaped for display: dev-year labels + CDFs per class. */
export const DEV_FACTOR_CURVES = Object.fromEntries(
  Object.entries(LDF_CONFIG).map(([key, cfg]) => [key, {
    label: cfg.label,
    source: cfg.source,
    reviewed: cfg.reviewed,
    ldfs: cfg.ldfs.map((ldf, i) => ({
      devYear: i === cfg.ldfs.length - 1 ? `${(i + 1) * 12}→Ult` : `${(i + 1) * 12}→${(i + 2) * 12}`,
      ldf,
    })),
    cdfs: LDF_CDFS[key],
  }]),
);

/* ── Loss components (Universe logic/lossCategoryAmounts) ────────────────── */

/** Sum raw (non-inflated) incurred of selected loss rows by UW year. */
export function sumLossesByYear(losses) {
  const map = new Map();
  for (const l of losses || []) {
    if (l.is_selected === false) continue;
    const yr = Number(l.uw_year);
    if (!Number.isFinite(yr)) continue;
    const inc = cn(l.incurred) || cn(l.paid) + cn(l.os);
    map.set(yr, (map.get(yr) || 0) + inc);
  }
  return map;
}

/** The projected-summary loss model: incurred is ALWAYS attritional + large +
    cat; large and cat pass straight through unprojected. */
export function deriveLossComponents({ premium = 0, incurredTotal = 0, large = 0, cat = 0 }) {
  const largeAmt = Math.max(0, large);
  const catAmt = Math.max(0, cat);
  const attritional = Math.max(0, incurredTotal - largeAmt - catAmt);
  const incurred = attritional + largeAmt + catAmt;
  const lr = (n) => (premium > 0 ? n / premium : 0);
  return {
    premium, attritional, large: largeAmt, cat: catAmt, incurred,
    attrLR: lr(attritional), largeLR: lr(largeAmt), catLR: lr(catAmt), incurredLR: lr(incurred),
  };
}

/* ── Proportional treaty financial engine (Universe propTreatyEngine +
      quick-summary-engine) ───────────────────────────────────────────────── */

/** Cap claims at a % of premium: explicit loss_cap_pct, else AAL-derived. */
export function applyLossCap(claims, prem, t) {
  if (prem <= 0) return claims;
  let capPct = cn(t.loss_cap_pct);
  if (!(capPct > 0)) {
    const aal = cn(t.aal);
    if (aal > 0) capPct = (aal / prem) * 100;
  }
  if (capPct > 0) return Math.min(claims, (prem * capPct) / 100);
  return claims;
}

function commPctFromTable(lr, table) {
  const pts = (table || [])
    .map((r) => ({ lr: cn(r.loss_ratio_pct ?? r.lossRatioPct), c: cn(r.commission_pct ?? r.commissionPct) }))
    .filter((p) => Number.isFinite(p.lr) && Number.isFinite(p.c))
    .sort((a, b) => a.lr - b.lr);
  if (pts.length < 2) return null;
  if (lr <= pts[0].lr) return pts[0].c;
  if (lr >= pts[pts.length - 1].lr) return pts[pts.length - 1].c;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (lr >= a.lr && lr <= b.lr) {
      const rng = b.lr - a.lr;
      if (!rng) return a.c;
      return a.c + ((lr - a.lr) / rng) * (b.c - a.c);
    }
  }
  return pts[pts.length - 1].c;
}

/** Commission: fixed % or sliding scale (table with interpolation, else
    min/max corridor) on the capped loss ratio. */
export function calcComm(prem, claims, t) {
  if (!prem || prem <= 0) return 0;
  const cappedClaims = applyLossCap(claims, prem, t);
  if ((t.mode || 'FIXED').toUpperCase() === 'FIXED') {
    return prem * (cn(t.fixed_commission_pct) / 100);
  }
  const lr = (cappedClaims / prem) * 100;
  const tablePct = commPctFromTable(lr, t.sliding_table);
  if (tablePct != null) return prem * (tablePct / 100);
  const minLR = cn(t.sliding_min_loss_ratio);
  const maxLR = cn(t.sliding_max_loss_ratio) || 100;
  const minC = cn(t.sliding_min_commission);
  const maxC = cn(t.sliding_max_commission);
  if (lr <= minLR) return prem * (maxC / 100);
  if (lr >= maxLR) return prem * (minC / 100);
  const rng = maxLR - minLR;
  if (!rng) return prem * (minC / 100);
  return prem * ((maxC - ((lr - minLR) / rng) * (maxC - minC)) / 100);
}

/** Stateful profit-commission calculator with FIFO loss carry-forward.
    Call in chronological year order; one closure per stream. */
export function makePCCalc(t) {
  const pct = cn(t.profit_commission_pct) / 100;
  const mgmtPct = cn(t.mgmt_expenses_pct) / 100;
  const lcfYears = cn(t.lcf_years);
  const extinction = !!t.lcf_extinction;
  const lcfActive = lcfYears > 0;
  const deficits = [];
  return function pcForYear(year, prem, claims, comm) {
    if (!prem || prem <= 0 || pct <= 0) return 0;
    const cappedClaims = applyLossCap(claims, prem, t);
    const mgmt = prem * mgmtPct;
    const yearProfit = prem - cappedClaims - comm - mgmt;
    if (!lcfActive) return yearProfit > 0 ? yearProfit * pct : 0;
    if (extinction) {
      while (deficits.length && (year - deficits[0].year) > lcfYears) deficits.shift();
    }
    if (yearProfit <= 0) {
      if (yearProfit < 0) deficits.push({ year, amount: -yearProfit });
      return 0;
    }
    let remaining = yearProfit;
    while (deficits.length && remaining > 0) {
      const d = deficits[0];
      if (d.amount <= remaining) { remaining -= d.amount; deficits.shift(); } else { d.amount -= remaining; remaining = 0; }
    }
    return remaining > 0 ? remaining * pct : 0;
  };
}

/** Loss-participation credit: stepped corridors, else the single corridor. */
export function calcLPC(prem, claims, t) {
  if (!t.lp_enabled || !prem || prem <= 0) return 0;
  const cappedClaims = applyLossCap(claims, prem, t);
  const lr = cappedClaims / prem;
  const slides = (t.lp_slides || [])
    .map((r) => ({
      minLr: cn(r.min_lr ?? r.minLr) / 100,
      maxLr: (cn(r.max_lr ?? r.maxLr) / 100) || 1,
      share: cn(r.share) / 100,
    }))
    .filter((r) => r.share > 0 && r.maxLr > r.minLr);
  if (slides.length > 1) {
    let credit = 0;
    for (const c of slides) {
      const top = Math.min(lr, c.maxLr);
      const bandLoss = Math.max(0, top - c.minLr);
      credit += bandLoss * prem * c.share;
    }
    return credit;
  }
  const sharePct = cn(t.lp_reinsurer_share_pct);
  if (sharePct <= 0) return 0;
  const minLR = cn(t.lp_min_loss_ratio_pct) / 100;
  const maxLR = cn(t.lp_max_loss_ratio_pct) / 100 || 1;
  if (lr <= minLR) return 0;
  const effectiveLR = Math.min(lr, maxLR);
  const participatingLoss = (effectiveLR - minLR) * prem;
  return participatingLoss * (sharePct / 100);
}

/**
 * Result = Premium − Claims(capped) − Commission − Brokerage − Taxes
 *          − ProfitComm + LPC, projected and actual streams side by side.
 * standardRows: [{year, ultPrem, ultLoss, actPrem, actLoss}].
 */
export function runFinancialEngine(standardRows, terms) {
  let cumResult = 0;
  let actCumResult = 0;
  let cumPremProj = 0;
  let cumPremAct = 0;
  const pcProj = makePCCalc(terms);
  const pcAct = makePCCalc(terms);
  const ordered = [...standardRows].sort((a, b) => Number(a.year) - Number(b.year));
  const rows = ordered.map((row) => {
    const yr = Number(row.year);
    const cappedUltLoss = applyLossCap(row.ultLoss, row.ultPrem, terms);
    const comm = calcComm(row.ultPrem, row.ultLoss, terms);
    const brok = row.ultPrem * (cn(terms.brokerage_pct) / 100);
    const taxes = row.ultPrem * (cn(terms.taxes_pct) / 100);
    const pc = pcProj(yr, row.ultPrem, row.ultLoss, comm);
    const lpc = calcLPC(row.ultPrem, row.ultLoss, terms);
    const result = row.ultPrem - cappedUltLoss - comm - brok - taxes - pc + lpc;
    cumResult += result;
    cumPremProj += row.ultPrem;

    const cappedActLoss = applyLossCap(row.actLoss, row.actPrem, terms);
    const actComm = calcComm(row.actPrem, row.actLoss, terms);
    const actBrok = row.actPrem * (cn(terms.brokerage_pct) / 100);
    const actTaxes = row.actPrem * (cn(terms.taxes_pct) / 100);
    const actPC = pcAct(yr, row.actPrem, row.actLoss, actComm);
    const actLPC = calcLPC(row.actPrem, row.actLoss, terms);
    const actResult = row.actPrem - cappedActLoss - actComm - actBrok - actTaxes - actPC + actLPC;
    actCumResult += actResult;
    cumPremAct += row.actPrem;

    return {
      year: row.year,
      premium: row.ultPrem, ultClaims: cappedUltLoss, comm, profitComm: pc, brokerage: brok, taxes, lpc,
      result, cumResult, cumResultPct: cumPremProj > 0 ? (cumResult / cumPremProj) * 100 : 0,
      actPremium: row.actPrem, actClaims: cappedActLoss, actComm, actPC, actBrokerage: actBrok, actTaxes, actLPC,
      actResult, actCumResult, actCumResultPct: cumPremAct > 0 ? (actCumResult / cumPremAct) * 100 : 0,
    };
  });
  const sum = (k) => rows.reduce((a, b) => a + (b[k] || 0), 0);
  const totals = {
    premium: sum('premium'), ultClaims: sum('ultClaims'), comm: sum('comm'), profitComm: sum('profitComm'),
    brokerage: sum('brokerage'), taxes: sum('taxes'), lpc: sum('lpc'), result: sum('result'),
    cumResult, cumResultPct: cumPremProj > 0 ? (cumResult / cumPremProj) * 100 : 0,
    actPremium: sum('actPremium'), actClaims: sum('actClaims'), actComm: sum('actComm'), actPC: sum('actPC'),
    actBrokerage: sum('actBrokerage'), actTaxes: sum('actTaxes'), actLPC: sum('actLPC'), actResult: sum('actResult'),
    actCumResult, actCumResultPct: cumPremAct > 0 ? (actCumResult / cumPremAct) * 100 : 0,
  };
  return { rows, totals };
}

/** Loss-ratio distribution stats over the actual stream. */
export function calcStats(rows) {
  const lrs = rows.filter((r) => r.actPremium > 0).map((r) => (r.actClaims / r.actPremium) * 100);
  if (!lrs.length) return null;
  const n = lrs.length;
  const mean = lrs.reduce((a, b) => a + b, 0) / n;
  const variance = lrs.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / n;
  const stdDev = Math.sqrt(variance);
  const sorted = [...lrs].sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const m3 = lrs.reduce((a, b) => a + Math.pow(b - mean, 3), 0) / n;
  const skewness = stdDev > 0 ? m3 / Math.pow(stdDev, 3) : 0;
  const m4 = lrs.reduce((a, b) => a + Math.pow(b - mean, 4), 0) / n;
  const kurtosis = variance > 0 ? m4 / (variance * variance) - 3 : 0;
  const sortedDesc = [...lrs].sort((a, b) => b - a);
  const var95 = sortedDesc[Math.floor(n * 0.05)] || sortedDesc[0];
  const var99 = sortedDesc[Math.floor(n * 0.01)] || sortedDesc[0];
  const cv = mean > 0 ? (stdDev / mean) * 100 : 0;
  const iqr = n >= 4 ? sorted[Math.floor(n * 0.75)] - sorted[Math.floor(n * 0.25)] : 0;
  return { mean, median, min: Math.min(...lrs), max: Math.max(...lrs), stdDev, skewness, kurtosis, var95, var99, cv, iqr, n };
}

/* ── Treaty terms from the placement (Universe buildTreatyTerms, adapted) ── */

/**
 * The engine's terms bag from the placement's proportional structure terms
 * plus the Quick Summary's own terms section. The Structure tab now carries
 * the modelling tool's full treaty detail — commission mode with the sliding
 * table, LCF, loss participation corridors, taxes and the loss cap — so the
 * structure seeds every term and the Quick Summary section only overrides.
 */
export function buildTreatyTerms(prop = {}, extra = {}) {
  // A meaningful override: present and not the empty string.
  const pick = (a, b) => (a !== undefined && a !== null && a !== '' ? a : b);
  const propSlides = (prop.lpSlides || []).filter((r) => r.minLr || r.maxLr || r.share);
  return {
    mode: pick(extra.mode, prop.commissionMode === 'sliding' ? 'SLIDING' : 'FIXED'),
    fixed_commission_pct: cn(extra.fixed_commission_pct) || cn(prop.commissionPct),
    sliding_min_loss_ratio: pick(extra.sliding_min_loss_ratio, prop.slidingMinLossRatio),
    sliding_max_loss_ratio: pick(extra.sliding_max_loss_ratio, prop.slidingMaxLossRatio),
    sliding_min_commission: pick(extra.sliding_min_commission, prop.slidingMinCommission),
    sliding_max_commission: pick(extra.sliding_max_commission, prop.slidingMaxCommission),
    sliding_table: (extra.sliding_table || []).length ? extra.sliding_table : (prop.slidingTable || []),
    mgmt_expenses_pct: pick(extra.mgmt_expenses_pct, prop.mgmtExpensesPct),
    profit_commission_pct: pick(extra.profit_commission_pct, prop.profitCommissionPct),
    lcf_years: pick(extra.lcf_years, prop.lcfYears === 'extinction' ? 0 : cn(prop.lcfYears) || 0),
    lcf_extinction: extra.lcf_extinction ?? prop.lcfYears === 'extinction',
    brokerage_pct: pick(extra.brokerage_pct, prop.brokeragePct) ?? 0,
    taxes_pct: pick(extra.taxes_pct, prop.taxesPct) ?? 0,
    loss_cap_pct: pick(extra.loss_cap_pct, prop.lossCapPct) ?? 0,
    strip_large_cat: extra.strip_large_cat !== false,
    aal: pick(extra.aal, prop.aal) ?? 0,
    lp_enabled: extra.lp_enabled
      ?? (prop.lossPartEnabled !== undefined ? prop.lossPartEnabled !== false : cn(prop.lpvPct) > 0),
    lp_min_loss_ratio_pct: pick(extra.lp_min_loss_ratio_pct, prop.minLossRatioPct) ?? 0,
    lp_max_loss_ratio_pct: pick(extra.lp_max_loss_ratio_pct, prop.maxLossRatioPct) ?? 0,
    lp_reinsurer_share_pct: pick(extra.lp_reinsurer_share_pct, pick(prop.reinsurerSharePct, prop.lpvPct)) ?? 0,
    lp_slides: (extra.lp_slides || []).length ? extra.lp_slides : propSlides,
  };
}

/** Total EPI from the structure's terms — the QS + Surplus split when
    present, else the legacy single EPI field. */
export function propEpiOf(prop = {}) {
  return (cn(prop.quotaShareEpi) + cn(prop.surplusEpi)) || cn(prop.epi);
}
