// The frontend modelling engine (ported from the Universe modelling tool's
// shared-logic) is pure ESM, so it is pinned here from node — the same numbers
// the tool's own golden-master suites assert. If a value here moves, treaty
// pricing moved; that is a deliberate act, never a cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTreatyTerms,
  propEpiOf,
  buildMatrixFromCells,
  calculateAgeToAgeFactors,
  calculateCdfs,
  calculatePattern,
  projectToUltimate,
  projectStraightStats,
  deriveLossComponents,
  runFinancialEngine,
  calcComm,
  makePCCalc,
  calcLPC,
  parseFlexibleNumber,
} from '../../../frontend/src/modelling/engine.js';
import {
  fitPareto,
  paretoLEV,
  paretoLayerExpectedLoss,
  calcPureBurningCost,
  mbbefdG,
  calcRiskExposureRating,
} from '../../../frontend/src/modelling/pricing.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('calculateCdfs builds the running product of pattern × tail', () => {
  const cdfs = calculateCdfs([1.5, 1.2, 1.05], 1.01);
  assert.equal(cdfs.length, 4);
  close(cdfs[3], 1.01);
  close(cdfs[2], 1.0605);
  close(cdfs[1], 1.2726);
  close(cdfs[0], 1.9089);
  assert.deepEqual(calculateCdfs([], 1.05), [1.05]);
});

test('calculatePattern: weighted / simple / last3 averages and exclusions', () => {
  const matrix = [
    [100, 150], [200, 320], [100, 130], [100, 140], [100, 120],
  ];
  const factors = calculateAgeToAgeFactors(matrix);
  close(calculatePattern(matrix, factors, 'weighted').pattern[0], 860 / 600);
  close(calculatePattern(matrix, factors, 'simple').pattern[0], 1.4);
  close(calculatePattern(matrix, factors, 'last3').pattern[0], (1.3 + 1.4 + 1.2) / 3);
  // Dropping the most recent factor shifts the last3 window back.
  close(calculatePattern(matrix, factors, 'last3', { excluded: new Set(['4:0']) }).pattern[0], (1.6 + 1.3 + 1.4) / 3);
});

test('calculatePattern warns on columns with <3 contributing origin years', () => {
  const matrix = [
    [100, 150, 158, 160],
    [110, 165, 174, null],
    [120, 180, null, null],
    [130, null, null, null],
  ];
  const factors = calculateAgeToAgeFactors(matrix);
  const { pattern, warnings } = calculatePattern(matrix, factors, 'weighted');
  assert.equal(pattern.length, 3);
  close(pattern[0], 1.5); // (150+165+180)/(100+110+120)
  close(pattern[1], 332 / 315);
  assert.deepEqual(warnings.map((w) => w.column).sort(), [1, 2]);
  assert.equal(warnings.find((w) => w.column === 1).devPeriod, '24→36');
});

test('buildMatrixFromCells preserves nulls and matches either call signature', () => {
  const cells = [
    { origin_year: 2020, dev_months: 12, cum_value: 100 },
    { origin_year: 2020, dev_months: 24, cum_value: null },
    { origin_year: 2021, dev_months: 12, cum_value: 200 },
  ];
  const auto = buildMatrixFromCells(cells);
  const explicit = buildMatrixFromCells(cells, 2020, 2);
  assert.equal(auto.matrix[0][1], null);
  assert.equal(explicit.matrix[0][1], null);
  assert.deepEqual(explicit.matrix, auto.matrix);
});

test('projectToUltimate: IBNR = ultimate − latest; empty row projects to 0', () => {
  const matrix = [
    [100, 150, 158, 160],
    [110, 165, 174, null],
    [120, 180, null, null],
    [null, null, null, null],
  ];
  const out = projectToUltimate([1.5, 1.05, 1.013], 1.0, { matrix, years: [2020, 2021, 2022, 2023] });
  for (const p of out.projections) close(p.ibnr, p.ultimate - p.latest);
  assert.deepEqual(out.projections[3], { year: 2023, latest: 0, cdf: 1, ultimate: 0, ibnr: 0 });
});

test('projectStraightStats applies benchmark CDFs oldest→newest', () => {
  const rows = projectStraightStats([
    { year: 2023, premium: 1000, paid: 100, os: 50 },
    { year: 2024, premium: 1200, paid: 60, os: 40 },
  ], 'PROPERTY_NONCAT');
  assert.equal(rows.length, 2);
  // Newest year carries the higher development factor.
  assert.ok(rows[1].devFactor > rows[0].devFactor);
  close(rows[1].ultLoss, 100 * rows[1].devFactor);
  close(rows[0].actLoss, 150);
});

