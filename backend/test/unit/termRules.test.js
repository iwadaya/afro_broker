import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTerms } from '../../src/domain/terms.js';
import { structureWarnings, reinstatementCount } from '../../src/domain/termRules.js';
import { PROPERTY_CAT_XL } from '../../src/domain/termSchemas/propertyCatXl.js';
import { PROPERTY_SURPLUS } from '../../src/domain/termSchemas/propertySurplus.js';

/**
 * Cross-field reconciliation (§1.3, §2.5).
 *
 * Every rule here guards a failure that is quiet rather than loud: the numbers
 * stay individually plausible and the calculations stay internally consistent,
 * and the error only surfaces at year-end as a figure nobody can explain.
 */

const catXl = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  ...over,
});

const surplus = (over = {}) => ({
  currency: 'USD',
  lines_ceded: 9,
  retention: '1000000',
  max_cession: '9000000',
  commission_pct: 30,
  brokerage_pct: 10,
  ...over,
});

const scale = (over = {}) => ({
  provisional_pct: 30,
  min_pct: 25,
  max_pct: 35,
  bands: [
    { loss_ratio_from_pct: 0, loss_ratio_to_pct: 50, commission_pct: 35 },
    { loss_ratio_from_pct: 50, loss_ratio_to_pct: 70, commission_pct: 30 },
    { loss_ratio_from_pct: 70, loss_ratio_to_pct: null, commission_pct: 25 },
  ],
  ...over,
});

const errorsFrom = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.details.termErrors.map((e) => e.message).join(' | ');
  }
};

// ---------------------------------------------------------------------------
// Cat XL — aggregate limit against the reinstatement schedule
// ---------------------------------------------------------------------------
test('aggregate limit must equal limit x (1 + reinstatements)', () => {
  // 20m limit, 2 reinstatements -> 60m aggregate.
  const ok = prepareTerms(catXl({
    reinstatements: [{ count: 2, rate_pct: 100 }],
    aggregate_limit: '60000000',
  }), PROPERTY_CAT_XL);
  assert.equal(ok.aggregate_limit, 6000000000);

  const wrong = errorsFrom(() => prepareTerms(catXl({
    reinstatements: [{ count: 2, rate_pct: 100 }],
    aggregate_limit: '40000000',
  }), PROPERTY_CAT_XL));
  assert.match(wrong, /does not reconcile/);
  assert.match(wrong, /expected USD 60000000\.00/,
    'the message says what the aggregate should have been');
});

test('reinstatements split across rates still sum for the aggregate', () => {
  // 1st at 100%, 2nd at 50% — two reinstatements in total, so 3 x limit.
  const ok = prepareTerms(catXl({
    reinstatements: [
      { count: 1, rate_pct: 100 },
      { count: 1, rate_pct: 50 },
    ],
    aggregate_limit: '60000000',
  }), PROPERTY_CAT_XL);
  assert.equal(ok.aggregate_limit, 6000000000);
});

test('a free reinstatement still consumes aggregate', () => {
  // Free means rate 0, not "does not exist": the cover still reinstates, so
  // the aggregate is 2 x limit.
  const ok = prepareTerms(catXl({
    reinstatements: [{ count: 1, rate_pct: 0 }],
    aggregate_limit: '40000000',
  }), PROPERTY_CAT_XL);
  assert.equal(ok.aggregate_limit, 4000000000);

  assert.match(
    errorsFrom(() => prepareTerms(catXl({
      reinstatements: [{ count: 1, rate_pct: 0 }],
      aggregate_limit: '20000000',
    }), PROPERTY_CAT_XL)),
    /does not reconcile/,
    'a free reinstatement is not a zero reinstatement',
  );
});

test('unlimited reinstatements cannot sit under a finite aggregate', () => {
  assert.match(
    errorsFrom(() => prepareTerms(catXl({
      reinstatements: [{ unlimited: true, rate_pct: 100 }],
      aggregate_limit: '60000000',
    }), PROPERTY_CAT_XL)),
    /Unlimited reinstatements cannot sit under a finite aggregate/,
  );

  // Stated on its own it is fine — there simply is no aggregate.
  const ok = prepareTerms(catXl({ reinstatements: [{ unlimited: true, rate_pct: 100 }] }), PROPERTY_CAT_XL);
  assert.equal(reinstatementCount(ok.reinstatements), null);
});

