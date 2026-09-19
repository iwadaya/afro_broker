// shared/broking/calcs.js — the AABI broking calculation library.
//
// Pure functions, no I/O, no React, no DOM: imported by the client screens
// (live derived values) AND by the server (every derived column is recomputed
// here before it is stored — client-sent derived values are never trusted).
//
// Every formula is ported from Universe (iwadaya/Saudi_re); the source function
// is named above each port. Where Universe and the design-system preview differ
// the Universe code wins and the difference is noted in a comment. The
// cross-check suite (calcs.crosscheck.test.js) feeds the same inputs into the
// verbatim Universe copies under client/src and into these functions.

/* ────────────────────────────── numbers ────────────────────────────── */

/**
 * Null-safe numeric coercion, the shape both Universe helpers share
 * (client utils/format.js numOrNull + server helpers.js numOrNull): strips
 * grouping commas and a trailing '%', '' / null / non-finite → null.
 */
export function toNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Universe propTreatyHelpers.clampPct: null → 0, then clamp to 0..100. */
export function clampPct(v) {
  const n = toNumber(v);
  return n == null ? 0 : Math.max(0, Math.min(100, n));
}

/** Round half away from zero the way Math.round does for the positive money amounts used here. */
const round0 = (n) => Math.round(n);

/**
 * Universe NpStructureHelpers.toNum: structure values are whole currency amounts,
 * so any fractional part is TRUNCATED (not rounded) — 1,000,000.9 → 1,000,000.
 * Used by every NP layer function below so the numbers match Universe exactly.
 */
export function wholeAmount(v) {
  const n = toNumber(v);
  return n == null ? 0 : Math.trunc(n);
}

/* ─────────────────────────── treaty mode ──────────────────────────── */

/**
 * Universe propTreatyHelpers.treatyModeFromType — verbatim logic.
 * "quota" + "surplus" → both; "quota" → quota; "surplus" or "fac oblig" → surplus; else quota.
 */
export function treatyModeFromType(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.includes('quota') && n.includes('surplus')) return 'both';
  if (n.includes('quota')) return 'quota';
  if (n.includes('surplus') || n.includes('fac oblig')) return 'surplus';
  return 'quota';
}
export const isQsMode = (mode) => mode === 'quota' || mode === 'both';
export const isSurplusMode = (mode) => mode === 'surplus' || mode === 'both';

/* ─────────────────────── retention / cession ──────────────────────── */

/**
 * Universe PropTreatyDetail handleRetPctChange / handleCesPctChange: editing one
 * side sets the other to 100 − clamp(value), kept to 6 decimals.
 * NOTE the design-system PropTreatyCapture preview rounds to 2 decimals; Universe
 * (6 decimals) wins.
 */
export function cessionFromRetention(retentionPct) {
  return +(100 - clampPct(retentionPct)).toFixed(6);
}
export function retentionFromCession(cessionPct) {
  return +(100 - clampPct(cessionPct)).toFixed(6);
}

/**
 * Universe PropTreatyDetail auto-calc: retAmt = round(QS × clamp(ret%) / 100)
 * when QS > 0, otherwise blank (null here).
 */
export function retentionAmt(qsLimit, retentionPct) {
  const qs = toNumber(qsLimit) || 0;
  return qs > 0 ? round0((qs * clampPct(retentionPct)) / 100) : null;
}
export function cessionAmt(qsLimit, cessionPct) {
  const qs = toNumber(qsLimit) || 0;
  return qs > 0 ? round0((qs * clampPct(cessionPct)) / 100) : null;
}

/**
 * Universe PropTreatyDetail auto-calc total capacity:
 *   quota:   QS
 *   both:    QS + MR × N
 *   surplus: MR + MR × N
 * A zero result is blank in Universe (capStr = cap ? … : ''), so null here.
 */
export function totalCapacity({ mode, qsLimit, surplusMaxRetention, numLines }) {
  const QS = toNumber(qsLimit) || 0;
  const MR = toNumber(surplusMaxRetention) || 0;
  const N = toNumber(numLines) || 0;
  const cap = mode === 'quota' ? QS : mode === 'both' ? QS + MR * N : MR + MR * N;
  return cap ? round0(cap) : null;
}

