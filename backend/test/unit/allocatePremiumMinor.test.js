import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSigning, allocatePremiumMinor } from '../../src/domain/signingDown.js';

/**
 * §2.6 / §2.5 — premium allocated by signed share, in integer minor units,
 * deterministically and without a float ever touching a currency amount.
 */

const sum = (parts) => parts.reduce((n, p) => n + p.premiumSignedMinor, 0);

test('an even split allocates exactly', () => {
  const alloc = allocatePremiumMinor(100000, [
    { id: 'a', signed: 50 }, { id: 'b', signed: 50 },
  ]);
  assert.deepEqual(alloc.map((a) => a.premiumSignedMinor), [50000, 50000]);
  assert.equal(sum(alloc), 100000);
});

test('an indivisible split still sums to the premium', () => {
  // Three equal lines on a total that does not divide by three.
  const signing = computeSigning(100, [
    { id: 'a', written: 40 }, { id: 'b', written: 40 }, { id: 'c', written: 40 },
  ]);
  const alloc = allocatePremiumMinor(100000, signing.lines);
  assert.equal(sum(alloc), 100000, 'the remainder is distributed, never dropped');
  assert.deepEqual(alloc.map((a) => a.premiumSignedMinor).sort((x, y) => y - x), [33334, 33333, 33333]);
});

test('a partial order allocates only the signed share', () => {
  // 50% of the risk placed; the premium follows the signed total, not 100%.
  const alloc = allocatePremiumMinor(100000, [
    { id: 'a', signed: 30 }, { id: 'b', signed: 20 },
  ]);
  assert.deepEqual(alloc.map((a) => a.premiumSignedMinor), [30000, 20000]);
  assert.equal(sum(alloc), 50000);
});

test('treaty-scale premiums stay exact where floats would not', () => {
  // ~987m at 2dp is 98,765,432,199 minor units. Multiplied by a tick count this
  // exceeds Number.MAX_SAFE_INTEGER, which is why the arithmetic is BigInt.
  const premium = 98765432199;
  const signing = computeSigning(100, [
    { id: 'a', written: 33 }, { id: 'b', written: 33 }, { id: 'c', written: 34 },
  ]);
  const alloc = allocatePremiumMinor(premium, signing.lines);
  assert.equal(sum(alloc), premium);
  assert.ok(alloc.every((a) => Number.isSafeInteger(a.premiumSignedMinor)));
});

test('four-decimal shares are honoured to the minor unit', () => {
  const alloc = allocatePremiumMinor(1000000, [
    { id: 'a', signed: 33.3334 }, { id: 'b', signed: 33.3333 }, { id: 'c', signed: 33.3333 },
  ]);
  assert.equal(sum(alloc), 1000000);
  assert.equal(alloc[0].premiumSignedMinor, 333334);
});

test('a zero-decimal currency needs no special handling — minor units are minor units', () => {
  // JPY 5,000,000 is 5000000 minor units, not 500000000.
  const alloc = allocatePremiumMinor(5000000, [
    { id: 'a', signed: 60 }, { id: 'b', signed: 40 },
  ]);
  assert.deepEqual(alloc.map((a) => a.premiumSignedMinor), [3000000, 2000000]);
});

test('the allocation is deterministic, not dependent on sort stability', () => {
  const lines = [
    { id: 'a', signed: 33.3333 }, { id: 'b', signed: 33.3333 }, { id: 'c', signed: 33.3334 },
  ];
  const first = allocatePremiumMinor(100000, lines);
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual(allocatePremiumMinor(100000, lines), first, '§2.5 — same inputs, same numbers');
  }
});

test('a to-stand line keeps its share of the premium', () => {
  const signing = computeSigning(100, [
    { id: 'guaranteed', written: 30, toStand: true },
    { id: 'flex-a', written: 50 },
    { id: 'flex-b', written: 50 },
  ]);
  assert.equal(signing.lines.find((l) => l.id === 'guaranteed').signed, 30);
  const alloc = allocatePremiumMinor(100000, signing.lines);
  assert.equal(alloc.find((a) => a.id === 'guaranteed').premiumSignedMinor, 30000);
  assert.equal(sum(alloc), 100000);
});

test('no lines allocates nothing, and a zero premium allocates zeroes', () => {
  assert.deepEqual(allocatePremiumMinor(1000, []), []);
  const alloc = allocatePremiumMinor(0, [{ id: 'a', signed: 50 }]);
  assert.equal(alloc[0].premiumSignedMinor, 0);
});

test('a non-integer or negative premium is refused rather than silently rounded', () => {
  assert.throws(() => allocatePremiumMinor(100.5, [{ id: 'a', signed: 50 }]), /minor units/);
  assert.throws(() => allocatePremiumMinor(-100, [{ id: 'a', signed: 50 }]), /non-negative/);
});
