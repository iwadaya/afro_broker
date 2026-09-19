import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerageByCurrency } from '../../src/domain/brokerage.js';

/**
 * D2 — Σ over signed lines: premium × signed_pct × structure.brokerage_pct,
 * with premium × signed_pct arriving as the stored premium_signed_minor.
 */

test('the D2 worked example: 10% brokerage on a fully placed USD 1m premium', () => {
  // Three signed lines allocated 40/40/20 of USD 1,000,000.00.
  const out = brokerageByCurrency([
    { premiumSignedMinor: 40000000, brokeragePct: 10, currency: 'USD' },
    { premiumSignedMinor: 40000000, brokeragePct: 10, currency: 'USD' },
    { premiumSignedMinor: 20000000, brokeragePct: 10, currency: 'USD' },
  ]);
  assert.deepEqual(out, [{ currency: 'USD', brokerageMinor: 10000000 }], 'USD 100,000.00');
});

test('brokerage can differ per structure, and each line contributes at its own rate', () => {
  // D2 puts brokerage on the structure terms, so two structures on one year can
  // legitimately carry different rates.
  const out = brokerageByCurrency([
    { premiumSignedMinor: 10000000, brokeragePct: 10, currency: 'USD' },   // 1,000,000
    { premiumSignedMinor: 10000000, brokeragePct: 12.5, currency: 'USD' }, // 1,250,000
  ]);
  assert.deepEqual(out, [{ currency: 'USD', brokerageMinor: 2250000 }]);
});

test('currencies never mix — no FX rate exists to combine them', () => {
  const out = brokerageByCurrency([
    { premiumSignedMinor: 10000000, brokeragePct: 10, currency: 'USD' },
    { premiumSignedMinor: 5000000, brokeragePct: 10, currency: 'JPY' },
  ]);
  assert.deepEqual(out, [
    { currency: 'JPY', brokerageMinor: 500000 },
    { currency: 'USD', brokerageMinor: 1000000 },
  ]);
});

test('rounding happens once per currency, not once per line', () => {
  // 12.5% of 33,333 minor = 4,166.625 per line. Rounded per line (4167 x 3 =
  // 12501) the book would drift; summed exactly then rounded once it is 12500
  // (3 x 4166.625 = 12,499.875 -> half-up 12500).
  const line = { premiumSignedMinor: 33333, brokeragePct: 12.5, currency: 'USD' };
  const out = brokerageByCurrency([line, line, line]);
  assert.deepEqual(out, [{ currency: 'USD', brokerageMinor: 12500 }]);
});

test('the half-up boundary rounds up', () => {
  // 0.5 minor exactly: 12.5% of 4 minor = 0.5 -> 1.
  const out = brokerageByCurrency([{ premiumSignedMinor: 4, brokeragePct: 12.5, currency: 'USD' }]);
  assert.deepEqual(out, [{ currency: 'USD', brokerageMinor: 1 }]);
});

test('treaty-scale premiums stay exact where floats would not', () => {
  // 98,765,432,199 minor x 10% = 9,876,543,219.9 -> 9,876,543,220.
  const out = brokerageByCurrency([
    { premiumSignedMinor: 98765432199, brokeragePct: 10, currency: 'USD' },
  ]);
  assert.deepEqual(out, [{ currency: 'USD', brokerageMinor: 9876543220 }]);
  assert.ok(Number.isSafeInteger(out[0].brokerageMinor));
});

test('unsigned lines contribute nothing rather than guessing', () => {
  const out = brokerageByCurrency([
    { premiumSignedMinor: null, brokeragePct: 10, currency: 'USD' },
    { premiumSignedMinor: 10000000, brokeragePct: 10, currency: 'USD' },
  ]);
  assert.deepEqual(out, [{ currency: 'USD', brokerageMinor: 1000000 }]);
});

test('no signed lines means no figures, not a zero in some default currency', () => {
  assert.deepEqual(brokerageByCurrency([]), []);
  assert.deepEqual(brokerageByCurrency([{ premiumSignedMinor: null, brokeragePct: 10, currency: 'USD' }]), []);
});

test('bad inputs are refused rather than absorbed', () => {
  assert.throws(
    () => brokerageByCurrency([{ premiumSignedMinor: 100.5, brokeragePct: 10, currency: 'USD' }]),
    /minor units/,
  );
  assert.throws(
    () => brokerageByCurrency([{ premiumSignedMinor: 100, brokeragePct: 101, currency: 'USD' }]),
    /between 0 and 100/,
  );
  assert.throws(
    () => brokerageByCurrency([{ premiumSignedMinor: 100, brokeragePct: 10, currency: '' }]),
    /without its currency/,
  );
});

test('a determinate result regardless of input order (§2.5)', () => {
  const lines = [
    { premiumSignedMinor: 33333, brokeragePct: 12.5, currency: 'USD' },
    { premiumSignedMinor: 66667, brokeragePct: 10, currency: 'USD' },
    { premiumSignedMinor: 5000000, brokeragePct: 15, currency: 'JPY' },
  ];
  const forward = brokerageByCurrency(lines);
  const backward = brokerageByCurrency([...lines].reverse());
  assert.deepEqual(forward, backward);
});
