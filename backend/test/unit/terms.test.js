import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicaliseTerms, presentTerms, validateTerms, prepareTerms, diffTerms } from '../../src/domain/terms.js';
import { PROPERTY_CAT_XL } from '../../src/domain/termSchemas/propertyCatXl.js';
import { PROPERTY_SURPLUS } from '../../src/domain/termSchemas/propertySurplus.js';

/**
 * §1.3 — typed terms, §2.6 — integer minor units, §1.2 — the generic diff.
 * Worked examples use the shapes D9 names: Property Cat XL and Property Surplus.
 */

const catXl = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  layer_no: 2,
  layer_of: 4,
  rate_pct: 3.75,
  rate_type: 'FLAT',
  egnpi: '80000000',
  brokerage_pct: 10,
  reinstatements: [
    { count: 1, rate_pct: 100, pro_rata_time: true, pro_rata_amount: true },
    { count: 1, rate_pct: 50, pro_rata_time: false, pro_rata_amount: true },
  ],
  ...over,
});

const surplus = (over = {}) => ({
  currency: 'USD',
  lines_ceded: 9,
  retention: '1000000',
  max_cession: '9000000',
  commission_pct: 30,
  epi: '45000000',
  brokerage_pct: 10,
  ...over,
});

// ---------------------------------------------------------------------------
// §2.6 — money never reaches the database as a float
// ---------------------------------------------------------------------------
test('declared money fields become integer minor units', () => {
  const t = prepareTerms(catXl({ deductible: '5000000.50' }), PROPERTY_CAT_XL);
  assert.equal(t.deductible, 500000050);
  assert.equal(t.limit, 2000000000);
  assert.equal(t.egnpi, 8000000000);
  assert.ok(Number.isInteger(t.deductible));
});

test('percentages are not money and are left alone', () => {
  const t = prepareTerms(catXl(), PROPERTY_CAT_XL);
  assert.equal(t.rate_pct, 3.75, 'a rate is a rate, not an amount');
  assert.equal(t.brokerage_pct, 10);
  assert.equal(t.reinstatements[1].rate_pct, 50);
});

test('money nested inside arrays is converted too', () => {
  const t = prepareTerms(catXl({
    mdp: '1200000',
    mdp_instalments: [
      { due_date: '2026-01-01', amount: '600000.25' },
      { due_date: '2026-04-01', amount: '599999.75' },
    ],
  }), PROPERTY_CAT_XL);
  assert.equal(t.mdp, 120000000);
  assert.deepEqual(t.mdp_instalments.map((i) => i.amount), [60000025, 59999975]);
});

test('canonicalising an already-canonical document is a no-op', () => {
  const once = prepareTerms(catXl(), PROPERTY_CAT_XL);
  const twice = canonicaliseTerms(once, PROPERTY_CAT_XL);
  assert.deepEqual(twice, once, 'versions get re-read, copied forward and diffed');
});

test('terms round-trip back to decimal strings for display', () => {
  const t = prepareTerms(catXl({ limit: '20000000.99' }), PROPERTY_CAT_XL);
  assert.equal(presentTerms(t, PROPERTY_CAT_XL).limit, '20000000.99');
});

test('the currency is required and must be one we handle', () => {
  assert.throws(() => prepareTerms(catXl({ currency: undefined }), PROPERTY_CAT_XL), /currency is required/);
  assert.throws(() => prepareTerms(catXl({ currency: 'XXX' }), PROPERTY_CAT_XL), /Unsupported currency/);
});

test('a zero-decimal currency does not acquire cents', () => {
  const t = prepareTerms(catXl({ currency: 'JPY', deductible: '5000000', limit: '20000000', egnpi: '80000000' }), PROPERTY_CAT_XL);
  assert.equal(t.deductible, 5000000, 'assuming 2dp would inflate a JPY layer 100x');
});

// ---------------------------------------------------------------------------
// §1.3 — the schema is what makes terms computable by M11
// ---------------------------------------------------------------------------
test('Property Cat XL requires attachment, limit, rate and brokerage', () => {
  for (const field of ['deductible', 'limit', 'rate_pct', 'rate_type', 'brokerage_pct']) {
    const t = catXl();
    delete t[field];
    assert.throws(() => prepareTerms(t, PROPERTY_CAT_XL), /do not satisfy/, `${field} must be required`);
  }
});

