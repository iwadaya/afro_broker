import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeRng, paretoAlphaFromMean, calibratePortfolio, simulateGrossTrials,
  normaliseStructure, applyStructure, stats, capitalFromResults, runDfa,
  scaleCalibration, technicalPremium, reinsurerDefaultPdPct,
} from '../../src/domain/dfa.js';
import { computeXolLoss } from '../../src/domain/xol.js';

const PORTFOLIO = {
  subject_premium: 10_000_000,
  expected_loss_ratio_pct: 62,
  large_loss_threshold: 250_000,
  large_frequency: 4,
  large_severity_mean: 600_000,
  cat_frequency: 0.5,
  cat_severity_mean: 2_500_000,
};

const XOL = {
  xol_layers: [
    { name: '1st', attachment: 500_000, limit: 1_500_000, premium100: 450_000, reinstatements: '2', reinstatement_pct: 100 },
    { name: '2nd', attachment: 2_000_000, limit: 3_000_000, premium100: 300_000, reinstatements: '1', reinstatement_pct: 100 },
  ],
};

// ---- Sampling & calibration ----

test('the seeded RNG is deterministic', () => {
  const a = makeRng(7);
  const b = makeRng(7);
  for (let i = 0; i < 100; i += 1) assert.equal(a(), b());
  const c = makeRng(8);
  assert.notEqual(makeRng(7)(), c());
});

test('pareto alpha comes from the mean and is clamped', () => {
  // E[X] = α·t/(α−1): mean 500k over threshold 250k ⇒ α = 2.
  assert.equal(paretoAlphaFromMean(500_000, 250_000), 2);
  assert.equal(paretoAlphaFromMean(200_000, 250_000), 1.05); // mean below threshold
  assert.equal(paretoAlphaFromMean(250_001, 250_000), 8);    // barely above ⇒ capped
});

test('calibration reconciles the expected loss ratio into its components', () => {
  const c = calibratePortfolio(PORTFOLIO);
  // 62% of 10m = 6.2m total; large 4×600k = 2.4m; cat 0.5×2.5m = 1.25m.
  assert.equal(c.expected.large, 2_400_000);
  assert.equal(c.expected.cat, 1_250_000);
  assert.equal(c.expected.attritional, 2_550_000);
  assert.equal(c.expected.loss_ratio_pct, 62);
});

test('calibration floors a negative attritional residual at zero', () => {
  const c = calibratePortfolio({ ...PORTFOLIO, expected_loss_ratio_pct: 10 });
  assert.equal(c.expected.attritional, 0);
  assert.ok(c.expected.loss_ratio_pct > 10); // event burdens still stand
});

test('gross trials are reproducible under a seed and land near the calibration', () => {
  const c = calibratePortfolio(PORTFOLIO);
  const t1 = simulateGrossTrials(c, { trials: 4000, seed: 42 });
  const t2 = simulateGrossTrials(c, { trials: 4000, seed: 42 });
  assert.deepEqual(t1[123], t2[123]);

  const total = t1.map((t) => t.attritional + t.events.reduce((a, e) => a + e.amount, 0));
  const mean = total.reduce((a, b) => a + b, 0) / total.length;
  // Monte Carlo mean of the simulated years within 12% of the analytic mean
  // (the severity cap shaves a little off the Pareto's analytic expectation).
  assert.ok(Math.abs(mean - c.expected.total) / c.expected.total < 0.12,
    `simulated mean ${mean} vs expected ${c.expected.total}`);
});

// ---- Structure normalisation ----

test('normalisation clamps, orders and derives premiums', () => {
  const s = normaliseStructure({
    quota_share: { cession_pct: 120, commission_pct: 25 },
    xol_layers: [
      { attachment: 2_000_000, limit: 3_000_000, rate_pct: 3 },
      { attachment: 500_000, limit: 1_500_000, premium100: 450_000, reinstatements: 'UNLIMITED' },
      { attachment: 1, limit: 0 }, // no limit ⇒ dropped
    ],
  }, 10_000_000);
  assert.equal(s.cession_pct, 90); // clamped
  assert.equal(s.xol_layers.length, 2);
  assert.equal(s.xol_layers[0].attachment, 500_000); // sorted by attachment
  assert.equal(s.xol_layers[0].reinstatements, Infinity);
  assert.equal(s.xol_layers[1].premium100, 300_000); // 3% rate on 10m
});

// ---- Structure application: hand-checkable single trials ----

const CTX = { subjectPremium: 10_000_000, expenseRatioPct: 30, reinsurerExpensePct: 10 };

test('quota share cedes losses and premium pro rata with commission back', () => {
  const trial = [{ attritional: 4_000_000, events: [{ amount: 1_000_000, cat: false }] }];
  const run = applyStructure(trial, { quota_share: { cession_pct: 20, commission_pct: 25 } }, CTX);
  assert.equal(run.grossLoss[0], 5_000_000);
  assert.equal(run.cededLoss[0], 1_000_000);          // 20% of every loss
  assert.equal(run.netLoss[0], 4_000_000);
  assert.equal(run.flows.qs_premium, 2_000_000);
  assert.equal(run.flows.qs_commission, 500_000);
  // Net premium 10m − 2m + 0.5m = 8.5m; result 8.5m − 4m − 3m expense = 1.5m.
  assert.equal(run.netPremium[0], 8_500_000);
  assert.equal(run.insurerResult[0], 1_500_000);
  // Reinsurer: 2m premium − 1m loss − 0.5m commission − 0.2m expense = 0.3m.
  assert.equal(run.reinsurerResult[0], 300_000);
});

test('XoL recovers per event above attachment and charges reinstatement premium', () => {
  const trial = [{
    attritional: 1_000_000,
    events: [{ amount: 2_000_000, cat: false }, { amount: 800_000, cat: false }],
  }];
  const run = applyStructure(trial, XOL, CTX);
  // 1st layer (1.5m xs 500k): 1.5m from the 2m event + 300k from the 800k event.
  assert.equal(run.cededLoss[0], 1_800_000);
  // RIP pro rata to amount at 100%: (1.5m/1.5m + 0.3m/1.5m) × 450k = 540k.
  assert.equal(run.ripPaid[0], 540_000);
  assert.equal(run.netLoss[0], 3_800_000 - 1_800_000);
  // Net premium: 10m − 750k XoL premium − 540k RIP.
  assert.equal(run.netPremium[0], 8_710_000);
});

