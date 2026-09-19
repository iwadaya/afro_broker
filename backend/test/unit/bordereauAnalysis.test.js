import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  num, aggregatePremium, aggregateClaims, dataQuality, aggregateBordereaux, sampleRows,
} from '../../src/modules/analysis/analysis.service.js';
import { completeJson, LlmUnavailableError } from '../../src/lib/llm.js';
import { ANALYSIS_SCHEMA, buildPrompt } from '../../src/modules/analysis/analysis.llm.js';

const premiumRows = [
  {
    policy_ref: 'P-001', insured: 'Acme Mills', class_of_business: 'Property', territory: 'Kenya',
    inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
    sum_insured_100: '5,000,000', si_retained: '1,000,000', si_ceded: '4,000,000',
    gross_premium_100: '25,000', premium_retained: '5,000', premium_ceded: '20,000',
  },
  {
    policy_ref: 'P-002', insured: 'Borak Foods', class_of_business: 'Property', territory: 'Kenya',
    inception: '2026-02-01', expiry: '2027-01-31', currency: 'USD',
    sum_insured_100: '3000000', si_retained: '600000', si_ceded: '2400000',
    gross_premium_100: '15000', premium_retained: '3000', premium_ceded: '12000',
  },
  {
    policy_ref: 'P-003', insured: 'Cedar Retail', class_of_business: 'Engineering', territory: 'Tanzania',
    inception: '2026-03-01', expiry: '2027-02-28', currency: 'USD',
    sum_insured_100: '12000000', si_retained: '2000000', si_ceded: '10000000',
    gross_premium_100: '60000', premium_retained: '12000', premium_ceded: '48000',
  },
];

const claimsRows = [
  {
    claim_ref: 'C-001', policy_ref: 'P-001', insured: 'Acme Mills', class_of_business: 'Property',
    date_of_loss: '2026-03-04', cause_of_loss: 'Fire', paid: '20,000', outstanding: '5,000',
  },
  {
    claim_ref: 'C-002', policy_ref: 'P-003', insured: 'Cedar Retail', class_of_business: 'Engineering',
    date_of_loss: '2026-06-30', cause_of_loss: 'Machinery breakdown', paid: '0', outstanding: '42000',
    incurred: '42000',
  },
];

test('numbers survive the formats bordereaux actually arrive in', () => {
  assert.equal(num('1,234.50'), 1234.5);
  assert.equal(num('$1 000'), 1000);
  assert.equal(num('(500)'), -500, 'accounting negatives');
  assert.equal(num(''), 0);
  assert.equal(num('n/a'), 0);
  assert.equal(num(2500), 2500);
});

test('premium aggregation totals exposure, income and the ceded rate', () => {
  const a = aggregatePremium(premiumRows);
  assert.equal(a.risks, 3);
  assert.equal(a.distinct_policies, 3);
  assert.equal(a.sum_insured_100, 20_000_000);
  assert.equal(a.si_ceded, 16_400_000);
  assert.equal(a.premium_ceded, 80_000);
  assert.equal(a.gross_premium_100, 100_000);
  // 80,000 / 16,400,000 = 0.4878%
  assert.equal(a.ceded_rate_pct, 0.49);
  assert.deepEqual(a.period.inception, { from: '2026-01-01', to: '2026-03-01' });
  assert.deepEqual(a.currencies, ['USD']);
  assert.equal(a.by_class[0].key, 'Engineering', 'ordered by premium, not by name');
  assert.equal(a.by_class[0].premium_ceded, 48_000);
  assert.equal(a.largest_risks[0].policy_ref, 'P-003');
});

test('claims aggregation derives incurred where the column is missing', () => {
  const a = aggregateClaims(claimsRows);
  assert.equal(a.claims, 2);
  assert.equal(a.paid, 20_000);
  assert.equal(a.outstanding, 47_000);
  // C-001 has no incurred column — paid + outstanding stands in for it.
  assert.equal(a.incurred, 67_000);
  assert.equal(a.open_claims, 2);
  assert.equal(a.largest_incurred, 42_000);
  assert.equal(a.by_cause[0].key, 'Machinery breakdown');
  assert.deepEqual(a.period.date_of_loss, { from: '2026-03-04', to: '2026-06-30' });
});

test('combined ratios are measured against the premium ceded to the treaty', () => {
  const agg = aggregateBordereaux([
    { id: 'b1', type: 'premium', source_file: 'prem.csv', parsed_rows: premiumRows },
    { id: 'b2', type: 'claims', source_file: 'claims.csv', parsed_rows: claimsRows },
  ], { currency: 'USD' });
  assert.equal(agg.currency, 'USD');
  assert.equal(agg.premium.premium_ceded, 80_000);
  assert.equal(agg.claims.incurred, 67_000);
  // 67,000 / 80,000
  assert.equal(agg.combined.loss_ratio_pct, 83.75);
  assert.equal(agg.combined.paid_ratio_pct, 25);
  assert.equal(agg.combined.claims_frequency_pct, 66.67);
  assert.equal(agg.sources.length, 2);
});

