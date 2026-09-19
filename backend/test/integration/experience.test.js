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

async function makePlacement(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Data Cedant' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  return placement.body.id;
}

const PREMIUM_CSV = `UW Year,Gross Premium
2023,1000000
2024,1200000
2025,1500000`;

const CLAIMS_CSV = `UW Year,Claim Ref,Insured,Paid,Outstanding,Cat Code
2023,C-1,Mill A,200000,100000,
2023,C-2,Depot B,400000,0,
2024,C-3,Plant C,150000,450000,EQ26
2025,C-4,Shed D,10000,5000,`;

const RISK_PROFILE_CSV = `Band,Risks,TSI,Premium
0 - 1m,120,80000000,900000
1m - 5m,40,120000000,1400000
5m - 10m,8,60000000,700000`;

test('loss summary carries large losses, cat losses and the risk profile', async () => {
  await withServer(async (api) => {
    const pid = await makePlacement(api);

    const prem = await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token, body: { type: 'premium', csv: PREMIUM_CSV },
    });
    assert.equal(prem.status, 201);
    assert.equal(prem.body.summary.premium, 3_700_000);

    const claims = await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token, body: { type: 'claims', csv: CLAIMS_CSV },
    });
    assert.equal(claims.status, 201);
    assert.equal(claims.body.summary.incurred, 1_315_000);

    const rp = await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token, body: { type: 'risk_profile', csv: RISK_PROFILE_CSV },
    });
    assert.equal(rp.status, 201);
    assert.equal(rp.body.summary.risks, 168);
    assert.equal(rp.body.summary.tsi, 260_000_000);

    // The aggregated loss summary merges everything for the pack.
    const summary = await api('GET', `/api/placements/${pid}/loss-summary?large_loss_threshold=250000`, { token: broker.token });
    const s = summary.body;
    assert.equal(s.premium, 3_700_000);
    assert.equal(s.incurred, 1_315_000);
    const y2023 = s.by_year.find((y) => y.year === 2023);
    assert.equal(y2023.premium, 1_000_000);
    assert.equal(y2023.incurred, 700_000);
    assert.equal(y2023.loss_ratio_pct, 70);
    const y2024 = s.by_year.find((y) => y.year === 2024);
    assert.equal(y2024.loss_ratio_pct, 50);
    // Large losses ≥ 250k incurred, sorted descending: C-3 (600k), C-2 (400k), C-1 (300k).
    assert.deepEqual(s.large_losses.map((l) => l.claim_ref), ['C-3', 'C-2', 'C-1']);
    assert.equal(s.large_losses[0].cat, true); // C-3 carries a cat code
    assert.equal(s.large_loss_threshold, 250_000);
    assert.equal(s.cat.count, 1);
    assert.equal(s.cat.incurred, 600_000);
    assert.equal(s.risk_profile.bands.length, 3);
    assert.equal(s.risk_profile.risks, 168);
  });
});

test('the default large-loss threshold applies when none is given', async () => {
  await withServer(async (api) => {
    const pid = await makePlacement(api);
    await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token, body: { type: 'claims', csv: CLAIMS_CSV },
    });
    const summary = await api('GET', `/api/placements/${pid}/loss-summary`, { token: broker.token });
    assert.equal(summary.body.large_loss_threshold, 250_000);
    assert.equal(summary.body.large_losses.length, 3);
    assert.equal(summary.body.risk_profile, null);
  });
});