test('deriveLossComponents: incurred is always attritional + large + cat', () => {
  const c = deriveLossComponents({ premium: 1000, incurredTotal: 700, large: 200, cat: 100 });
  assert.equal(c.attritional, 400);
  assert.equal(c.incurred, 700);
  close(c.incurredLR, 0.7);
  // Large + cat exceeding the total floors attritional at zero.
  const f = deriveLossComponents({ premium: 1000, incurredTotal: 250, large: 200, cat: 100 });
  assert.equal(f.attritional, 0);
  assert.equal(f.incurred, 300);
});

test('commission: fixed and sliding-corridor forms', () => {
  const fixed = { mode: 'FIXED', fixed_commission_pct: 25 };
  close(calcComm(1000, 500, fixed), 250);
  const sliding = {
    mode: 'SLIDING', sliding_min_loss_ratio: 50, sliding_max_loss_ratio: 80,
    sliding_min_commission: 20, sliding_max_commission: 35,
  };
  close(calcComm(1000, 400, sliding), 350); // LR 40% ≤ min → max comm
  close(calcComm(1000, 900, sliding), 200); // LR 90% ≥ max → min comm
  close(calcComm(1000, 650, sliding), 275); // midpoint interpolates
});

test('profit commission carries deficits forward FIFO', () => {
  const t = { profit_commission_pct: 20, mgmt_expenses_pct: 0, lcf_years: 3, lcf_extinction: false };
  const pc = makePCCalc(t);
  assert.equal(pc(2021, 1000, 1200, 0), 0); // deficit 200 banked
  // 2022 profit 300 first repays the 200 deficit → PC on 100.
  close(pc(2022, 1000, 700, 0), 20);
});

test('loss participation credit over a corridor', () => {
  const t = { lp_enabled: true, lp_min_loss_ratio_pct: 80, lp_max_loss_ratio_pct: 110, lp_reinsurer_share_pct: 50 };
  close(calcLPC(1000, 1000, t), 100); // LR 100%: (1.0-0.8)×1000×50%
  close(calcLPC(1000, 700, t), 0);
  close(calcLPC(1000, 2000, t), 150); // capped at max LR 110%
});

test('runFinancialEngine reconciles result to its components', () => {
  const terms = { mode: 'FIXED', fixed_commission_pct: 25, brokerage_pct: 2.5, taxes_pct: 1, profit_commission_pct: 0 };
  const { rows, totals } = runFinancialEngine([
    { year: 2023, ultPrem: 1000, ultLoss: 500, actPrem: 900, actLoss: 450 },
    { year: 2024, ultPrem: 1100, ultLoss: 660, actPrem: 1000, actLoss: 300 },
  ], terms);
  for (const r of rows) {
    close(r.result, r.premium - r.ultClaims - r.comm - r.brokerage - r.taxes - r.profitComm + r.lpc);
  }
  close(totals.premium, 2100);
  close(totals.cumResult, rows[1].cumResult);
});

test('Pareto: MLE fit, LEV and layer expected loss', () => {
  // Deterministic sample: α for {2,4,8} above xm=2 is 3/ln(8) ≈ 1.4427.
  const { alpha, n } = fitPareto([2, 4, 8], 2);
  assert.equal(n, 3);
  close(alpha, 3 / Math.log(8), 1e-9);
  // LEV below the threshold is the cap itself.
  close(paretoLEV(alpha, 2, 1.5), 1.5);
  // Layer expected loss scales with frequency n/years.
  const el = paretoLayerExpectedLoss(alpha, 2, 2, 10, 3, 6);
  const el2 = paretoLayerExpectedLoss(alpha, 2, 2, 10, 3, 3);
  close(el2, el * 2, 1e-9);
});

test('pure burning cost: layer-cut per year ÷ EGNPI, ROL on the limit', () => {
  const losses = [
    { uw_year: 2022, incurred: 1_500_000, inflation_factor: 1 },
    { uw_year: 2023, incurred: 2_500_000, inflation_factor: 1 },
  ].map((l) => ({ ...l, inflated_incurred: l.incurred }));
  // Layer 1m xs 1m: hits are 500k (2022) and 1m (2023) → 1.5m over 5 years
  // = 300k/yr against EGNPI 10m → loss cost 3%; ROL = 300k / 1m = 30%.
  const r = calcPureBurningCost(losses, 1_000_000, 1_000_000, 10_000_000, 5);
  close(r.totalLayerLoss, 1_500_000);
  close(r.avgAnnualLayerLoss, 300_000, 1e-6);
  close(r.rol, 0.3, 1e-9);
});

