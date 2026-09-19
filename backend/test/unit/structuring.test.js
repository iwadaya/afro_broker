import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compact, sig3, sweep, towerAt, buildCandidates, FAMILIES, FAMILY_KEYS, GRID_DEFAULTS,
  DEFAULT_APPETITE, DEFAULT_STRESSES, appetiteTests, appetiteOf, efficientSet, pickRecommended, assessStructuring,
} from '../../src/domain/structuring.js';
import { runStructuring } from '../../src/domain/dfa.js';

const CURRENT = {
  xol_layers: [
    { attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: 2 },
    { attachment: 10_000_000, limit: 20_000_000, premium100: 600_000, reinstatements: 1 },
  ],
};

test('labels say money the way a broker does, and a swept figure is a round one', () => {
  assert.equal(compact(5_000_000), '5m');
  assert.equal(compact(7_500_000), '7.5m');
  assert.equal(compact(250_000), '250k');
  assert.equal(compact(1_234_567), '1.23m');
  assert.equal(compact(2_500_000_000), '2.5bn');
  assert.equal(sig3(3_333_333), 3_330_000);
  assert.equal(sig3(0), 0);
});

test('a sweep walks the range in even steps, deduplicated', () => {
  assert.deepEqual(sweep(1_000_000, 8_000_000, 5), [1_000_000, 2_750_000, 4_500_000, 6_250_000, 8_000_000]);
  assert.deepEqual(sweep(10, 50, 5, Math.round), [10, 20, 30, 40, 50]);
  assert.deepEqual(sweep(2_000_000, 2_000_000, 4), [2_000_000]);
  assert.equal(sweep(1, 100, 99).length, 12); // capped
});

test('the tower at a retention keeps the current tower’s shape above it', () => {
  const layers = CURRENT.xol_layers;
  // Below the tower: a new priced bottom layer up to the first layer.
  const low = towerAt(layers, 2_000_000, 30_000_000);
  assert.deepEqual(low.map((l) => [l.attachment, l.limit, l.premium100]), [[2_000_000, 3_000_000, null], [5_000_000, 5_000_000, 900_000], [10_000_000, 20_000_000, 600_000]]);
  assert.equal(low[0].name, '3m xs 2m');
  // At the current retention: the tower as it is, quotes kept.
  assert.deepEqual(towerAt(layers, 5_000_000, 30_000_000).map((l) => l.premium100), [900_000, 600_000]);
  // Through the first layer: it starts at the retention and is re-priced; the rest stands.
  const mid = towerAt(layers, 8_000_000, 30_000_000);
  assert.deepEqual(mid.map((l) => [l.attachment, l.limit, l.premium100, l.reinstatements]), [[8_000_000, 2_000_000, null, 2], [10_000_000, 20_000_000, 600_000, 1]]);
  // Above the first layer: it goes, the second is cut.
  assert.deepEqual(towerAt(layers, 12_000_000, 30_000_000).map((l) => [l.attachment, l.limit]), [[12_000_000, 18_000_000]]);
  // A higher top adds a layer; a lower one trims.
  assert.deepEqual(towerAt(layers, 5_000_000, 40_000_000).map((l) => [l.attachment, l.limit]), [[5_000_000, 5_000_000], [10_000_000, 20_000_000], [30_000_000, 10_000_000]]);
  assert.deepEqual(towerAt(layers, 5_000_000, 20_000_000).map((l) => [l.attachment, l.limit]), [[5_000_000, 5_000_000], [10_000_000, 10_000_000]]);
  // No tower to start from: one layer, retention to top, with the grid's reinstatements.
  assert.deepEqual(towerAt([], 3_000_000, 20_000_000, 2).map((l) => [l.attachment, l.limit, l.reinstatements]), [[3_000_000, 17_000_000, 2]]);
  // A retention at or above the top is no tower at all.
  assert.deepEqual(towerAt(layers, 30_000_000, 30_000_000), []);
});