test('XoL responds net of the quota share and honours the placed share', () => {
  const trial = [{ attritional: 0, events: [{ amount: 2_500_000, cat: true }] }];
  const structure = {
    quota_share: { cession_pct: 20, commission_pct: 0 },
    xol_layers: [{ attachment: 500_000, limit: 1_500_000, premium100: 450_000, reinstatements: '2', placed_pct: 80 }],
  };
  const run = applyStructure(trial, structure, CTX);
  // Retained event 2m ⇒ layer takes 1.5m at 100%, 1.2m at the 80% placed.
  // Ceded = 500k QS + 1.2m XoL.
  assert.equal(run.cededLoss[0], 1_700_000);
  // Full-limit consumption ⇒ RIP 450k at 100% ⇒ 360k at 80%.
  assert.equal(run.ripPaid[0], 360_000);
  assert.equal(run.flows.xol_premium, 360_000); // 450k × 80%
});

test('aggregate reinstatement capacity exhausts across events in a year', () => {
  // 1 reinstatement on 1m xs 1m ⇒ aggregate capacity 2m.
  const structure = { xol_layers: [{ attachment: 1_000_000, limit: 1_000_000, premium100: 100_000, reinstatements: '1' }] };
  const trial = [{
    attritional: 0,
    events: [{ amount: 2_000_000 }, { amount: 2_000_000 }, { amount: 2_000_000 }],
  }];
  const run = applyStructure(trial, structure, CTX);
  assert.equal(run.cededLoss[0], 2_000_000);  // third event recovers nothing
  assert.equal(run.ripPaid[0], 100_000);      // only one limit is reinstated
});

// ---- Summaries ----

test('stats and capital read the distribution correctly', () => {
  const values = Float64Array.from({ length: 1000 }, (_, i) => i + 1); // 1..1000
  const s = stats(values);
  assert.equal(s.mean, 500.5);
  assert.equal(s.p50, 500);
  assert.equal(s.p99, 990);
  assert.equal(s.min, 1);
  assert.equal(s.max, 1000);

  // Results of −1..−1000: the 99th-percentile loss is 990, tail mean beyond it.
  const results = Float64Array.from({ length: 1000 }, (_, i) => -(i + 1));
  const cap = capitalFromResults(results, 99);
  assert.equal(cap.var, 990);
  assert.equal(cap.tvar, (990 + 991 + 992 + 993 + 994 + 995 + 996 + 997 + 998 + 999 + 1000) / 11);

  // An always-profitable book needs no capital.
  const profit = Float64Array.from({ length: 1000 }, () => 5);
  assert.equal(capitalFromResults(profit, 99.5).var, 0);
});

// ---- The full run ----

test('runDfa applies every structure to identical trials and reports relief', () => {
  const out = runDfa({
    portfolio: PORTFOLIO,
    structures: { current: XOL, bare: {} },
    assumptions: { trials: 3000, seed: 7 },
  });

  // The bare structure is the gross book run through the same machinery.
  assert.deepEqual(out.structures.bare.loss, out.gross.loss);
  assert.equal(out.structures.bare.capital.relief, 0);
  assert.equal(out.structures.bare.reinsurer, null);

  const cur = out.structures.current;
  // Reinsurance narrows the net: less tail, less required capital.
  assert.ok(cur.loss.p99_5 < out.gross.loss.p99_5);
  assert.ok(cur.capital.required < out.gross.capital.required);
  assert.equal(cur.capital.relief,
    Math.round((out.gross.capital.required - cur.capital.required) * 100) / 100);
  // Both sides of the slip are reported.
  assert.ok(cur.reinsurer.premium > 0);
  assert.ok(cur.reinsurer.expected_loss > 0);
  assert.ok(Array.isArray(cur.ep_curve) && cur.ep_curve.length > 10);
  // The EP curve nets down: net ≤ gross at every point.
  for (const pt of cur.ep_curve) assert.ok(pt.net <= pt.gross + 0.01);

  // Determinism: the same seed reproduces the same headline numbers.
  const again = runDfa({
    portfolio: PORTFOLIO,
    structures: { current: XOL },
    assumptions: { trials: 3000, seed: 7 },
  });
  assert.deepEqual(again.structures.current.result, cur.result);
});

test('a heavier structure cedes more premium and more tail than a lighter one', () => {
  const light = { xol_layers: [{ attachment: 2_000_000, limit: 1_000_000, premium100: 150_000, reinstatements: '1' }] };
  const out = runDfa({
    portfolio: PORTFOLIO,
    structures: { light, heavy: { ...XOL, quota_share: { cession_pct: 15, commission_pct: 25 } } },
    assumptions: { trials: 3000, seed: 11 },
  });
  const l = out.structures.light;
  const h = out.structures.heavy;
  assert.ok(h.reinsurer.premium > l.reinsurer.premium);
  assert.ok(h.capital.required < l.capital.required);
  assert.ok(h.loss.mean < l.loss.mean);
});

// ---- Parameter risk, loss-sensitive terms and covers ----

const meanOf = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const varianceOf = (xs) => {
  const m = meanOf(xs);
  return xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
};

test('the year factor carries parameter risk: means hold, counts over-disperse', () => {
  const pure = calibratePortfolio({ ...PORTFOLIO, parameter_uncertainty_pct: 0, cat_frequency_cv_pct: 0 });
  const mixed = calibratePortfolio({ ...PORTFOLIO, parameter_uncertainty_pct: 40, cat_frequency_cv_pct: 0 });
  const t0 = simulateGrossTrials(pure, { trials: 6000, seed: 3 });
  const t1 = simulateGrossTrials(mixed, { trials: 6000, seed: 3 });
  const counts = (t) => t.map((y) => y.events.filter((e) => !e.cat).length);
  const m0 = meanOf(counts(t0));
  const m1 = meanOf(counts(t1));
  // Poisson: variance ≈ mean. Gamma-mixed (negative binomial): variance =
  // mean + (cv·mean)² = 4 + 2.56 on a rate of 4.
  assert.ok(Math.abs(m1 - m0) / m0 < 0.1, `means ${m0} vs ${m1}`);
  assert.ok(varianceOf(counts(t1)) > varianceOf(counts(t0)) * 1.3);
  assert.ok(t0.every((y) => y.factor === 1));
  assert.ok(Math.abs(meanOf(t1.map((y) => y.factor)) - 1) < 0.03);
});

test('an annual aggregate deductible absorbs recoveries before the layer pays', () => {
  const layer = { attachment: 1_000_000, limit: 1_000_000, premium100: 100_000, reinstatements: '2', aggregate_deductible: 500_000 };
  // 1.4m ⇒ 400k to the layer, all absorbed; 1.8m ⇒ 800k, 100k absorbed, 700k paid.
  const trial = [{ attritional: 0, events: [{ amount: 1_400_000 }, { amount: 1_800_000 }] }];
  const run = applyStructure(trial, { xol_layers: [layer] }, CTX);
  assert.equal(run.cededLoss[0], 700_000);
  assert.equal(run.ripPaid[0], 70_000); // RIP on what the reinsurer actually paid
  const bare = applyStructure(trial, { xol_layers: [{ ...layer, aggregate_deductible: 0 }] }, CTX);
  assert.equal(bare.cededLoss[0], 1_200_000);
});

