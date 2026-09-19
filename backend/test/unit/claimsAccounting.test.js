import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateClaim } from '../../src/domain/claimsAccounting.js';
const placement = { currency: 'USD', inception: '2026-01-01', expiry: '2026-12-31' };
const lines = [{ market_id: 'a', market_name: 'Alpha', signed_pct: 60 }, { market_id: 'b', market_name: 'Beta', signed_pct: 25 }];
const layer = { key: 'first', name: '2m xs 1m', currency: 'USD', attachment: 1e6, limit_amt: 2e6, premium100: 400000, reinstatements: '1', reinstatement_pct: 100, lines };
const input = { name: 'Retained loss', loss_date: '2026-06-01', retained_loss: 5e6, paid: 2e6, outstanding: 3e6, cat_event: false };
const run = changes => calculateClaim({ placement, layers: [layer], input, ...changes });

test('retained paid and outstanding must reconcile exactly, including zero and cents', () => {
  for (const bad of [{ paid: 1 }, { paid: '' }, { paid: -1 }, { retained_loss: 5e6 + .001 }, { loss_date: '2027-01-01' }]) assert.throws(() => run({ input: { ...input, ...bad } }));
  assert.equal(run({ input: { ...input, retained_loss: 0, paid: 0, outstanding: 0 } }).totals.recovery, 0);
  assert.equal(run({ input: { ...input, retained_loss: .3, paid: .1, outstanding: .2 } }).totals.recovery, 0);
});
test('paid goes through the deductible; layer and market net splits reconcile', () => {
  const second = { ...layer, key: 'second', name: '3m xs 3m', attachment: 3e6, limit_amt: 3e6, premium100: 300000 };
  const s = run({ layers: [layer, second] });
  const a = s.layers[0].calculation, b = s.layers[1].calculation;
  assert.deepEqual([a.recovery, a.paid_recovery, a.outstanding_recovery, a.reinstatement_premium, a.net, a.net_paid], [2e6, 1e6, 1e6, 400000, 1600000, 800000]);
  assert.deepEqual([b.recovery, b.paid_recovery, b.outstanding_recovery, b.reinstatement_premium, b.net], [2e6, 0, 2e6, 200000, 1800000]);
  assert.equal(s.placed_totals.recovery, 3400000, '85% of 4m, not a normalised 100%');
  assert.equal(s.placed_totals.net, 2890000);
  for (const m of s.markets) {
    assert.equal(m.recovery, m.paid_recovery + m.outstanding_recovery);
    assert.equal(m.net, m.net_paid + m.net_outstanding);
    assert.equal(m.net, m.recovery - m.reinstatement_premium);
  }
});
test('prior claims consume aggregate and reinstatement capacity', () => {
  const prior = { gross_loss: 3e6, currency: 'USD', cat_event: false };
  const second = run({ previous: [prior] }).layers[0].calculation;
  assert.equal(second.recovery, 2e6); assert.equal(second.reinstatement_premium, 0); assert.equal(second.remaining_aggregate, 0);
  assert.equal(run({ previous: [prior, prior] }).totals.recovery, 0);
  assert.equal(run({ layers: [{ ...layer, reinstatements: 'UNLIMITED' }], previous: [prior, prior] }).totals.reinstatement_premium, 400000);
});
test('annual aggregate deductible and cover flags apply before recovery', () => {
  const small = { ...layer, attachment: 100, limit_amt: 1000, aad: 200, premium100: 100 };
  const loss = { ...input, retained_loss: 600, paid: 200, outstanding: 400 };
  const s = run({ layers: [small], input: loss, previous: [{ gross_loss: 200, currency: 'USD', cat_event: false }] });
  assert.equal(s.totals.recovery, 400); assert.equal(s.totals.paid_recovery, 0); assert.equal(s.layers[0].calculation.aad_applied, 100);
  assert.throws(() => run({ layers: [{ ...layer, risk_cover: false }] }), /No placed layer covers/);
  const mixed = run({ layers: [layer, { ...layer, key: 'eur', currency: 'EUR' }] });
  assert.equal(mixed.layers[1].calculation, null); assert.equal(mixed.totals.recovery, 2e6);
});
test('fractional signed allocations preserve non-negative reserves and net arithmetic', () => {
  const fractions = [17, 29, 39].map((signed_pct, i) => ({ market_id: String(i), market_name: String(i), signed_pct }));
  for (const total of [.01, .07, 1.01, 100.03]) for (const paid of [0, total / 2, total]) {
    const p = Math.round(paid * 100) / 100, os = Math.round((total - p) * 100) / 100;
    const s = run({ layers: [{ ...layer, attachment: 0, limit_amt: 1000, premium100: 137, lines: fractions }], input: { ...input, retained_loss: total, paid: p, outstanding: os } });
    for (const m of s.markets) {
      assert.ok(m.outstanding_recovery >= 0); assert.ok(m.outstanding_reinstatement_premium >= 0);
      assert.equal(Math.round(m.net * 100), Math.round(m.net_paid * 100) + Math.round(m.net_outstanding * 100));
    }
  }
  assert.throws(() => run({ layers: [{ ...layer, lines: [{ ...lines[0], signed_pct: 110 }] }] }), /no more than 100/);
});
