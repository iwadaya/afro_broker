import { fmtCompact } from '../../components.jsx';

/*
 * The desk's model: the editable shapes of a structure and the loss model,
 * the payloads the engine takes, the frontier variants a scan produces, and
 * the plain-language helpers every stage reads (what a figure means, how a
 * structure is described in a few words, what the calibration implies).
 * No React in here — the tabs render, this file decides.
 */

export const REINSTATEMENT_OPTIONS = ['0', '1', '2', '3', '4', '5', 'UNLIMITED'];

export const DEFAULT_SLIDING = { min_pct: 15, max_pct: 35, min_lr_pct: 50, max_lr_pct: 70 };
export const DEFAULT_CORRIDOR = { from_lr_pct: 80, to_lr_pct: 100, cedant_share_pct: 50 };
export const DEFAULT_AGGREGATE = { attachment_lr_pct: 90, exhaust_lr_pct: 110, premium100: '', placed_pct: 100 };
export const DEFAULT_QS = { cession_pct: 20, commission_pct: 25, event_limit: '' };
export const DEFAULT_SURPLUS = { retained_line: '', lines: 5, commission_pct: 25, event_limit: '' };

let layerKeySeq = 0;
export const withKey = (l) => ({ ...l, _key: `L${layerKeySeq += 1}` });

/** Number with a fallback for blanks and non-numbers. */
export const num = (v, fallback = 0) => (v === '' || v == null || Number.isNaN(Number(v)) ? fallback : Number(v));
export const positive = (v) => (num(v) > 0 ? num(v) : null);

/** Editable copy of a server-shaped structure. */
export function editableStructure(s) {
  const qs = s?.quota_share;
  return {
    quota_share: qs
      ? {
        cession_pct: qs.cession_pct,
        commission_pct: qs.commission_pct,
        event_limit: qs.event_limit ?? '',
        inferred: !!qs.inferred,
        sliding: !!qs.sliding_scale,
        sliding_scale: qs.sliding_scale ? { ...qs.sliding_scale } : { ...DEFAULT_SLIDING },
        corridor: !!qs.loss_corridor,
        loss_corridor: qs.loss_corridor ? { ...qs.loss_corridor } : { ...DEFAULT_CORRIDOR },
      }
      : null,
    surplus: s?.surplus
      ? {
        retained_line: s.surplus.retained_line ?? '',
        lines: s.surplus.lines ?? DEFAULT_SURPLUS.lines,
        commission_pct: s.surplus.commission_pct ?? DEFAULT_SURPLUS.commission_pct,
        event_limit: s.surplus.event_limit ?? '',
      }
      : null,
    xol_layers: (s?.xol_layers || []).map((l) => withKey({
      name: l.name || '',
      attachment: l.attachment ?? 0,
      limit: l.limit ?? '',
      premium100: l.premium100 > 0 ? l.premium100 : '',
      reinstatements: String(l.reinstatements ?? 0),
      reinstatement_pct: l.reinstatement_pct ?? 100,
      placed_pct: l.placed_pct ?? 100,
      aggregate_deductible: l.aggregate_deductible ?? 0,
    })),
    aggregate: s?.aggregate_cover
      ? {
        attachment_lr_pct: s.aggregate_cover.attachment_lr_pct ?? DEFAULT_AGGREGATE.attachment_lr_pct,
        exhaust_lr_pct: s.aggregate_cover.exhaust_lr_pct ?? DEFAULT_AGGREGATE.exhaust_lr_pct,
        premium100: s.aggregate_cover.premium100 > 0 ? s.aggregate_cover.premium100 : '',
        placed_pct: s.aggregate_cover.placed_pct ?? 100,
      }
      : null,
  };
}

/** A fresh copy of an editable structure (new layer keys), for "start from current". */
export function cloneStructure(s) {
  return {
    quota_share: s.quota_share ? {
      ...s.quota_share,
      sliding_scale: { ...s.quota_share.sliding_scale },
      loss_corridor: { ...s.quota_share.loss_corridor },
    } : null,
    surplus: s.surplus ? { ...s.surplus } : null,
    xol_layers: s.xol_layers.map((l) => withKey({ ...l })),
    aggregate: s.aggregate ? { ...s.aggregate } : null,
  };
}