test('an aggregate excess of loss responds to the net retained annual loss', () => {
  // Retained premium 10m: attaches at 85% LR (8.5m), exhausts at 110% (limit 2.5m).
  const cover = { attachment_lr_pct: 85, exhaust_lr_pct: 110, premium100: 400_000 };
  const trials = [
    { attritional: 8_000_000, events: [] },
    { attritional: 8_000_000, events: [{ amount: 2_000_000 }] },
    { attritional: 9_000_000, events: [{ amount: 5_000_000 }] },
  ];
  const run = applyStructure(trials, { aggregate_cover: cover }, CTX);
  assert.deepEqual(Array.from(run.cededLoss), [0, 1_500_000, 2_500_000]);
  assert.equal(run.flows.aggregate_premium, 400_000);
  assert.equal(run.netPremium[0], 9_600_000);
  assert.equal(run.structure.aggregate.attachment, 8_500_000);
  assert.equal(run.structure.aggregate.limit, 2_500_000);

  // Behind the per-event layers only the net feeds it: the 2m event goes to
  // the 1st layer (net 8.5m ⇒ nothing); the 5m event cedes 4.5m to the XoL,
  // leaving 9.5m net ⇒ 1m from the aggregate.
  const layered = applyStructure(trials, { ...XOL, aggregate_cover: cover }, CTX);
  assert.equal(layered.cededLoss[1], 1_500_000);
  assert.equal(layered.cededLoss[2], 5_500_000);
});

test('quota-share loss-sensitive terms: event limit, sliding scale and corridor', () => {
  const big = [{ attritional: 0, events: [{ amount: 10_000_000 }] }];
  const qs = { cession_pct: 20, commission_pct: 0, event_limit: 1_000_000 };
  assert.equal(applyStructure(big, { quota_share: qs }, CTX).cededLoss[0], 1_000_000);
  // The XoL sees the event net of what the QS really took: 9m ⇒ 1.5m from the 1st layer.
  assert.equal(applyStructure(big, { quota_share: qs, xol_layers: [XOL.xol_layers[0]] }, CTX).cededLoss[0], 2_500_000);

  // Sliding scale on a 2m QS premium: 35% at ≤50% LR, 15% at ≥70%, 1:1 between.
  const sliding = {
    quota_share: { cession_pct: 20, commission_pct: 25, sliding_scale: { min_pct: 15, max_pct: 35, min_lr_pct: 50, max_lr_pct: 70 } },
  };
  const years = [
    { attritional: 4_000_000, events: [] }, // LR 40% ⇒ 35%
    { attritional: 6_000_000, events: [] }, // LR 60% ⇒ 25%
    { attritional: 9_000_000, events: [] }, // LR 90% ⇒ 15%
  ];
  const run = applyStructure(years, sliding, CTX);
  assert.deepEqual(Array.from(run.netPremium).map(Math.round), [8_700_000, 8_500_000, 8_300_000]);
  assert.equal(run.flows.qs_commission, 500_000); // the expected commission

  // Corridor: the cedant takes back 50% of ceded losses between 80% and 100% LR.
  const corridor = {
    quota_share: { cession_pct: 20, commission_pct: 25, loss_corridor: { from_lr_pct: 80, to_lr_pct: 100, cedant_share_pct: 50 } },
  };
  // LR 90% ⇒ 10 points × 2m × 50% = 100k handed back.
  assert.equal(applyStructure([years[2]], corridor, CTX).cededLoss[0], 1_700_000);
});

test('a cover without a quoted premium is priced technically', () => {
  // max(E[L] + β·σ, limit × min ROL) grossed up for expenses.
  assert.equal(technicalPremium({ mean: 100_000, sd: 200_000, limit: 1_000_000 },
    { risk_load_sd_multiple: 0.5, min_rate_on_line_pct: 1, reinsurer_expense_pct: 20 }), 250_000);
  assert.equal(technicalPremium({ mean: 1_000, sd: 5_000, limit: 10_000_000 },
    { risk_load_sd_multiple: 0.35, min_rate_on_line_pct: 2, reinsurer_expense_pct: 0 }), 200_000);

  const out = runDfa({
    portfolio: PORTFOLIO,
    structures: { s: { xol_layers: [{ attachment: 2_000_000, limit: 3_000_000, reinstatements: '1' }] } },
    assumptions: { trials: 2000, seed: 3 },
  });
  const layer = out.structures.s.layers[0];
  assert.equal(layer.priced, 'technical');
  assert.equal(layer.premium100, layer.technical_premium100);
  assert.ok(layer.premium100 > layer.expected_recovery); // loaded above expected loss
  assert.equal(out.structures.s.structure.xol_layers[0].priced, 'technical');
});

test('scaling a calibration grows the book and trends the losses', () => {
  const c = calibratePortfolio(PORTFOLIO);
  const s = scaleCalibration(c, { exposure: 1.1, severity: 1.05 });
  assert.ok(Math.abs(s.subject_premium - 11_000_000) < 1e-6);
  assert.ok(Math.abs(s.large.frequency - 4.4) < 1e-9);
  assert.equal(s.cat.frequency, 0.5); // the weather does not grow with the book
  assert.ok(Math.abs(s.attritional.mean - 2_550_000 * 1.155) < 1e-6);
  assert.ok(Math.abs(s.large.threshold - 262_500) < 1e-6);
  assert.equal(scaleCalibration(c), c);
});

// ---- Reinsurance economics, capital and the horizon ----

test('reinsurance economics: value added is the change in EVA, the implied cost meets the hurdle', () => {
  const out = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7, credit_pd_pct: 0 } });
  const g = out.gross;
  const c = out.structures.current;
  const r = c.reinsurance;
  assert.ok(r);
  assert.equal(g.reinsurance, null);
  // Ceded margin: premium (incl. RIP) − recoveries − commission …
  assert.ok(Math.abs(r.expected_cost - (r.ceded_premium - r.expected_recoveries - r.expected_commission)) < 0.05);
  // … which, without credit risk, is exactly the drop in expected result.
  assert.ok(Math.abs(r.expected_cost - (g.result.mean - c.result.mean)) < 1);
  assert.equal(r.capital_relief, c.capital.relief);
  assert.ok(Math.abs(r.coc_saved - r.capital_relief * 0.08) < 1);
  assert.ok(Math.abs(r.value_added - (c.capital.eva - g.capital.eva)) < 1);
  assert.equal(r.hurdle_coc_pct, 8);
  assert.equal(r.efficient, r.implied_coc_pct <= r.hurdle_coc_pct);
  assert.ok(r.erd_pct >= 0);
  assert.equal(r.risk_transfer_ok, r.erd_pct >= 1);
});

