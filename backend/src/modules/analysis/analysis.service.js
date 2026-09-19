/*
 * Bordereau analysis.
 *
 * Two layers, deliberately separated:
 *
 *  1. Aggregation (this file, no AI). Every figure a broker acts on —
 *     premiums, sums insured, paid/outstanding/incurred, loss ratio, splits by
 *     class and territory, largest risks and losses, data-quality flags — is
 *     computed in code from the stored bordereau rows. Deterministic,
 *     testable, and identical on every run.
 *
 *  2. Narrative (analysis.llm.js). The model is handed the finished figures
 *     and asked to read them: what stands out, what looks wrong, what to ask
 *     the cedant. It never does the arithmetic, so it cannot get the numbers
 *     wrong.
 */

const round2 = (n) => Math.round(n * 100) / 100;

/** Number from a bordereau cell: tolerates "1,234.50", "(500)", "$1 000", "". */
export function num(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v).trim();
  const negative = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, '').replace(/[^0-9.-]/g, ''));
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/** True when a cell holds something numeric — "" and "n/a" do not. */
const isNumeric = (v) => {
  if (v == null || v === '') return false;
  if (typeof v === 'number') return Number.isFinite(v);
  return /\d/.test(String(v)) && Number.isFinite(num(v));
};

const text = (v) => String(v ?? '').trim();
const sum = (rows, field) => round2(rows.reduce((a, r) => a + num(r[field]), 0));

/** Group rows by a column, summing the named fields per group. */
function groupBy(rows, key, fields, limit = 12) {
  const groups = new Map();
  for (const r of rows) {
    const k = text(r[key]) || '(unstated)';
    if (!groups.has(k)) groups.set(k, { key: k, count: 0 });
    const g = groups.get(k);
    g.count += 1;
    for (const f of fields) g[f] = round2((g[f] || 0) + num(r[f]));
  }
  const primary = fields[0];
  return [...groups.values()]
    .sort((a, b) => (b[primary] || 0) - (a[primary] || 0) || b.count - a.count)
    .slice(0, limit);
}

/** The n rows with the largest value in `field`, keeping only useful columns. */
function topBy(rows, field, keep, n = 10) {
  return [...rows]
    .filter((r) => num(r[field]) !== 0)
    .sort((a, b) => num(b[field]) - num(a[field]))
    .slice(0, n)
    .map((r) => Object.fromEntries([
      ...keep.map((k) => [k, text(r[k])]),
      [field, round2(num(r[field]))],
    ]));
}

const dates = (rows, field) => rows
  .map((r) => text(r[field]))
  .filter((d) => /^\d{4}-\d{2}-\d{2}/.test(d))
  .sort();

const range = (list) => (list.length
  ? { from: list[0].slice(0, 10), to: list[list.length - 1].slice(0, 10) }
  : null);

/** Premium bordereau: exposure and income. */
export function aggregatePremium(rows) {
  const premiumCeded = sum(rows, 'premium_ceded');
  const siCeded = sum(rows, 'si_ceded');
  const siTotal = sum(rows, 'sum_insured_100');
  const policies = new Set(rows.map((r) => text(r.policy_ref)).filter(Boolean));
  const inceptions = dates(rows, 'inception');
  const expiries = dates(rows, 'expiry');
  return {
    risks: rows.length,
    distinct_policies: policies.size,
    sum_insured_100: siTotal,
    si_ceded: siCeded,
    si_retained: sum(rows, 'si_retained'),
    si_fac: sum(rows, 'si_fac'),
    gross_premium_100: sum(rows, 'gross_premium_100'),
    premium_ceded: premiumCeded,
    premium_retained: sum(rows, 'premium_retained'),
    premium_fac: sum(rows, 'premium_fac'),
    // Rate on the ceded exposure — the treaty's own rate, not the original.
    ceded_rate_pct: siCeded > 0 ? round2((premiumCeded / siCeded) * 100) : null,
    average_sum_insured: rows.length ? round2(siTotal / rows.length) : 0,
    average_premium_ceded: rows.length ? round2(premiumCeded / rows.length) : 0,
    period: { inception: range(inceptions), expiry: range(expiries) },
    currencies: [...new Set(rows.map((r) => text(r.currency)).filter(Boolean))],
    by_class: groupBy(rows, 'class_of_business', ['premium_ceded', 'sum_insured_100']),
    by_territory: groupBy(rows, 'territory', ['premium_ceded', 'sum_insured_100']),
    largest_risks: topBy(rows, 'sum_insured_100', ['policy_ref', 'insured', 'class_of_business', 'territory']),
  };
}

/** Claims bordereau: paid, outstanding and incurred. */
export function aggregateClaims(rows) {
  const withIncurred = rows.map((r) => ({
    ...r,
    // Incurred is often left out — paid + outstanding is the same figure.
    incurred: isNumeric(r.incurred) ? num(r.incurred) : num(r.paid) + num(r.outstanding),
  }));
  const losses = dates(rows, 'date_of_loss');
  const open = withIncurred.filter((r) => num(r.outstanding) > 0);
  return {
    claims: rows.length,
    distinct_claims: new Set(rows.map((r) => text(r.claim_ref)).filter(Boolean)).size,
    paid: sum(rows, 'paid'),
    outstanding: sum(rows, 'outstanding'),
    incurred: sum(withIncurred, 'incurred'),
    open_claims: open.length,
    closed_claims: rows.length - open.length,
    average_incurred: rows.length ? round2(sum(withIncurred, 'incurred') / rows.length) : 0,
    largest_incurred: withIncurred.length
      ? round2(Math.max(...withIncurred.map((r) => num(r.incurred)))) : 0,
    period: { date_of_loss: range(losses) },
    currencies: [...new Set(rows.map((r) => text(r.currency)).filter(Boolean))],
    by_class: groupBy(withIncurred, 'class_of_business', ['incurred', 'paid']),
    by_cause: groupBy(withIncurred, 'cause_of_loss', ['incurred', 'paid']),
    largest_losses: topBy(withIncurred, 'incurred', ['claim_ref', 'policy_ref', 'insured', 'date_of_loss', 'cause_of_loss']),
  };
}