/** The engine-shaped payload for one edited structure. */
export function payloadStructure(s) {
  const qs = s?.quota_share;
  return {
    quota_share: qs
      ? {
        cession_pct: num(qs.cession_pct),
        commission_pct: num(qs.commission_pct),
        event_limit: positive(qs.event_limit),
        sliding_scale: qs.sliding ? {
          min_pct: num(qs.sliding_scale.min_pct),
          max_pct: num(qs.sliding_scale.max_pct),
          min_lr_pct: num(qs.sliding_scale.min_lr_pct),
          max_lr_pct: num(qs.sliding_scale.max_lr_pct),
        } : null,
        loss_corridor: qs.corridor ? {
          from_lr_pct: num(qs.loss_corridor.from_lr_pct),
          to_lr_pct: num(qs.loss_corridor.to_lr_pct),
          cedant_share_pct: num(qs.loss_corridor.cedant_share_pct),
        } : null,
      }
      : null,
    surplus: s?.surplus && num(s.surplus.retained_line) > 0 && num(s.surplus.lines) > 0
      ? {
        retained_line: num(s.surplus.retained_line),
        lines: num(s.surplus.lines),
        commission_pct: num(s.surplus.commission_pct),
        event_limit: positive(s.surplus.event_limit),
      }
      : null,
    xol_layers: (s?.xol_layers || [])
      .filter((l) => num(l.limit) > 0)
      .map((l) => ({
        name: l.name || undefined,
        attachment: num(l.attachment),
        limit: num(l.limit),
        premium100: positive(l.premium100),
        reinstatements: l.reinstatements,
        reinstatement_pct: num(l.reinstatement_pct, 100),
        placed_pct: num(l.placed_pct, 100),
        aggregate_deductible: num(l.aggregate_deductible),
      })),
    aggregate_cover: s?.aggregate
      ? {
        attachment_lr_pct: num(s.aggregate.attachment_lr_pct),
        exhaust_lr_pct: num(s.aggregate.exhaust_lr_pct),
        premium100: positive(s.aggregate.premium100),
        placed_pct: num(s.aggregate.placed_pct, 100),
      }
      : null,
  };
}

/** Whether two edited structures would run as the same programme. */
export function structuresEqual(a, b) {
  return JSON.stringify(payloadStructure(a)) === JSON.stringify(payloadStructure(b));
}

const short = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** "QS 20% · 3 XoL layers · stop loss" — a programme in a few words. */
export function describeStructure(payload) {
  const parts = [];
  if (payload.quota_share) parts.push(`QS ${short(payload.quota_share.cession_pct)}%`);
  if (payload.surplus) parts.push(`Surplus line ${fmtCompact(payload.surplus.retained_line)} × ${short(payload.surplus.lines)}`);
  const n = payload.xol_layers.length;
  if (n) parts.push(`${n} XoL layer${n === 1 ? '' : 's'}`);
  if (payload.aggregate_cover) parts.push('stop loss');
  return parts.length ? parts.join(' · ') : 'No reinsurance';
}

/** 99.5 → 200: the return period a capital percentile names. */
export const returnPeriod = (pct) => Math.max(1, Math.round(1 / (1 - num(pct, 99.5) / 100)));

/**
 * What the loss model expects, split the way the engine splits it
 * (calibratePortfolio): the event burdens first, the attritional cost as
 * whatever the expected total leaves. Computed here too, so the Book stage
 * can show the split as the figures are typed rather than after a run.
 */
export function expectedSplit(cal) {
  const premium = num(cal?.subject_premium);
  const threshold = num(cal?.large_loss_threshold) > 0 ? num(cal.large_loss_threshold) : 250000;
  const largeSeverity = Math.max(threshold * 1.2, num(cal?.large_severity_mean));
  const catSeverity = Math.max(threshold * 2, num(cal?.cat_severity_mean));
  const total = premium * num(cal?.expected_loss_ratio_pct) / 100;
  const large = Math.max(0, num(cal?.large_frequency)) * largeSeverity;
  const cat = Math.max(0, num(cal?.cat_frequency)) * catSeverity;
  const attritional = Math.max(0, total - large - cat);
  const modelled = attritional + large + cat;
  return {
    premium,
    total,
    large,
    cat,
    attritional,
    modelled,
    // The event burdens alone exceed the stated loss ratio: the engine floors
    // the attritional cost at zero and the book runs hotter than typed.
    overrun: modelled > total + 0.5,
    modelled_loss_ratio_pct: premium > 0 ? (modelled / premium) * 100 : 0,
  };
}

/**
 * Frontier scan: variants of the proposed structure along one dimension.
 * Retention moves the first layer's attachment with its exhaust point fixed
 * (re-priced technically); cession walks the quota share; aggregate walks
 * the stop-loss attachment with its width fixed.
 */
export function scanVariants(kind, proposed) {
  const out = {};
  if (kind === 'retention' && proposed.xol_layers.length) {
    const layers = [...proposed.xol_layers].sort((a, b) => a.attachment - b.attachment);
    const first = layers[0];
    const top = first.attachment + first.limit;
    for (const f of [0.5, 0.75, 1.25, 1.5, 2]) {
      const attachment = Math.round(first.attachment * f);
      if (attachment >= top || attachment <= 0) continue;
      out[`Ret ${fmtCompact(attachment)}`] = {
        ...proposed,
        xol_layers: [{ ...first, attachment, limit: top - attachment, premium100: null }, ...layers.slice(1)],
      };
    }
  }
  if (kind === 'cession') {
    const base = proposed.quota_share || { commission_pct: 25 };
    for (const c of [0, 10, 20, 30, 40, 50]) {
      if (proposed.quota_share && c === proposed.quota_share.cession_pct) continue;
      out[`QS ${c}%`] = { ...proposed, quota_share: c > 0 ? { ...base, cession_pct: c } : null };
    }
  }
  if (kind === 'aggregate') {
    const base = proposed.aggregate_cover || { exhaust_lr_pct: 110, attachment_lr_pct: 90, placed_pct: 100 };
    const width = Math.max(5, base.exhaust_lr_pct - base.attachment_lr_pct);
    for (const a of [70, 80, 90, 100, 110]) {
      if (proposed.aggregate_cover && a === proposed.aggregate_cover.attachment_lr_pct) continue;
      out[`Agg ${a}% LR`] = {
        ...proposed,
        aggregate_cover: { ...base, attachment_lr_pct: a, exhaust_lr_pct: a + width, premium100: null },
      };
    }
  }
  return out;
}