test('available capital drives ruin probability, EPD and the solvency ratio', () => {
  const out = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7, available_capital: 5_000_000 } });
  const g = out.gross;
  const c = out.structures.current;
  assert.equal(out.assumptions.available_capital, 5_000_000);
  assert.equal(out.assumptions.available_capital_source, 'given');
  assert.equal(g.capital.available, 5_000_000);
  assert.ok(g.capital.ruin_prob_pct > 0);
  assert.ok(c.capital.ruin_prob_pct <= g.capital.ruin_prob_pct);
  assert.ok(c.capital.epd_pct <= g.capital.epd_pct);
  assert.ok(c.capital.solvency_ratio_pct > g.capital.solvency_ratio_pct);
  assert.ok(c.capital.earnings_at_risk <= g.capital.earnings_at_risk);
  assert.ok(c.capital.loss_1in100_pct_of_capital < g.capital.loss_1in100_pct_of_capital);

  // By default the insurer is assumed to hold the gross 1-in-N loss.
  const dflt = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7 } });
  assert.equal(dflt.assumptions.available_capital, dflt.gross.capital.required);
  assert.equal(dflt.gross.capital.solvency_ratio_pct, 100);
});

test('the multi-year roll-forward accumulates results and reports ruin over the horizon', () => {
  const out = runDfa({
    portfolio: PORTFOLIO,
    structures: { current: XOL },
    assumptions: { trials: 2000, seed: 5, horizon_years: 3, investment_yield_pct: 0, premium_growth_pct: 10, credit_pd_pct: 0 },
  });
  const b = out.structures.current;
  const h = b.horizon;
  assert.equal(h.years, 3);
  assert.equal(h.by_year.length, 3);
  assert.equal(h.by_year[1].subject_premium, 11_000_000);
  assert.equal(h.by_year[2].subject_premium, 12_100_000);
  // No yield: year-1 surplus is the capital plus the year's result.
  assert.equal(h.by_year[0].investment_income_mean, 0);
  assert.ok(Math.abs(h.by_year[0].surplus_mean - (h.available_capital + b.result.mean)) < 1);
  const sumMeans = h.by_year.reduce((a, y) => a + y.uw_result_mean, 0);
  assert.ok(Math.abs(h.cumulative_result.mean - sumMeans) < 1);
  assert.ok(h.prob_ruin_pct >= b.capital.ruin_prob_pct);
  assert.ok(h.prob_capital_breach_pct >= h.prob_ruin_pct);
  // The worst year-end surplus never exceeds the opening capital, and its
  // lower tail orders correctly.
  assert.ok(h.min_surplus.max <= h.available_capital + 0.01);
  assert.ok(h.min_surplus_p1 <= h.min_surplus_p10);
  assert.ok(h.min_surplus_p10 <= h.min_surplus.p50);
  // The gross book rolls forward too, and a one-year run still has a block.
  assert.equal(out.gross.horizon.years, 3);
  const one = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 1000, seed: 5 } });
  assert.equal(one.structures.current.horizon.years, 1);
});

test('layer attribution reconciles to the programme and prices marginal relief', () => {
  const out = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7, credit_pd_pct: 0 } });
  const b = out.structures.current;
  assert.equal(b.layers.length, 2);
  assert.ok(Math.abs(b.layers.reduce((a, l) => a + l.premium, 0) - b.flows.xol_premium) < 0.05);
  assert.ok(Math.abs(b.layers.reduce((a, l) => a + l.expected_rip, 0) - b.reinsurer.expected_rip) < 0.05);
  assert.ok(Math.abs(b.layers.reduce((a, l) => a + l.expected_recovery, 0) - b.reinsurer.expected_loss) < 0.05);
  for (const l of b.layers) {
    assert.ok(l.prob_attach_pct >= l.prob_exhaust_pct);
    assert.ok(l.rol_pct > 0 && l.payback_years > 0);
    assert.ok(l.marginal_capital_relief != null);
  }
  assert.ok(b.layers[0].prob_attach_pct > b.layers[1].prob_attach_pct);
  assert.equal(out.gross.layers.length, 0);
});

test('reinsurer default costs the cedant part of its recoveries', () => {
  const heavy = runDfa({
    portfolio: PORTFOLIO,
    structures: { current: XOL },
    assumptions: { trials: 3000, seed: 7, credit_pd_pct: 20, credit_lgd_pct: 50, credit_stress_multiple: 1 },
  });
  const r = heavy.structures.current.reinsurance;
  const expected = 0.2 * 0.5 * r.expected_recoveries;
  assert.ok(Math.abs(r.expected_credit_loss - expected) / expected < 0.25, `${r.expected_credit_loss} vs ${expected}`);
  for (const pt of heavy.structures.current.ep_curve) assert.ok(pt.net <= pt.gross + 0.01);
  const clean = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7, credit_pd_pct: 0 } });
  assert.equal(clean.structures.current.reinsurance.expected_credit_loss, 0);
  assert.ok(heavy.structures.current.result.mean < clean.structures.current.result.mean);
});

test('variants feed the frontier without becoming full structures', () => {
  const out = runDfa({
    portfolio: PORTFOLIO,
    structures: { current: XOL },
    variants: { 'QS 20': { ...XOL, quota_share: { cession_pct: 20, commission_pct: 25 } } },
    assumptions: { trials: 2000, seed: 7 },
  });
  assert.deepEqual(Object.keys(out.structures), ['current']);
  assert.deepEqual(out.frontier.map((f) => f.label), ['gross', 'current', 'QS 20']);
  assert.deepEqual(out.frontier.map((f) => f.kind), ['gross', 'structure', 'variant']);
  assert.ok(out.variants['QS 20'].capital_required < out.structures.current.capital.required);
  assert.equal(out.frontier[0].capital_required, out.gross.capital.required);
});

test('reinsurer default probabilities follow the panel rating', () => {
  assert.equal(reinsurerDefaultPdPct('AA-'), 0.05);
  assert.equal(reinsurerDefaultPdPct('A+'), 0.05);
  assert.equal(reinsurerDefaultPdPct('A'), 0.1);
  assert.equal(reinsurerDefaultPdPct('a-'), 0.1);
  assert.equal(reinsurerDefaultPdPct('BBB+'), 0.3);
  assert.equal(reinsurerDefaultPdPct('B++'), 0.3);
  assert.equal(reinsurerDefaultPdPct('BB'), 1.2);
  assert.equal(reinsurerDefaultPdPct('CCC'), 5);
  assert.equal(reinsurerDefaultPdPct(null), 0.5);
  assert.equal(reinsurerDefaultPdPct('NR'), 0.5);
});

