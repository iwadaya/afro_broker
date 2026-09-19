// The Universe treaty-detail arithmetic and rules, ported from the modelling
// tool's proportional treaty detail (propTreatyHelpers) and its NP treaty
// detail: number coercion, the treaty mode a treaty type implies, the
// retention / cession pair, the derived amounts and capacity, the renewal
// and UW-year date rules, the contract description, and the required-field
// rules per screen. Pure functions — no React, no I/O — so the two contract
// pages and their tests share one copy.

/* ────────────────────────────── numbers ────────────────────────────── */

/** Null-safe numeric coercion: strips grouping commas and a trailing '%';
    '' / null / non-finite → null. */
export function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Universe clampPct: null → 0, then clamp to 0..100. */
export function clampPct(v) {
  const n = toNumber(v);
  return n == null ? 0 : Math.max(0, Math.min(100, n));
}

const round0 = (n) => Math.round(n);

/* ─────────────────────────── treaty mode ──────────────────────────── */

/**
 * Universe treatyModeFromType: "quota" + "surplus" → both; "quota" → quota;
 * "surplus" or "fac oblig" → surplus; anything else reads as quota. The
 * codes Afro-Asian's older records carried (QS, Surplus, QS + Surplus) read
 * the same way.
 */
export function propMode(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (n === 'qs + surplus') return 'both';
  if (n === 'qs') return 'quota';
  if (n === 'surplus') return 'surplus';
  if (n.includes('quota') && n.includes('surplus')) return 'both';
  if (n.includes('quota')) return 'quota';
  if (n.includes('surplus') || n.includes('fac oblig')) return 'surplus';
  return 'quota';
}
export const treatyModeFromType = propMode;
export const isQsMode = (mode) => mode === 'quota' || mode === 'both';
export const isSurplusMode = (mode) => mode === 'surplus' || mode === 'both';

/* ─────────────────────── retention / cession ──────────────────────── */

/** Editing one side sets the other to 100 − clamp(value), kept to 6 decimals. */
export function cessionFromRetention(retentionPct) {
  return +(100 - clampPct(retentionPct)).toFixed(6);
}
export function retentionFromCession(cessionPct) {
  return +(100 - clampPct(cessionPct)).toFixed(6);
}

/** retAmt = round(QS × clamp(ret%) / 100) when QS > 0, otherwise blank. */
export function retentionAmt(qsLimit, retentionPct) {
  const qs = toNumber(qsLimit) || 0;
  return qs > 0 ? round0((qs * clampPct(retentionPct)) / 100) : null;
}
export function cessionAmt(qsLimit, cessionPct) {
  const qs = toNumber(qsLimit) || 0;
  return qs > 0 ? round0((qs * clampPct(cessionPct)) / 100) : null;
}

/**
 * Total treaty capacity: quota → QS; both → QS + MR × N; surplus → MR + MR × N.
 * A zero result is blank in Universe, so null here.
 */
export function totalCapacity({ mode, qsLimit, surplusMaxRetention, numLines }) {
  const QS = toNumber(qsLimit) || 0;
  const MR = toNumber(surplusMaxRetention) || 0;
  const N = toNumber(numLines) || 0;
  const cap = mode === 'quota' ? QS : mode === 'both' ? QS + MR * N : MR + MR * N;
  return cap ? round0(cap) : null;
}

/** Surplus capacity on its own: MR × N (the surplus half's limit). */
export function surplusCapacity({ surplusMaxRetention, numLines }) {
  const MR = toNumber(surplusMaxRetention) || 0;
  const N = toNumber(numLines) || 0;
  const cap = MR * N;
  return cap ? round0(cap) : null;
}

/* ───────────────────────────── dates ──────────────────────────────── */

/** Universe addMonthsClamped: the day is clamped to the target month, so
    31 January + 1 month is 28/29 February rather than 3 March. */