export const SCAN_OPTIONS = [
  { key: 'none', label: 'Nothing else — just current and proposed' },
  { key: 'retention', label: 'The first layer’s retention, up and down' },
  { key: 'cession', label: 'The quota-share cession, 0% to 50%' },
  { key: 'aggregate', label: 'The stop-loss attachment, 70% to 110% LR' },
];

/** The engine's bands for an edited risk profile: the usable rows, or null for the engine's own assumption. */
export function profilePayload(bands) {
  const rows = (bands || [])
    .filter((b) => num(b.sum_insured) > 0 && num(b.premium_pct) > 0)
    .map((b) => ({ sum_insured: num(b.sum_insured), premium_pct: num(b.premium_pct) }));
  return rows.length ? rows.slice(0, 12) : null;
}

/**
 * The profile the engine assumes when none is typed — five bands from the
 * large-loss threshold to the largest single loss, the premium halving from
 * one band to the next — so 01 Scope can say what a surplus would read.
 */
export function assumedProfile(cal) {
  const lo = Math.max(1, num(cal?.large_loss_threshold) || 250000);
  const largest = num(cal?.large_severity_cap) > 0
    ? num(cal.large_severity_cap) : Math.max(lo * 1.2, num(cal?.large_severity_mean)) * 40;
  const hi = Math.max(lo * 2, largest);
  const ratio = (hi / lo) ** (1 / 4);
  const weights = [16, 8, 4, 2, 1];
  return weights.map((w, i) => ({ sum_insured: Math.round(lo * ratio ** i), premium_pct: Math.round((w / 31) * 10000) / 100 }));
}

/** The loss model as the engine takes it — shared by a run and a structuring sweep. */
export function portfolioBody(cal) {
  return {
    subject_premium: num(cal.subject_premium),
    expected_loss_ratio_pct: num(cal.expected_loss_ratio_pct),
    large_loss_threshold: num(cal.large_loss_threshold) || undefined,
    large_frequency: num(cal.large_frequency),
    large_severity_mean: num(cal.large_severity_mean),
    cat_frequency: num(cal.cat_frequency),
    cat_severity_mean: num(cal.cat_severity_mean),
    attritional_cv_pct: num(cal.attritional_cv_pct) || undefined,
    parameter_uncertainty_pct: num(cal.parameter_uncertainty_pct),
    cat_frequency_cv_pct: num(cal.cat_frequency_cv_pct),
    large_severity_cap: positive(cal.large_severity_cap),
    cat_pml: positive(cal.cat_pml),
    opening_reserves: num(cal.opening_reserves),
    reserve_development_pct: num(cal.reserve_development_pct),
    reserve_cv_pct: num(cal.reserve_cv_pct, 8),
    risk_profile: profilePayload(cal.risk_profile),
  };
}

/** The assumptions as the engine takes them — shared by a run and a structuring sweep. */
export function assumptionsBody(assumptions) {
  return {
    trials: num(assumptions.trials) || undefined,
    seed: Math.trunc(num(assumptions.seed)),
    expense_ratio_pct: num(assumptions.expense_ratio_pct),
    reinsurer_expense_pct: num(assumptions.reinsurer_expense_pct),
    capital_percentile: num(assumptions.capital_percentile) || undefined,
    cost_of_capital_pct: num(assumptions.cost_of_capital_pct),
    available_capital: positive(assumptions.available_capital),
    investment_yield_pct: num(assumptions.investment_yield_pct),
    asset_return_volatility_pct: num(assumptions.asset_return_volatility_pct),
    horizon_years: Math.max(1, Math.trunc(num(assumptions.horizon_years, 1))),
    premium_growth_pct: num(assumptions.premium_growth_pct),
    loss_trend_pct: num(assumptions.loss_trend_pct),
    credit_pd_pct: num(assumptions.credit_pd_pct),
    credit_lgd_pct: num(assumptions.credit_lgd_pct),
    risk_load_sd_multiple: num(assumptions.risk_load_sd_multiple),
    min_rate_on_line_pct: num(assumptions.min_rate_on_line_pct),
    domicile: assumptions.domicile || null,
    regulatory_required_capital: positive(assumptions.regulatory_required_capital),
    invested_assets: positive(assumptions.invested_assets),
  };
}