test('an aggregate with no reinstatements stated is left alone', () => {
  const ok = prepareTerms(catXl({ aggregate_limit: '60000000' }), PROPERTY_CAT_XL);
  assert.equal(ok.aggregate_limit, 6000000000, 'nothing to reconcile against yet');
});

test('deposit instalments must sum to the deposit premium', () => {
  const ok = prepareTerms(catXl({
    mdp: '1000000',
    mdp_instalments: [
      { due_date: '2026-01-01', amount: '250000' },
      { due_date: '2026-04-01', amount: '250000' },
      { due_date: '2026-07-01', amount: '250000' },
      { due_date: '2026-10-01', amount: '250000' },
    ],
  }), PROPERTY_CAT_XL);
  assert.equal(ok.mdp, 100000000);

  assert.match(
    errorsFrom(() => prepareTerms(catXl({
      mdp: '1000000',
      mdp_instalments: [
        { due_date: '2026-01-01', amount: '250000' },
        { due_date: '2026-04-01', amount: '250000' },
      ],
    }), PROPERTY_CAT_XL)),
    /Instalments total USD 500000\.00 but the minimum and deposit premium is USD 1000000\.00/,
  );
});

// ---------------------------------------------------------------------------
// Surplus — maximum cession against retention and lines
// ---------------------------------------------------------------------------
test('maximum cession must equal retention x lines', () => {
  assert.equal(prepareTerms(surplus(), PROPERTY_SURPLUS).max_cession, 900000000);

  assert.match(
    errorsFrom(() => prepareTerms(surplus({ max_cession: '5000000' }), PROPERTY_SURPLUS)),
    /does not reconcile with 9 line\(s\) of USD 1000000\.00: expected USD 9000000\.00/,
  );
});

test('a fractional line count still reconciles', () => {
  const ok = prepareTerms(surplus({ lines_ceded: 9.5, max_cession: '9500000' }), PROPERTY_SURPLUS);
  assert.equal(ok.max_cession, 950000000);
});

// ---------------------------------------------------------------------------
// Surplus — the sliding scale, checked hardest
// ---------------------------------------------------------------------------
const withScale = (s) => ({ ...surplus(), commission_pct: undefined, sliding_scale: s });

test('a well-formed sliding scale passes', () => {
  const ok = prepareTerms(withScale(scale()), PROPERTY_SURPLUS);
  assert.equal(ok.sliding_scale.bands.length, 3);
});

test('a gap between bands is refused — a loss ratio there earns nothing', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({
      bands: [
        { loss_ratio_from_pct: 0, loss_ratio_to_pct: 50, commission_pct: 35 },
        { loss_ratio_from_pct: 60, loss_ratio_to_pct: null, commission_pct: 25 },
      ],
    })), PROPERTY_SURPLUS)),
    /Gap between 50% and 60%: a loss ratio in that range would earn no commission/,
  );
});

test('overlapping bands are refused — a loss ratio there has two commissions', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({
      bands: [
        { loss_ratio_from_pct: 0, loss_ratio_to_pct: 60, commission_pct: 35 },
        { loss_ratio_from_pct: 50, loss_ratio_to_pct: null, commission_pct: 25 },
      ],
    })), PROPERTY_SURPLUS)),
    /Bands overlap between 50% and 60%/,
  );
});

test('the bottom tail must be covered — bands start at 0%', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({
      bands: [
        { loss_ratio_from_pct: 40, loss_ratio_to_pct: 70, commission_pct: 35 },
        { loss_ratio_from_pct: 70, loss_ratio_to_pct: null, commission_pct: 25 },
      ],
    })), PROPERTY_SURPLUS)),
    /first band starts at 40%.*must start at 0%/s,
  );
});

test('the top tail must be covered — the last band is open-ended', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({
      bands: [
        { loss_ratio_from_pct: 0, loss_ratio_to_pct: 70, commission_pct: 35 },
        { loss_ratio_from_pct: 70, loss_ratio_to_pct: 120, commission_pct: 25 },
      ],
    })), PROPERTY_SURPLUS)),
    /last band ends at 120%.*must be open-ended/s,
    'a loss ratio can exceed any finite bound',
  );
});

