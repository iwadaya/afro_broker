/**
 * Treaty structuring — the decision layer over the DFA engine.
 *
 * The engine (dfa.js) simulates a book and applies programmes to the same
 * years. This file turns that into a retention and structure decision the
 * way the buyer frames it:
 *
 *   - Test every structure. The four families a treaty buyer chooses among
 *     — excess of loss, quota share, surplus, and a quota share with excess
 *     of loss over it — each built across a range of retentions (the
 *     attachment, the cession, the retained line) from one grid, so every
 *     candidate runs against the same simulated years.
 *   - Anchor to capital and appetite. A stated risk appetite — the chance of
 *     ruin the board will accept, how much of the capital a 1-in-100 year
 *     may eat, the solvency ratio to hold, the combined ratio a bad year may
 *     reach, and the budget for the cover — read against every candidate as
 *     pass / fail, test by test.
 *   - A defensible range. Of the candidates that fit, the range of
 *     retentions each family fits at, and the pick: the cheapest programme
 *     that keeps the insurer inside its appetite — safe, without paying for
 *     more protection than it needs. With nothing fitting, the closest.
 *   - The frontier. Every candidate as a point: what the cover is expected
 *     to cost against how much the net result swings, with the efficient
 *     ones (nothing both cheaper and steadier) marked.
 *
 * Pure functions, no engine calls: the route builds the candidates here,
 * runs them through runStructuring, and hands the result back here to read.
 */

const round2 = (n) => Math.round(n * 100) / 100;
const numOr = (v, fallback) => (v == null || v === '' || !Number.isFinite(Number(v)) ? fallback : Number(v));

