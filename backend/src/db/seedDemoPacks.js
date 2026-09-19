/*
 * Three demo placements, every screen filled, each with a renewal pack.
 *
 *   DEMO-27-QS        Iberia Mutua       proportional only (Quota Share)
 *   DEMO-27-XL        Alzey Versicherung non-proportional only (Risk & CAT XL, three layers)
 *   DEMO-27-COMBINED  Tyrrhenia Assicura both: a quota share and a two-layer XL
 *
 * Each carries its structures to quote, an expiring structure, premium and
 * claims bordereaux, data on every modelling screen (triangles, straight
 * stats, loss lists and selections, dev factors, summaries, profiles, CRESTA,
 * event loss tables, the NP premiums, LDFs, excess dev factors and historical
 * performance), and a renewal pack version cut from it with its Excel and
 * PDF stored — approved, or awaiting the Senior Broker, so the negotiation
 * and the approval can both be shown.
 *
 * The figures are invented but consistent: paid + OS = incurred, the straight
 * stats follow the triangle diagonals, the loss lists sum into the selections.
 * Idempotent: the three placements are seeded only while DEMO-27-QS does not exist.
 */

import { query } from './pool.js';
import { loadContext } from '../modules/packs/packs.routes.js';
import { buildPack } from '../modules/packs/packs.build.js';
import { presentPack, packFilename } from '../modules/packs/packs.present.js';
import { packToXlsx } from '../modules/packs/packs.xlsx.js';
import { packToPdf } from '../modules/packs/packs.pdf.js';
import { modellingBases, modellingGroups, requiredScreens } from '../../../frontend/src/modelling/workflow.js';

const K = 1000;
const YEARS = [2022, 2023, 2024, 2025, 2026]; // experience from 2022; renewal 2027
const RENEWAL = 2027;
const STAT_YEARS = [...YEARS, RENEWAL];
const COB = 'Property';

/** The modelling tool's peril mode for a non-proportional treaty type name. */
const npCoverMode = (name) => {
  const n = String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (n === 'RISK XL') return 'RISK';
  if (n === 'CAT XL') return 'CAT';
  return 'BOTH';
};

const r2 = (n) => Math.round(n * 100) / 100;

/* ── The three placements ── */

const PROP_TERMS = {
  treatyType: 'Quota Share', qsLimit: 5_000_000, retentionPct: 30, surplusMaxRetention: '', numLines: '',
  commissionPct: 30, epi: 12_000_000, quotaShareEpi: 12_000_000, surplusEpi: '', epiSplit: [],
  eventLimit: 15_000_000, aal: '', profitCommissionPct: 15, mgmtExpensesPct: 5, lpvPct: '', brokeragePct: 2.5, cashLossAdvice: 250_000,
  commissionMode: 'fixed', commissionSurplusPct: '', slidingMinLossRatio: '', slidingMaxLossRatio: '',
  slidingMinCommission: '', slidingMaxCommission: '', slidingTable: [], provisionalCommissionPct: '', lcfYears: 3,
  lossPartEnabled: true, minLossRatioPct: 80, maxLossRatioPct: 120, reinsurerSharePct: 50, lpSlides: [],
  taxesPct: 0.5, lossCapPct: 250,
};

const layer = (name, attachment, limit, premium, rate, extra = {}) => ({
  id: null, name, type: 'XoL', region: '', attachment, limit, order: '100', premium,
  risk: true, cat: true, reinstatements: '1', reinstatementPct: 100, egnpi: 18_000_000, rate, aad: '',
  attachLrPct: '', limitLrPct: '', rolPct: '', aggLimit: '', aggDeductible: '', ...extra,
});

const XL_LAYERS = [
  layer('Layer 1', 1_000_000, 4_000_000, 720_000, 4.0),
  layer('Layer 2', 5_000_000, 10_000_000, 540_000, 3.0),
  layer('Layer 3', 15_000_000, 25_000_000, 450_000, 2.5),
];

const propStructure = (cobs) => ({ basis: 'PROP', npTreatyType: '', agg: { franchiseDeductible: false, structuredDeal: false }, layers: [], prop: { ...PROP_TERMS }, cobs: cobRows(cobs, 1) });
const npStructure = (cobs, layers) => ({ basis: 'NP', npTreatyType: 'Risk & CAT XL', agg: { franchiseDeductible: false, structuredDeal: false }, layers, prop: {}, cobs: cobRows(cobs, layers.length) });
const cobRows = (cobs, n) => cobs.map((cob) => ({ cob, limit: 30_000_000, layers: Array(n).fill(true), manual: Array(n).fill(false), innerLimit: '', innerDeductible: '' }));

