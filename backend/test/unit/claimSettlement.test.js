import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settlementLadder, marketBreakdown, settlementFor } from '../../src/domain/claimSettlement.js';

const recoveries = [
  {
    layer_id: 'l1', layer_name: 'Layer 1', loss_to_layer: '1500000.00', reinstatement_premium: '990000.00',
    detail: { limit: 2500000, reinstated: 1500000, markets: [
      { market_id: 'a', market_name: 'Alpha Re', signed_pct: 50, recovery: 750000, reinstatement_premium: 495000 },
      { market_id: 'b', market_name: 'Beta Re', signed_pct: 50, recovery: 750000, reinstatement_premium: 495000 },
    ] },
  },
  {
    layer_id: 'l2', layer_name: 'Layer 2', loss_to_layer: '0.00', reinstatement_premium: '0.00',
    detail: { limit: 5000000, reinstated: 0, markets: [{ market_id: 'a', market_name: 'Alpha Re', signed_pct: 100, recovery: 0, reinstatement_premium: 0 }] },
  },
];

test('the ladder: gross plus expenses, less salvage, reinstatement premium and cash funded', () => {
  const ladder = settlementLadder({ event: { lae: 30000, salvage: 10000, cash_funded: 200000, waive_reinstatement: false }, recoveries });
  assert.equal(ladder.gross_to_layer, 1500000);
  assert.equal(ladder.lae, 30000);
  assert.equal(ladder.salvage, 10000);
  assert.equal(ladder.reinstatement_premium, 990000);
  assert.equal(ladder.reinstated_pct, 60, '1.5m of the 2.5m layer reinstated');
  assert.equal(ladder.reinstatement_basis, 'pro rata amount, 100% as to time');
  assert.equal(ladder.cash_funded, 200000);
  assert.equal(ladder.net_due, 1500000 + 30000 - 10000 - 990000 - 200000);
  assert.deepEqual(ladder.attaching_layer, { id: 'l1', name: 'Layer 1' });
  assert.equal(ladder.layers_reached, 1);
  assert.equal(ladder.layers[0].erosion_pct, 60);
});

test('waiving the reinstatement premium removes it from the ladder and every share, and keeps the full figure', () => {
  const { ladder, markets } = settlementFor({ event: { lae: 0, salvage: 0, cash_funded: 0, waive_reinstatement: true }, recoveries });
  assert.equal(ladder.reinstatement_premium, 0);
  assert.equal(ladder.reinstatement_premium_full, 990000);
  assert.equal(ladder.net_due, 1500000);
  assert.ok(markets.every((m) => m.reinstatement_premium === 0));
  assert.equal(markets.find((m) => m.market_id === 'a').net_due, 750000);
});

test('every market\'s share: the engine\'s gross and reinstatement by signed line; expenses, salvage and cash apportioned to the cent', () => {
  const ladder = settlementLadder({ event: { lae: 30001, salvage: 10000, cash_funded: 200000, waive_reinstatement: false }, recoveries });
  const shares = marketBreakdown({ ladder, recoveries });
  assert.deepEqual(shares.map((s) => s.market_name), ['Alpha Re', 'Beta Re']);
  const a = shares[0];
  const b = shares[1];
  assert.equal(a.gross, 750000);
  assert.equal(a.signed_pct, 50, 'the line quoted is the one on the layer reached');
  assert.equal(a.lines.length, 2, 'the market\'s lines on every layer are kept');
  assert.equal(a.reinstatement_premium, 495000);
  assert.equal(a.cash_funded, 100000);
  assert.equal(a.lae + b.lae, 30001, 'an odd cent lands on exactly one market');
  assert.equal(a.salvage + b.salvage, 10000);
  assert.equal(Math.round((a.net_due + b.net_due) * 100) / 100, ladder.net_due, 'the shares sum to the ladder');
  assert.equal(a.expenses_net, Math.round((a.lae - a.salvage) * 100) / 100);
});

test('no recoveries yet is an empty ladder, not an error', () => {
  const { ladder, markets } = settlementFor({ event: { lae: 0, salvage: 0, cash_funded: 0 }, recoveries: [] });
  assert.equal(ladder.gross_to_layer, 0);
  assert.equal(ladder.net_due, 0);
  assert.equal(ladder.attaching_layer, null);
  assert.deepEqual(markets, []);
});