test('the inlined layer arithmetic matches the reference helper on random years', () => {
  // Random towers and random years, checked layer by layer against
  // computeXolLoss (which the engine no longer calls on its hot path).
  const rng = makeRng(2024);
  for (let round = 0; round < 40; round += 1) {
    const layers = [];
    let att = Math.round(rng() * 500_000);
    for (let j = 0; j < 1 + Math.floor(rng() * 4); j += 1) {
      const limit = Math.round(200_000 + rng() * 3_000_000);
      layers.push({
        attachment: att, limit, premium100: 100_000,
        reinstatements: rng() < 0.2 ? 'UNLIMITED' : String(Math.floor(rng() * 3)),
        placed_pct: rng() < 0.5 ? 100 : Math.round(50 + rng() * 50),
      });
      att += limit;
    }
    const events = Array.from({ length: Math.floor(rng() * 8) }, () => ({ amount: Math.round(rng() * 6_000_000) }));
    const run = applyStructure([{ attritional: 0, events }], { xol_layers: layers }, CTX);
    const s = normaliseStructure({ xol_layers: layers }, CTX.subjectPremium);
    let ceded = 0;
    let rip = 0;
    const consumed = s.xol_layers.map(() => 0);
    for (const e of events) {
      s.xol_layers.forEach((l, j) => {
        const r = computeXolLoss({
          grossLoss: e.amount, attachment: l.attachment, limit: l.limit, premium100: 100_000,
          reinstatements: l.reinstatements, reinstatementPremiumPct: 100, consumedBefore: consumed[j],
        });
        consumed[j] += r.recovery;
        ceded += r.recovery * (l.placed_pct / 100);
        rip += r.reinstatementPremium * (l.placed_pct / 100);
      });
    }
    assert.ok(Math.abs(run.cededLoss[0] - ceded) < 0.02, `round ${round}: ceded ${run.cededLoss[0]} vs ${ceded}`);
    assert.ok(Math.abs(run.ripPaid[0] - rip) < 0.05, `round ${round}: rip ${run.ripPaid[0]} vs ${rip}`);
  }
});

// ---- The Handbook's additions: reserves, scenarios, the capital regime ----

import {
  STANDARD_SCENARIOS, SCENARIO_KEYS, scenarioOverrides, applyScenario, standingOf,
} from '../../src/domain/dfa.js';

test('an opening reserve runs off with its own uncertainty and widens the capital needed', () => {
  const plain = calibratePortfolio(PORTFOLIO);
  assert.equal(plain.reserves.opening, 0);
  assert.equal(plain.expected.reserve_development, 0);
  const withReserve = calibratePortfolio({ ...PORTFOLIO, opening_reserves: 20_000_000, reserve_development_pct: 5, reserve_cv_pct: 10 });
  assert.equal(withReserve.reserves.opening, 20_000_000);
  assert.equal(withReserve.expected.reserve_development, 1_000_000);

  // A book without a reserve samples exactly the years it always did.
  const t0 = simulateGrossTrials(plain, { trials: 500, seed: 9 });
  assert.equal(t0[7].reserve_dev, 0);
  const t1 = simulateGrossTrials(withReserve, { trials: 4000, seed: 9 });
  const devMean = meanOf(t1.map((t) => t.reserve_dev));
  assert.ok(Math.abs(devMean - 1_000_000) / 1_000_000 < 0.1, `mean development ${devMean}`);
  assert.ok(t1.some((t) => t.reserve_dev < 0) && t1.some((t) => t.reserve_dev > 2_000_000), 'the run-off is two-sided');

  const base = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7, available_capital: 6_000_000 } });
  const res = runDfa({
    portfolio: { ...PORTFOLIO, opening_reserves: 20_000_000, reserve_cv_pct: 25 },
    structures: { current: XOL },
    assumptions: { trials: 3000, seed: 7, available_capital: 6_000_000 },
  });
  // The reserve has its own stream: the underwriting years are the ones the
  // book without a reserve sampled.
  assert.deepEqual(res.gross.loss, base.gross.loss);
  assert.equal(base.structures.current.reserves, null);
  const r = res.structures.current.reserves;
  assert.equal(r.opening, 20_000_000);
  assert.ok(r.development_p99_5 > r.development_p90 && r.development_p90 > r.expected_development);
  // The run-off is the same for every structure: relief is unchanged in
  // expectation, the capital each needs is wider.
  assert.ok(res.structures.current.capital.required > base.structures.current.capital.required);
  assert.ok(res.gross.capital.required > base.gross.capital.required);
  assert.ok(Math.abs(res.structures.current.flows.reserve_development - res.gross.flows.reserve_development) < 1e-6);
  assert.equal(res.calibration.opening_reserves, 20_000_000);
  // Leverage reads the premium and the reserve against the capital held.
  assert.equal(res.structures.current.leverage.reserves_to_capital_pct, Math.round((20_000_000 / 6_000_000) * 10000) / 100);
  assert.ok(res.structures.current.leverage.net_premium_to_capital_pct < res.gross.leverage.net_premium_to_capital_pct);
});

test('scenario overrides move the inputs the way the Handbook describes', () => {
  assert.ok(STANDARD_SCENARIOS.length >= 8);
  for (const d of STANDARD_SCENARIOS) {
    assert.ok(SCENARIO_KEYS.includes(d.param.key), d.key);
    for (const k of Object.keys(d.fixed)) assert.ok(SCENARIO_KEYS.includes(k), `${d.key}: ${k}`);
    assert.ok(d.label && d.section && d.text);
  }
  const rates = STANDARD_SCENARIOS.find((d) => d.key === 'rates');
  assert.deepEqual(scenarioOverrides(rates), { loss_ratio_delta_pts: 10 });
  assert.deepEqual(scenarioOverrides(rates, 20), { loss_ratio_delta_pts: 20 });
  const growth = STANDARD_SCENARIOS.find((d) => d.key === 'growth');
  assert.deepEqual(scenarioOverrides(growth), { loss_ratio_delta_pts: 5, premium_growth_pct: 25 });

  const base = { ...PORTFOLIO, opening_reserves: 10_000_000, cat_pml: 8_000_000 };
  const s = applyScenario(base, { credit_pd_pct: 0.1 }, {
    loss_ratio_delta_pts: 10, severity_multiple: 1.5, large_frequency_multiple: 2, forced_cat_pml_multiple: 1.25,
    reserve_shock_pct: 10, latent_claims_pct_of_premium: 5, asset_shock_pct: 10, uncollectible_pct: 30, loss_trend_pct: 4,
  }, { catPml: 999, investedAssets: 30_000_000 });
  assert.equal(s.portfolio.expected_loss_ratio_pct, 72);
  assert.equal(s.portfolio.large_severity_mean, 900_000);
  assert.equal(s.portfolio.cat_pml, 12_000_000);          // inflated too
  assert.equal(s.portfolio.large_frequency, 8);
  assert.equal(s.portfolio.forced_event, 15_000_000);      // the typed PML (inflated) × 1.25
  // 10% of the reserve + 5% of the premium + 10% of the invested assets.
  assert.equal(s.assumptions.surplus_charge, 1_000_000 + 500_000 + 3_000_000);
  assert.equal(s.assumptions.credit_pd_pct, 100);
  assert.equal(s.assumptions.credit_lgd_pct, 30);
  assert.equal(s.assumptions.loss_trend_pct, 4);
  // Without a typed PML the run's modelled event stands in.
  const noPml = applyScenario(PORTFOLIO, {}, { forced_cat_pml_multiple: 1 }, { catPml: 4_000_000 });
  assert.equal(noPml.portfolio.forced_event, 4_000_000);
  assert.equal(applyScenario(PORTFOLIO, {}, {}).assumptions.surplus_charge, 0);
});