const DEMOS = [
  {
    reference: 'DEMO-27-QS', cedant: 'Iberia Mutua', class: `${COB} Quota Share`, est_gwp: 12.0e6,
    structures: (cobs) => [propStructure(cobs)],
    expiring: { basis: 'PROP', prop: { ...PROP_TERMS, commissionPct: 28, epi: 10_800_000, quotaShareEpi: 10_800_000 }, layers: [] },
    pack: 'approved',
  },
  {
    reference: 'DEMO-27-XL', cedant: 'Alzey Versicherung', class: `${COB} Risk & CAT XL`, est_gwp: 1.71e6,
    structures: (cobs) => [npStructure(cobs, XL_LAYERS)],
    expiring: { basis: 'NP', prop: {}, layers: XL_LAYERS.map((l) => ({ ...l, premium: Math.round(l.premium * 0.92) })) },
    pack: 'submitted',
  },
  {
    reference: 'DEMO-27-COMBINED', cedant: 'Tyrrhenia Assicura', class: `${COB} Quota Share`, est_gwp: 13.2e6,
    structures: (cobs) => [propStructure(cobs), npStructure(cobs, XL_LAYERS.slice(0, 2))],
    expiring: { basis: 'BOTH', prop: { ...PROP_TERMS, commissionPct: 27.5 }, layers: XL_LAYERS.slice(0, 2).map((l) => ({ ...l, premium: Math.round(l.premium * 0.9) })) },
    pack: 'approved',
  },
];

/* ── Screen data, built from a few base series ── */

/** Base figures per UW year: premium, paid, OS (USD), growing with the book. */
function baseSeries(scale) {
  return YEARS.map((y, i) => {
    const premium = Math.round((9_400 + i * 780) * K * scale);
    const paid = Math.round(premium * [0.58, 0.61, 0.49, 0.42, 0.18][i]);
    const os = Math.round(premium * [0.02, 0.05, 0.09, 0.14, 0.17][i]);
    return { year: y, premium, paid, os, incurred: paid + os };
  });
}

/** A development pattern over dev years (cumulative share of ultimate). */
const PREMIUM_PATTERN = [0.82, 0.96, 0.99, 1.0, 1.0];
const PAID_PATTERN = [0.32, 0.61, 0.82, 0.93, 0.98];
const OS_PATTERN = [0.45, 0.42, 0.25, 0.12, 0.05]; // OS as share of ultimate incurred, running off

/** Triangle cells for one measure: cumulative by origin year × development year, within the triangle. */
function triangleCells(series, pattern, ultimateOf, jitter = 0) {
  const cells = [];
  series.forEach((row, r) => {
    const n = YEARS.length - r; // development years observed for this origin
    for (let c = 0; c < n; c += 1) {
      const wobble = 1 + (((r * 7 + c * 3 + jitter) % 5) - 2) * 0.006;
      cells.push({ origin_year: row.year, dev_months: (c + 1) * 12, cum_value: Math.round(ultimateOf(row) * pattern[c] * wobble) });
    }
  });
  return cells;
}

const triangle = (series, pattern, ultimateOf) => ({
  MODIFIED: { cells: triangleCells(series, pattern, ultimateOf, 1) },
  ACTUAL: { cells: triangleCells(series, pattern, ultimateOf, 2) },
});

/** Age-to-age factors from a pattern, and the chosen LDF/CDF rows a dev-factor screen stores. */
function devFactors(pattern, { premium = false } = {}) {
  const ldfs = pattern.map((p, i) => (i + 1 < pattern.length ? r2(pattern[i + 1] / p * 10000) / 10000 : 1.0));
  const cdfs = ldfs.map((_, i) => r2(ldfs.slice(i).reduce((a, f) => a * f, 1) * 10000) / 10000);
  return {
    factors: ldfs.map((ldf, i) => ({
      dev_month: (i + 1) * 12, actual_ldf: ldf, actual_cdf: cdfs[i], parametrized_ldf: ldf, parametrized_cdf: cdfs[i],
      chosen_source: 'SELECTED', chosen_ldf: ldf, chosen_cdf: cdfs[i],
    })),
    settings: {
      avg_method: 'VOLUME_WEIGHTED', proj_method: 'CHAIN_LADDER', chosen_base: 'LINK_RATIO', tail_factor: 1.0, bf_ielr: 0.65,
      excluded_ratios: [], excluded_for_year_window: `${YEARS[0]}:${YEARS.length}`,
      ...(premium ? { bf_percent_achieved: 1, bf_epi_per_year: YEARS.map(() => 0) } : {}),
    },
  };
}