test('a book with no premium does not divide by zero', () => {
  const agg = aggregateBordereaux([{ id: 'b', type: 'claims', parsed_rows: claimsRows }]);
  assert.equal(agg.combined.loss_ratio_pct, null);
  assert.equal(agg.combined.claims_frequency_pct, null);
  assert.equal(agg.claims.incurred, 67_000);
});

test('data quality flags the things a broker checks by eye', () => {
  const flags = dataQuality(
    [
      ...premiumRows,
      { policy_ref: 'P-001', insured: 'Acme Mills', sum_insured_100: '100', premium_ceded: '0' },
      { policy_ref: '', insured: '', premium_ceded: '10', si_ceded: '500', sum_insured_100: '100' },
    ],
    [...claimsRows, { claim_ref: 'C-003', policy_ref: 'P-999', paid: '0', outstanding: '0' }],
  );
  const by = Object.fromEntries(flags.map((f) => [f.issue, f.rows_affected]));
  assert.equal(by.duplicate_policy_reference, 1, 'P-001 appears twice');
  assert.equal(by.missing_policy_reference, 1);
  assert.equal(by.zero_premium, 1);
  assert.equal(by.cession_exceeds_sum_insured, 1);
  assert.equal(by.claim_without_policy, 1, 'C-003 points at a policy not in the bordereau');
  assert.equal(by.nil_claims, 1);
  assert.ok(!('negative_amounts' in by), 'clean checks are left out entirely');
});

test('the sample strides through a long bordereau rather than taking the head', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ policy_ref: `P-${i}` }));
  const { premium } = sampleRows([{ type: 'premium', parsed_rows: rows }], 25);
  assert.equal(premium.length, 25);
  assert.equal(premium[0].policy_ref, 'P-0');
  assert.notEqual(premium[1].policy_ref, 'P-1', 'strided, not the first 25');
  assert.ok(Number(premium.at(-1).policy_ref.slice(2)) > 150, 'reaches the tail');
});

/* ── Single provider: ChatGPT, deliberately no fallback ───────────────── */

test('ChatGPT answers and the attempt is recorded', async () => {
  const res = await completeJson({ system: 's', prompt: 'p', schema: ANALYSIS_SCHEMA }, {
    openai: async () => ({ data: { headline: 'ok' }, model: 'gpt-4.1' }),
  });
  assert.equal(res.provider, 'openai');
  assert.equal(res.model, 'gpt-4.1');
  assert.deepEqual(res.attempts, [{ provider: 'openai', status: 'ok' }]);
});

test('a ChatGPT failure raises LlmUnavailable with the reason — nothing else is tried', async () => {
  await assert.rejects(
    () => completeJson({ system: 's', prompt: 'p', schema: ANALYSIS_SCHEMA }, {
      openai: async () => { throw new Error('chatgpt down'); },
    }),
    (e) => {
      assert.ok(e instanceof LlmUnavailableError);
      assert.equal(e.code, 'llm_unavailable');
      assert.match(e.message, /chatgpt down/);
      assert.deepEqual(e.attempts, [{ provider: 'openai', status: 'failed', error: 'chatgpt down' }]);
      return true;
    },
  );
});

test('with no key configured it says so instead of calling out', async () => {
  const openaiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      () => completeJson({ system: 's', prompt: 'p', schema: ANALYSIS_SCHEMA }),
      (e) => {
        assert.match(e.message, /No AI provider is configured/);
        assert.match(e.message, /OPENAI_API_KEY/);
        assert.deepEqual(e.attempts, [{ provider: 'openai', status: 'not_configured' }]);
        return true;
      },
    );
  } finally {
    if (openaiKey) process.env.OPENAI_API_KEY = openaiKey;
  }
});

test('the prompt carries the figures, the sample and the treaty context', () => {
  const aggregates = aggregateBordereaux([
    { id: 'b1', type: 'premium', parsed_rows: premiumRows },
    { id: 'b2', type: 'claims', parsed_rows: claimsRows },
  ], { currency: 'USD' });
  const prompt = buildPrompt({
    placement: {
      reference: 'UB-2026-TEST', class: 'Property Surplus', currency: 'USD',
      inception: '2026-01-01', expiry: '2026-12-31', status: 'DATA',
      layers: [{ name: 'Layer 1', type: 'XoL', limit_amt: 10_000_000, reinstatements: '2' }],
    },
    aggregates,
    sample: sampleRows([{ type: 'premium', parsed_rows: premiumRows }]),
  });
  const parsed = JSON.parse(prompt);
  assert.equal(parsed.placement.reference, 'UB-2026-TEST');
  assert.equal(parsed.placement.layers[0].reinstatements, '2');
  assert.equal(parsed.computed_figures.combined.loss_ratio_pct, 83.75);
  assert.equal(parsed.sample_rows.premium.length, 3);
});
