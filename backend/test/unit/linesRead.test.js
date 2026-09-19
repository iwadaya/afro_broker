// Reading written and signed lines out of a reinsurer's email, offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicLines, readLines } from '../../src/modules/final/lines.llm.js';

const TERMS = [
  { key: 's1:l0', structure_index: 1, layer_index: 0, label: 'Layer 1', structure_label: 'Structure 1', basis: 'NP' },
  { key: 's1:l1', structure_index: 1, layer_index: 1, label: 'Layer 2', structure_label: 'Structure 1', basis: 'NP' },
];

test('a written line stated for the programme lands on every line', () => {
  const r = heuristicLines('Dear Jo,\n\nThank you for the firm order terms. We are pleased to confirm we will write a line of 12.5% across the programme.\n\nKind regards', TERMS);
  assert.equal(r.kind, 'written');
  assert.deepEqual(r.lines.map((l) => [l.term_key, l.written_pct, l.signed_pct]), [['s1:l0', 12.5, null], ['s1:l1', 12.5, null]]);
});

test('a line named per layer lands on that layer', () => {
  const r = heuristicLines('We can support Layer 1 at 10% and Layer 2 at 7.5%. Please sign us accordingly.', TERMS);
  assert.equal(r.kind, 'written');
  assert.deepEqual(r.lines.map((l) => [l.term_key, l.written_pct]), [['s1:l0', 10], ['s1:l1', 7.5]]);
});

test('a signed line reads as signed, a decline as declined, and silence as nothing', () => {
  const signed = heuristicLines('Please note our signed line at 8% following signing down.', TERMS);
  assert.equal(signed.kind, 'signed');
  assert.deepEqual(signed.lines.map((l) => [l.term_key, l.written_pct, l.signed_pct]), [['s1:l0', null, 8], ['s1:l1', null, 8]]);
  const declined = heuristicLines('Regret we are unable to support this programme this year.', TERMS);
  assert.equal(declined.kind, 'decline');
  assert.ok(declined.lines.every((l) => l.declined && l.written_pct === null));
  const nothing = heuristicLines('Thanks, received — will revert next week.', TERMS);
  assert.equal(nothing.kind, 'other');
  assert.deepEqual(nothing.lines, []);
});

test('with no model configured the read falls back to the keyword rules and says so', async () => {
  const r = await readLines({ from_email: 'jo@alpha.test', body: 'We will write 15% of the programme.' }, { terms: TERMS });
  assert.equal(r.source, 'fallback');
  assert.equal(r.lines[0].written_pct, 15);
  assert.ok(r.reason);
});