test('a swing rate must carry its min and max, or year-end adjustment cannot run', () => {
  assert.throws(
    () => prepareTerms(catXl({ rate_type: 'SWING' }), PROPERTY_CAT_XL),
    /do not satisfy/,
  );
  const ok = prepareTerms(catXl({ rate_type: 'SWING', swing_min_pct: 2, swing_max_pct: 6 }), PROPERTY_CAT_XL);
  assert.equal(ok.swing_max_pct, 6);
});

test('"layer 2" without "of 4" is refused', () => {
  const t = catXl();
  delete t.layer_of;
  assert.throws(() => prepareTerms(t, PROPERTY_CAT_XL), /do not satisfy/);
});

test('a free reinstatement is rate zero, not count zero', () => {
  // `count` is how many; `rate_pct` is what they cost. Conflating the two
  // loses one of them, and a "free" layer would silently become a layer with
  // no reinstatements at all.
  const free = prepareTerms(catXl({
    reinstatements: [{ count: 1, rate_pct: 0 }],
    aggregate_limit: '40000000',
  }), PROPERTY_CAT_XL);
  assert.equal(free.reinstatements[0].count, 1, 'one reinstatement...');
  assert.equal(free.reinstatements[0].rate_pct, 0, '...which happens to be free');

  assert.throws(
    () => prepareTerms(catXl({ reinstatements: [{ count: 0, rate_pct: 0 }] }), PROPERTY_CAT_XL),
    /do not satisfy/,
    'count 0 is not a way of saying "free"',
  );
});

test('unlimited reinstatements are a flag, not a large integer', () => {
  const t = prepareTerms(catXl({ reinstatements: [{ unlimited: true, rate_pct: 100 }] }), PROPERTY_CAT_XL);
  assert.equal(t.reinstatements[0].unlimited, true);

  assert.throws(
    () => prepareTerms(catXl({ reinstatements: [{ unlimited: true, count: 3, rate_pct: 100 }] }), PROPERTY_CAT_XL),
    /do not satisfy/,
    'countable or unlimited, not both',
  );
  assert.throws(
    () => prepareTerms(catXl({ reinstatements: [{ rate_pct: 100 }] }), PROPERTY_CAT_XL),
    /do not satisfy/,
    'and one of them always',
  );
});

test('pro-rata time and amount are independent — a slip may say either, both or neither', () => {
  const both = prepareTerms(catXl({
    reinstatements: [{ count: 1, rate_pct: 100, pro_rata_time: true, pro_rata_amount: true }],
  }), PROPERTY_CAT_XL);
  assert.equal(both.reinstatements[0].pro_rata_time, true);

  const neither = prepareTerms(catXl({ reinstatements: [{ count: 1, rate_pct: 100 }] }), PROPERTY_CAT_XL);
  assert.equal(neither.reinstatements[0].pro_rata_time, undefined,
    'absent stays absent — no default is silently applied');
  assert.equal(neither.reinstatements[0].pro_rata_amount, undefined);
});

test('unknown fields are rejected rather than silently stored', () => {
  assert.throws(
    () => prepareTerms(catXl({ favourite_colour: 'blue' }), PROPERTY_CAT_XL),
    /do not satisfy/,
    'free-form JSON is exactly what §1.3 forbids',
  );
});

test('every schema failure is reported at once, not one at a time', () => {
  const t = catXl();
  delete t.limit;
  delete t.brokerage_pct;
  try {
    prepareTerms(t, PROPERTY_CAT_XL);
    assert.fail('should have thrown');
  } catch (err) {
    const paths = err.details.termErrors.map((e) => e.params?.missingProperty).filter(Boolean);
    assert.ok(paths.includes('limit') && paths.includes('brokerage_pct'));
  }
});

test('Property Surplus must say how much it cedes, and only one way', () => {
  const neither = surplus();
  delete neither.lines_ceded;
  assert.throws(() => prepareTerms(neither, PROPERTY_SURPLUS), /do not satisfy/);

  assert.throws(
    () => prepareTerms(surplus({ cession_pct: 25 }), PROPERTY_SURPLUS),
    /do not satisfy/,
    'lines and a flat cession together is a contradiction, not extra detail',
  );

  const qsShaped = prepareTerms({ ...surplus({ cession_pct: 25 }), lines_ceded: undefined }, PROPERTY_SURPLUS);
  assert.equal(qsShaped.cession_pct, 25);
});