/** The request body for one run: the loss model, the two programmes, the variants, the scenarios and the assumptions. */
export function runBody({ cal, current, proposed, assumptions, scan, scenarios }) {
  const proposedPayload = payloadStructure(proposed);
  return {
    portfolio: portfolioBody(cal),
    structures: {
      current: payloadStructure(current),
      proposed: proposedPayload,
    },
    variants: scan === 'none' ? {} : scanVariants(scan, proposedPayload),
    scenarios: scenarioPayload(scenarios),
    assumptions: assumptionsBody(assumptions),
  };
}

/* ── The Handbook's scenarios ─────────────────────────────────────────── */

/** The desk's scenario list, seeded from the API's standard set: each on, at its default figure. */
export function seedScenarios(defaults) {
  return (defaults?.scenarios || []).map((d) => ({ ...d, on: true, value: d.param.value }));
}

/** The engine's { label: overrides } for the scenarios that are on. */
export function scenarioPayload(list) {
  const out = {};
  for (const s of list || []) {
    if (!s.on) continue;
    out[s.label] = { ...(s.fixed || {}), [s.param.key]: num(s.value, s.param.value) };
  }
  return out;
}

/** How a programme stands against the capital — the word, its tone, and what it means. */
export const STANDINGS = {
  holds: { label: 'Holds', tone: 'ok', text: 'The capital holds through the year: above the first action level, and expected to stay there.' },
  strained: { label: 'Strained', tone: 'warn', text: 'A real chance of dropping below the first action level in the year — one in four or worse — or a 1-in-10 year ends below it.' },
  breach: { label: 'Breach', tone: 'fail', text: 'Already below the first action level, or expected to be there by the year end.' },
};

/* ── What the desk models: a standalone book, one contract, or the portfolio ── */

export const SCOPES = [
  {
    key: 'standalone',
    label: 'Standalone model',
    kicker: 'From scratch',
    text: 'Type the book’s figures yourself — premium, loss ratio, event rates. Nothing is read from a placement, and the programme starts empty.',
  },
  {
    key: 'contract',
    label: 'One contract',
    kicker: 'From a placement',
    text: 'Read the loss model and the programme in force from one placement on the book, then test changes against it.',
  },
  {
    key: 'portfolio',
    label: 'Whole portfolio',
    kicker: 'Every placement',
    text: 'Every placement with a premium, combined into one book — every programme’s layers responding to the same events. Narrow it to a selection if you like.',
  },
];

/** The scope a URL names: ?scope= and ?placements= together. */
export function resolveMode(scope, selection) {
  if (scope === 'standalone') return 'standalone';
  if (scope === 'portfolio') return 'portfolio';
  if (selection?.length) return selection.length === 1 ? 'contract' : 'portfolio';
  return 'unchosen';
}

/** A blank loss model for a standalone book: the API's fallbacks, the premium left to type. */
export function blankCalibration(defaults) {
  const d = defaults?.calibration || {};
  return {
    subject_premium: '',
    expected_loss_ratio_pct: d.expected_loss_ratio_pct ?? 65,
    large_loss_threshold: d.large_loss_threshold ?? 250000,
    large_frequency: d.large_frequency ?? 3,
    large_severity_mean: d.large_severity_mean ?? 500000,
    cat_frequency: d.cat_frequency ?? 0.2,
    cat_severity_mean: d.cat_severity_mean ?? 2500000,
    attritional_cv_pct: d.attritional_cv_pct ?? 12,
    parameter_uncertainty_pct: d.parameter_uncertainty_pct ?? 10,
    cat_frequency_cv_pct: d.cat_frequency_cv_pct ?? 20,
    large_severity_cap: '',
    cat_pml: '',
    opening_reserves: d.opening_reserves ?? 0,
    reserve_development_pct: d.reserve_development_pct ?? 0,
    reserve_cv_pct: d.reserve_cv_pct ?? 8,
  };
}

/** Whether a loss model can be run: the engine needs a positive subject premium. */
export const runnable = (cal) => num(cal?.subject_premium) > 0;

/* ── The loss model's fields, grouped the way a broker thinks about them ── */