test('the grid builds every family across the range, each candidate a structure the engine takes', () => {
  const grid = { families: FAMILY_KEYS, steps: 4, retention_from: 2_000_000, retention_to: 8_000_000, tower_top: 30_000_000 };
  const list = buildCandidates(grid, { current: CURRENT });
  assert.equal(list.length, 16);
  assert.equal(new Set(list.map((c) => c.label)).size, 16, 'labels are unique');
  const by = (f) => list.filter((c) => c.family === f);
  assert.deepEqual(by('xol').map((c) => c.axis.value), [2_000_000, 4_000_000, 6_000_000, 8_000_000]);
  assert.ok(by('xol').every((c) => !c.structure.quota_share && !c.structure.surplus && c.structure.xol_layers.length >= 1));
  assert.deepEqual(by('quota_share').map((c) => c.structure.quota_share.cession_pct), [10, 23, 37, 50]);
  assert.ok(by('quota_share').every((c) => c.structure.quota_share.commission_pct === GRID_DEFAULTS.commission_pct && c.structure.xol_layers.length === 0));
  assert.deepEqual(by('surplus').map((c) => c.structure.surplus.retained_line), [2_000_000, 4_000_000, 6_000_000, 8_000_000]);
  assert.ok(by('surplus').every((c) => c.structure.surplus.lines === GRID_DEFAULTS.surplus_lines));
  assert.equal(by('surplus')[0].label, 'Surplus · line 2m × 5');
  const blend = by('blend')[0];
  assert.equal(blend.structure.quota_share.cession_pct, GRID_DEFAULTS.blend_cession_pct);
  assert.equal(blend.structure.xol_layers[0].attachment, 2_000_000);
  assert.equal(blend.label, 'QS 20% + XoL · retention 2m');
  // One family, its own terms.
  const qs = buildCandidates({ families: ['quota_share'], steps: 3, cession_from: 20, cession_to: 60, commission_pct: 30 });
  assert.deepEqual(qs.map((c) => [c.structure.quota_share.cession_pct, c.structure.quota_share.commission_pct]), [[20, 30], [40, 30], [60, 30]]);
  // A retention the tower cannot sit above is skipped, not built empty.
  const tall = buildCandidates({ families: ['xol'], steps: 3, retention_from: 10_000_000, retention_to: 30_000_000, tower_top: 20_000_000 }, { current: CURRENT });
  assert.deepEqual(tall.map((c) => c.axis.value), [10_000_000]);
  assert.ok(FAMILIES.every((f) => f.key && f.label && f.axis && f.text));
});

const block = (over = {}) => ({
  flows: { subject_premium: 10_000_000 },
  capital: { ruin_prob_pct: 0.2, loss_1in100_pct_of_capital: 40, solvency_ratio_pct: 150 },
  combined_ratio: { p90: 105 },
  result: { mean: 500_000, sd: 1_000_000 },
  reinsurance: { expected_cost: 300_000 },
  standing: 'holds',
  ...over,
});

test('the appetite reads test by test, a blank limit switches a test off', () => {
  const ok = appetiteOf(block(), DEFAULT_APPETITE);
  assert.equal(ok.pass, true);
  assert.deepEqual(ok.tests.map((t) => t.key), ['ruin', 'tail', 'solvency', 'earnings', 'standing']);
  assert.ok(ok.tests.every((t) => t.ok && t.shortfall === 0));

  const hot = appetiteOf(block({ capital: { ruin_prob_pct: 1.2, loss_1in100_pct_of_capital: 70, solvency_ratio_pct: 110 }, standing: 'strained' }), DEFAULT_APPETITE);
  assert.equal(hot.pass, false);
  assert.deepEqual(hot.failed, ['ruin', 'tail', 'solvency', 'standing']);
  const ruin = hot.tests.find((t) => t.key === 'ruin');
  assert.deepEqual([ruin.value, ruin.limit, ruin.op, ruin.ok], [1.2, 0.5, '≤', false]);
  assert.equal(ruin.shortfall, 1.4); // (1.2 − 0.5) / 0.5
  assert.equal(hot.shortfall, 1.4 + 0.17 + 0.08 + 0.5);

  // A budget only when given; a blank limit drops its test; the standing test can be turned off.
  const budget = appetiteTests(block(), { ...DEFAULT_APPETITE, max_cost_pct_of_premium: 2, max_ruin_pct: null, require_standing_holds: false });
  assert.deepEqual(budget.map((t) => [t.key, t.ok]), [['tail', true], ['solvency', true], ['earnings', true], ['budget', false]]);
  assert.equal(budget.find((t) => t.key === 'budget').value, 3); // 300k of 10m
  // A figure the run could not read passes rather than fails.
  assert.ok(appetiteOf(block({ capital: { ruin_prob_pct: 0, loss_1in100_pct_of_capital: null, solvency_ratio_pct: null } })).pass);
});