test('scenarios re-run the same seed with the inputs moved, against the same capital', () => {
  const structures = { current: XOL, proposed: { ...XOL, quota_share: { cession_pct: 20, commission_pct: 25 } } };
  const scenarios = {
    'Rates inadequate': { loss_ratio_delta_pts: 10 },
    'A good year': { loss_ratio_delta_pts: -5 },
    'The cat PML event happens': { forced_cat_pml_multiple: 1 },
    'A reinsurer fails': { uncollectible_pct: 40 },
    'Investment markets fall': { asset_shock_pct: 10 },
  };
  const out = runDfa({ portfolio: PORTFOLIO, structures, scenarios, assumptions: { trials: 2000, seed: 3, credit_pd_pct: 0 } });
  assert.deepEqual(Object.keys(out.scenarios), Object.keys(scenarios));
  const base = out.structures.proposed;
  const hot = out.scenarios['Rates inadequate'];
  const good = out.scenarios['A good year'];
  assert.equal(hot.expected_loss_ratio_pct, 72);
  assert.equal(good.expected_loss_ratio_pct, 57);
  assert.ok(hot.structures.proposed.result_mean < base.result.mean);
  assert.ok(good.structures.proposed.result_mean > base.result.mean);
  assert.ok(hot.structures.proposed.capital_required > base.capital.required);
  // The capital held is the base case's, not re-derived from the hotter gross.
  assert.ok(hot.structures.proposed.solvency_ratio_pct < base.capital.solvency_ratio_pct);
  assert.deepEqual(Object.keys(hot.structures), ['current', 'proposed']);
  assert.equal(typeof hot.gross.result_mean, 'number');

  // The forced event is the modelled 1-in-200 cat event, added to every year.
  const cat = out.scenarios['The cat PML event happens'];
  assert.equal(cat.forced_event, out.calibration.cat_event_1in200);
  assert.ok(out.calibration.cat_event_1in200 >= out.calibration.cat_event_1in100);
  assert.ok(Math.abs((cat.gross.loss_mean - out.gross.loss.mean) - cat.forced_event) / cat.forced_event < 0.02);
  assert.ok(cat.structures.proposed.ruin_prob_pct >= base.capital.ruin_prob_pct);

  // Uncollectible recoveries: a certain default of that share.
  const fail = out.scenarios['A reinsurer fails'];
  const rec = fail.structures.proposed.reinsurance;
  assert.ok(Math.abs(rec.expected_credit_loss - 0.4 * rec.expected_recoveries) < 1);

  // An asset shock is a charge of that share of the invested assets.
  const crash = out.scenarios['Investment markets fall'];
  assert.equal(crash.surplus_charge, Math.round(out.assumptions.invested_assets * 0.1 * 100) / 100);
  assert.ok(Math.abs((base.result.mean - crash.structures.proposed.result_mean) - crash.surplus_charge) < 1);
  assert.ok(['holds', 'strained', 'breach'].includes(crash.structures.proposed.standing));
  assert.equal(crash.structures.proposed.threat, crash.structures.proposed.standing !== 'holds');
  assert.equal(Object.keys(runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 500 } }).scenarios).length, 0);
});

test('a domicile reads the capital held against that country\'s ladder', () => {
  const structures = { current: XOL };
  const none = runDfa({ portfolio: PORTFOLIO, structures, assumptions: { trials: 2000, seed: 7 } });
  assert.equal(none.regime, null);
  assert.equal(none.structures.current.regime, null);
  assert.ok(['holds', 'strained', 'breach'].includes(none.structures.current.standing));

  // Solvency II: the modelled 1-in-200 loss is the SCR; holding exactly the
  // gross 1-in-200 loss reads 100% gross and better net of the programme.
  const gb = runDfa({ portfolio: PORTFOLIO, structures, assumptions: { trials: 2000, seed: 7, domicile: 'United Kingdom' } });
  assert.equal(gb.regime.code, 'GB');
  assert.equal(gb.assumptions.domicile, 'GB');
  const g = gb.gross.regime;
  const c = gb.structures.current.regime;
  assert.equal(g.required_source, 'modelled');
  assert.equal(g.ratio_pct, 100);
  assert.equal(g.strain_before_action, 0);
  assert.ok(c.ratio_pct > 100);
  assert.equal(c.band.level, 'SCR met');
  assert.equal(c.required, Math.round((c.modelled * 100 / 100) * 100) / 100);
  assert.ok(c.prob_breach_pct < g.prob_breach_pct);
  assert.ok(c.prob_control_pct <= c.prob_breach_pct);
  assert.ok(c.ratio_end_p1_pct < c.ratio_end_p10_pct && c.ratio_end_p10_pct < c.ratio_end_mean_pct);
  assert.equal(c.intervention_pct, 100);
  assert.equal(c.control_pct, 25);

  // NAIC RBC with the ACL typed from the annual statement: the ratio is
  // TAC over the ACL and the band follows the NAIC ladder.
  const us = runDfa({
    portfolio: PORTFOLIO, structures,
    assumptions: { trials: 2000, seed: 7, domicile: 'US', available_capital: 6_000_000, regulatory_required_capital: 5_000_000 },
  });
  const u = us.structures.current.regime;
  assert.equal(u.required_source, 'given');
  assert.equal(u.required, 5_000_000);
  assert.equal(u.ratio_pct, 120);
  assert.equal(u.band.level, 'Regulatory Action Level');
  assert.equal(u.strain_before_action, 6_000_000 - 10_000_000);
  assert.equal(us.structures.current.standing, 'breach');
  assert.equal(standingOf(us.structures.current), 'breach');

  // A fixed minimum capital needs the figure typed.
  const zw = runDfa({ portfolio: PORTFOLIO, structures, assumptions: { trials: 1000, seed: 7, domicile: 'ZW' } });
  assert.equal(zw.structures.current.regime.needs_input, true);
  assert.equal(zw.structures.current.regime.ratio_pct, null);
  assert.equal(zw.structures.current.regime.prob_breach_pct, null);
  const unknown = runDfa({ portfolio: PORTFOLIO, structures, assumptions: { trials: 1000, seed: 7, domicile: 'Atlantis' } });
  assert.equal(unknown.regime, null);
});