export const CAL_GROUPS = [
  {
    label: 'Premium and loss ratio',
    note: 'The subject premium the covers are rated on, and the all-in loss ratio the book is expected to run at.',
    fields: [
      { key: 'subject_premium', label: 'Subject premium (GNPI)', kind: 'money' },
      { key: 'expected_loss_ratio_pct', label: 'Expected loss ratio %', kind: 'pct' },
    ],
  },
  {
    label: 'Large losses',
    note: 'Single events above the threshold — how often they come and how big they are on average. Their tail is Pareto, so a few big ones are always possible.',
    fields: [
      { key: 'large_loss_threshold', label: 'Large-loss threshold', kind: 'money' },
      { key: 'large_frequency', label: 'Large losses a year', kind: 'num' },
      { key: 'large_severity_mean', label: 'Average large loss', kind: 'money' },
      { key: 'large_severity_cap', label: 'Largest single loss', kind: 'money', placeholder: '40 × average' },
    ],
  },
  {
    label: 'Catastrophe events',
    note: 'Events that hit many risks at once. The PML caps the biggest one the model will produce.',
    fields: [
      { key: 'cat_frequency', label: 'Cat events a year', kind: 'num' },
      { key: 'cat_severity_mean', label: 'Average cat loss', kind: 'money' },
      { key: 'cat_pml', label: 'Cat PML', kind: 'money', placeholder: '40 × average' },
    ],
  },
  {
    label: 'Prior-year reserves',
    note: 'The loss reserve the year opens with and how it is expected to run off — the largest liability on the balance sheet, and the Handbook’s second risk. Zero switches it off.',
    fields: [
      { key: 'opening_reserves', label: 'Opening loss reserves', kind: 'money', title: 'Outstanding losses on prior years, net of the reinsurance they already carry. Seeded from the claims bordereaux’ outstanding where there are any.' },
      { key: 'reserve_development_pct', label: 'Expected run-off deviation %', kind: 'pct', title: 'How the reserve is expected to develop over the year: + is adverse (the ultimate grows), − is a release.' },
      { key: 'reserve_cv_pct', label: 'Reserve uncertainty %', kind: 'pct', title: 'Coefficient of variation of the one-year development factor — process, parameter and specification uncertainty in one dial.' },
    ],
  },
  {
    label: 'How sure we are',
    note: 'Wider settings make bad years worse across the whole book at once. Fewer bordereau years observed means wider by default.',
    fields: [
      { key: 'attritional_cv_pct', label: 'Attritional volatility %', kind: 'pct', title: 'Year-to-year swing of the small-loss cost, as a coefficient of variation.' },
      { key: 'parameter_uncertainty_pct', label: 'Parameter uncertainty %', kind: 'pct', title: 'Coefficient of variation of the year factor that moves the attritional cost and the large-loss frequency together — parameter risk and common shock in one dial. Poisson counts become negative binomial.' },
      { key: 'cat_frequency_cv_pct', label: 'Cat rate uncertainty %', kind: 'pct', title: 'Coefficient of variation of the cat-frequency mixing factor. 0 is a plain Poisson count.' },
    ],
  },
];

/* ── The assumptions, grouped by who owns them ─────────────────────────── */

export const CAPITAL_PERCENTILES = [
  { value: 95, label: '1-in-20 year (95th)' },
  { value: 99, label: '1-in-100 year (99th)' },
  { value: 99.5, label: '1-in-200 year (99.5th)' },
  { value: 99.6, label: '1-in-250 year (99.6th)' },
  { value: 99.8, label: '1-in-500 year (99.8th)' },
  { value: 99.9, label: '1-in-1000 year (99.9th)' },
];

export const ASSUMPTION_GROUPS = [
  {
    key: 'insurer',
    label: 'The insurer',
    note: 'The capital the buyer holds, the return it needs on it, and what running the book costs.',
    fields: [
      { key: 'available_capital', label: 'Available capital', kind: 'money', placeholder: 'the gross 1-in-N loss', title: 'Leave blank to hold exactly the capital the gross book needs at the chosen percentile — then every structure’s solvency reads against that.' },
      { key: 'domicile', label: 'Country of domicile', kind: 'domicile', title: 'The insurer’s home regulator sets the capital regime — Solvency II, risk-based capital, a solvency margin or a minimum capital — that 05 Capital and 07 Scenarios read the capital against. Seeded from the cedant’s domicile on the register.' },
      { key: 'regulatory_required_capital', label: 'Regulatory requirement, if known', kind: 'money', placeholder: 'the modelled capital stands in', title: 'The SCR, the ACL risk-based capital, the required solvency margin or the minimum capital from the last return, in the book’s currency. Leave it blank and the modelled capital at the regime’s own calibration stands in for it.' },
      { key: 'capital_percentile', label: 'Capital measured at', kind: 'percentile', title: 'Required capital is the underwriting loss at this return period (VaR); the tail mean beyond it (TVaR) is reported alongside. 1-in-200 is the Solvency II standard.' },
      { key: 'cost_of_capital_pct', label: 'Cost of capital % (the hurdle)', kind: 'pct', title: 'The return the insurer needs on capital. Reinsurance is worth buying when the capital it frees would cost more than this to hold.' },
      { key: 'expense_ratio_pct', label: 'Expense ratio %', kind: 'pct', title: 'Acquisition and operating cost as a share of gross premium.' },
      { key: 'invested_assets', label: 'Invested assets', kind: 'money', placeholder: 'capital + reserves + half the premium', title: 'What the asset-side scenario writes down. Leave it blank for the capital held plus the opening reserves and half the year’s premium.' },
    ],
  },
  {
    key: 'reinsurers',
    label: 'The reinsurers',
    note: 'How a cover without a quote is priced, and the chance the panel fails to pay.',
    fields: [
      { key: 'risk_load_sd_multiple', label: 'Risk load × σ', kind: 'num', title: 'Technical price for an unquoted cover: expected recovery plus this many standard deviations, floored at the minimum rate on line, grossed up for expenses (Kreps).' },
      { key: 'min_rate_on_line_pct', label: 'Minimum rate on line %', kind: 'pct', title: 'A remote layer is never priced below this share of its limit.' },
      { key: 'reinsurer_expense_pct', label: 'Reinsurer expenses %', kind: 'pct', title: 'Loaded onto the technical price, and charged against the reinsurer’s result.' },
      { key: 'credit_pd_pct', label: 'Default probability %', kind: 'pct', title: 'One-year probability that the panel fails to pay, seeded from the signed panel’s ratings. Defaults cluster in the worst 1% of gross years.' },
      { key: 'credit_lgd_pct', label: 'Loss given default %', kind: 'pct', title: 'The share of that year’s recoveries lost when a default happens.' },
    ],
  },
  {
    key: 'projection',
    label: 'The projection',
    note: 'One treaty year, or up to five with the book growing and losses trending while the programme stays fixed.',
    fields: [
      { key: 'horizon_years', label: 'Horizon', kind: 'horizon' },
      { key: 'premium_growth_pct', label: 'Growth % a year', kind: 'pct', title: 'Volume growth: more premium, more risks, bigger cat events.' },
      { key: 'loss_trend_pct', label: 'Loss trend % a year', kind: 'pct', title: 'Severity inflation the premium does not keep up with.' },
      { key: 'investment_yield_pct', label: 'Investment yield %', kind: 'pct', title: 'Earned on the surplus and on half the year’s net premium.' },
      { key: 'asset_return_volatility_pct', label: 'Asset return volatility %', kind: 'pct', title: 'How much the yield swings a year — the asset side of the balance sheet, drawn once a year and shared by every programme. Zero holds the yield fixed.' },
    ],
  },
  {
    key: 'simulation',
    label: 'The simulation',
    note: 'How many treaty years to simulate, and the seed — the same seed always reproduces the same years.',
    fields: [
      { key: 'trials', label: 'Simulated years', kind: 'num', title: '500 to 20,000. More years give smoother tails and a slower run.' },
      { key: 'seed', label: 'Seed', kind: 'num', title: 'Change it to check a conclusion holds on a different draw of years.' },
    ],
  },
];