export function addMonthsClamped(dateStr, months) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const targetMonth = m - 1 + Number(months || 0);
  const targetYear = y + Math.floor(targetMonth / 12);
  const normMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normMonth + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(normMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Treaty Renewal Date default: inception + 12 months. */
export function defaultRenewalDate(inceptionDate) {
  return addMonthsClamped(inceptionDate, 12);
}

/** UW Year: the year of a YYYY-MM-DD inception, read without timezone conversion. */
export function uwYearFromInception(dateStr) {
  const s = String(dateStr ?? '').trim();
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : (s.includes('T') ? s.split('T')[0] : '');
  const y = iso ? Number(iso.slice(0, 4)) : NaN;
  return Number.isFinite(y) && y > 0 ? y : null;
}

/** Universe expYears: the last 41 calendar years, ascending. */
const THIS_YEAR = new Date().getFullYear();
export const EXPERIENCE_YEARS = Array.from({ length: 41 }, (_, i) => THIS_YEAR - 40 + i);

/* ───────────────────── contract description ───────────────────────── */

/**
 * Universe contractDescription: [UW year, cedant, treaty type, "(COB, …)",
 * country code] joined by spaces, empty parts skipped — the same builder for
 * both business types.
 */
export function buildContractDescription({ uwYear, cedantName, treatyTypeName, classNames, countryCode } = {}) {
  const names = (classNames || []).filter(Boolean);
  const parts = [uwYear || '', cedantName || '', treatyTypeName || '', names.length ? `(${names.join(', ')})` : '', countryCode || '']
    .filter(Boolean);
  return parts.join(' ') || '';
}

/* ──────────────────────── required fields ─────────────────────────── */

const has = (v) => v != null && String(v).trim() !== '';

/**
 * Universe getMissingRequiredFields for the proportional treaty detail —
 * "active fields only": the QS fields when the treaty has a quota share
 * side, the surplus fields when it has a surplus side; a sliding scale
 * needs its four bounds, the provisional commission and at least two
 * complete rows of the slide; the loss-participation scalars only when the
 * toggle is YES. Event Limit, AAL, brokerage, taxes, loss cap, management
 * expenses, profit commission, LCF and the alternative contract id are
 * never required.
 */
export function propMissingRequiredFields(s, { tMode, commMode }) {
  const missing = [];
  if (!has(s.countryId)) missing.push('Country');
  if (!has(s.cedantId)) missing.push('Cedant Name');
  if (!has(s.treatyTypeId)) missing.push('Treaty Type');
  if (!(s.classIds || []).length) missing.push('Line of Business');
  if (!has(s.brokerId)) missing.push('Broker');
  if (!has(s.currencyId)) missing.push('Currency');
  if (!has(s.inceptionDate)) missing.push('Treaty Inception Date');
  if (!has(s.experienceStartYear)) missing.push('Experience Start Year');
  const qs = isQsMode(tMode);
  const surplus = isSurplusMode(tMode);
  if (qs) {
    if (!has(s.qsLimit)) missing.push('QS 100% Limit');
    if (!has(s.retentionPct)) missing.push('Retention %');
    if (!has(s.quotaShareEpi)) missing.push('Quota Share EPI');
  }
  if (surplus) {
    if (!has(s.surplusMaxRetention)) missing.push('Surplus Max Retention');
    if (!has(s.numLines)) missing.push('Number of Lines');
    if (!has(s.surplusEpi)) missing.push('Surplus EPI');
  }
  if (commMode === 'sliding') {
    if (!has(s.slidingMinLossRatio)) missing.push('Sliding Min Loss Ratio %');
    if (!has(s.slidingMaxLossRatio)) missing.push('Sliding Max Loss Ratio %');
    if (!has(s.slidingMinCommission)) missing.push('Sliding Min Commission %');
    if (!has(s.slidingMaxCommission)) missing.push('Sliding Max Commission %');
    if (!has(s.provisionalCommissionPct)) missing.push('Provisional Commission %');
    const validRows = (s.slidingTable || []).filter((r) => has(r.lossRatioPct) && has(r.commissionPct));
    if (validRows.length < 2) missing.push('Sliding Scale table (need ≥2 complete rows)');
  } else {
    if (qs && !has(s.fixedCommissionQSPct)) missing.push('Fixed QS Commission %');
    if (surplus && !has(s.fixedCommissionSurplusPct)) missing.push('Fixed Surplus Commission %');
  }
  if (s.lossPartEnabled === true) {
    if (!has(s.minLossRatioPct)) missing.push('LP Min Loss Ratio %');
    if (!has(s.maxLossRatioPct)) missing.push('LP Max Loss Ratio %');
    if (!has(s.reinsurerSharePct)) missing.push('LP Reinsurer Share %');
  }
  return missing;
}

/**
 * The NP Contract Details pane's required fields: Country, Cedant, Treaty
 * Type, Classes of Business, Broker, Currency, Treaty Inception Date and
 * Experience Start Year.
 */
export function npMissingRequiredFields(s) {
  const missing = [];
  if (!has(s.countryId)) missing.push('Country');
  if (!has(s.cedantId)) missing.push('Cedant Name');
  if (!has(s.treatyTypeId)) missing.push('Treaty Type');
  if (!(s.classIds || []).length) missing.push('Classes of Business');
  if (!has(s.brokerId)) missing.push('Broker');
  if (!has(s.currencyId)) missing.push('Currency');
  if (!has(s.inceptionDate)) missing.push('Treaty Inception Date');
  if (!has(s.experienceStartYear)) missing.push('Experience Start Year');
  return missing;
}
