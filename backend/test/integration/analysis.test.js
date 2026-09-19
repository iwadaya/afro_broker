import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
});

const PREMIUM_ROWS = [
  { policy_ref: 'P-001', insured: 'Acme Mills', class_of_business: 'Property', territory: 'Kenya',
    inception: '2026-01-01', expiry: '2026-12-31', sum_insured_100: '5000000', si_ceded: '4000000',
    gross_premium_100: '25000', premium_ceded: '20000' },
  { policy_ref: 'P-002', insured: 'Borak Foods', class_of_business: 'Property', territory: 'Kenya',
    inception: '2026-02-01', expiry: '2027-01-31', sum_insured_100: '3000000', si_ceded: '2400000',
    gross_premium_100: '15000', premium_ceded: '12000' },
];
const CLAIMS_ROWS = [
  { claim_ref: 'C-001', policy_ref: 'P-001', insured: 'Acme Mills', date_of_loss: '2026-03-04',
    cause_of_loss: 'Fire', paid: '20000', outstanding: '5000' },
];

async function seedWithBordereaux(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Analysis Cedant' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property Surplus', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  for (const [type, rows] of [['premium', PREMIUM_ROWS], ['claims', CLAIMS_ROWS]]) {
    const r = await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token, body: { type, source_file: `${type}.csv`, rows },
    });
    assert.equal(r.status, 201, `${type} bordereau ingested`);
  }
  return pid;
}

test('analysis figures are computed from the stored bordereaux, no model involved', async () => {
  await withServer(async (api) => {
    const pid = await seedWithBordereaux(api);
    const res = await api('GET', `/api/placements/${pid}/analysis`, { token: broker.token });
    assert.equal(res.status, 200);
    const { aggregates } = res.body;
    assert.equal(aggregates.currency, 'USD');
    assert.equal(aggregates.premium.risks, 2);
    assert.equal(aggregates.premium.sum_insured_100, 8_000_000);
    assert.equal(aggregates.premium.premium_ceded, 32_000);
    assert.equal(aggregates.claims.incurred, 25_000);
    // 25,000 / 32,000
    assert.equal(aggregates.combined.loss_ratio_pct, 78.13);
    assert.equal(res.body.analysis, null, 'nothing generated yet');
    assert.deepEqual(res.body.providers.map((p) => p.provider), ['openai']);
  });
});

test('a placement with no bordereaux is refused rather than sent to a model', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Empty Cedant' } });
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property QS', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    const res = await api('POST', `/api/placements/${placement.body.id}/analysis`, { token: broker.token, body: {} });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'no_bordereaux');
    assert.equal(res.body.aggregates.premium.risks, 0);
  });
});

test('with no provider configured the figures still come back, with the reason', async () => {
  const savedOpenai = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await withServer(async (api) => {
      const pid = await seedWithBordereaux(api);
      const res = await api('POST', `/api/placements/${pid}/analysis`, { token: broker.token, body: {} });
      assert.equal(res.status, 503);
      assert.equal(res.body.code, 'llm_unavailable');
      assert.match(res.body.error, /No AI provider is configured/);
      // The whole point: the numbers do not depend on the model.
      assert.equal(res.body.aggregates.premium.premium_ceded, 32_000);
      assert.deepEqual(res.body.attempts, [{ provider: 'openai', status: 'not_configured' }]);
    });
  } finally {
    if (savedOpenai) process.env.OPENAI_API_KEY = savedOpenai;
  }
});
