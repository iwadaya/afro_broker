import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, normaliseBody, diffWords, similarity, alignClauseSets, titleKey,
} from '../../src/domain/wordingDiff.js';

const clause = (title, body, extra = {}) => ({
  title, body, category: 'exclusion', clause_ref: null, ...extra,
});

test('tokenize splits words and punctuation, keeping both', () => {
  assert.deepEqual(tokenize('72 consecutive hours.'), ['72', 'consecutive', 'hours', '.']);
  assert.deepEqual(tokenize("Reinsured's net"), ["Reinsured's", 'net']);
  assert.deepEqual(tokenize(''), []);
  assert.deepEqual(tokenize(null), []);
});

test('normaliseBody treats whitespace, case and curly quotes as drafting noise', () => {
  assert.equal(
    normaliseBody('The  Reinsured’s\n\n liability'),
    normaliseBody("the reinsured's liability"),
  );
  assert.notEqual(normaliseBody('72 hours'), normaliseBody('168 hours'));
});

test('titleKey ignores case and punctuation so a retitled clause still pairs', () => {
  assert.equal(titleKey('War & Civil War Exclusion'), 'war civil war exclusion');
  assert.equal(titleKey('Sanctions Limitation'), titleKey('  SANCTIONS,  limitation.  '));
});

test('diffWords marks only what changed', () => {
  const diff = diffWords(
    'The Reinsurer shall pay 100% of each loss',
    'The Reinsurer shall pay 90% of each loss',
  );
  assert.deepEqual(diff.filter((d) => d.op === 'del').map((d) => d.text), ['100']);
  assert.deepEqual(diff.filter((d) => d.op === 'add').map((d) => d.text), ['90']);
  // Reassembling the 'same' + 'del' runs reproduces the left body.
  const left = diff.filter((d) => d.op !== 'add').map((d) => d.text).join(' ');
  assert.equal(normaliseBody(left), normaliseBody('The Reinsurer shall pay 100% of each loss'));
});

test('diffWords on identical text is one unchanged run', () => {
  const diff = diffWords('Sanctions apply.', 'sanctions   apply.');
  assert.equal(diff.length, 1);
  assert.equal(diff[0].op, 'same');
});

test('similarity is 1 for identical bodies, 0 when one side is empty', () => {
  assert.equal(similarity('a b c', 'a b c'), 1);
  assert.equal(similarity('a b c', ''), 0);
  assert.equal(similarity('', ''), 1);
  assert.ok(similarity('a b c d', 'a b c e') > 0.5);
  assert.ok(similarity('war and civil war', 'nuclear energy risks') < 0.2);
});

test('alignClauseSets pairs on clause reference even when the title differs', () => {
  const { rows, summary } = alignClauseSets(
    [clause('War and Civil War Exclusion', 'War is excluded.', { clause_ref: 'NMA 464' })],
    [clause('War Exclusion (Lloyd’s)', 'War is excluded.', { clause_ref: 'nma-464' })],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'identical');
  assert.equal(summary.identical, 1);
  assert.equal(summary.only_left, 0);
});

test('alignClauseSets pairs on title when there is no reference', () => {
  const { rows } = alignClauseSets(
    [clause('Sanctions Limitation', 'Standard sanctions text.')],
    [clause('sanctions   limitation', 'Reinsurer sanctions text, materially reworded and extended.')],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'changed');
  assert.ok(rows[0].diff.some((d) => d.op === 'add'));
});

test('alignClauseSets pairs a reworded, retitled clause on body similarity', () => {
  const body = 'This Agreement excludes loss arising from ionising radiation or contamination by radioactivity from any nuclear fuel.';
  const { rows } = alignClauseSets(
    [clause('Nuclear Energy Risks Exclusion', body)],
    [clause('Radioactivity Exclusion', `${body} No write-back applies.`)],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'changed');
  assert.ok(rows[0].similarity > 0.8);
});

test('alignClauseSets never pairs across categories', () => {
  const body = 'Identical text on both sides of the comparison.';
  const { summary } = alignClauseSets(
    [{ ...clause('Offset', body), category: 'condition' }],
    [{ ...clause('Offset', body), category: 'definition' }],
  );
  assert.equal(summary.identical, 0);
  assert.equal(summary.only_left, 1);
  assert.equal(summary.only_right, 1);
});

test('alignClauseSets reports added and dropped clauses', () => {
  const asbestos = 'This Agreement excludes liability arising out of the mining, processing, distribution, removal or disposal of asbestos or products containing asbestos fibres.';
  const cyber = 'This Agreement excludes any cyber loss, being loss caused by or arising out of a cyber act or cyber incident affecting any computer system.';
  const pfas = 'This Agreement excludes liability arising out of exposure to per- and polyfluoroalkyl substances, including perfluorooctanoic acid.';
  const { rows, summary } = alignClauseSets(
    [clause('Asbestos Exclusion', asbestos), clause('Cyber Exclusion', cyber)],
    [clause('Cyber Exclusion', cyber), clause('PFAS Exclusion', pfas)],
  );
  assert.equal(summary.identical, 1);
  assert.equal(summary.only_left, 1);
  assert.equal(summary.only_right, 1);
  // Left order is preserved, then the right-only remainder.
  assert.deepEqual(rows.map((r) => r.status), ['only_left', 'identical', 'only_right']);
  assert.equal(rows[0].right, null);
  assert.equal(rows[2].left, null);
});

test('a clause is used at most once, and the strongest match wins', () => {
  const stem = 'The Reinsurer shall not be liable for any loss arising out of or in connection with the operation of the excluded activity described in the Schedule';
  const left = [
    clause('Exclusion A', `${stem}, save where the Reinsured has obtained prior written agreement.`),
    clause('Exclusion B', `${stem}, save where the Reinsured has obtained prior written consent.`),
  ];
  const right = [clause('Exclusion C', `${stem}, save where the Reinsured has obtained prior written consent.`)];
  const { rows, summary } = alignClauseSets(left, right);
  assert.equal(summary.total, 2);
  // B is the closer body, so B pairs and A is left over.
  const paired = rows.find((r) => r.left && r.right);
  assert.equal(paired.left.title, 'Exclusion B');
  assert.equal(rows.find((r) => r.status === 'only_left').left.title, 'Exclusion A');
});

test('match_pct credits a light reword more than a rewrite', () => {
  const base = 'The Reinsurer shall indemnify the Reinsured for the Ultimate Net Loss in excess of the retention.';
  const light = alignClauseSets([clause('X', base)], [clause('X', `${base} Subject to the limit.`)]);
  const heavy = alignClauseSets([clause('X', base)], [clause('X', 'Entirely different drafting with no shared terms whatsoever here.')]);
  assert.ok(light.summary.match_pct > 80, `light reword scored ${light.summary.match_pct}`);
  assert.ok(heavy.summary.match_pct < 20, `rewrite scored ${heavy.summary.match_pct}`);
});

test('two empty wordings compare cleanly rather than dividing by zero', () => {
  const { rows, summary } = alignClauseSets([], []);
  assert.deepEqual(rows, []);
  assert.equal(summary.total, 0);
  assert.equal(summary.match_pct, 0);
});