/** Checks a broker would run by eye before sending a pack to market. */
export function dataQuality(premiumRows, claimsRows) {
  const flags = [];
  const flag = (issue, detail, rows_affected) => {
    if (rows_affected > 0) flags.push({ issue, detail, rows_affected });
  };

  const missing = (rows, field) => rows.filter((r) => !text(r[field])).length;
  flag('missing_policy_reference', 'Premium rows with no policy reference', missing(premiumRows, 'policy_ref'));
  flag('missing_insured', 'Premium rows with no insured name', missing(premiumRows, 'insured'));
  flag('missing_sum_insured', 'Premium rows with no sum insured',
    premiumRows.filter((r) => !isNumeric(r.sum_insured_100)).length);
  flag('zero_premium', 'Premium rows ceding no premium to the treaty',
    premiumRows.filter((r) => num(r.premium_ceded) === 0).length);
  flag('negative_amounts', 'Premium rows with a negative sum insured or premium',
    premiumRows.filter((r) => num(r.sum_insured_100) < 0 || num(r.premium_ceded) < 0).length);
  flag('cession_exceeds_sum_insured', 'Rows ceding more than the sum insured',
    premiumRows.filter((r) => isNumeric(r.si_ceded) && isNumeric(r.sum_insured_100)
      && num(r.si_ceded) > num(r.sum_insured_100)).length);

  const seen = new Set();
  const dupes = new Set();
  for (const r of premiumRows) {
    const ref = text(r.policy_ref).toLowerCase();
    if (!ref) continue;
    if (seen.has(ref)) dupes.add(ref);
    seen.add(ref);
  }
  flag('duplicate_policy_reference', 'Policy references appearing more than once', dupes.size);

  flag('missing_claim_reference', 'Claims with no claim reference', missing(claimsRows, 'claim_ref'));
  flag('missing_date_of_loss', 'Claims with no date of loss',
    claimsRows.filter((r) => !/^\d{4}-\d{2}-\d{2}/.test(text(r.date_of_loss))).length);
  flag('claim_without_policy', 'Claims whose policy reference is not in the premium bordereau',
    premiumRows.length === 0 ? 0 : claimsRows.filter((r) => {
      const ref = text(r.policy_ref).toLowerCase();
      return ref && !seen.has(ref);
    }).length);
  flag('nil_claims', 'Claims with neither paid nor outstanding amounts',
    claimsRows.filter((r) => num(r.paid) === 0 && num(r.outstanding) === 0).length);

  return flags;
}

/**
 * Aggregate every bordereau on a placement into one picture. `bordereaux` are
 * rows from the bordereau table, each with `type` and `parsed_rows`.
 */
export function aggregateBordereaux(bordereaux, { currency } = {}) {
  const of = (type) => bordereaux.filter((b) => b.type === type);
  const rowsOf = (type) => of(type).flatMap((b) => b.parsed_rows || []);
  const premiumRows = rowsOf('premium');
  const claimsRows = rowsOf('claims');

  const premium = aggregatePremium(premiumRows);
  const claims = aggregateClaims(claimsRows);
  // Loss ratio is measured against the premium ceded to the treaty — the
  // premium that actually paid for these losses.
  const base = premium.premium_ceded || premium.gross_premium_100;
  const lossRatio = base > 0 ? round2((claims.incurred / base) * 100) : null;

  return {
    currency: currency || premium.currencies[0] || claims.currencies[0] || null,
    sources: bordereaux.map((b) => ({
      id: b.id, type: b.type, source_file: b.source_file, rows: (b.parsed_rows || []).length,
    })),
    premium,
    claims,
    combined: {
      loss_ratio_pct: lossRatio,
      paid_ratio_pct: base > 0 ? round2((claims.paid / base) * 100) : null,
      claims_frequency_pct: premium.risks > 0 ? round2((claims.claims / premium.risks) * 100) : null,
      burning_cost_pct: premium.si_ceded > 0 ? round2((claims.incurred / premium.si_ceded) * 100) : null,
      premium_per_risk: premium.average_premium_ceded,
      incurred_per_claim: claims.average_incurred,
    },
    data_quality: dataQuality(premiumRows, claimsRows),
  };
}

/**
 * A compact, representative sample for the model to read alongside the
 * figures — enough to spot patterns, small enough to stay cheap.
 */
export function sampleRows(bordereaux, perType = 25) {
  const pick = (type) => {
    const rows = bordereaux.filter((b) => b.type === type).flatMap((b) => b.parsed_rows || []);
    if (rows.length <= perType) return rows;
    // Even stride rather than the first N — the tail of a bordereau is often
    // where the odd rows live.
    const stride = Math.ceil(rows.length / perType);
    return rows.filter((_, i) => i % stride === 0).slice(0, perType);
  };
  return { premium: pick('premium'), claims: pick('claims') };
}