test('a flat commission and a sliding scale cannot both be stated', () => {
  const scale = {
    provisional_pct: 30, min_pct: 25, max_pct: 35,
    bands: [{ loss_ratio_from_pct: 0, loss_ratio_to_pct: null, commission_pct: 30 }],
  };
  assert.throws(
    () => prepareTerms(surplus({ sliding_scale: scale }), PROPERTY_SURPLUS),
    /do not satisfy/,
    'M11 would not know which to pay on',
  );
  const ok = prepareTerms({ ...surplus(), commission_pct: undefined, sliding_scale: scale }, PROPERTY_SURPLUS);
  assert.equal(ok.sliding_scale.bands.length, 1);
});

test('profit commission without an expense allowance is not computable', () => {
  assert.throws(
    () => prepareTerms(surplus({ profit_commission_pct: 20 }), PROPERTY_SURPLUS),
    /do not satisfy/,
  );
  const ok = prepareTerms(surplus({ profit_commission_pct: 20, pc_expenses_pct: 5 }), PROPERTY_SURPLUS);
  assert.equal(ok.pc_expenses_pct, 5);
});

test('the two D9 schemas do not accept each other\'s terms', () => {
  assert.throws(() => prepareTerms(catXl(), PROPERTY_SURPLUS), /do not satisfy/);
  assert.throws(() => prepareTerms(surplus(), PROPERTY_CAT_XL), /do not satisfy/);
});

// ---------------------------------------------------------------------------
// §1.2 — one generic diff over terms
// ---------------------------------------------------------------------------
test('diffing two states reports each changed leaf with its path', () => {
  const before = prepareTerms(catXl(), PROPERTY_CAT_XL);
  const after = prepareTerms(catXl({ deductible: '7500000', rate_pct: 4.25 }), PROPERTY_CAT_XL);
  const changes = diffTerms(before, after);

  assert.deepEqual(changes.map((c) => c.path), ['deductible', 'rate_pct']);
  assert.deepEqual(
    changes.find((c) => c.path === 'deductible'),
    { path: 'deductible', from: 500000000, to: 750000000, change: 'changed' },
  );
});

test('the diff reaches inside the reinstatement schedule', () => {
  const before = prepareTerms(catXl(), PROPERTY_CAT_XL);
  const after = prepareTerms(catXl({
    reinstatements: [
      { count: 1, rate_pct: 100, pro_rata_time: true, pro_rata_amount: true },
      { count: 1, rate_pct: 75, pro_rata_time: false, pro_rata_amount: true },
    ],
  }), PROPERTY_CAT_XL);

  assert.deepEqual(diffTerms(before, after), [
    { path: 'reinstatements.1.rate_pct', from: 50, to: 75, change: 'changed' },
  ]);
});

test('added and removed fields are distinguished from changed ones', () => {
  const before = prepareTerms(catXl(), PROPERTY_CAT_XL);
  // 2 reinstatements on a 20m limit: 20m x (1 + 2) = 60m.
  const after = prepareTerms(catXl({ aggregate_limit: '60000000', egnpi: undefined }), PROPERTY_CAT_XL);
  const changes = diffTerms(before, after);

  assert.equal(changes.find((c) => c.path === 'aggregate_limit').change, 'added');
  assert.equal(changes.find((c) => c.path === 'egnpi').change, 'removed');
});

test('identical terms diff to nothing', () => {
  const t = prepareTerms(catXl(), PROPERTY_CAT_XL);
  assert.deepEqual(diffTerms(t, structuredClone(t)), []);
});

test('the diff is generic — it works on proportional terms unchanged', () => {
  const before = prepareTerms(surplus(), PROPERTY_SURPLUS);
  const after = prepareTerms(
    surplus({ lines_ceded: 12, max_cession: '12000000', commission_pct: 32.5 }),
    PROPERTY_SURPLUS,
  );
  assert.deepEqual(diffTerms(before, after).map((c) => c.path),
    ['commission_pct', 'lines_ceded', 'max_cession']);
});

test('validate accepts a canonical document that prepare produced', () => {
  const t = prepareTerms(catXl(), PROPERTY_CAT_XL);
  assert.equal(validateTerms(t, PROPERTY_CAT_XL), t);
});