/** 5000000 → "5m", 7500000 → "7.5m", 250000 → "250k": the way a label says money. */
export function compact(v) {
  const n = Number(v) || 0;
  const a = Math.abs(n);
  const trim = (x) => {
    const dp = x >= 100 ? 0 : x >= 10 ? 1 : 2;
    return x.toFixed(dp).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
  };
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}${trim(a / 1e9)}bn`;
  if (a >= 1e6) return `${sign}${trim(a / 1e6)}m`;
  if (a >= 1e3) return `${sign}${trim(a / 1e3)}k`;
  return `${sign}${Math.round(a)}`;
}

/** Three significant figures, so a swept retention reads as a round number. */
export function sig3(v) {
  const n = Number(v);
  if (!(n > 0)) return 0;
  const mag = 10 ** (Math.floor(Math.log10(n)) - 2);
  return Math.round(n / mag) * mag;
}

// ---- The families ----

export const FAMILIES = [
  {
    key: 'xol',
    label: 'Excess of loss',
    short: 'XoL',
    axis: 'retention',
    text: 'Per-event layers from the retention up to the top of the tower. The retention is what is swept; the tower above it keeps its shape.',
  },
  {
    key: 'quota_share',
    label: 'Quota share',
    short: 'QS',
    axis: 'cession',
    text: 'A flat share of every risk and every loss, for a commission. The cession is what is swept.',
  },
  {
    key: 'surplus',
    label: 'Surplus',
    short: 'Surplus',
    axis: 'line',
    text: 'The part of each risk above the retained line, up to a number of lines — big risks cede more, small ones nothing. The line is what is swept.',
  },
  {
    key: 'blend',
    label: 'Quota share + excess of loss',
    short: 'Blend',
    axis: 'retention',
    text: 'A fixed quota share with the excess-of-loss tower on the retained account. The tower’s retention is what is swept.',
  },
];
export const FAMILY_KEYS = FAMILIES.map((f) => f.key);
export const familyOf = (key) => FAMILIES.find((f) => f.key === key) || null;

export const GRID_DEFAULTS = {
  steps: 5,
  reinstatements: 1,
  cession_from: 10,
  cession_to: 50,
  commission_pct: 25,
  surplus_lines: 5,
  blend_cession_pct: 20,
};

/** `steps` values from `from` to `to` inclusive, rounded to three figures, deduplicated. */
export function sweep(from, to, steps, round = sig3) {
  const a = Number(from);
  const b = Number(to);
  const n = Math.max(2, Math.min(12, Math.trunc(Number(steps)) || GRID_DEFAULTS.steps));
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const v = round(a + ((b - a) * i) / (n - 1));
    if (v > 0 && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * The excess-of-loss tower at a retention: the current tower's layers above
 * it keep their shape (and their quoted premium), the one the retention
 * cuts through starts there and is priced by the model, anything wholly
 * below it goes; the tower is trimmed or extended to `top`. With no tower
 * to start from, one layer from the retention to the top.
 */
export function towerAt(baseLayers, retention, top, reinstatements = GRID_DEFAULTS.reinstatements) {
  const r = Number(retention);
  const t = Number(top);
  if (!(t > r) || !(r >= 0)) return [];
  const priced = (attachment, limit, template = {}) => ({
    name: `${compact(limit)} xs ${compact(attachment)}`,
    attachment,
    limit,
    premium100: null,
    reinstatements: template.reinstatements ?? reinstatements,
    reinstatement_pct: template.reinstatement_pct ?? 100,
    placed_pct: 100,
    aggregate_deductible: 0,
  });
  const layers = (baseLayers || [])
    .filter((l) => Number(l.limit) > 0)
    .map((l) => ({ ...l, attachment: Number(l.attachment) || 0, limit: Number(l.limit) }))
    .sort((a, b) => a.attachment - b.attachment);
  if (!layers.length) return [priced(r, t - r)];
  const out = [];
  for (const l of layers) {
    const lTop = l.attachment + l.limit;
    if (lTop <= r || l.attachment >= t) continue;
    const attachment = Math.max(l.attachment, r);
    const limit = Math.min(lTop, t) - attachment;
    if (!(limit > 0)) continue;
    const moved = attachment !== l.attachment || limit !== l.limit;
    out.push(moved ? priced(attachment, limit, l) : { ...l });
  }
  // A retention below the tower opens a new bottom layer up to it; a tower
  // that stops short of the top gets a new layer up to the top.
  if (out.length && out[0].attachment > r) out.unshift(priced(r, out[0].attachment - r, layers[0]));
  const reached = out.length ? out[out.length - 1].attachment + out[out.length - 1].limit : r;
  if (reached < t) out.push(priced(reached, t - reached));
  return out;
}

/**
 * Every candidate programme the grid names, each a structure the engine
 * takes, labelled and placed on its family's axis.
 *
 * @param {object} grid  { families, steps, retention_from, retention_to, tower_top,
 *                         reinstatements, cession_from, cession_to, commission_pct,
 *                         surplus_lines, blend_cession_pct }
 * @param {object} base  { current } — the current programme, whose tower the
 *                        excess-of-loss candidates keep the shape of
 */
export function buildCandidates(grid, base = {}) {
  const g = { ...GRID_DEFAULTS, ...grid };
  const families = (g.families || FAMILY_KEYS).filter((k) => FAMILY_KEYS.includes(k));
  const retentions = sweep(g.retention_from, g.retention_to, g.steps);
  const cessions = sweep(g.cession_from, g.cession_to, g.steps, (v) => Math.round(v));
  const commission = numOr(g.commission_pct, GRID_DEFAULTS.commission_pct);
  const baseLayers = base.current?.xol_layers || [];
  const out = [];
  for (const family of families) {
    if (family === 'xol' || family === 'blend') {
      const qs = family === 'blend'
        ? { cession_pct: numOr(g.blend_cession_pct, GRID_DEFAULTS.blend_cession_pct), commission_pct: commission }
        : null;
      for (const r of retentions) {
        const layers = towerAt(baseLayers, r, g.tower_top, g.reinstatements);
        if (!layers.length) continue;
        out.push({
          label: qs ? `QS ${qs.cession_pct}% + XoL · retention ${compact(r)}` : `XoL · retention ${compact(r)}`,
          family,
          axis: { kind: 'retention', value: r, text: `retention ${compact(r)}` },
          structure: { quota_share: qs, surplus: null, xol_layers: layers, aggregate_cover: null },
        });
      }
    } else if (family === 'quota_share') {
      for (const c of cessions) {
        out.push({
          label: `QS ${c}%`,
          family,
          axis: { kind: 'cession', value: c, text: `cession ${c}%` },
          structure: { quota_share: { cession_pct: c, commission_pct: commission }, surplus: null, xol_layers: [], aggregate_cover: null },
        });
      }
    } else if (family === 'surplus') {
      const lines = Math.max(1, numOr(g.surplus_lines, GRID_DEFAULTS.surplus_lines));
      for (const r of retentions) {
        out.push({
          label: `Surplus · line ${compact(r)} × ${lines}`,
          family,
          axis: { kind: 'line', value: r, text: `line ${compact(r)} × ${lines}` },
          structure: { quota_share: null, surplus: { retained_line: r, lines, commission_pct: commission }, xol_layers: [], aggregate_cover: null },
        });
      }
    }
  }
  return out;
}

// ---- The appetite ----

/**
 * The stated risk tolerance, as the board would state it. A blank limit
 * switches its test off; the budget is off unless given.
 */
export const DEFAULT_APPETITE = {
  max_ruin_pct: 0.5,                   // chance of ruin in the year, at most
  max_loss_1in100_pct_of_capital: 60,  // the 1-in-100 net loss, as a share of the capital held, at most
  min_solvency_ratio_pct: 120,         // the desk's solvency ratio (capital held over capital needed), at least
  max_combined_ratio_1in10_pct: 115,   // the combined ratio in a 1-in-10 year, at most
  require_standing_holds: true,        // the standing on the domicile's ladder (or the desk's standard) must be "holds"
  max_cost_pct_of_premium: null,       // the expected cost of the cover, as a share of the subject premium, at most
};

export const APPETITE_FIELDS = [
  { key: 'max_ruin_pct', label: 'Chance of ruin, at most', unit: '%', kind: 'pct2', op: '≤', test: 'ruin' },
  { key: 'max_loss_1in100_pct_of_capital', label: '1-in-100 net loss, at most', unit: '% of capital', kind: 'pct', op: '≤', test: 'tail' },
  { key: 'min_solvency_ratio_pct', label: 'Solvency ratio, at least', unit: '%', kind: 'pct', op: '≥', test: 'solvency' },
  { key: 'max_combined_ratio_1in10_pct', label: '1-in-10 combined ratio, at most', unit: '%', kind: 'pct', op: '≤', test: 'earnings' },
  { key: 'require_standing_holds', label: 'Must hold on the capital ladder', unit: '', kind: 'bool', op: '=', test: 'standing' },
  { key: 'max_cost_pct_of_premium', label: 'Cost of the cover, at most', unit: '% of premium', kind: 'pct', op: '≤', test: 'budget' },
];

/** The test-by-test reading of one block against the appetite. */
export function appetiteTests(block, appetite = DEFAULT_APPETITE, ctx = {}) {
  const a = { ...DEFAULT_APPETITE, ...(appetite || {}) };
  const premium = Number(ctx.subject_premium) || Number(block.flows?.subject_premium) || 0;
  const regime = block.regime && !block.regime.needs_input ? block.regime : null;
  const cost = block.reinsurance?.expected_cost ?? 0;
  const readings = {
    ruin: { label: 'Chance of ruin', value: block.capital?.ruin_prob_pct ?? null, kind: 'pct2' },
    tail: { label: '1-in-100 net loss as a share of capital', value: block.capital?.loss_1in100_pct_of_capital ?? null, kind: 'pct' },
    solvency: { label: 'Solvency ratio', value: block.capital?.solvency_ratio_pct ?? null, kind: 'pct' },
    earnings: { label: '1-in-10 combined ratio', value: block.combined_ratio?.p90 ?? null, kind: 'pct' },
    standing: {
      label: regime ? `Standing under ${ctx.regime_name || 'the capital regime'}` : 'Standing against the capital standard',
      value: block.standing ?? null,
      kind: 'standing',
    },
    budget: { label: 'Cost of the cover as a share of premium', value: premium > 0 ? round2((cost / premium) * 100) : null, kind: 'pct' },
  };
  const tests = [];
  for (const f of APPETITE_FIELDS) {
    const r = readings[f.test];
    const value = r.value;
    if (f.kind === 'bool') {
      // Off unless asked for; a standing must read "holds".
      if (a[f.key] !== true) continue;
      const ok = value == null || value === 'holds';
      tests.push({ key: f.test, label: r.label, kind: r.kind, op: f.op, value, limit: 'holds', ok, shortfall: ok ? 0 : (value === 'strained' ? 0.5 : 1) });
      continue;
    }
    const limit = numOr(a[f.key], null);
    if (limit == null) continue;
    let ok = true;
    let shortfall = 0;
    if (value != null) {
      ok = f.op === '≤' ? value <= limit : value >= limit;
      const scale = Math.max(Math.abs(limit), 1e-9);
      shortfall = ok ? 0 : round2(Math.abs(value - limit) / scale);
    }
    tests.push({ key: f.test, label: r.label, kind: r.kind, op: f.op, value, limit, ok, shortfall });
  }
  return tests;
}

export function appetiteOf(block, appetite, ctx) {
  const tests = appetiteTests(block, appetite, ctx);
  const failed = tests.filter((t) => !t.ok);
  return {
    pass: failed.length === 0,
    failed: failed.map((t) => t.key),
    shortfall: round2(failed.reduce((s, t) => s + t.shortfall, 0)),
    tests,
  };
}

// ---- Reading the run ----

const costOf = (b) => b.reinsurance?.expected_cost ?? 0;
const swingOf = (b) => b.result?.sd ?? 0;

/** Nothing else is both cheaper and steadier: the Pareto-efficient set on cost against volatility. */
export function efficientSet(rows) {
  return rows.map((r, i) => !rows.some((o, j) => j !== i
    && costOf(o) <= costOf(r) && swingOf(o) <= swingOf(r)
    && (costOf(o) < costOf(r) || swingOf(o) < swingOf(r))));
}

/** The pick among the rows: the cheapest that fits; with nothing fitting, the closest. */
export function pickRecommended(rows) {
  const fits = rows.filter((r) => r.appetite.pass);
  if (fits.length) {
    const best = [...fits].sort((x, y) => costOf(x) - costOf(y) || swingOf(x) - swingOf(y))[0];
    return { label: best.label, fits: true, reason: 'the cheapest programme that keeps the insurer inside its appetite' };
  }
  if (!rows.length) return { label: null, fits: false, reason: 'nothing was tested' };
  const closest = [...rows].sort((x, y) => x.appetite.failed.length - y.appetite.failed.length
    || x.appetite.shortfall - y.appetite.shortfall || costOf(x) - costOf(y))[0];
  return { label: closest.label, fits: false, reason: 'nothing tested fits the appetite — this is the closest' };
}

/**
 * The structuring result read against the appetite: every candidate with
 * its tests, its place on the frontier and how it stood under each stress;
 * the references (gross, current, proposed) read the same way; the
 * defensible range family by family; and the pick.
 *
 * @param {object} result       from runStructuring
 * @param {object} args
 * @param {object[]} args.candidates  the built list (label, family, axis, structure)
 * @param {object} [args.appetite]
 */
export function assessStructuring(result, { candidates, appetite }) {
  const ctx = {
    subject_premium: result.calibration?.subject_premium,
    regime_name: result.regime?.regime,
  };
  const stressLabels = Object.keys(result.stresses || {});
  const stressOf = (label) => Object.fromEntries(stressLabels.map((s) => {
    const b = result.stresses[s].structures?.[label];
    return [s, b ? {
      standing: b.standing,
      ruin_prob_pct: b.ruin_prob_pct,
      result_mean: b.result_mean,
      capital_required: b.capital_required,
      solvency_ratio_pct: b.solvency_ratio_pct,
      ratio_pct: b.regime?.ratio_pct ?? null,
      band: b.regime?.band ?? null,
      combined_ratio_p90: b.combined_ratio_p90,
      net_income_p1: b.net_income_p1,
    } : null];
  }));

  const rows = candidates
    .filter((c) => result.candidates[c.label])
    .map((c) => {
      const b = result.candidates[c.label];
      return { ...c, ...b, appetite: appetiteOf(b, appetite, ctx), stress: stressOf(c.label) };
    });
  const efficient = efficientSet(rows);
  rows.forEach((r, i) => { r.efficient = efficient[i]; });
  const pick = pickRecommended(rows);
  rows.forEach((r) => { r.recommended = r.label === pick.label; });

  const references = {};
  const gross = { ...result.gross, appetite: appetiteOf(result.gross, appetite, ctx), stress: {} };
  for (const s of stressLabels) {
    const b = result.stresses[s].gross;
    gross.stress[s] = b ? { standing: b.standing, ruin_prob_pct: b.ruin_prob_pct, result_mean: b.result_mean, capital_required: b.capital_required, solvency_ratio_pct: b.solvency_ratio_pct, ratio_pct: b.regime?.ratio_pct ?? null, band: b.regime?.band ?? null, combined_ratio_p90: b.combined_ratio_p90, net_income_p1: b.net_income_p1 } : null;
  }
  references.gross = gross;
  for (const [label, b] of Object.entries(result.references || {})) {
    references[label] = { ...b, appetite: appetiteOf(b, appetite, ctx), stress: stressOf(label) };
  }

  const families = [...new Set(rows.map((r) => r.family))].map((key) => {
    const fam = familyOf(key);
    const tested = rows.filter((r) => r.family === key);
    const fits = tested.filter((r) => r.appetite.pass);
    const values = fits.map((r) => r.axis.value);
    const cheapest = fits.length ? [...fits].sort((x, y) => costOf(x) - costOf(y))[0] : null;
    return {
      family: key,
      label: fam?.label || key,
      axis: fam?.axis || tested[0]?.axis.kind,
      tested: tested.length,
      fits: fits.length,
      tested_from: Math.min(...tested.map((r) => r.axis.value)),
      tested_to: Math.max(...tested.map((r) => r.axis.value)),
      fits_from: values.length ? Math.min(...values) : null,
      fits_to: values.length ? Math.max(...values) : null,
      cheapest: cheapest?.label || null,
    };
  });

  const fits = rows.filter((r) => r.appetite.pass);
  return {
    candidates: rows,
    references,
    defensible: {
      tested: rows.length,
      fits: fits.length,
      recommended: pick.label,
      recommended_fits: pick.fits,
      reason: pick.reason,
      families,
      stresses: stressLabels,
    },
  };
}

/**
 * The stresses every candidate is re-run under unless the desk names its
 * own: the cat PML event landing on an ordinary year, the opening reserve
 * deteriorating, and rates running hot — the Handbook's three most common
 * ways a programme is found out.
 */
export const DEFAULT_STRESSES = {
  'A major cat year': { forced_cat_pml_multiple: 1 },
  'Reserves deteriorate': { reserve_shock_pct: 15 },
  'Rates inadequate': { loss_ratio_delta_pts: 10 },
};
