import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSigning, allocatePremium, roundPct } from '../../src/domain/signingDown.js';

const sum = (arr, k) => arr.reduce((a, x) => a + x[k], 0);

test('oversubscribed: design-doc example signs down to the order', () => {
  // order 100, written Lead 25, A 20, B 30, C 40 (=115%)
  const res = computeSigning(100, [
    { id: 'Lead', written: 25 },
    { id: 'A', written: 20 },
    { id: 'B', written: 30 },
    { id: 'C', written: 40 },
  ]);
  assert.equal(res.state, 'OVERSUBSCRIBED');
  assert.equal(res.writtenTotal, 115);
  assert.equal(roundPct(res.signingFactor), 0.8696);
  // Σ signed must equal the order exactly.
  assert.equal(res.signedTotal, 100);
  assert.equal(roundPct(sum(res.lines, 'signed')), 100);
  // Spot-check the per-line values are within a basis point of the doc.
  const byId = Object.fromEntries(res.lines.map((l) => [l.id, l.signed]));
  assert.ok(Math.abs(byId.Lead - 21.74) < 0.01);
  assert.ok(Math.abs(byId.A - 17.39) < 0.01);
  assert.ok(Math.abs(byId.B - 26.09) < 0.01);
  assert.ok(Math.abs(byId.C - 34.78) < 0.01);
});

test('exactly placed: signed equals written', () => {
  const res = computeSigning(100, [
    { id: 'A', written: 60 },
    { id: 'B', written: 40 },
  ]);
  assert.equal(res.state, 'EXACT');
  assert.equal(res.signedTotal, 100);
  assert.equal(res.signingFactor, 1);
  assert.deepEqual(res.lines.map((l) => l.signed), [60, 40]);
});

test('undersubscribed: signed equals written, shortfall reported', () => {
  const res = computeSigning(100, [
    { id: 'A', written: 30 },
    { id: 'B', written: 25 },
  ]);
  assert.equal(res.state, 'UNDERSUBSCRIBED');
  assert.equal(res.writtenTotal, 55);
  assert.equal(res.shortfall, 45);
  assert.equal(res.signedTotal, 55);
  assert.deepEqual(res.lines.map((l) => l.signed), [30, 25]);
});

test('order below 100 (cedant co-reinsurance retention)', () => {
  const res = computeSigning(80, [
    { id: 'A', written: 50 },
    { id: 'B', written: 50 },
  ]);
  assert.equal(res.state, 'OVERSUBSCRIBED');
  assert.equal(res.signedTotal, 80);
  assert.equal(res.lines[0].signed, 40);
  assert.equal(res.lines[1].signed, 40);
});

test('to-stand line is reserved and excluded from the factor', () => {
  // order 100, Lead stands at 30, A/B/C flexible total 90 -> residual 70.
  const res = computeSigning(100, [
    { id: 'Lead', written: 30, toStand: true },
    { id: 'A', written: 30 },
    { id: 'B', written: 30 },
    { id: 'C', written: 30 },
  ]);
  assert.equal(res.standingTotal, 30);
  const lead = res.lines.find((l) => l.id === 'Lead');
  assert.equal(lead.signed, 30); // untouched
  assert.equal(res.signedTotal, 100);
  // flexible lines share the residual 70 across 90 written.
  const a = res.lines.find((l) => l.id === 'A');
  assert.ok(Math.abs(a.signed - (30 * 70) / 90) < 0.01);
});

test('to-stand exceeding the order throws', () => {
  assert.throws(
    () => computeSigning(100, [
      { id: 'Lead', written: 120, toStand: true },
      { id: 'A', written: 10 },
    ]),
    /exceed the order/,
  );
});

test('empty lines: EMPTY state with full shortfall', () => {
  const res = computeSigning(100, []);
  assert.equal(res.state, 'EMPTY');
  assert.equal(res.shortfall, 100);
  assert.equal(res.signedTotal, 0);
});

test('signed total is exact across many awkward fractions (property-ish)', () => {
  // Values chosen to create nasty rounding; sum must still hit the order.
  const cases = [
    { order: 100, lines: [33.33, 33.33, 33.34, 50] },
    { order: 100, lines: [7, 11, 13, 17, 19, 23, 29, 31] },
    { order: 75, lines: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 5] },
    { order: 100, lines: [99.9999, 0.0001, 50] },
    { order: 60, lines: [1, 1, 1, 1, 1, 1, 1, 1, 1, 100] },
  ];
  for (const c of cases) {
    const res = computeSigning(
      c.order,
      c.lines.map((w, i) => ({ id: i, written: w })),
    );
    assert.equal(res.signedTotal, c.order, `case ${JSON.stringify(c)}`);
    // No signed line is negative.
    for (const l of res.lines) assert.ok(l.signed >= 0);
  }
});

test('allocatePremium reconciles to the cent', () => {
  const signed = computeSigning(100, [
    { id: 'Lead', written: 25 },
    { id: 'A', written: 20 },
    { id: 'B', written: 30 },
    { id: 'C', written: 40 },
  ]).lines;
  const alloc = allocatePremium(1_000_000, signed);
  const total = alloc.reduce((a, l) => a + l.premiumSigned, 0);
  assert.equal(Math.round(total * 100) / 100, 1_000_000);
});

test('allocatePremium on undersubscribed allocates only written share', () => {
  const signed = computeSigning(100, [
    { id: 'A', written: 30 },
    { id: 'B', written: 25 },
  ]).lines;
  const alloc = allocatePremium(1_000_000, signed); // 55% placed
  const total = alloc.reduce((a, l) => a + l.premiumSigned, 0);
  assert.equal(Math.round(total * 100) / 100, 550_000);
});
