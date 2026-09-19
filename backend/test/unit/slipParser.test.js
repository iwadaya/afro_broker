import test from 'node:test';
import assert from 'node:assert/strict';
import { headingOf, parseSlipClauses, guessCategory } from '../../src/domain/slipParser.js';

test('headingOf recognises the shapes slips actually use', () => {
  assert.equal(headingOf('ARTICLE 4 — ULTIMATE NET LOSS'), 'ULTIMATE NET LOSS');
  assert.equal(headingOf('7.  Hours Clause'), 'Hours Clause');
  assert.equal(headingOf('EXCLUSIONS'), 'EXCLUSIONS');
  assert.equal(headingOf('Territorial Scope:'), 'Territorial Scope');
  assert.equal(headingOf('LMA5400 Cyber Exclusion'), 'LMA5400 Cyber Exclusion');
  assert.equal(headingOf('(iv) Reinstatements'), 'Reinstatements');
  assert.equal(headingOf('3.2 Net Retained Lines'), 'Net Retained Lines');
});

test('headingOf leaves body prose alone', () => {
  assert.equal(headingOf('This Contract is made between the Reinsured and the Reinsurers.'), null);
  assert.equal(
    headingOf('The Reinsurers shall be liable for the amount by which the loss exceeds the retention.'),
    null,
  );
  // A sentence that happens to open in title case is not a heading.
  assert.equal(headingOf('Losses Occurring During the period of this Contract shall attach.'), null);
  assert.equal(headingOf(''), null);
  assert.equal(headingOf('   '), null);
});

test('parseSlipClauses cuts a slip into titled clauses', () => {
  const slip = [
    'REINSURANCE SLIP',
    '',
    'ARTICLE 1 — BUSINESS COVERED',
    'This Contract covers the Property Catastrophe Excess of Loss business of the',
    'Reinsured, classified by them as Fire and Allied Perils.',
    '',
    '2. Ultimate Net Loss',
    'The term Ultimate Net Loss shall mean the sum actually paid by the Reinsured',
    'in settlement of losses.',
    '',
    'LMA5400 Cyber Exclusion',
    'Notwithstanding any provision to the contrary, this Contract excludes cyber loss.',
  ].join('\n');

  const clauses = parseSlipClauses(slip);
  assert.equal(clauses.length, 3);
  assert.deepEqual(clauses.map((c) => c.title), [
    'BUSINESS COVERED', 'Ultimate Net Loss', 'LMA5400 Cyber Exclusion',
  ]);
  assert.equal(clauses[2].clause_ref, 'LMA5400');
  assert.match(clauses[0].body, /Fire and Allied Perils/);
  assert.deepEqual(clauses.map((c) => c.position), [1, 2, 3]);
});

test('parseSlipClauses keeps a substantial preamble and drops a page header', () => {
  const withHeader = 'SLIP\n\nEXCLUSIONS\nWar and civil war are excluded from this Contract.';
  assert.deepEqual(parseSlipClauses(withHeader).map((c) => c.title), ['EXCLUSIONS']);

  const recital = Array(30).fill('whereas the parties have agreed as follows').join(' ');
  const withPreamble = `${recital}\n\nEXCLUSIONS\nWar is excluded.`;
  const parsed = parseSlipClauses(withPreamble);
  assert.equal(parsed[0].title, 'Preamble');
  assert.equal(parsed.length, 2);
});

test('parseSlipClauses drops contents-page headings that carry no text', () => {
  const slip = [
    'ARTICLE 1 — BUSINESS COVERED',
    'ARTICLE 2 — TERM',
    'ARTICLE 3 — TERRITORY',
    '',
    'ARTICLE 1 — BUSINESS COVERED',
    'The business covered is Property Catastrophe Excess of Loss.',
  ].join('\n');
  const clauses = parseSlipClauses(slip);
  assert.equal(clauses.length, 1);
  assert.equal(clauses[0].title, 'BUSINESS COVERED');
});

test('parseSlipClauses tolerates empty and blank input', () => {
  assert.deepEqual(parseSlipClauses(''), []);
  assert.deepEqual(parseSlipClauses(null), []);
  assert.deepEqual(parseSlipClauses('\n\n   \n'), []);
});

test('guessCategory sorts a clause into the library’s categories', () => {
  assert.equal(guessCategory('Cyber Exclusion'), 'exclusion');
  assert.equal(guessCategory('Definition of Ultimate Net Loss'), 'definition');
  assert.equal(guessCategory('Terrorism Write-Back'), 'extension');
  assert.equal(guessCategory('Business Covered'), 'coverage');
  assert.equal(guessCategory('Hours Clause'), 'condition');
});
