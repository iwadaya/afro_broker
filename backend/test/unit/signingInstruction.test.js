import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInstructedSigning } from '../../src/domain/signingDown.js';

const LINES = [
  { id: 'a', written: 50 },
  { id: 'b', written: 40 },
  { id: 'c', written: 30 },
];

test('client instruction allocates the order exactly as dictated', () => {
  const r = computeInstructedSigning(100, LINES, [
    { id: 'a', signed: 50 },
    { id: 'b', signed: 35 },
    { id: 'c', signed: 15 },
  ]);
  assert.equal(r.state, 'INSTRUCTED');
  assert.equal(r.signedTotal, 100);
  assert.equal(r.signingFactor, null);
  assert.deepEqual(r.lines.map((l) => l.signed), [50, 35, 15]);
});

test('lines omitted from the instruction sign at nought', () => {
  const r = computeInstructedSigning(90, LINES, [
    { id: 'a', signed: 50 },
    { id: 'b', signed: 40 },
  ]);
  assert.deepEqual(r.lines.map((l) => l.signed), [50, 40, 0]);
  assert.equal(r.signedTotal, 90);
});

test('the instruction must allocate the whole order', () => {
  assert.throws(
    () => computeInstructedSigning(100, LINES, [{ id: 'a', signed: 50 }, { id: 'b', signed: 30 }]),
    /signed total 80% must equal the order 100%/,
  );
});

test('no market may sign above its written line', () => {
  assert.throws(
    () => computeInstructedSigning(100, LINES, [
      { id: 'a', signed: 55 }, { id: 'b', signed: 30 }, { id: 'c', signed: 15 },
    ]),
    /above its written line/,
  );
});

test('an instruction for an unknown or duplicated line is rejected', () => {
  assert.throws(
    () => computeInstructedSigning(100, LINES, [{ id: 'zz', signed: 100 }]),
    /no written line/,
  );
  assert.throws(
    () => computeInstructedSigning(100, LINES, [
      { id: 'a', signed: 50 }, { id: 'a', signed: 50 },
    ]),
    /twice/,
  );
  assert.throws(() => computeInstructedSigning(100, LINES, []), /at least one line/);
});

test('fractional allocations round at basis-point precision', () => {
  const r = computeInstructedSigning(100, LINES, [
    { id: 'a', signed: 41.6667 },
    { id: 'b', signed: 33.3333 },
    { id: 'c', signed: 25 },
  ]);
  assert.equal(r.signedTotal, 100);
});