const LARGE = [
  ['Textiles del Sur', 'Fire — spinning mill', 2022, '2022-03-14', 'Fire', 1_850_000, 0],
  ['Puerto Logística', 'Warehouse collapse', 2022, '2022-11-02', 'Collapse', 2_300_000, 150_000],
  ['Hotel Mediterráneo', 'Kitchen fire', 2023, '2023-06-21', 'Fire', 1_120_000, 80_000],
  ['Frutas Levante', 'Cold store failure', 2023, '2023-09-08', 'Machinery', 940_000, 260_000],
  ['Cementos Norte', 'Kiln explosion', 2024, '2024-02-17', 'Explosion', 2_650_000, 1_100_000],
  ['Centro Comercial Vega', 'Sprinkler leakage', 2024, '2024-10-30', 'Water', 610_000, 390_000],
  ['Bodegas Ribera', 'Fire — bottling hall', 2025, '2025-05-12', 'Fire', 1_480_000, 1_720_000],
  ['Metalúrgica Ebro', 'Press fire', 2025, '2025-12-03', 'Fire', 420_000, 980_000],
  ['Hospital San Juan', 'Electrical fire', 2026, '2026-04-19', 'Fire', 310_000, 1_540_000],
];
const CAT = [
  ['Storm Gloria', 'Windstorm — coastal portfolio', 2022, '2022-01-21', 'Windstorm', 3_900_000, 0],
  ['DANA — Valencia', 'Flood — Valencia region', 2023, '2023-09-04', 'Flood', 2_750_000, 350_000],
  ['Hail — Zaragoza', 'Hail — motor and property', 2024, '2024-07-16', 'Hail', 1_150_000, 220_000],
  ['DANA — Murcia', 'Flood — Murcia and Alicante', 2025, '2025-10-29', 'Flood', 4_200_000, 2_600_000],
  ['Storm Herminia', 'Windstorm — north coast', 2026, '2026-01-27', 'Windstorm', 620_000, 1_180_000],
];

function lossRows(list, inflationPct, scale) {
  return list.map(([insured, name, uwYear, date, cause, paid, os]) => {
    const p = Math.round(paid * scale);
    const o = Math.round(os * scale);
    const factor = r2(((1 + inflationPct / 100) ** (RENEWAL - uwYear)) * 10000) / 10000;
    return {
      insured_name: insured, loss_name: name, uw_year: uwYear, date_of_loss: date, date_reported: date,
      class_of_business: COB, paid: p, os: o, incurred: p + o,
      gross_loss: p + o, quota_share: 0, first_surplus: 0, second_surplus: 0, facultative: 0, net_retention: p + o,
      is_selected: true, inflation_factor: factor, cause_of_loss: cause,
    };
  });
}

function lossSelection(rows, threshold, inflationPct) {
  const selected = rows.filter((l) => l.is_selected !== false);
  const inflated = selected.map((l) => ({ ...l, inflated_incurred: r2(l.incurred * l.inflation_factor) }));
  const sorted = [...inflated].sort((a, b) => b.inflated_incurred - a.inflated_incurred);
  const xm = threshold;
  const alpha = 1.35;
  const points = [10, 25, 50, 100, 200, 250].map((rp) => ({ rp, loss: Math.round(xm * (rp * YEARS.length / selected.length) ** (1 / alpha)) }));
  const at = (rp) => points.find((p) => p.rp === rp)?.loss ?? null;
  return {
    inflation_mode: 'manual', inflation_rate_pct: inflationPct, inflation_to_year: RENEWAL,
    threshold, loadings: [{ name: 'IBNR', pct: 5 }, { name: 'Trend', pct: 2.5 }], total_loading_pct: 7.5,
    selected_count: selected.length, selected_losses: inflated,
    pareto_xm: xm, pareto_alpha: alpha, observation_years: YEARS.length, active_distribution: 'PARETO',
    distribution_fits: [{ key: 'PARETO', params: { xm, alpha }, ks: 0.11, paramStr: `xm=${xm}, α=${alpha}`, n: selected.length }],
    return_period_curve: { activeDist: 'PARETO', xm, yearsOvr: null, points, layer_burning_cost: { wEmp: 0.5, wModel: 0.5, rows: [] } },
    return_period_key_points: { rp10: at(10), rp25: at(25), rp50: at(50), rp100: at(100), rp200: at(200), rp250: at(250) },
    ranked: sorted.slice(0, 5).map((l, i) => ({ rank: i + 1, insured_name: l.insured_name, inflated_incurred: l.inflated_incurred })),
  };
}

function riskProfile() {
  const bands = [
    [0, 250_000, 6_200, 620_000_000, 4_030_000], [250_000, 1_000_000, 2_100, 1_050_000_000, 5_250_000],
    [1_000_000, 5_000_000, 640, 1_280_000_000, 4_480_000], [5_000_000, 15_000_000, 110, 880_000_000, 2_200_000],
    [15_000_000, 50_000_000, 22, 550_000_000, 1_100_000], [50_000_000, 150_000_000, 4, 320_000_000, 480_000],
  ];
  return {
    [COB]: {
      bands: bands.map(([from, to, risks, tsi, prem]) => ({ from_amt: from, to_amt: to, no_of_risks: risks, total_sum_insured: tsi, gross_premium: prem })),
      c_value: 3.5, pml_percentage: 100, selected_curve: 'Y3', custom_b: null, gross_loss_ratio: 100,
    },
  };
}