/* ── Plain words for the figures the results carry ──────────────────────── */

export const GLOSSARY = {
  required_capital: 'The underwriting loss at the chosen return period (value at risk). What the insurer must hold to survive that year.',
  tvar: 'The average loss in the years beyond the value-at-risk point — how bad the tail is once you are in it.',
  expected_result: 'Net premium less net losses and expenses, averaged over every simulated year.',
  volatility: 'The standard deviation of the underwriting result across the simulated years.',
  earnings_at_risk: 'The underwriting loss in a 1-in-10 year.',
  capital_relief: 'The capital the gross book needs, less what this structure needs — what the reinsurance frees up.',
  solvency: 'Available capital as a share of the capital the structure needs. Below 100% the insurer is under-capitalised for the structure.',
  ruin: 'The share of simulated years whose underwriting loss exceeds the available capital.',
  epd: 'Expected policyholder deficit: the average shortfall beyond the available capital, as a share of premium.',
  roe: 'Expected underwriting result over the capital required.',
  eva: 'Economic value added: the expected result less the cost of holding the required capital at the hurdle rate.',
  ceded_premium: 'Everything paid to reinsurers in a year, including expected reinstatement premium.',
  expected_recoveries: 'What the reinsurers pay back, on average.',
  expected_cost: 'The ceded margin: premium paid, less recoveries and commission received. What the cover really costs in expectation.',
  coc_saved: 'The capital relief multiplied by the hurdle rate — what holding that capital would have cost.',
  value_added: 'The cost of capital saved, less the expected cost of the cover and the expected credit loss. Positive means the cover is cheaper than holding the capital.',
  implied_coc: 'The expected cost of the cover per unit of capital it frees. Below the hurdle the cover is the cheaper source of capital.',
  erd: 'Expected reinsurer deficit: the reinsurer’s expected loss on the deal as a share of premium. At least 1% is the usual risk-transfer test.',
  ten_ten: 'The share of years in which the reinsurer loses at least 10% of the premium. The “10-10” rule of thumb wants this at 10% or more.',
  marginal_relief: 'The extra capital the programme would need without this one cover, on the same simulated years.',
  payback: 'Years of premium it takes to pay for one full limit.',
  rol: 'Rate on line: premium as a share of limit. Loss on line: expected recovery as a share of limit.',
  prob_attach: 'The share of years in which the cover pays anything; exhaust is the share in which it pays its full capacity.',
  combined_ratio: 'Net losses plus expenses, as a share of net premium.',
  consumption: 'The average underwriting loss in the years there is one.',
  regime_ratio: 'The regulator’s own ratio: the capital held over the requirement — own funds over the SCR, total adjusted capital over the ACL, capital available over the minimum. The requirement is the modelled capital at the regime’s calibration unless it is typed on 03.',
  regime_required: 'The regulatory requirement the ratio divides by: typed on 03 Assumptions, else the modelled capital at the regime’s own calibration read as the amount that puts the ratio at its reference level.',
  strain: 'The loss the insurer could take in the year before its ratio drops to the first action level — the Handbook’s “maximum withstandable strain”. Negative means it is already below.',
  prob_breach: 'The share of simulated years whose result takes the ratio below the first action level by the year end.',
  prob_control: 'The share of simulated years whose result takes the ratio down to the level at which the regulator takes control.',
  ratio_end: 'The ratio at the year end, after the year’s result: on average, in a 1-in-10 year, and in a 1-in-100 year.',
  standing: 'Holds, strained or breach: where the capital stands against the regime’s first action level — or, with no domicile chosen, against the desk’s own capital standard.',
  leverage: 'Premium and reserves as a share of the capital held — the leverage the Handbook lists among the regulatory monitors. The IRIS tests flag net premium above 300% and gross premium above 900% of surplus.',
  reserve_development: 'The change in the prior-year ultimate over the year: what the run-off is expected to cost, and how bad a 1-in-10, 1-in-100 or 1-in-200 development is.',
  scenario_surplus: 'The surplus at the end of the horizon under the scenario: the expected figure, and after the slash the 1-in-100 year.',
  net_income: 'The year’s underwriting result plus investment income on the capital held and half the net premium — the yield, with its volatility, drawn once a year and shared by every programme.',
  solvency_end: 'The capital held plus the year’s net income, over the capital the programme needs: where the insurer stands at the year end, in an average year and in a bad one.',
  net_volatility: 'How much the net underwriting result swings from year to year — its standard deviation across the simulated years. The frontier’s horizontal axis.',
  ceded_cost: 'What the cover is expected to cost: premium paid to reinsurers, less the recoveries and commission expected back. The frontier’s vertical axis.',
  appetite: 'The stated risk tolerance: every programme is read against each limit in turn, and fits only when it passes them all.',
  efficient: 'No other programme tested is both cheaper and steadier. The dotted line joins the efficient ones.',
  defensible: 'Of the programmes that fit the appetite, the range of retentions each family fits at — the room to negotiate in — and the cheapest of them as the pick.',
  stress_standing: 'How the programme stands after one thing goes wrong — the cat PML event, a reserve shock, rates running hot — on the same simulated years and the same capital.',
  surplus: 'A surplus treaty keeps one line of every risk and cedes the part above it, up to a number of lines: big risks cede more, small ones nothing. The book’s risk profile on 01 Scope decides how much.',
  risk_profile: 'The sums insured the book is written on, as bands with their share of the premium — what a surplus treaty responds to. Seeded from the modelling pack when the placement carries one; otherwise assumed from the large-loss calibration.',
  asset_volatility: 'How much the investment yield swings a year. Zero holds the yield fixed; a positive figure makes the net income and the surplus path carry asset risk too.',
};