test('MBBEFD: G(d) endpoints and a linear c≈0 curve; exposure rating sums bands', () => {
  assert.equal(mbbefdG(0, 3), 0);
  assert.equal(mbbefdG(1, 3), 1);
  close(mbbefdG(0.4, 0), 0.4);
  const { rol, totalExpLoss } = calcRiskExposureRating(
    [{ profile: { pml_percentage: 100, selected_curve: 'Y3' }, bands: [{ no_of_risks: 10, total_sum_insured: 10_000_000 }] }],
    0, 1_000_000, 5_000_000,
  );
  assert.ok(totalExpLoss > 0);
  close(rol, totalExpLoss / 1_000_000, 1e-9);
});

test('parseFlexibleNumber handles currency, separators and accounting negatives', () => {
  assert.equal(parseFlexibleNumber('1,234.50'), 1234.5);
  assert.equal(parseFlexibleNumber('$1,234'), 1234);
  assert.equal(parseFlexibleNumber('(500)'), -500);
  assert.equal(parseFlexibleNumber('1.234,56'), 1234.56);
  assert.equal(parseFlexibleNumber('garbage'), null);
});

test('buildTreatyTerms seeds the engine from the structure treaty detail', () => {
  // The Structure tab now carries the modelling tool's full treaty detail;
  // with no Quick Summary overrides, every term flows from the structure.
  const prop = {
    commissionMode: 'sliding', commissionPct: '25',
    slidingMinLossRatio: '40', slidingMaxLossRatio: '80',
    slidingMinCommission: '20', slidingMaxCommission: '35',
    slidingTable: [{ lossRatioPct: '60', commissionPct: '32' }, { lossRatioPct: '70', commissionPct: '28' }],
    mgmtExpensesPct: '5', profitCommissionPct: '20', lcfYears: 'extinction',
    brokeragePct: '2.5', taxesPct: '2', lossCapPct: '500', aal: '10000000',
    lossPartEnabled: true, minLossRatioPct: '70', maxLossRatioPct: '100',
    reinsurerSharePct: '50',
    lpSlides: [{ minLr: '70', maxLr: '100', share: '50' }, { minLr: '', maxLr: '', share: '' }],
  };
  const t = buildTreatyTerms(prop, {});
  assert.equal(t.mode, 'SLIDING');
  assert.equal(t.sliding_min_loss_ratio, '40');
  assert.equal(t.sliding_max_commission, '35');
  assert.deepEqual(t.sliding_table, [{ lossRatioPct: '60', commissionPct: '32' }, { lossRatioPct: '70', commissionPct: '28' }]);
  assert.equal(t.lcf_years, 0);
  assert.equal(t.lcf_extinction, true);
  assert.equal(t.taxes_pct, '2');
  assert.equal(t.loss_cap_pct, '500');
  assert.equal(t.lp_enabled, true);
  assert.equal(t.lp_reinsurer_share_pct, '50');
  assert.deepEqual(t.lp_slides, [{ minLr: '70', maxLr: '100', share: '50' }]);
  // The engine actually slides: LR 65% interpolates the table to 30%.
  assert.equal(calcComm(1_000_000, 650_000, t), 300_000);

  // Quick Summary overrides still win where they hold a value…
  const over = buildTreatyTerms(prop, { mode: 'FIXED', fixed_commission_pct: '27.5', taxes_pct: '3' });
  assert.equal(over.mode, 'FIXED');
  assert.equal(calcComm(1_000_000, 650_000, over), 275_000);
  assert.equal(over.taxes_pct, '3');
  // …but an empty string in the section never clobbers the structure.
  assert.equal(buildTreatyTerms(prop, { taxes_pct: '' }).taxes_pct, '2');

  // Legacy stored terms: a lone lpvPct still drives loss participation.
  const legacy = buildTreatyTerms({ lpvPct: '10' }, {});
  assert.equal(legacy.lp_enabled, true);
  assert.equal(legacy.lp_reinsurer_share_pct, '10');
});

test('propEpiOf prefers the QS + Surplus split and falls back to legacy EPI', () => {
  assert.equal(propEpiOf({ quotaShareEpi: '10000000', surplusEpi: '5000000' }), 15_000_000);
  assert.equal(propEpiOf({ epi: '5000000' }), 5_000_000);
  assert.equal(propEpiOf({}), 0);
});