function claimsProfile() {
  const bands = [
    [0, 25_000, 1_840, 12_400_000, 3_100_000], [25_000, 100_000, 310, 15_800_000, 2_900_000],
    [100_000, 500_000, 74, 16_300_000, 2_100_000], [500_000, 2_000_000, 18, 17_100_000, 1_400_000], [2_000_000, 10_000_000, 5, 14_900_000, 600_000],
  ];
  return {
    [COB]: {
      bands: bands.map(([from, to, n, inc, prem]) => ({ from_amt: from, to_amt: to, no_of_claims: n, total_sum_insured: inc * 40, aggregate_incurred: inc, gross_premium: prem })),
    },
  };
}

const cresta = () => ({
  combined: false,
  zones: [
    ['ES-01', 'Andalucía', 620, 410, 40, 380, 60], ['ES-02', 'Cataluña', 540, 380, 30, 520, 45], ['ES-03', 'Madrid', 210, 90, 25, 140, 30],
    ['ES-04', 'Valencia', 480, 690, 20, 610, 40], ['ES-05', 'Galicia', 130, 220, 10, 720, 20], ['ES-06', 'Murcia', 350, 460, 10, 300, 25],
  ].map(([id, name, eq, fl, srcc, ws, oth]) => ({ zone_id: id, zone_name: name, eq_agg: eq * 1e6, flood_agg: fl * 1e6, srcc_agg: srcc * 1e6, ws_agg: ws * 1e6, others_agg: oth * 1e6 })),
  distribution: { residential_bldg_pct: 32, commercial_bldg_pct: 24, commercial_cont_pct: 14, industrial_bldg_pct: 20, industrial_cont_pct: 10 },
});

const eventLossTables = () => ({
  vendor: 'Universe', modelVersion: '2026.2', perilSet: 'EQ, Flood, Windstorm',
  rows: [
    ['EQ-0001', 'Earthquake', 'ES-01 Andalucía', 250, 41_200_000, 28_840_000, 4_000_000, 4_000_000, 'Granada scenario'],
    ['FL-0142', 'Flood', 'ES-04 Valencia', 100, 23_600_000, 16_520_000, 4_000_000, 4_000_000, 'DANA footprint'],
    ['WS-0310', 'Windstorm', 'ES-05 Galicia', 50, 12_900_000, 9_030_000, 4_000_000, 4_000_000, ''],
    ['FL-0088', 'Flood', 'ES-06 Murcia', 25, 6_400_000, 4_480_000, 3_480_000, 3_480_000, ''],
    ['WS-0122', 'Windstorm', 'ES-02 Cataluña', 10, 3_100_000, 2_170_000, 1_170_000, 1_170_000, ''],
  ].map(([eventId, peril, region, returnPeriod, grossLoss, netQs, netXl, ultimateNetLoss, comment]) => ({ eventId, peril, region, returnPeriod, grossLoss, netQs, netXl, ultimateNetLoss, comment })),
  updatedAt: '2026-08-20T09:00:00.000Z',
});

function npPremiums(series) {
  const egnpi = [...series.map((s) => Math.round(s.premium * 1.5)), Math.round(series[series.length - 1].premium * 1.5 * 1.06)];
  const inflation = [4.5, 3.8, 3.2, 2.9, 2.6, 2.5];
  let cum = 1;
  const inflationRows = STAT_YEARS.map((y, i) => {
    cum = r2(cum * (1 + inflation[i] / 100) * 10000) / 10000;
    return { uwYear: y, inflationPct: inflation[i], cumulativeFactor: cum };
  });
  return {
    inflationMode: 'perYear', averageInflationPct: null,
    uwRows: STAT_YEARS.map((y, i) => ({ uwYear: y, egnpi: egnpi[i] })),
    inflationRows,
    rateRows: STAT_YEARS.map((y, i) => ({ uwYear: y, rateChangePct: [0, 2.5, 4.0, 6.5, 3.0, 2.0][i] })),
  };
}

function npLdf(rows, pattern) {
  const ldfs = pattern.map((p, i) => (i + 1 < pattern.length ? r2(pattern[i + 1] / p * 10000) / 10000 : 1.0));
  const cdfs = ldfs.map((_, i) => r2(ldfs.slice(i).reduce((a, f) => a * f, 1) * 10000) / 10000);
  const byYear = YEARS.map((y) => {
    const mine = rows.filter((l) => l.uw_year === y);
    const reported = mine.reduce((a, l) => a + l.incurred, 0);
    const age = RENEWAL - y - 1; // 0 for the newest year
    const cdf = cdfs[Math.min(age, cdfs.length - 1)];
    const ultimate = Math.round(reported * cdf);
    return { year: y, reported, cdf, ultimate, ibnr: ultimate - reported, count: mine.length };
  });
  return {
    manualLdfs: ldfs, manualLdfCount: ldfs.length, tailFactor: 1.0,
    factors: ldfs.map((ldf, i) => ({ dev_month: (i + 1) * 12, chosen_ldf: ldf, chosen_cdf: cdfs[i] })),
    ultimates: byYear,
    totalUltimate: byYear.reduce((a, r) => a + r.ultimate, 0),
    totalReported: byYear.reduce((a, r) => a + r.reported, 0),
    updatedAt: '2026-08-20T09:00:00.000Z',
  };
}