test('the efficient set and the pick', () => {
  const rows = [
    { label: 'a', result: { sd: 100 }, reinsurance: { expected_cost: 10 }, appetite: { pass: false, failed: ['tail'], shortfall: 0.5 } },
    { label: 'b', result: { sd: 80 }, reinsurance: { expected_cost: 20 }, appetite: { pass: true, failed: [], shortfall: 0 } },
    { label: 'c', result: { sd: 90 }, reinsurance: { expected_cost: 25 }, appetite: { pass: true, failed: [], shortfall: 0 } }, // dominated by b
    { label: 'd', result: { sd: 60 }, reinsurance: { expected_cost: 40 }, appetite: { pass: false, failed: ['ruin', 'tail'], shortfall: 0.2 } },
  ];
  assert.deepEqual(efficientSet(rows), [true, true, false, true]);
  assert.deepEqual(pickRecommended(rows), { label: 'b', fits: true, reason: 'the cheapest programme that keeps the insurer inside its appetite' });
  // Nothing fits: the fewest failures, then the smallest shortfall.
  const none = rows.map((r) => ({ ...r, appetite: r.label === 'b' || r.label === 'c' ? { pass: false, failed: ['ruin'], shortfall: 0.3 } : r.appetite }));
  assert.equal(pickRecommended(none).label, 'b');
  assert.equal(pickRecommended(none).fits, false);
  assert.equal(pickRecommended([]).label, null);
});

test('a structuring run read against the appetite: candidates, ranges by family, stresses and the pick', () => {
  const portfolio = {
    subject_premium: 50_000_000, expected_loss_ratio_pct: 65, large_frequency: 3,
    large_severity_mean: 800_000, cat_frequency: 0.3, cat_severity_mean: 6_000_000, opening_reserves: 20_000_000,
  };
  const current = { xol_layers: [{ attachment: 5_000_000, limit: 5_000_000, premium100: 900_000, reinstatements: '2' }] };
  const grid = { families: FAMILY_KEYS, steps: 3, retention_from: 2_000_000, retention_to: 8_000_000, tower_top: 20_000_000 };
  const candidates = buildCandidates(grid, { current });
  const result = runStructuring({
    portfolio,
    structures: { current },
    candidates: Object.fromEntries(candidates.map((c) => [c.label, c.structure])),
    assumptions: { trials: 1500, seed: 4, available_capital: 25_000_000 },
    stresses: DEFAULT_STRESSES,
  });
  const read = assessStructuring(result, { candidates, appetite: DEFAULT_APPETITE });
  assert.equal(read.candidates.length, 12);
  assert.deepEqual(read.candidates.map((c) => c.label), candidates.map((c) => c.label));
  for (const c of read.candidates) {
    assert.ok(typeof c.appetite.pass === 'boolean' && Array.isArray(c.appetite.tests));
    assert.ok(typeof c.efficient === 'boolean');
    assert.deepEqual(Object.keys(c.stress), Object.keys(DEFAULT_STRESSES));
    assert.ok(['holds', 'strained', 'breach'].includes(c.stress['A major cat year'].standing));
    assert.ok(c.combined_ratio.p90 >= c.combined_ratio.p50);
    assert.ok(c.net_income && c.solvency_end);
  }
  const d = read.defensible;
  assert.equal(d.tested, 12);
  assert.equal(d.fits, read.candidates.filter((c) => c.appetite.pass).length);
  assert.deepEqual(d.families.map((f) => f.family), FAMILY_KEYS);
  assert.deepEqual(d.stresses, Object.keys(DEFAULT_STRESSES));
  const xol = d.families.find((f) => f.family === 'xol');
  assert.deepEqual([xol.tested, xol.tested_from, xol.tested_to], [3, 2_000_000, 8_000_000]);
  // Exactly one candidate is the pick, and it is what the rule says.
  const picked = read.candidates.filter((c) => c.recommended);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].label, d.recommended);
  if (d.fits > 0) {
    assert.equal(d.recommended_fits, true);
    const fits = read.candidates.filter((c) => c.appetite.pass);
    assert.equal(picked[0].label, [...fits].sort((x, y) => x.reinsurance.expected_cost - y.reinsurance.expected_cost)[0].label);
    assert.ok(read.candidates.filter((c) => c.appetite.pass).length === d.fits);
  }
  // The references are read the same way.
  assert.ok(read.references.gross.appetite && read.references.current.appetite);
  assert.equal(read.references.gross.reinsurance, null);
  assert.deepEqual(Object.keys(read.references.current.stress), Object.keys(DEFAULT_STRESSES));
});