/* ───────────────────────────── dates ──────────────────────────────── */

/** Universe utils/format.js addMonthsClamped — verbatim (day clamped to the target month). */
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

/** Treaty Renewal Date default: inception + 12 months (Universe: addMonths(inception, 12)). */
export function defaultRenewalDate(inceptionDate) {
  return addMonthsClamped(inceptionDate, 12);
}

/** Universe utils/format.js yearFromDateInput on a YYYY-MM-DD string (no timezone conversion). */
export function uwYearFromInception(dateStr) {
  const s = String(dateStr ?? '').trim();
  const iso = /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : (s.includes('T') ? s.split('T')[0] : '');
  const y = iso ? Number(iso.slice(0, 4)) : NaN;
  return Number.isFinite(y) && y > 0 ? y : null;
}

/* ───────────────────── contract description ───────────────────────── */

/**
 * Universe PropTreatyDetail / NpTreatyDetail contractDescription:
 * [UW year, cedant, treaty type, "(COB, …)", country code] joined by spaces,
 * empty parts skipped. Same builder for both business types.
 */
export function buildContractDescription({ uwYear, cedantName, treatyTypeName, classNames, countryCode } = {}) {
  const names = (classNames || []).filter(Boolean);
  const parts = [uwYear || '', cedantName || '', treatyTypeName || '', names.length ? `(${names.join(', ')})` : '', countryCode || ''].filter(Boolean);
  return parts.join(' ') || '';
}

/* ─────────────────────────── NP: peril mode ────────────────────────── */

/**
 * Universe utils/npTreatyType.getNpTreatyTypeMode on a treaty-type NAME:
 * "Risk XL" → RISK, "CAT XL" → CAT, everything else (Risk & CAT XL, Stop Loss,
 * Aggregate XL) → BOTH.
 */
export function perilModeFromTreatyType(name) {
  const n = String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (n === 'RISK XL') return 'RISK';
  if (n === 'CAT XL') return 'CAT';
  return 'BOTH';
}
export const isStopLossType = (name) => String(name || '').trim().toUpperCase().replace(/\s+/g, ' ') === 'STOP LOSS';
export const isAggregateXlType = (name) => String(name || '').trim().toUpperCase().replace(/\s+/g, ' ') === 'AGGREGATE XL';

/**
 * Universe structureReducer.applyTreatyModeCovers: RISK forces risk on / cat off,
 * CAT forces cat on / risk off, BOTH keeps the layer's own choice (default both on).
 */
export function applyPerilMode(mode, { riskCover, catCover } = {}) {
  if (mode === 'RISK') return { riskCover: true, catCover: false };
  if (mode === 'CAT') return { riskCover: false, catCover: true };
  return { riskCover: riskCover !== undefined ? !!riskCover : true, catCover: catCover !== undefined ? !!catCover : true };
}

/** peril_scope column ↔ the two checkboxes (Universe useNpStructureState save / hydrateStructureResponse). */
export function perilScopeFromCovers({ riskCover, catCover }) {
  return riskCover && catCover ? 'BOTH' : catCover ? 'CAT' : 'RISK';
}
export function coversFromPerilScope(scope) {
  return { riskCover: scope === 'RISK' || scope === 'BOTH', catCover: scope === 'CAT' || scope === 'BOTH' };
}

/* ─────────────────────────── NP: layer maths ───────────────────────── */

/**
 * Universe structureReducer.recomputeDeductibles: layer 1 = programme deductible
 * (a blank / zero programme deductible keeps the layer's loaded attachment);
 * layer n = attachment(n−1) + limit(n−1), read from the UPDATED previous layer.
 * Returns the attachment per layer as numbers (null when nothing is known).
 */