function npExcessDev(largeRows) {
  const ldfs = [1.42, 1.18, 1.07, 1.02, 1.0];
  const cdfs = ldfs.map((_, i) => r2(ldfs.slice(i).reduce((a, f) => a * f, 1) * 10000) / 10000);
  return {
    dataMode: 'DIRECT', projMethod: 'CHAIN_LADDER', avgMethod: 'VOLUME_WEIGHTED', chosenBase: 'LINK_RATIO', tailFactor: 1.0, ielr: 0.62,
    manualLosses: YEARS.map((y) => largeRows.filter((l) => l.uw_year === y).reduce((a, l) => a + l.incurred, 0)),
    manualLdfs: ldfs, manualLdfCount: ldfs.length, triCells: [],
    factors: ldfs.map((ldf, i) => ({ dev_month: (i + 1) * 12, chosen_source: 'SELECTED', chosen_ldf: ldf, chosen_cdf: cdfs[i], actual_ldf: ldf, actual_cdf: cdfs[i], parametrized_ldf: ldf, parametrized_cdf: cdfs[i] })),
    excluded: [], excludedForYearWindow: `${YEARS[0]}:${YEARS.length}`, updatedAt: '2026-08-20T09:00:00.000Z',
  };
}

function npHistorical(series) {
  const rows = [...series, { year: RENEWAL, premium: Math.round(series[series.length - 1].premium * 1.06), paid: 0, os: 0, incurred: 0 }];
  return {
    rows: rows.map((s) => {
      const premiums = Math.round(s.premium * 0.12);
      const claims = Math.round(s.incurred * 0.09);
      const lr = premiums ? r2((claims / premiums) * 100) : 0;
      return { uw_year: s.year, premiums, claims, egnpi: Math.round(s.premium * 1.5), result: premiums - claims, loss_ratio: lr, expense_ratio: 10, combined_ratio: r2(lr + 10) };
    }),
  };
}

function pricingYearly(series) {
  return {
    rows: series.flatMap((s) => {
      const ultPrem = Math.round(s.premium / PREMIUM_PATTERN[Math.min(RENEWAL - s.year - 1, 4)]);
      const ultLoss = Math.round(s.incurred / PAID_PATTERN[Math.min(RENEWAL - s.year - 1, 4)]);
      return [
        { uw_year: s.year, record_type: 'ACTUAL', ultimate_premium: s.premium, ultimate_loss: s.incurred, loss_ratio: r2(s.incurred / s.premium * 10000) / 10000 },
        { uw_year: s.year, record_type: 'PROJECTED', ultimate_premium: ultPrem, ultimate_loss: ultLoss, loss_ratio: r2(ultLoss / ultPrem * 10000) / 10000 },
      ];
    }),
    source: 'triangles', saved_at: '2026-08-20T09:00:00.000Z',
  };
}

const propTerms = () => ({
  mode: 'FIXED', fixed_commission_pct: 30, sliding_min_loss_ratio: 50, sliding_max_loss_ratio: 80, sliding_min_commission: 25, sliding_max_commission: 35,
  profit_commission_pct: 15, mgmt_expenses_pct: 5, lcf_years: 3, brokerage_pct: 2.5, taxes_pct: 0.5, loss_cap_pct: 250, aal: 0,
  lp_min_loss_ratio_pct: 80, lp_max_loss_ratio_pct: 120, lp_reinsurer_share_pct: 50,
});