// ---- The structuring module's engine work: surplus, the profile, asset returns, the distributions ----

import {
  surplusShare, surplusAverageCession, defaultRiskProfile, normaliseRiskProfile, runStructuring,
} from '../../src/domain/dfa.js';

test('a surplus cedes per risk: nothing within the line, the part above it up to the lines', () => {
  assert.equal(surplusShare(500_000, 1_000_000, 4), 0);
  assert.equal(surplusShare(5_000_000, 1_000_000, 4), 0.8);   // 4m of 5m
  assert.equal(surplusShare(10_000_000, 1_000_000, 4), 0.4);  // capped at 4 lines
  assert.equal(surplusShare(2_000_000, 0, 4), 0);
  const profile = { bands: [{ sum_insured: 1_000_000, premium_pct: 50 }, { sum_insured: 5_000_000, premium_pct: 50 }] };
  assert.ok(Math.abs(surplusAverageCession(profile, 1_000_000, 4) - 0.4) < 1e-12);
  // Net of a 20% quota share the risks are smaller: 0.8m and 4m ⇒ 0 and 3m/4m.
  assert.ok(Math.abs(surplusAverageCession(profile, 1_000_000, 4, 0.8) - 0.375) < 1e-12);
  assert.equal(surplusAverageCession(null, 1_000_000, 4), 0);
});

test('a surplus treaty in a hand-checkable year, alone and behind a quota share', () => {
  const profile = { bands: [{ sum_insured: 1_000_000, premium_pct: 50 }, { sum_insured: 5_000_000, premium_pct: 50 }] };
  const ctx = { ...CTX, profile };
  const trial = [{
    attritional: 1_000_000,
    events: [
      { amount: 2_000_000, cat: false, si: 5_000_000 }, // 80% of the risk ⇒ 1.6m
      { amount: 3_000_000, cat: false, si: 3_000_000 }, // min(4m, 2m)/3m ⇒ 2m
      { amount: 5_000_000, cat: true },                  // spread: the 40% average ⇒ 2m
    ],
  }];
  const run = applyStructure(trial, { surplus: { retained_line: 1_000_000, lines: 4, commission_pct: 20 } }, ctx);
  // Attritional at the average: 0.4m. Total ceded 0.4 + 1.6 + 2 + 2.
  assert.ok(Math.abs(run.cededLoss[0] - 6_000_000) < 0.01);
  assert.equal(run.flows.surplus_premium, 4_000_000);          // 40% of 10m
  assert.equal(run.flows.surplus_commission, 800_000);
  assert.equal(run.flows.surplus_average_cession_pct, 40);
  assert.equal(run.netPremium[0], 6_800_000);                  // 10m − 4m + 0.8m
  assert.equal(run.reinsurerMargin[0], 4_000_000 - 6_000_000 - 800_000);
  assert.equal(run.structure.surplus.lines, 4);

  // Behind a 20% quota share the surplus reads each risk net of the cession:
  // the 5m risk is 4m, the retained 1.6m event cedes 75% ⇒ 1.2m; the 3m risk
  // is 2.4m ⇒ 1.4m/2.4m of the retained 2.4m ⇒ 1.4m; the cat 4m × 37.5%.
  const both = applyStructure(trial, {
    quota_share: { cession_pct: 20, commission_pct: 0 },
    surplus: { retained_line: 1_000_000, lines: 4, commission_pct: 20 },
  }, ctx);
  const qs = 0.2 * (1_000_000 + 2_000_000 + 3_000_000 + 5_000_000);
  const sp = 800_000 * 0.375 + 1_200_000 + 1_400_000 + 4_000_000 * 0.375;
  assert.ok(Math.abs(both.cededLoss[0] - (qs + sp)) < 0.01, `${both.cededLoss[0]} vs ${qs + sp}`);
  assert.equal(both.flows.surplus_premium, 8_000_000 * 0.375);
  // The excess of loss sees what the surplus leaves: the 3m event nets to 1m.
  const layered = applyStructure(trial, {
    surplus: { retained_line: 1_000_000, lines: 4, commission_pct: 20 },
    xol_layers: [{ attachment: 500_000, limit: 1_500_000, premium100: 100_000, reinstatements: '2' }],
  }, ctx);
  // Retained events: 0.4m (below), 1m ⇒ 0.5m to the layer, 3m ⇒ 1.5m.
  assert.ok(Math.abs(layered.cededLoss[0] - (6_000_000 + 500_000 + 1_500_000)) < 0.01);

  // Without a profile every event is a total loss on a risk of its own size,
  // the attritional cost cedes nothing, and no premium is ceded.
  const unsized = [{ attritional: 1_000_000, events: trial[0].events.map(({ si, ...e }) => e) }];
  const bare = applyStructure(unsized, { surplus: { retained_line: 1_000_000, lines: 4, commission_pct: 20 } }, CTX);
  // 2m on 2m ⇒ 1m; 3m on 3m ⇒ 2m; cat at 0.
  assert.ok(Math.abs(bare.cededLoss[0] - 3_000_000) < 0.01);
  assert.equal(bare.flows.surplus_premium, 0);
  // An event limit caps what a cat event cedes.
  const capped = applyStructure(trial, { surplus: { retained_line: 1_000_000, lines: 4, commission_pct: 20, event_limit: 500_000 } }, ctx);
  assert.ok(Math.abs(capped.cededLoss[0] - (400_000 + 500_000 + 500_000 + 500_000)) < 0.01);
});