export function cascadeDeductibles(layers, programmeDeductible) {
  const base = toNumber(programmeDeductible);
  const out = [];
  for (let i = 0; i < layers.length; i++) {
    const own = toNumber(layers[i]?.attachment ?? layers[i]?.deductible);
    if (i === 0) {
      out.push(base != null && base > 0 ? Math.trunc(base) : own);
    } else {
      const prevDed = wholeAmount(out[i - 1]);
      const prevLim = wholeAmount(layers[i - 1]?.limit);
      const next = prevDed + prevLim;
      out.push(next > 0 ? next : own);
    }
  }
  return out;
}

/**
 * Universe NpStructureHelpers.rateToFloat — verbatim: a rate string like "3%" → 3;
 * non-positive → 0. NOTE: parseFloat stops at the first comma ("1,000" → 1), so a
 * rate never accepts thousands separators; kept as Universe has it.
 */
export function rateToFloat(v) {
  const n = parseFloat(String(v ?? '').replace(/%/g, ''));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Universe NpStructureHelpers.RateInput onBlur: 6 significant figures. */
export function normaliseRate(v) {
  const n = parseFloat(String(v ?? '').replace(/%/g, '').replace(/,/g, ''));
  return Number.isFinite(n) ? parseFloat(n.toPrecision(6)) : null;
}

/**
 * Universe structureReducer.recomputeFinancials:
 *   earnedPremium = round(EGNPI × rate / 100)  when EGNPI > 0 and rate > 0
 *   rol           = EP / limit                 when limit > 0 and EP > 0
 *   mdpPct        = MDP / EP                   when EP > 0 and MDP > 0
 * Universe stores blanks as ''; here they are null. Fractions (rol, mdpPct) are
 * returned unformatted (Universe formats them with fmtPctMaybe for display).
 */
export function layerFinancials({ egnpi, rate, limit, mdp } = {}) {
  const e = wholeAmount(egnpi);
  const r = rateToFloat(rate);
  const earnedPremium = e > 0 && r > 0 ? round0((e * r) / 100) : null;
  const lim = wholeAmount(limit);
  const m = wholeAmount(mdp);
  const ep = earnedPremium || 0;
  const rol = lim > 0 && ep > 0 ? ep / lim : null;
  const mdpPct = ep > 0 && m > 0 ? m / ep : null;
  return { earnedPremium, mdpPct, rol };
}

/**
 * Full NP recalc (Universe fullRecalc = recomputeDeductibles + recomputeFinancials):
 * returns a new array with attachment, earnedPremium, mdpPct and rol set.
 */
export function computeLayers(layers, programmeDeductible) {
  const attachments = cascadeDeductibles(layers, programmeDeductible);
  return layers.map((l, i) => ({ ...l, attachment: attachments[i], ...layerFinancials(l) }));
}

/**
 * Universe LayerTableCard totals row:
 *   limit, aggregate limit, earned premium, MDP = sums; deductible = layer 1;
 *   EGNPI = max; rate = Σ rate; MDP% = ΣMDP / ΣEP;
 *   ROL = Σ(rate/100 × EGNPI) / Σlimit, falling back to ΣEP / Σlimit when EP was
 *   entered directly; reinstatements = max, or 'Unlimited' if any layer is.
 * Numbers in, numbers out (null when Universe shows a blank).
 */
export function layerTotals(layers) {
  const num = wholeAmount;
  const eps = layers.map((l) => (l.earnedPremium != null ? num(l.earnedPremium) : (layerFinancials(l).earnedPremium || 0)));
  const totLimit = layers.reduce((s, l) => s + num(l.limit), 0);
  const firstDed = layers.length ? num(layers[0].attachment ?? layers[0].deductible) : 0;
  const totAgg = layers.reduce((s, l) => s + num(l.aggregateLimit ?? l.annualAggLimit), 0);
  const totEgnpi = Math.max(0, ...layers.map((l) => num(l.egnpi)));
  const totRate = layers.reduce((s, l) => s + rateToFloat(l.rate), 0);
  const totEP = eps.reduce((s, e) => s + e, 0);
  const totMdp = layers.reduce((s, l) => s + num(l.mdp), 0);
  const totRolNum = layers.reduce((s, l) => s + (rateToFloat(l.rate) / 100) * num(l.egnpi), 0);
  const rol = totLimit > 0 && totRolNum > 0 ? totRolNum / totLimit : totLimit > 0 && totEP > 0 ? totEP / totLimit : null;
  // Universe LayerTableCard reduce, verbatim semantics: an 'UNLIMITED' layer sets the
  // total to Unlimited, but a LATER numeric layer compares against 0 and wins again
  // (the reduce is order-dependent). Kept exactly as Universe renders it — see
  // docs/broking/CHANGELOG.md, "Universe quirks carried over".
  const maxReinst = layers.reduce((max, l) => {
    const v = l.reinstatements ?? l.numReinstatements;
    if (v === 'UNLIMITED' || v === -1 || v === 'Unlimited') return 'UNLIMITED';
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > (typeof max === 'number' ? max : 0) ? n : max;
  }, 0);
  return {
    limit: totLimit || null,
    deductible: firstDed || null,
    aggregateLimit: totAgg || null,
    egnpi: totEgnpi || null,
    rate: totRate > 0 ? parseFloat(totRate.toFixed(4)) : null,
    earnedPremium: totEP || null,
    mdp: totMdp || null,
    mdpPct: totEP > 0 && totMdp > 0 ? totMdp / totEP : null,
    reinstatements: maxReinst === 'UNLIMITED' ? 'Unlimited' : maxReinst > 0 ? maxReinst : null,
    rol,
  };
}

/**
 * Universe NpStructureHelpers.fmtPctMaybe: a 0..1 fraction → "12.5%" (2 dp, trailing
 * zeros trimmed); non-positive → ''. Used for MDP% / ROL display so the screen
 * shows exactly what Universe shows.
 */
export function fmtPctMaybe(n01) {
  if (!Number.isFinite(n01) || n01 <= 0) return '';
  const v = n01 * 100;
  return `${v.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`;
}

/* ─────────────────────────── Stop Loss ─────────────────────────────── */

/**
 * Universe NpStopLossStructure resolved columns:
 *   limit      = EPI × Limit LR % / 100
 *   attachment = EPI × Attach LR % / 100
 * null when either input is missing (Universe shows a blank).
 */
export function stopLossResolve({ epi, limitLrPct, attachLrPct } = {}) {
  const e = toNumber(epi);
  const lim = toNumber(limitLrPct);
  const att = toNumber(attachLrPct);
  return {
    limit: e != null && lim != null ? (e * lim) / 100 : null,
    attachment: e != null && att != null ? (e * att) / 100 : null,
  };
}

/* ────────────────────────────── UMR ───────────────────────────────── */

export const UMR_RE = /^B[0-9]{4}[A-Z0-9]{1,12}$/;
export const UMR_MAX_LENGTH = 17;

/** Uppercase, strip ALL whitespace (data-model.md: "trimmed, uppercase, no spaces"). */
export function normaliseUmr(v) {
  return String(v ?? '').toUpperCase().replace(/\s+/g, '');
}

export function isValidUmr(v) {
  return UMR_RE.test(normaliseUmr(v));
}

/**
 * The live format message shown under the UMR input (IdentityField README):
 * null when the UMR is valid.
 */
export function umrFormatMessage(v) {
  const u = normaliseUmr(v);
  if (!u) return 'B + 4-digit broker no. + up to 12 characters';
  if (u[0] !== 'B') return 'A UMR starts with B.';
  if (!/^B[0-9]{4}/.test(u)) return 'B must be followed by the 4-digit broker number.';
  if (u.length <= 5) return 'Add 1–12 letters or digits after the broker number.';
  if (u.length > UMR_MAX_LENGTH) return `A UMR is at most ${UMR_MAX_LENGTH} characters.`;
  if (!UMR_RE.test(u)) return 'Format: B + 4 digits + 1–12 letters or digits (max 17).';
  return null;
}

/* ──────────────────────── required fields ─────────────────────────── */

/**
 * Universe propTreatyHelpers.getMissingRequiredFields — verbatim rules on the
 * Universe camelCase slice keys. "Active fields only": disabled QS / surplus
 * fields are skipped; sliding scale needs ≥2 complete rows; LP scalars only
 * when the toggle is explicitly YES.
 */
export function propMissingRequiredFields(s, { tMode, commMode }) {
  const has = (v) => v != null && String(v).trim() !== '';
  const missing = [];
  if (!has(s.countryId)) missing.push('Country');
  if (!has(s.cedantId)) missing.push('Cedant Name');
  if (!has(s.treatyTypeId)) missing.push('Treaty Type');
  if (!(s.classIds || []).length) missing.push('Line of Business');
  if (!has(s.brokerId)) missing.push('Broker');
  if (!has(s.currencyId)) missing.push('Currency');
  if (!has(s.inceptionDate)) missing.push('Treaty Inception Date');
  if (!has(s.experienceStartYear)) missing.push('Experience Start Year');
  const isQS = tMode === 'quota' || tMode === 'both';
  const isSurplus = tMode === 'surplus' || tMode === 'both';
  if (isQS) {
    if (!has(s.qsLimit)) missing.push('QS 100% Limit');
    if (!has(s.retentionPct)) missing.push('Retention %');
    if (!has(s.quotaShareEpi)) missing.push('Quota Share EPI');
  }
  if (isSurplus) {
    if (!has(s.surplusMaxRetention)) missing.push('Surplus Max Retention');
    if (!has(s.numLines)) missing.push('Number of Lines');
    if (!has(s.surplusEpi)) missing.push('Surplus EPI');
  }
  if (commMode === 'fixed') {
    if (isQS && !has(s.fixedCommissionQSPct)) missing.push('Fixed QS Commission %');
    if (isSurplus && !has(s.fixedCommissionSurplusPct)) missing.push('Fixed Surplus Commission %');
  } else if (commMode === 'sliding') {
    if (!has(s.slidingMinLossRatio)) missing.push('Sliding Min Loss Ratio %');
    if (!has(s.slidingMaxLossRatio)) missing.push('Sliding Max Loss Ratio %');
    if (!has(s.slidingMinCommission)) missing.push('Sliding Min Commission %');
    if (!has(s.slidingMaxCommission)) missing.push('Sliding Max Commission %');
    if (!has(s.provisionalCommissionPct)) missing.push('Provisional Commission %');
    const validRows = (s.slidingTable || []).filter((r) => has(r.lossRatioPct) && has(r.commissionPct));
    if (validRows.length < 2) missing.push('Sliding Scale table (need ≥2 complete rows)');
  }
  if (s.lossPartEnabled === true) {
    if (!has(s.minLossRatioPct)) missing.push('LP Min Loss Ratio %');
    if (!has(s.maxLossRatioPct)) missing.push('LP Max Loss Ratio %');
    if (!has(s.reinsurerSharePct)) missing.push('LP Reinsurer Share %');
  }
  return missing;
}

/**
 * NP Contract Details required fields (capture-flow.md + NpContractDetails README):
 * Country, Cedant, Treaty Type, Classes of Business, Broker, Currency,
 * Treaty Inception Date, Experience Start Year.
 */
export function npMissingRequiredFields(s) {
  const has = (v) => v != null && String(v).trim() !== '';
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

/** Contract status pipeline (capture-flow.md "Status pipeline"). */
export const STATUS_PIPELINE = ['DRAFT', 'SUBMITTED', 'QUOTED', 'FIRM_ORDER', 'BOUND', 'SIGNED'];
export const STATUS_EXITS = ['NTU', 'CANCELLED'];
export const ALL_STATUSES = [...STATUS_PIPELINE, ...STATUS_EXITS];

/** Legal next statuses: one step forward along the pipeline, or an exit from any live status. */
export function allowedNextStatuses(current) {
  const i = STATUS_PIPELINE.indexOf(current);
  if (i === -1) return [];               // NTU / CANCELLED are terminal
  const next = STATUS_PIPELINE[i + 1] ? [STATUS_PIPELINE[i + 1]] : [];
  return [...next, ...STATUS_EXITS];
}
export function canTransition(from, to) {
  return allowedNextStatuses(from).includes(to);
}