/** Every modelling section for a placement, from one scale factor. */
function sectionsFor(scale) {
  const series = baseSeries(scale);
  const large = lossRows(LARGE, 3.0, scale);
  const cat = lossRows(CAT, 3.0, scale);
  return {
    triangle_premium: triangle(series, PREMIUM_PATTERN, (s) => s.premium / PREMIUM_PATTERN[Math.min(RENEWAL - s.year - 1, 4)]),
    triangle_paid: triangle(series, PAID_PATTERN, (s) => s.incurred / PAID_PATTERN[Math.min(RENEWAL - s.year - 1, 4)]),
    triangle_os: triangle(series, OS_PATTERN, (s) => s.incurred / PAID_PATTERN[Math.min(RENEWAL - s.year - 1, 4)]),
    straight_stats: {
      strip_large_cat: true, class_key: 'PROPERTY_NONCAT',
      stats: [...series.map((s) => ({ year: s.year, premium: s.premium, paid: s.paid, os: s.os })), { year: RENEWAL, premium: Math.round(series[4].premium * 1.06), paid: 0, os: 0 }],
    },
    large_losses: { report_date: '2026-06-30', losses: large },
    loss_selection_large: lossSelection(large, Math.round(500_000 * scale), 3.0),
    cat_losses: { report_date: '2026-06-30', losses: cat },
    loss_selection_cat: lossSelection(cat, Math.round(1_000_000 * scale), 3.0),
    dev_factors_premium: devFactors(PREMIUM_PATTERN, { premium: true }),
    dev_factors_paid: devFactors(PAID_PATTERN),
    dev_factors_os: devFactors([0.77, 0.87, 0.93, 0.97, 0.99]),
    dev_factors_incurred: devFactors([0.77, 0.87, 0.93, 0.97, 0.99]),
    pricing_yearly: pricingYearly(series),
    prop_terms: propTerms(),
    risk_profile: riskProfile(),
    claims_profile: claimsProfile(),
    cresta: cresta(),
    event_loss_tables: eventLossTables(),
    np_premiums: npPremiums(series),
    np_large_ldf: npLdf(large, [0.55, 0.78, 0.9, 0.97, 1.0]),
    np_cat_ldf: npLdf(cat, [0.6, 0.85, 0.95, 0.99, 1.0]),
    np_excess_dev: npExcessDev(large),
    np_historical: npHistorical(series),
  };
}

/* ── Bordereaux: the Data screen ── */

/** The occupancy categories of the retentions table, so the premium bordereau profiles by the same names. */
const RETENTIONS = {
  limit: 30_000_000,
  rows: [
    { klass: 'A', category: 'Residential', pct: 100 }, { klass: 'A', category: 'Commercial — offices and retail', pct: 100 },
    { klass: 'B', category: 'Light industrial', pct: 75 }, { klass: 'B', category: 'Warehousing', pct: 60 },
    { klass: 'C', category: 'Heavy industrial and chemical', pct: 40 }, { klass: 'C', category: 'Timber and textiles', pct: 25 },
  ],
};
const OCCUPANCIES = RETENTIONS.rows.map((r) => r.category);

function bordereaux(scale) {
  const series = baseSeries(scale);
  const premiumRows = [];
  series.forEach((s, yi) => {
    const n = 40;
    for (let i = 0; i < n; i += 1) {
      const si = Math.round((800_000 + ((i * 3_731) % 9_000_000)) * scale);
      premiumRows.push({
        policy_ref: `P-${s.year}-${String(i + 1).padStart(3, '0')}`, insured: `Insured ${s.year}/${i + 1}`, class_of_business: COB,
        territory: ['Andalucía', 'Cataluña', 'Madrid', 'Valencia'][i % 4], cresta: ['ES-01', 'ES-02', 'ES-03', 'ES-04', 'ES-05', 'ES-06'][i % 6],
        occupancy: OCCUPANCIES[i % OCCUPANCIES.length], uw_year: s.year,
        sum_insured_100: si, si_ceded: Math.round(si * 0.7), gross_premium_100: r2(s.premium / n / 0.7), premium_ceded: r2(s.premium / n),
      });
    }
    void yi;
  });
  const claimsRows = [];
  series.forEach((s) => {
    const n = 25;
    for (let i = 0; i < n; i += 1) {
      // The first row of each year carries a large loss (well over 5% of the ceded premium), the rest are attritional.
      const share = i === 0 ? 0.45 : (((i * 17) % 23 + 1) / 276) * 0.55;
      claimsRows.push({
        claim_ref: `C-${s.year}-${String(i + 1).padStart(3, '0')}`, policy_ref: `P-${s.year}-${String((i % 40) + 1).padStart(3, '0')}`,
        insured: `Insured ${s.year}/${(i % 40) + 1}`, class_of_business: COB, uw_year: s.year,
        date_of_loss: `${s.year}-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`,
        cause_of_loss: ['Fire', 'Water', 'Windstorm', 'Theft', 'Flood'][i % 5],
        paid: r2(s.paid * share), outstanding: r2(s.os * share),
      });
    }
  });
  const sum = (rows, k) => r2(rows.reduce((a, r) => a + (r[k] || 0), 0));
  return [
    { type: 'premium', file: 'premium_bordereau_2022-2026.csv', rows: premiumRows, start: '2022-01-01', end: '2026-12-31',
      summary: { label: 'Premium bordereau 2022–2026', premium: sum(premiumRows, 'premium_ceded'), state: 'reconciled' } },
    { type: 'claims', file: 'claims_bordereau_asat_30Jun2026.csv', rows: claimsRows, start: '2022-01-01', end: '2026-06-30',
      summary: { label: 'Claims bordereau as at 30 Jun 2026', paid: sum(claimsRows, 'paid'), outstanding: sum(claimsRows, 'outstanding'), incurred: r2(sum(claimsRows, 'paid') + sum(claimsRows, 'outstanding')), state: 'reconciled' } },
  ];
}

