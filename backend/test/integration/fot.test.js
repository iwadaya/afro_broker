import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let uw;
let admin;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
  admin = await makeUser('admin');
});

/** Build a placement+layer in QUOTED with an authorisable FOT proposal. */
async function setupLayer(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'FOT Cedant' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Liability', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  const layer = await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token, body: { name: 'L1', type: 'XoL', order_pct: 100, premium100: 1_000_000, currency: 'USD' },
  });
  for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
  }
  return { pid, lid: layer.body.id };
}

test('four-eyes: proposer cannot authorise their own FOT', async () => {
  await withServer(async (api) => {
    const { lid } = await setupLayer(api);
    // Broker proposes, broker tries to authorise -> blocked by role (broker can't authorise).
    await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: { rol: 0.1 } } });
    const selfBroker = await api('POST', `/api/layers/${lid}/fot/authorise`, { token: broker.token });
    assert.equal(selfBroker.status, 403); // broker lacks authorise role

    // Admin can both propose and authorise by role, so it exercises the
    // four-eyes guard: admin proposes (superseding the broker's), then the same
    // admin attempts to authorise -> blocked because proposer === approver.
    await api('POST', `/api/layers/${lid}/fot`, { token: admin.token, body: { agreed_terms: { rol: 0.1 } } });
    const selfAdmin = await api('POST', `/api/layers/${lid}/fot/authorise`, { token: admin.token });
    assert.equal(selfAdmin.status, 409);
    assert.match(selfAdmin.body.error, /cannot authorise their own/i);

    // A different authoriser (underwriter) succeeds.
    const ok = await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, 'authorised');
  });
});

test('authorised FOT is immutable; a change is a new version that supersedes', async () => {
  await withServer(async (api) => {
    const { lid } = await setupLayer(api);
    await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: { rol: 0.1 } } });
    const auth1 = await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
    assert.equal(auth1.body.version, 1);
    assert.equal(auth1.body.status, 'authorised');

    // Propose a new version (the only legitimate "change").
    const v2 = await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: { rol: 0.12 } } });
    assert.equal(v2.body.version, 2);
    await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });

    // History: v1 superseded, v2 authorised; exactly one authorised.
    const list = await api('GET', `/api/layers/${lid}/fot`, { token: broker.token });
    const byVersion = Object.fromEntries(list.body.map((f) => [f.version, f.status]));
    assert.equal(byVersion[1], 'superseded');
    assert.equal(byVersion[2], 'authorised');
    const authorised = list.body.filter((f) => f.status === 'authorised');
    assert.equal(authorised.length, 1);

    const active = await api('GET', `/api/layers/${lid}/fot/active`, { token: broker.token });
    assert.equal(active.body.version, 2);
  });
});

test('cannot write lines before an authorised FOT exists', async () => {
  await withServer(async (api) => {
    const { lid } = await setupLayer(api);
    const market = await api('POST', '/api/markets', { token: broker.token, body: { name: 'M1' } });
    const res = await api('POST', `/api/layers/${lid}/lines`, { token: broker.token, body: { market_id: market.body.id, written_pct: 50 } });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /No authorised FOT/i);
  });
});
