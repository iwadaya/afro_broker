import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SLIP_COMMENTARY_SCHEMA, buildPrompt, analyseSlipComparison,
} from '../../src/modules/wordings/slips.llm.js';

const comparison = {
  mode: 'slip_vs_slip',
  standard: { label: 'Property · Cat XL', clause_count: 42 },
  slips: [{ name: 'Swiss Re' }, { name: 'Munich Re' }],
  summary: { total: 5, standard: 2, non_standard: 1, additional: 1, missing: 1 },
  rows: [
    { title: 'Hours Clause', clause_ref: 'LMA5400', category: 'condition', flag: 'non_standard', slip_match: 'differs' },
    { title: 'War Exclusion', clause_ref: null, category: 'exclusion', flag: 'missing', slip_match: 'neither' },
  ],
};

const slipTexts = [
  { name: 'Swiss Re', text: 'LIMIT: USD 10,000,000 xs USD 1,500,000. REINSTATEMENTS: 2 at 100% additional premium.' },
  { name: 'Munich Re', text: 'LIMIT: USD 10,000,000 xs USD 2,500,000. REINSTATEMENTS: 1 at 120% additional premium.' },
];

const RESULT = {
  summary: 'ok',
  wording_commentary: 'w',
  key_terms: [{
    term: 'Reinstatements', category: 'reinstatements',
    slip_a: '2 at 100%', slip_b: '1 at 120%', status: 'differs', commentary: '',
  }],
  concerns: [],
  questions_for_market: [],
};

test('the prompt carries the computed flags and the full slip text', () => {
  const prompt = buildPrompt({ comparison, slips: slipTexts });
  assert.match(prompt, /Property · Cat XL \(42 clauses\)/);
  assert.match(prompt, /Hours Clause \[LMA5400\] \(condition\): non_standard; slips differs/);
  assert.match(prompt, /War Exclusion \(exclusion\): missing/);
  assert.match(prompt, /Slip A — "Swiss Re"/);
  assert.match(prompt, /REINSTATEMENTS: 2 at 100% additional premium/);
  assert.match(prompt, /Slip B — "Munich Re"/);
  assert.match(prompt, /xs USD 2,500,000/);
  assert.match(prompt, /limits, attachments, reinstatements/);
});

test('an over-long slip is truncated with a note rather than failing', () => {
  const long = { name: 'Big', text: 'x'.repeat(70_000) };
  const prompt = buildPrompt({ comparison: { ...comparison, mode: 'against_standard' }, slips: [long] });
  assert.match(prompt, /\[slip truncated at 60000 characters\]/);
  assert.ok(prompt.length < 75_000);
});

test('analyseSlipComparison hands ChatGPT the schema and returns its reading', async () => {
  let seen;
  const out = await analyseSlipComparison(
    { comparison, slips: slipTexts },
    { openai: async (args) => { seen = args; return { data: structuredClone(RESULT), model: 'gpt-test' }; } },
  );
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-test');
  assert.equal(seen.schema, SLIP_COMMENTARY_SCHEMA);
  assert.equal(seen.schemaName, 'slip_comparison_commentary');
  assert.equal(out.data.key_terms[0].status, 'differs');
});

test('a ChatGPT failure surfaces as llm_unavailable — there is no fallback provider', async () => {
  await assert.rejects(
    analyseSlipComparison({ comparison, slips: slipTexts }, { openai: async () => { throw new Error('boom'); } }),
    (e) => {
      assert.equal(e.code, 'llm_unavailable');
      assert.deepEqual(e.attempts, [{ provider: 'openai', status: 'failed', error: 'boom' }]);
      return true;
    },
  );
});