/* ── The checklist a version records, as the page would send it ── */

const PLACEMENT_SCREENS = [['detail', 'Treaty Detail'], ['expiring', 'Expiring Structure'], ['structure', 'Quote Structure'], ['retentions', 'Retentions'], ['data', 'Data']];

function screensRecordFor(structures, category, cobs) {
  const bases = modellingBases(category, structures, npCoverMode);
  const required = requiredScreens(bases);
  const rows = [
    ...PLACEMENT_SCREENS.map(([key, label]) => ({ key, label, group: 'Placement', scope: 'placement', done: [true], required: required.has(key) })),
    ...modellingGroups(bases).flatMap((g) => g.tabs.map(([key, label]) => ({
      key, label, group: g.label.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), scope: 'class', done: cobs.map(() => true), required: required.has(key),
    }))),
  ];
  const cells = rows.reduce((n, r) => n + r.done.length, 0);
  return { cobs, rows, filled: cells, total: cells, missing: [], required_missing: [] };
}

/* ── Seeding ── */

async function cutPack(placementId, record, userId) {
  const ctx = await loadContext(placementId);
  const snapshot = buildPack(ctx);
  snapshot.screens = record;
  const { rows } = await query(
    `INSERT INTO renewal_pack (placement_id, version, basis, template_version, snapshot, summary, changes, created_by, created_at)
     VALUES ($1, 1, $2, $3, $4, $5, '[]', $6, '2026-08-21T10:00:00Z') RETURNING *`,
    [placementId, snapshot.basis, snapshot.template_version, JSON.stringify(snapshot), JSON.stringify(snapshot.summary), userId],
  );
  const pack = rows[0];
  const presented = presentPack(pack);
  for (const [format, render] of [['xlsx', packToXlsx], ['pdf', packToPdf]]) {
    const buffer = await render(presented);
    await query(
      'INSERT INTO renewal_pack_file (pack_id, format, filename, bytes, content) VALUES ($1, $2, $3, $4, $5)',
      [pack.id, format, packFilename(pack, format), buffer.length, buffer],
    );
  }
  return pack;
}

/** A primary underwriter with an address at every reinsurer that has none. */
export async function seedUnderwriterContacts(users) {
  const { rows } = await query(
    `SELECT m.id, m.name FROM market m
     WHERE m.type = 'reinsurer' AND NOT EXISTS (SELECT 1 FROM market_contact c WHERE c.market_id = m.id)
     ORDER BY m.name`,
  );
  const first = ['Jo', 'Anders', 'Priya', 'Luca', 'Mei', 'Tomas', 'Aisha', 'Erik', 'Sofia', 'Daniel', 'Hana', 'Marco'];
  let n = 0;
  for (const m of rows) {
    const name = `${first[n % first.length]} ${m.name.split(' ')[0]}`;
    const domain = m.name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'reinsurer';
    await query(
      `INSERT INTO market_contact (market_id, name, email, role, is_primary, created_by)
       VALUES ($1, $2, $3, 'underwriter', TRUE, $4)
       ON CONFLICT DO NOTHING`,
      [m.id, name, `${name.split(' ')[0].toLowerCase()}.underwriting@${domain}.example`, users['admin@broking.local'] || null],
    );
    n += 1;
  }
  if (n) console.log(`seeded underwriter contacts: ${n}`);
  return n;
}

/**
 * Seed the three demo placements. `users` and `cedants` are the maps the seed
 * builds (email → id, cedant name → id). No-op once DEMO-27-QS exists.
 */