test('the risk profile: assumed from the calibration unless given, and every large event sits on a risk', () => {
  const dflt = defaultRiskProfile(250_000, 32_000_000);
  assert.equal(dflt.source, 'default');
  assert.equal(dflt.bands.length, 5);
  assert.equal(dflt.bands[0].sum_insured, 250_000);
  assert.equal(dflt.bands[4].sum_insured, 32_000_000);
  assert.ok(Math.abs(dflt.bands.reduce((a, b) => a + b.premium_pct, 0) - 100) < 0.05);
  assert.ok(dflt.bands[0].premium_pct > dflt.bands[1].premium_pct);
  const given = normaliseRiskProfile([{ sum_insured: 2_000_000, premium_pct: 30 }, { sum_insured: 500_000, premium_pct: 90 }, { sum_insured: 0, premium_pct: 5 }], 250_000, 1e7);
  assert.equal(given.source, 'given');
  assert.deepEqual(given.bands, [{ sum_insured: 500_000, premium_pct: 75 }, { sum_insured: 2_000_000, premium_pct: 25 }]);
  assert.equal(normaliseRiskProfile([], 250_000, 1e7).source, 'default');

  const c = calibratePortfolio(PORTFOLIO);
  assert.equal(c.profile.source, 'default');
  assert.equal(c.profile.bands[0].sum_insured, 250_000);
  assert.equal(c.profile.bands[4].sum_insured, c.large.cap);
  const t = simulateGrossTrials(c, { trials: 2000, seed: 5 });
  const large = t.flatMap((y) => y.events.filter((e) => !e.cat));
  assert.ok(large.length > 1000);
  const sis = new Set(c.profile.bands.map((b) => b.sum_insured));
  assert.ok(large.every((e) => e.si >= e.amount - 1e-6 && (sis.has(e.si) || e.si === e.amount)));
  assert.ok(t.flatMap((y) => y.events.filter((e) => e.cat)).every((e) => e.si === undefined));
  // The risks have their own stream: the years are the ones a book without a profile samples.
  const g = calibratePortfolio({ ...PORTFOLIO, risk_profile: [{ sum_insured: 1e6, premium_pct: 100 }] });
  const t2 = simulateGrossTrials(g, { trials: 2000, seed: 5 });
  assert.deepEqual(t.map((y) => y.attritional), t2.map((y) => y.attritional));
  assert.deepEqual(t.map((y) => y.events.map((e) => e.amount)), t2.map((y) => y.events.map((e) => e.amount)));
  // Scaling inflates the sums insured with the losses.
  assert.equal(scaleCalibration(c, { severity: 1.1 }).profile.bands[0].sum_insured, 275_000);
  // A run reports the profile it used.
  const out = runDfa({ portfolio: PORTFOLIO, structures: { s: { surplus: { retained_line: 1_000_000, lines: 5, commission_pct: 25 } } }, assumptions: { trials: 1000, seed: 2 } });
  assert.equal(out.calibration.risk_profile.source, 'default');
  const s = out.structures.s;
  assert.ok(s.structure.surplus.average_cession_pct > 0 && s.structure.surplus.average_cession_pct < 100);
  assert.ok(s.reinsurance.ceded_premium > 0 && s.reinsurance.expected_recoveries > 0);
  assert.ok(s.capital.required < out.gross.capital.required);
});

test('asset returns: the yield’s volatility widens net income and the surplus path, never the underwriting result', () => {
  const still = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 3, horizon_years: 2 } });
  const moving = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 3, horizon_years: 2, asset_return_volatility_pct: 10 } });
  const a = still.structures.current;
  const b = moving.structures.current;
  assert.equal(still.assumptions.asset_return_volatility_pct, 0);
  assert.equal(moving.assumptions.asset_return_volatility_pct, 10);
  assert.deepEqual(a.result, b.result);
  assert.ok(b.net_income.sd > a.net_income.sd * 1.05);
  assert.ok(Math.abs(b.investment_income_mean - a.investment_income_mean) / a.investment_income_mean < 0.1);
  assert.ok(b.horizon.surplus_end.sd > a.horizon.surplus_end.sd);
  // With the yield fixed, net income is the result plus a fixed return on the capital and the float.
  assert.ok(Math.abs(a.net_income.mean - (a.result.mean + a.investment_income_mean)) < 1);
  assert.ok(a.investment_income_mean > 0);
});

test('the year on the balance sheet: combined ratio, net income and the year-end solvency as distributions', () => {
  const out = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 3000, seed: 7, available_capital: 6_000_000 } });
  const b = out.structures.current;
  const cr = b.combined_ratio;
  assert.ok(cr.p50 <= cr.p90 && cr.p90 <= cr.p99);
  assert.ok(Math.abs(cr.mean - b.combined_ratio_pct) / b.combined_ratio_pct < 0.05);
  assert.ok(b.net_income.p1 < b.net_income.p50);
  assert.ok(b.prob_net_loss_pct <= b.prob_uw_loss_pct);
  const s = b.solvency_end;
  assert.ok(s.p1 < s.p10 && s.p10 < s.p50);
  assert.ok(Math.abs(s.mean - ((6_000_000 + b.net_income.mean) / b.capital.required) * 100) < 0.5);
  assert.ok(s.prob_below_100_pct >= 0 && s.prob_below_100_pct <= 100);
  assert.equal(typeof out.frontier[1].combined_ratio_p90, 'number');
  // The compact block a stress reads carries the same figures.
  const stressed = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, scenarios: { hot: { loss_ratio_delta_pts: 10 } }, assumptions: { trials: 1000, seed: 7 } });
  const c = stressed.scenarios.hot.structures.current;
  assert.ok(c.combined_ratio_p90 > 0 && typeof c.net_income_p1 === 'number' && typeof c.loss_1in100_pct_of_capital === 'number');
});

test('runStructuring applies the references and every candidate to the same years, then the stresses', () => {
  const candidates = {
    'XoL · retention 1m': { xol_layers: [{ attachment: 1_000_000, limit: 4_000_000, reinstatements: 1 }] },
    'QS 30%': { quota_share: { cession_pct: 30, commission_pct: 25 } },
    'Surplus · line 500k × 5': { surplus: { retained_line: 500_000, lines: 5, commission_pct: 25 } },
  };
  const out = runStructuring({
    portfolio: PORTFOLIO,
    structures: { current: XOL },
    candidates,
    assumptions: { trials: 1500, seed: 9, domicile: 'GB' },
    stresses: { 'A major cat year': { forced_cat_pml_multiple: 1 }, 'Rates inadequate': { loss_ratio_delta_pts: 10 } },
  });
  assert.equal(out.trials, 1500);
  assert.deepEqual(Object.keys(out.references), ['current']);
  assert.deepEqual(Object.keys(out.candidates), Object.keys(candidates));
  assert.deepEqual(Object.keys(out.stresses), ['A major cat year', 'Rates inadequate']);
  // Same gross years for every structure: the gross loss is one distribution.
  const plain = runDfa({ portfolio: PORTFOLIO, structures: { current: XOL }, assumptions: { trials: 1500, seed: 9, domicile: 'GB' } });
  assert.deepEqual(out.gross.loss, plain.gross.loss);
  assert.deepEqual(out.references.current.result, plain.structures.current.result);
  // Compact: what the stage reads, not the desk's attribution.
  const c = out.candidates['QS 30%'];
  assert.ok(c.reinsurance.ceded_premium > 0 && c.combined_ratio.p90 > 0 && c.solvency_end && c.regime && c.standing);
  assert.equal(c.layers, undefined);
  assert.equal(c.ep_curve, undefined);
  assert.ok(out.candidates['Surplus · line 500k × 5'].structure.surplus.average_cession_pct > 0);
  const stress = out.stresses['Rates inadequate'];
  assert.equal(stress.expected_loss_ratio_pct, 72);
  assert.deepEqual(Object.keys(stress.structures), ['current', ...Object.keys(candidates)]);
  assert.ok(stress.structures['QS 30%'].result_mean < c.result.mean);
  assert.equal(out.stresses['A major cat year'].forced_event, out.calibration.cat_event_1in200);
});