/* ── 08 Structuring: the appetite, the grid, the sweep ──────────────────── */

/** The appetite's fields, in the words the board would use; a blank limit turns its test off. */
export const APPETITE_FIELDS = [
  { key: 'max_ruin_pct', label: 'Chance of ruin, at most', unit: '%', kind: 'pct2', step: 0.1, title: 'The share of simulated years whose underwriting loss exceeds the capital held. 0.5% is one year in two hundred.' },
  { key: 'max_loss_1in100_pct_of_capital', label: '1-in-100 net loss, at most', unit: '% of capital', kind: 'pct', step: 1, title: 'How much of the capital held a 1-in-100 year may eat, net of the programme.' },
  { key: 'min_solvency_ratio_pct', label: 'Solvency ratio, at least', unit: '%', kind: 'pct', step: 1, title: 'The capital held over the capital the programme needs at the chosen percentile. 100% is holding exactly the 1-in-N loss.' },
  { key: 'max_combined_ratio_1in10_pct', label: '1-in-10 combined ratio, at most', unit: '%', kind: 'pct', step: 1, title: 'The combined ratio in a bad year — the earnings volatility the board will accept.' },
  { key: 'max_cost_pct_of_premium', label: 'Cost of the cover, at most', unit: '% of premium', kind: 'pct', step: 0.5, title: 'A budget: the expected cost of the cover as a share of the subject premium. Leave it blank for no budget.' },
];

export const FAMILY_TONES = { xol: 'xol', quota_share: 'qs', surplus: 'surplus', blend: 'blend' };

/** The stated appetite the stage starts from: the API's defaults. */
export function seedAppetite(defaults) {
  return { ...(defaults?.appetite || {}) };
}

/** The appetite as the API takes it: numbers, blanks as null, the standing toggle as a boolean. */
export function appetitePayload(appetite) {
  const out = {};
  for (const f of APPETITE_FIELDS) {
    const v = appetite?.[f.key];
    out[f.key] = v === '' || v == null ? null : num(v);
  }
  out.require_standing_holds = appetite?.require_standing_holds !== false;
  return out;
}

/** Three significant figures, so a swept retention reads as a round number. */
export const sig3 = (v) => {
  const n = num(v);
  if (!(n > 0)) return 0;
  const mag = 10 ** (Math.floor(Math.log10(n)) - 2);
  return Math.round(n / mag) * mag;
};

/**
 * The grid the sweep starts from, read off the book: the retention range
 * around the current tower's retention (or a share of the premium when there
 * is no tower), the tower's top, the current tower's reinstatements and the
 * quota share's terms where there are any.
 */
