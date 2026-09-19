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

/**
 * Drive a placement to signed lines so every metric has something to count:
 * one lead market and one follow, both quoting with a premium and both
 * writing a line that signs.
 */
async function buildBook(api, { premium100 = 1_000_000, currency = 'USD', cedantName } = {}) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const cedant = await api('POST', '/api/cedants', {
    token: broker.token, body: { name: cedantName || `Cedant ${suffix}`, domicile: 'GB' },
  });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property Cat XoL',
      inception: '2026-01-01', expiry: '2026-12-31', currency,
    },
  });
  const pid = placement.body.id;
  const layer = await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token,
    body: {
      name: 'Layer 1', type: 'XoL', attachment: 1_000_000, limit_amt: 5_000_000,
      order_pct: 100, premium100, currency,
    },
  });
  const lid = layer.body.id;

  for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
  }

  const byRole = {};
  for (const [label, role, quotePremium, line] of [
    ['Lead Re', 'lead', 400_000, 60],
    ['Follow Re', 'follow', 300_000, 40],
  ]) {
    const market = await api('POST', '/api/markets', {
      token: broker.token, body: { name: `${label} ${suffix}`, rating: 'A+' },
    });
    const ap = await api('POST', `/api/layers/${lid}/approaches`, {
      token: broker.token, body: { market_id: market.body.id, role },
    });
    await api('POST', `/api/approaches/${ap.body.id}/quotes`, {
      token: broker.token, body: { type: 'firm', premium: quotePremium, line_offered: line },
    });
    byRole[role] = { approach_id: ap.body.id, market_id: market.body.id, line };
  }

  await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: { rol: 0.05 } } });
  await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
  for (const role of ['lead', 'follow']) {
    await api('POST', `/api/layers/${lid}/lines`, {
      token: broker.token,
      body: { market_id: byRole[role].market_id, written_pct: byRole[role].line, approach_id: byRole[role].approach_id },
    });
  }
  await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });

  return { cedant: cedant.body, placement_id: pid, layer_id: lid };
}

test('metrics report quoted premium, quotes, wins, cedants and premium seen/placed', async () => {
  await withServer(async (api) => {
    const empty = await api('GET', '/api/dashboards/metrics', { token: broker.token });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.quoted_premium.total, 0);
    assert.equal(empty.body.cedants, 0);
    assert.equal(empty.body.placed_ratio_pct, null, 'no premium seen means no ratio, not zero');

    await buildBook(api);
    const m = (await api('GET', '/api/dashboards/metrics', { token: broker.token })).body;

    // Quoted premium counts the live quotes only; both are still active/accepted.
    assert.equal(m.quoted_premium.total, 700_000);
    assert.deepEqual(m.quoted_premium.by_currency, { USD: 700_000 });
    assert.equal(m.lead_quotes, 1);
    assert.equal(m.follow_quotes, 1);
    assert.equal(m.quotes_total, 2);
    assert.equal(m.quotes_without_premium, 0);

    // One lead line and one follow line, both written and signed.
    assert.equal(m.lead_markets_won, 1);
    assert.equal(m.lead_markets_won_distinct, 1);
    assert.equal(m.follow_markets_won, 1);
    assert.equal(m.follow_markets_won_distinct, 1);

    assert.equal(m.cedants, 1);
    assert.equal(m.cedants_with_placements, 1);

    // Premium seen is the layer at 100%; placed is what the signed lines carry.
    // The order is 100% and fully subscribed, so the two match.
    assert.equal(m.total_premium_seen.total, 1_000_000);
    assert.equal(m.total_premium_placed.total, 1_000_000);
    assert.equal(m.placed_ratio_pct, 100);
    assert.equal(m.signed_lines, 2);
  });
});

test('a superseded quote stops counting toward quoted premium', async () => {
  await withServer(async (api) => {
    const { layer_id: lid } = await buildBook(api);
    const approaches = await api('GET', `/api/layers/${lid}/approaches`, { token: broker.token });
    const lead = approaches.body.find((a) => a.role === 'lead');

    // A re-quote supersedes the prior one: the total moves, it does not stack.
    await api('POST', `/api/approaches/${lead.id}/quotes`, {
      token: broker.token, body: { type: 'firm', premium: 450_000, line_offered: 60 },
    });
    const m = (await api('GET', '/api/dashboards/metrics', { token: broker.token })).body;
    assert.equal(m.quotes_total, 2, 'still two live quotes, not three');
    assert.equal(m.quoted_premium.total, 750_000, '450k lead + 300k follow');
  });
});

test('a quote priced on rate alone is reported rather than silently understating', async () => {
  await withServer(async (api) => {
    const { layer_id: lid } = await buildBook(api);
    const markets = await api('POST', '/api/markets', {
      token: broker.token, body: { name: `Rate Only ${Math.random().toString(36).slice(2, 7)}` },
    });
    const ap = await api('POST', `/api/layers/${lid}/approaches`, {
      token: broker.token, body: { market_id: markets.body.id, role: 'follow' },
    });
    // No premium on the quote — priced by rate on line.
    await api('POST', `/api/approaches/${ap.body.id}/quotes`, {
      token: broker.token, body: { type: 'firm', rol: 0.0525, line_offered: 15 },
    });

    const m = (await api('GET', '/api/dashboards/metrics', { token: broker.token })).body;
    assert.equal(m.quotes_total, 3);
    assert.equal(m.quotes_without_premium, 1);
    assert.equal(m.quoted_premium.total, 700_000, 'the rate-only quote adds nothing to the total');
  });
});

test('a mixed-currency book is split by currency, never merged silently', async () => {
  await withServer(async (api) => {
    await buildBook(api, { premium100: 1_000_000, currency: 'USD' });
    await buildBook(api, { premium100: 500_000, currency: 'EUR' });

    const m = (await api('GET', '/api/dashboards/metrics', { token: broker.token })).body;
    assert.equal(m.cedants, 2);
    assert.equal(m.total_premium_seen.total, 1_500_000);
    assert.deepEqual(m.total_premium_seen.by_currency, { USD: 1_000_000, EUR: 500_000 });
    assert.deepEqual(m.quoted_premium.by_currency, { USD: 700_000, EUR: 700_000 });
    assert.equal(m.lead_markets_won, 2);
  });
});

test('the pipeline endpoint is gone', async () => {
  await withServer(async (api) => {
    const gone = await api('GET', '/api/dashboards/pipeline', { token: broker.token });
    assert.equal(gone.status, 404);
  });
});
