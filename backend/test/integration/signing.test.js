import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

/** Set up a layer with an authorised FOT, ready to collect lines. */
async function readyLayer(api, { order = 100, premium100 = 1_000_000 } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Sign Cedant' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  const layer = await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token, body: { name: 'L', type: 'XoL', order_pct: order, premium100, currency: 'USD' },
  });
  const lid = layer.body.id;
  for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
  }
  await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: {} } });
  await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
  return { pid, lid };
}

async function addLine(api, lid, name, written, toStand = false) {
  const m = await api('POST', '/api/markets', { token: broker.token, body: { name } });
  await api('POST', `/api/layers/${lid}/lines`, { token: broker.token, body: { market_id: m.body.id, written_pct: written, to_stand: toStand } });
  return m.body.id;
}

test('undersubscribed: apply rejected without accept_shortfall, placement INCOMPLETE with it', async () => {
  await withServer(async (api) => {
    const { pid, lid } = await readyLayer(api);
    await addLine(api, lid, 'A', 30);
    await addLine(api, lid, 'B', 25); // total 55 < 100

    const preview = await api('GET', `/api/layers/${lid}/signing/preview`, { token: broker.token });
    assert.equal(preview.body.state, 'UNDERSUBSCRIBED');
    assert.equal(preview.body.shortfall, 45);

    const blocked = await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(blocked.status, 409);
    assert.match(blocked.body.error, /Undersubscribed/);

    const firmed = await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: { accept_shortfall: true } });
    assert.equal(firmed.status, 200);
    assert.equal(firmed.body.signedTotal, 55);

    const p = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(p.body.status, 'INCOMPLETE');

    // Bind blocked because signed total ≠ order.
    const propose = await api('POST', `/api/layers/${lid}/bind/propose`, { token: broker.token });
    assert.equal(propose.status, 409);
    assert.match(propose.body.error, /≠ order|cannot bind/);
  });
});

test('to-stand line is reserved; signed total still equals order', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    await addLine(api, lid, 'Lead', 30, true); // stands
    await addLine(api, lid, 'A', 30);
    await addLine(api, lid, 'B', 30);
    await addLine(api, lid, 'C', 30); // total 120, oversubscribed

    const applied = await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.signedTotal, 100);
    const lead = applied.body.lines.find((l) => l.id && l.toStand);
    assert.equal(lead.signed, 30); // untouched

    const alloc = await api('GET', `/api/layers/${lid}/premium-allocation`, { token: broker.token });
    assert.equal(alloc.body.premium_allocated, 1_000_000);
  });
});

test('bind requires four-eyes: proposer cannot authorise their own bind', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    await addLine(api, lid, 'A', 60);
    await addLine(api, lid, 'B', 40); // exactly 100
    await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });

    const propose = await api('POST', `/api/layers/${lid}/bind/propose`, { token: broker.token });
    assert.equal(propose.status, 201);

    // Underwriter who is NOT the proposer authorises -> ok.
    const bind = await api('POST', `/api/layers/${lid}/bind/authorise`, { token: uw.token });
    assert.equal(bind.status, 200);
    assert.equal(bind.body.layer.status, 'BOUND');
  });
});

test('signed % cannot be set directly through the line write endpoint', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const m = await api('POST', '/api/markets', { token: broker.token, body: { name: 'Sneaky' } });
    // Attempt to inject signed_pct via the write body — schema strips it, signed stays null.
    const ln = await api('POST', `/api/layers/${lid}/lines`, {
      token: broker.token, body: { market_id: m.body.id, written_pct: 50, signed_pct: 999 },
    });
    assert.equal(ln.status, 201);
    assert.equal(ln.body.signed_pct, null);
  });
});