export function defaultGrid({ cal, current, defaults }) {
  const g = defaults?.structuring || {};
  const premium = num(cal?.subject_premium);
  const layers = (current?.xol_layers || []).filter((l) => num(l.limit) > 0)
    .map((l) => ({ attachment: num(l.attachment), limit: num(l.limit), reinstatements: l.reinstatements }))
    .sort((a, b) => a.attachment - b.attachment);
  const retention = layers.length ? layers[0].attachment : 0;
  const top = layers.length ? Math.max(...layers.map((l) => l.attachment + l.limit)) : 0;
  const pml = num(cal?.cat_pml);
  const from = retention > 0 ? retention * 0.5 : premium * 0.02;
  const to = retention > 0 ? retention * 2 : premium * 0.1;
  const towerTop = top > 0 ? Math.max(top, to * 1.5) : (pml > 0 ? pml : Math.max(premium * 0.3, num(cal?.cat_severity_mean) * 3, to * 2));
  const qs = current?.quota_share;
  return {
    families: ['xol', 'quota_share', 'surplus', 'blend'],
    steps: g.steps ?? 5,
    retention_from: sig3(from),
    retention_to: sig3(to),
    tower_top: sig3(towerTop),
    reinstatements: layers.length && layers[0].reinstatements != null && layers[0].reinstatements !== '' ? String(layers[0].reinstatements) : String(g.reinstatements ?? 1),
    cession_from: g.cession_from ?? 10,
    cession_to: g.cession_to ?? 50,
    commission_pct: qs ? num(qs.commission_pct, g.commission_pct ?? 25) : (g.commission_pct ?? 25),
    surplus_lines: g.surplus_lines ?? 5,
    blend_cession_pct: qs && num(qs.cession_pct) > 0 ? num(qs.cession_pct) : (g.blend_cession_pct ?? 20),
  };
}

/** How many programmes the grid names, before the engine sees it. */
export function gridCount(grid) {
  const steps = Math.max(2, Math.min(8, Math.trunc(num(grid?.steps, 5))));
  return (grid?.families || []).length * steps;
}

/** What is wrong with the grid, in a sentence — or null when it can run. */
export function gridProblem(grid) {
  if (!grid) return 'No grid yet.';
  if (!grid.families?.length) return 'Turn at least one family on.';
  const from = num(grid.retention_from);
  const to = num(grid.retention_to);
  const needsTower = grid.families.includes('xol') || grid.families.includes('blend');
  const needsLine = needsTower || grid.families.includes('surplus');
  if (needsLine && !(from > 0 && to >= from)) return 'The retention range needs a “from” and a “to”, the second at least the first.';
  if (needsTower && !(num(grid.tower_top) > to)) return 'The top of the tower must sit above the highest retention.';
  if (grid.families.includes('quota_share') && !(num(grid.cession_from) > 0 && num(grid.cession_to) >= num(grid.cession_from))) return 'The cession range needs a “from” and a “to”.';
  return null;
}

/** The grid as the API takes it. */
export function gridPayload(grid) {
  const needsTower = grid.families.includes('xol') || grid.families.includes('blend');
  const r = grid.reinstatements === 'UNLIMITED' ? 'UNLIMITED' : Math.trunc(num(grid.reinstatements, 1));
  return {
    families: [...grid.families],
    steps: Math.max(2, Math.min(8, Math.trunc(num(grid.steps, 5)))),
    retention_from: num(grid.retention_from) > 0 ? num(grid.retention_from) : 1,
    retention_to: num(grid.retention_to) > 0 ? num(grid.retention_to) : 1,
    tower_top: needsTower ? num(grid.tower_top) : null,
    reinstatements: r,
    cession_from: num(grid.cession_from, 10),
    cession_to: num(grid.cession_to, 50),
    commission_pct: num(grid.commission_pct, 25),
    surplus_lines: num(grid.surplus_lines, 5),
    blend_cession_pct: num(grid.blend_cession_pct, 20),
  };
}

/**
 * The stresses every candidate is re-run under, taken from 07 Scenarios so
 * the figures agree: the cat PML event, the reserve shock and the rates
 * case at whatever figure the desk has them, on or off.
 */
export const STRESS_KEYS = { cat: 'A major cat year', reserves: 'Reserves deteriorate', rates: 'Rates inadequate' };
export function stressesFrom(scenarios) {
  const out = {};
  for (const s of scenarios || []) {
    const label = STRESS_KEYS[s.key];
    if (!label) continue;
    out[label] = { ...(s.fixed || {}), [s.param.key]: num(s.value, s.param.value) };
  }
  return out;
}

/** The request body for a structuring sweep. */
export function structuringBody({ cal, current, proposed, assumptions, appetite, grid, scenarios }) {
  const structures = { current: payloadStructure(current) };
  if (proposed && !structuresEqual(current, proposed)) structures.proposed = payloadStructure(proposed);
  return {
    portfolio: portfolioBody(cal),
    structures,
    grid: gridPayload(grid),
    appetite: appetitePayload(appetite),
    stresses: stressesFrom(scenarios),
    assumptions: assumptionsBody(assumptions),
  };
}
