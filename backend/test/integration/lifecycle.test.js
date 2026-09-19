import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let uw;

before(async () => {
  await resetDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

/** Drive a placement from DRAFT all the way to BOUND through the real API. */
test('full placement lifecycle: draft → bound with oversubscription sign-down', async () => {
  await withServer(async (api) => {
    // Cedant
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Acme Insurance', domicile: 'GB' } });
    assert.equal(cedant.status, 201);

    // Placement
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property CAT', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    assert.equal(placement.status, 201);
    assert.equal(placement.body.status, 'DRAFT');
    const pid = placement.body.id;

    // Layer: order 100%, premium100 1,000,000
    const layer = await api('POST', `/api/placements/${pid}/layers`, {
      token: broker.token,
      body: { name: 'Layer 1 xs', type: 'XoL', attachment: 10_000_000, limit_amt: 20_000_000, order_pct: 100, premium100: 1_000_000, currency: 'USD' },
    });
    assert.equal(layer.status, 201);
    const lid = layer.body.id;

    // Walk placement statuses to QUOTED.
    for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
      const t = await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
      assert.equal(t.status, 200, `transition to ${status}`);
    }

    // Markets
    const mkNames = ['Lead Re', 'Follower A', 'Follower B', 'Follower C'];
    const markets = [];
    for (const name of mkNames) {
      const m = await api('POST', '/api/markets', { token: broker.token, body: { name, rating: 'A+' } });
      assert.equal(m.status, 201);
      markets.push(m.body);
    }

    // Approaches + quotes (lead first)
    const written = { 'Lead Re': 25, 'Follower A': 20, 'Follower B': 30, 'Follower C': 40 };
    const approachByMarket = {};
    for (let i = 0; i < markets.length; i += 1) {
      const role = i === 0 ? 'lead' : 'follow';
      const ap = await api('POST', `/api/layers/${lid}/approaches`, { token: broker.token, body: { market_id: markets[i].id, role } });
      assert.equal(ap.status, 201, `approach ${markets[i].name}`);
      approachByMarket[markets[i].name] = ap.body.id;
      const q = await api('POST', `/api/approaches/${ap.body.id}/quotes`, {
        token: broker.token, body: { type: 'firm', rol: 0.05, line_offered: written[markets[i].name] },
      });
      assert.equal(q.status, 201);
    }

    // FOT propose (broker) then authorise (underwriter, four-eyes)
    const fot = await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: { rol: 0.05 }, agreed_date: '2026-01-05' } });
    assert.equal(fot.status, 201);
    assert.equal(fot.body.status, 'proposed');

    const auth = await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
    assert.equal(auth.status, 200);
    assert.equal(auth.body.status, 'authorised');

    // Placement should now be FOT_AGREED.
    const pAfterFot = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(pAfterFot.body.status, 'FOT_AGREED');

    // Write lines (oversubscribed 115%)
    for (const name of mkNames) {
      const m = markets.find((x) => x.name === name);
      const ln = await api('POST', `/api/layers/${lid}/lines`, {
        token: broker.token,
        body: { market_id: m.id, written_pct: written[name], approach_id: approachByMarket[name] },
      });
      assert.equal(ln.status, 201, `line ${name}`);
    }

    // Preview signing
    const preview = await api('GET', `/api/layers/${lid}/signing/preview`, { token: broker.token });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.state, 'OVERSUBSCRIBED');
    assert.equal(preview.body.signedTotal, 100);

    // Apply signing
    const applied = await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.signedTotal, 100);

    // Premium allocation reconciles to premium100.
    const alloc = await api('GET', `/api/layers/${lid}/premium-allocation`, { token: broker.token });
    assert.equal(alloc.status, 200);
    assert.equal(alloc.body.premium_allocated, 1_000_000);
    assert.equal(Math.round(alloc.body.signed_total_pct), 100);

    // Four-eyes bind: propose (broker) then authorise (underwriter)
    const propose = await api('POST', `/api/layers/${lid}/bind/propose`, { token: broker.token });
    assert.equal(propose.status, 201);
    const bind = await api('POST', `/api/layers/${lid}/bind/authorise`, { token: uw.token });
    assert.equal(bind.status, 200);
    assert.equal(bind.body.layer.status, 'BOUND');

    // Placement is BOUND (only one layer).
    const finalP = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(finalP.body.status, 'BOUND');

    // Closing document captures the allocation.
    const closing = await api('POST', `/api/layers/${lid}/documents`, { token: broker.token, body: { type: 'closing' } });
    assert.equal(closing.status, 201);
    assert.equal(closing.body.content.premium_allocated, 1_000_000);
  });
});

test('renewal cloning copies structure, links renewal_of, starts DRAFT', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Renewable Mutual' } });
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Motor', inception: '2025-01-01', expiry: '2025-12-31', currency: 'EUR' },
    });
    const pid = placement.body.id;
    await api('POST', `/api/placements/${pid}/layers`, {
      token: broker.token, body: { name: 'QS', type: 'QS', order_pct: 80, premium100: 500_000, currency: 'EUR' },
    });

    const renewal = await api('POST', `/api/placements/${pid}/renew`, { token: broker.token, body: { inception: '2026-01-01', expiry: '2026-12-31' } });
    assert.equal(renewal.status, 201);
    assert.equal(renewal.body.status, 'DRAFT');
    assert.equal(renewal.body.renewal_of, pid);

    const full = await api('GET', `/api/placements/${renewal.body.id}`, { token: broker.token });
    assert.equal(full.body.layers.length, 1);
    assert.equal(full.body.layers[0].order_pct, 80);
    assert.equal(Number(full.body.layers[0].premium100), 0); // premium resets on renewal
  });
});

/** Placement ids are UUIDs: malformed ones are the caller's error, not a 500. */
test('a malformed placement id is a bad request; an unknown one is a 404', async () => {
  await withServer(async (api) => {
    const bad = await api('GET', '/api/placements/not-a-uuid', { token: broker.token });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_input');

    const missing = await api('GET', '/api/placements/00000000-0000-0000-0000-000000000000', { token: broker.token });
    assert.equal(missing.status, 404);
  });
});

/** The treaty detail's cedant dropdown moves the placement between cedants. */
test('PATCH moves the placement to another cedant, and only a real one', async () => {
  await withServer(async (api) => {
    const uk = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'UK Mutual', domicile: 'UK' } });
    const ke = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Nairobi Re', domicile: 'Kenya' } });
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: uk.body.id, class: 'Property QS', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    const pid = placement.body.id;

    const moved = await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token, body: { cedant_id: ke.body.id },
    });
    assert.equal(moved.status, 200);
    assert.equal(moved.body.cedant_id, ke.body.id);

    const ghost = await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token, body: { cedant_id: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(ghost.status, 404);

    const read = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(read.body.cedant_id, ke.body.id, 'the failed move left the cedant alone');
  });
});