test('an open-ended band that is not last is refused', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({
      bands: [
        { loss_ratio_from_pct: 0, loss_ratio_to_pct: null, commission_pct: 35 },
        { loss_ratio_from_pct: 70, loss_ratio_to_pct: null, commission_pct: 25 },
      ],
    })), PROPERTY_SURPLUS)),
    /open-ended but is not the last band/,
  );
});

test('provisional commission must fall between the minimum and maximum', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({ provisional_pct: 40 })), PROPERTY_SURPLUS)),
    /Provisional commission 40% must fall between the minimum 25% and maximum 35%/,
  );
});

test('a band cannot pay outside the scale it belongs to', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({
      bands: [
        { loss_ratio_from_pct: 0, loss_ratio_to_pct: 50, commission_pct: 45 },
        { loss_ratio_from_pct: 50, loss_ratio_to_pct: null, commission_pct: 25 },
      ],
    })), PROPERTY_SURPLUS)),
    /pays 45%, outside the scale's 25%–35% range/,
  );
});

test('a minimum above the maximum is refused', () => {
  assert.match(
    errorsFrom(() => prepareTerms(withScale(scale({ min_pct: 40, max_pct: 35, provisional_pct: 37 })), PROPERTY_SURPLUS)),
    /Minimum commission 40% exceeds the maximum 35%/,
  );
});

test('bands given out of order are still checked correctly', () => {
  const ok = prepareTerms(withScale(scale({
    bands: [
      { loss_ratio_from_pct: 70, loss_ratio_to_pct: null, commission_pct: 25 },
      { loss_ratio_from_pct: 0, loss_ratio_to_pct: 50, commission_pct: 35 },
      { loss_ratio_from_pct: 50, loss_ratio_to_pct: 70, commission_pct: 30 },
    ],
  })), PROPERTY_SURPLUS);
  assert.equal(ok.sliding_scale.bands.length, 3, 'order of entry is not a defect');
});

test('every inconsistency is reported at once', () => {
  const messages = errorsFrom(() => prepareTerms(withScale(scale({
    provisional_pct: 40,
    bands: [
      { loss_ratio_from_pct: 10, loss_ratio_to_pct: 50, commission_pct: 35 },
      { loss_ratio_from_pct: 60, loss_ratio_to_pct: 90, commission_pct: 30 },
    ],
  })), PROPERTY_SURPLUS));
  assert.match(messages, /Provisional commission/);
  assert.match(messages, /must start at 0%/);
  assert.match(messages, /Gap between 50% and 60%/);
  assert.match(messages, /must be open-ended/);
});

// ---------------------------------------------------------------------------
// Layer contiguity — a warning, deliberately not a rule
// ---------------------------------------------------------------------------
const layer = (label, deductible, limit) => ({
  id: label, label, basis: 'NP',
  latest_version: { terms: { currency: 'USD', deductible, limit } },
});

test('a contiguous tower produces no warnings', () => {
  assert.deepEqual(structureWarnings([
    layer('L1', 500000000, 1500000000),   // 5m xs 5m -> tops at 20m
    layer('L2', 2000000000, 3000000000),  // 30m xs 20m
  ]), []);
});

test('a gap in the tower is a warning, not an error', () => {
  const [w] = structureWarnings([
    layer('L1', 500000000, 1500000000),   // tops at 20m
    layer('L2', 2500000000, 3000000000),  // attaches at 25m
  ]);
  assert.equal(w.code, 'LAYER_GAP');
  assert.match(w.message, /may be deliberate/,
    'non-contiguous towers are a real thing and must not be forbidden');
  assert.deepEqual(w.structures, ['L1', 'L2']);
});

test('overlapping layers are also only a warning', () => {
  const [w] = structureWarnings([
    layer('L1', 500000000, 2000000000),   // tops at 25m
    layer('L2', 2000000000, 3000000000),  // attaches at 20m
  ]);
  assert.equal(w.code, 'LAYER_OVERLAP');
});

test('layers given out of order are sorted by attachment before checking', () => {
  assert.deepEqual(structureWarnings([
    layer('L2', 2000000000, 3000000000),
    layer('L1', 500000000, 1500000000),
  ]), []);
});

test('proportional structures are not part of the tower check', () => {
  assert.deepEqual(structureWarnings([
    layer('L1', 500000000, 1500000000),
    { id: 'S', label: 'Surplus', basis: 'PROP', latest_version: { terms: { currency: 'USD', retention: 1 } } },
  ]), []);
});
