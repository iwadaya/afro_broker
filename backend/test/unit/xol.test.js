import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMdpSchedule, computeXolLoss, parseReinstatements } from '../../src/domain/xol.js';

// ---- Reinstatement terms parsing (layer.reinstatements is TEXT, mig. 014) ----

test('reinstatement text parses to a count, Infinity or zero', () => {
  assert.equal(parseReinstatements('1'), 1);
  assert.equal(parseReinstatements('10'), 10);
  assert.equal(parseReinstatements('UNLIMITED'), Infinity);
  assert.equal(parseReinstatements('unlimited'), Infinity);
  assert.equal(parseReinstatements(null), 0);
  assert.equal(parseReinstatements(''), 0);
  assert.equal(parseReinstatements('bogus'), 0);
});

test('unlimited reinstatements always restore the limit and always charge RIP', () => {
  const layer = {
    attachment: 1_000_000, limit: 2_000_000, premium100: 400_000,
    reinstatements: Infinity, reinstatementPremiumPct: 100,
  };
  // Even after heavy consumption, a full-limit loss recovers and reinstates in full.
  const r = computeXolLoss({ ...layer, grossLoss: 10_000_000, consumedBefore: 8_000_000 });
  assert.equal(r.recovery, 2_000_000);
  assert.equal(r.reinstated, 2_000_000);
  assert.equal(r.reinstatementPremium, 400_000);
  assert.equal(r.remainingAggregate, null); // no finite aggregate to report
});

// ---- MDP schedule ----

test('MDP schedule spreads the deposit evenly and reconciles to the cent', () => {
  const schedule = buildMdpSchedule({
    depositPremium: 1_000_000, instalments: 3, firstDue: '2026-01-01', frequencyMonths: 3,
  });
  assert.equal(schedule.length, 3);
  assert.deepEqual(schedule.map((s) => s.due_date), ['2026-01-01', '2026-04-01', '2026-07-01']);
  const total = schedule.reduce((a, s) => a + s.amount, 0);
  assert.equal(Math.round(total * 100) / 100, 1_000_000);
  // 1,000,000 / 3 = 333,333.33 recurring; the first instalment absorbs the cent.
  assert.equal(schedule[1].amount, 333333.33);
  assert.equal(schedule[0].amount, 333333.34);
});

test('MDP schedule handles a single instalment and monthly frequency', () => {
  const one = buildMdpSchedule({ depositPremium: 500, instalments: 1, firstDue: '2026-06-15' });
  assert.deepEqual(one, [{ instalment_no: 1, due_date: '2026-06-15', amount: 500 }]);

  const monthly = buildMdpSchedule({
    depositPremium: 1200, instalments: 12, firstDue: '2026-01-31', frequencyMonths: 1,
  });
  assert.equal(monthly.length, 12);
  assert.equal(monthly.reduce((a, s) => a + s.amount, 0), 1200);
});

test('MDP schedule rejects bad inputs', () => {
  assert.throws(() => buildMdpSchedule({ depositPremium: -1, instalments: 4, firstDue: '2026-01-01' }));
  assert.throws(() => buildMdpSchedule({ depositPremium: 100, instalments: 0, firstDue: '2026-01-01' }));
  assert.throws(() => buildMdpSchedule({ depositPremium: 100, instalments: 4, firstDue: 'not a date' }));
});

// ---- XoL loss / reinstatement premium ----

const LAYER = {
  attachment: 1_000_000, limit: 2_000_000, premium100: 400_000,
  reinstatements: 1, reinstatementPremiumPct: 100,
};

test('loss below the attachment recovers nothing', () => {
  const r = computeXolLoss({ ...LAYER, grossLoss: 900_000 });
  assert.equal(r.lossToLayer, 0);
  assert.equal(r.recovery, 0);
  assert.equal(r.reinstatementPremium, 0);
});

test('partial loss to the layer reinstates pro rata to amount', () => {
  // 1.5m gross → 500k into the layer; RIP = (500k / 2m) × 400k × 100% = 100k.
  const r = computeXolLoss({ ...LAYER, grossLoss: 1_500_000 });
  assert.equal(r.lossToLayer, 500_000);
  assert.equal(r.recovery, 500_000);
  assert.equal(r.reinstated, 500_000);
  assert.equal(r.reinstatementPremium, 100_000);
  assert.equal(r.remainingAggregate, 3_500_000); // 2m × (1+1) − 500k
});

test('total loss consumes the occurrence limit and one full reinstatement', () => {
  const r = computeXolLoss({ ...LAYER, grossLoss: 10_000_000 });
  assert.equal(r.lossToLayer, 2_000_000);
  assert.equal(r.recovery, 2_000_000);
  assert.equal(r.reinstated, 2_000_000);
  assert.equal(r.reinstatementPremium, 400_000); // full annual premium at 100%
});

test('second total loss recovers but has no reinstatement left to buy', () => {
  // First loss consumed the limit and its single reinstatement.
  const r = computeXolLoss({ ...LAYER, grossLoss: 10_000_000, consumedBefore: 2_000_000 });
  assert.equal(r.recovery, 2_000_000); // the reinstated limit responds
  assert.equal(r.reinstated, 0); // nothing left to reinstate (1 reinstatement, used)
  assert.equal(r.reinstatementPremium, 0);
  assert.equal(r.remainingAggregate, 0);
});

test('aggregate exhaustion caps the recovery', () => {
  // Capacity 4m; 3.5m consumed → only 500k left despite a full-limit loss.
  const r = computeXolLoss({ ...LAYER, grossLoss: 10_000_000, consumedBefore: 3_500_000 });
  assert.equal(r.lossToLayer, 2_000_000);
  assert.equal(r.recovery, 500_000);
  assert.equal(r.reinstated, 0);
  assert.equal(r.remainingAggregate, 0);
});

test('reinstatement premium respects the agreed percentage', () => {
  // 1 @ 50% additional premium: half the pro-rata RIP.
  const r = computeXolLoss({ ...LAYER, reinstatementPremiumPct: 50, grossLoss: 1_500_000 });
  assert.equal(r.reinstatementPremium, 50_000);
});

test('two reinstatements extend the aggregate and the RIP capacity', () => {
  const layer = { ...LAYER, reinstatements: 2 };
  // After a full-limit loss, a second full loss still buys a reinstatement.
  const r = computeXolLoss({ ...layer, grossLoss: 10_000_000, consumedBefore: 2_000_000 });
  assert.equal(r.recovery, 2_000_000);
  assert.equal(r.reinstated, 2_000_000);
  assert.equal(r.reinstatementPremium, 400_000);
  assert.equal(r.remainingAggregate, 2_000_000);
});

test('unlimited layers recover in full with no reinstatement mechanics', () => {
  const r = computeXolLoss({
    grossLoss: 5_000_000, attachment: 1_000_000, limit: null, premium100: 400_000,
    reinstatements: 1, reinstatementPremiumPct: 100,
  });
  assert.equal(r.recovery, 4_000_000);
  assert.equal(r.reinstatementPremium, 0);
  assert.equal(r.remainingAggregate, null);
});