export async function seedDemoPacks(users, cedants) {
  const exists = await query("SELECT 1 FROM placement WHERE reference = 'DEMO-27-QS'");
  if (exists.rowCount) {
    console.log('demo packs already present — skipping');
    return 0;
  }
  const broker = users['broker@broking.local'];
  const edwin = users['edwin@broking.local'] || users['senior@broking.local'];
  const cobs = [COB];
  let scale = 1;
  for (const demo of DEMOS) {
    const structures = demo.structures(cobs);
    const { rows } = await query(
      `INSERT INTO placement (reference, cedant_id, class, inception, expiry, currency, est_gwp, status, notes, quote_structures, expiring_structure, created_by)
       VALUES ($1,$2,$3,'2027-01-01','2027-12-31','USD',$4,'PACK',$5,$6,$7,$8)
       ON CONFLICT (reference) DO NOTHING RETURNING id`,
      [demo.reference, cedants[demo.cedant], demo.class, demo.est_gwp,
        'Broker: Universe Broking · Experience from 2022 · Demo placement — every screen filled',
        JSON.stringify(structures), JSON.stringify(demo.expiring), broker],
    );
    if (!rows[0]) continue;
    const pid = rows[0].id;

    for (const b of bordereaux(scale)) {
      await query(
        `INSERT INTO bordereau (placement_id, type, source_file, period_start, period_end, parsed_rows, row_count, summary, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'2026-08-18T09:00:00Z')`,
        [pid, b.type, b.file, b.start, b.end, JSON.stringify(b.rows), b.rows.length, JSON.stringify(b.summary), broker],
      );
    }
    // The table of retentions by occupancy, and two special acceptances raised on the placement.
    await query('UPDATE placement SET retentions = $2 WHERE id = $1', [pid, JSON.stringify(RETENTIONS)]);
    for (const [type, title, detail, date, status] of [
      ['special_acceptance', 'Puerto Logística — port warehousing', 'Sum insured USD 42m exceeds the treaty limit; accepted for the 2027 period at the cedant\'s request.', '2027-01-01', 'agreed'],
      ['endorsement', 'Territorial extension — Canary Islands', 'Risks located in the Canary Islands to be covered from inception.', '2027-01-01', 'outstanding'],
    ]) {
      await query(
        'INSERT INTO amendment (placement_id, type, title, detail, effective_date, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [pid, type, title, detail, date, status, broker],
      );
    }
    // The programme rows behind the non-proportional structures: the layer
    // register the Premiums Table, the technical benchmark and the slip hang
    // off, plus the slip itself and a draft wording built from the library.
    const npLayers = structures.filter((s) => s.basis === 'NP').flatMap((s) => s.layers);
    let firstLayer = null;
    for (const [i, l] of npLayers.entries()) {
      const { rows: lr } = await query(
        `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, order_pct, premium100, currency, status, position,
                            reinstatements, reinstatement_pct, egnpi, rate_pct, brokerage_pct)
         VALUES ($1,$2,'XoL',$3,$4,100,$5,'USD','OPEN',$6,$7,$8,$9,$10,10) RETURNING id`,
        [pid, `USD ${l.limit / 1e6}m xs USD ${l.attachment / 1e6}m`, l.attachment, l.limit, l.premium, i,
          l.reinstatements, l.reinstatementPct, l.egnpi, l.rate],
      );
      firstLayer = firstLayer || lr[0].id;
    }
    await query(
      `INSERT INTO document (placement_id, layer_id, type, version, file, content, created_by, created_at)
       VALUES ($1,$2,'mrc_slip',1,$3,$4,$5,'2026-08-19T10:00:00Z')`,
      [pid, firstLayer, `${demo.reference}_MRC_slip_v1.pdf`, JSON.stringify({ reference: demo.reference, inception: '2027-01-01', expiry: '2027-12-31' }), broker],
    );
    const { rows: wd } = await query(
      `INSERT INTO wording_draft (title, cob, treaty_type, placement_id, layer_id, status, version, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,'draft',1,$6,$7) RETURNING id`,
      [`${demo.reference} — ${demo.class} wording 2027`, COB, structures[0].basis === 'PROP' ? structures[0].prop.treatyType : structures[0].npTreatyType,
        pid, firstLayer, 'Built from the library for the 2027 renewal; standard clauses pending market comments.', broker],
    );
    const { rows: clauses } = await query(
      `SELECT DISTINCT ON (category) id, category, title, clause_ref, body FROM wording_clause
       WHERE category IN ('coverage', 'exclusion', 'condition', 'definition') ORDER BY category, title`,
    );
    for (const [i, c] of clauses.entries()) {
      await query(
        `INSERT INTO wording_draft_clause (draft_id, clause_id, position, category, title, clause_ref, body, source_body)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
        [wd[0].id, c.id, i + 1, c.category, c.title, c.clause_ref, c.body],
      );
    }
    for (const [section, data] of Object.entries(sectionsFor(scale))) {
      await query(
        `INSERT INTO placement_modelling (placement_id, section, data, updated_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (placement_id, section) DO UPDATE SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [pid, section, JSON.stringify(data), broker],
      );
    }

    const category = structures.some((s) => s.basis === 'PROP') ? 'PROPORTIONAL' : 'NON_PROPORTIONAL';
    const pack = await cutPack(pid, screensRecordFor(structures, category, cobs), broker);
    if (demo.pack === 'submitted') {
      await query("UPDATE renewal_pack SET status = 'submitted', submitted_by = $2, submitted_at = '2026-08-21T11:00:00Z' WHERE id = $1", [pack.id, broker]);
    } else if (demo.pack === 'approved') {
      await query(
        `UPDATE renewal_pack SET status = 'approved', submitted_by = $2, submitted_at = '2026-08-21T11:00:00Z',
                approved_by = $3, approved_at = '2026-08-22T09:30:00Z' WHERE id = $1`,
        [pack.id, broker, edwin],
      );
    }
    console.log(`seeded demo pack: ${demo.reference} (${demo.class}, ${structures.map((s) => s.basis).join(' + ')}) — pack v1 ${demo.pack}`);
    scale = r2(scale * 0.85);
  }
  return DEMOS.length;
}
