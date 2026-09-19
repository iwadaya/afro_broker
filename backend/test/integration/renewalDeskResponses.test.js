// The renewal desk's responses: one row per reinsurer per layer off the line
// ledger, the broker's signed column, signing down through the existing
// engine, and the release gate — every layer signed to exactly its order.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox } from '../../src/integrations/mailer.js';

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  clearOutbox();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

async function market(api, name, person) {
  const m = await api('POST', '/api/markets', { token: broker.token, body: { name } });
  const c = await api('POST', `/api/markets/${m.body.id}/contacts`, {
    token: broker.token,
    body: { name: person, email: `${person.split(' ')[0]}@${name.split(' ')[0]}.example`.toLowerCase(), is_primary: true },
  });
  return { ...m.body, contact: c.body };
}

async function fot(api, layerId) {
  const proposed = await api('POST', `/api/layers/${layerId}/fot`, { token: broker.token, body: { agreed_terms: { order_pct: 100 } } });
  assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
  const authorised = await api('POST', `/api/layers/${layerId}/fot/authorise`, { token: uw.token });
  assert.equal(authorised.status, 200, JSON.stringify(authorised.body));
}

test('responses read one row per reinsurer per layer, the broker signs, and the release gate holds', async () => {
  await withServer(async (api) => {
    const alpha = await market(api, 'Alpha Re', 'Ann Alpha');
    const beta = await market(api, 'Beta Re', 'Ben Beta');
    const gamma = await market(api, 'Gamma Re', 'Gil Gamma');
    const delta = await market(api, 'Delta Re', 'Di Delta');

    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Kenya Re' } });
    const placement = (await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property Risk XL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
    })).body;
    const { rows: layers } = await pool.query(
      `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, currency, premium100, position) VALUES
         ($1, 'Layer 1', 'XoL', 2500000, 2500000, 'USD', 1650000, 1),
         ($1, 'Layer 2', 'XoL', 5000000, 5000000, 'USD', 1120000, 2)
       RETURNING id, name`,
      [placement.id],
    );
    const [l1, l2] = layers;

    const a = (await api('POST', '/api/renewal-analyses', {
      token: broker.token, body: { cedant_name: 'Kenya Re', class_of_business: 'Property', treaty_type: 'Risk XL' },
    })).body;
    await api('PUT', `/api/renewal-analyses/${a.id}/placement`, { token: broker.token, body: { placement_id: placement.id } });

    // The desk wrote to four markets (a sent submission, written straight to the record).
    const { rows: [sub] } = await pool.query(
      `INSERT INTO negotiation_submission (placement_id, analysis_id, subject, body, status, created_by, sent_at, broker_reviewed)
       VALUES ($1, $2, 'Firm order terms', 'body', 'sent', $3, now(), TRUE) RETURNING id`,
      [placement.id, a.id, broker.user.id],
    );
    for (const m of [alpha, beta, gamma, delta]) {
      await pool.query(
        `INSERT INTO negotiation_submission_recipient (submission_id, market_id, contact_id, name, email, status, sent_at)
         VALUES ($1, $2, $3, $4, $5, 'sent', now())`,
        [sub.id, m.id, m.contact.id, m.contact.name, m.contact.email],
      );
    }

    // Before firm order terms are authorised, no line can be written.
    const early = await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: alpha.id, written_pct: 40 } });
    assert.equal(early.status, 409);
    assert.match(early.body.error, /FOT/);

    await fot(api, l1.id);
    // Layer 1: oversubscribed — 40 + 40 + 40 = 120 against an order of 100; Delta declines.
    for (const [m, pct] of [[alpha, 40], [beta, 40], [gamma, 40]]) {
      const w = await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: m.id, written_pct: pct } });
      assert.equal(w.status, 201, JSON.stringify(w.body));
    }
    await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: delta.id, written_pct: 0 } });
    const declined = await api('POST', `/api/layers/${l1.id}/lines/${delta.id}/decline`, { token: broker.token });
    assert.equal(declined.status, 200);
    const noted = await api('PATCH', `/api/layers/${l1.id}/lines/${delta.id}`, {
      token: broker.token, body: { notes: 'Minimum ROL not met' },
    });
    assert.equal(noted.status, 200);
    assert.equal(noted.body.notes, 'Minimum ROL not met');

    // The read model: every market the desk wrote to is a row on every layer.
    const ctx = (await api('GET', `/api/renewal-analyses/${a.id}/responses`, { token: broker.token })).body;
    assert.equal(ctx.ready, true);
    assert.equal(ctx.placement.reference, placement.reference);
    assert.equal(ctx.emailed, 4);
    assert.deepEqual(ctx.layers.map((l) => l.name), ['Layer 1', 'Layer 2']);
    const L1 = ctx.layers[0];
    assert.equal(L1.fot.status, 'authorised');
    assert.equal(L1.written_total, 120);
    assert.equal(L1.signed_total, 0);
    assert.equal(L1.declined, 1);
    assert.equal(L1.awaiting, 0);
    assert.equal(L1.rows.length, 4);
    const byName = (layer) => Object.fromEntries(layer.rows.map((r) => [r.market_name, r]));
    const r1 = byName(L1);
    assert.equal(r1['Alpha Re'].status, 'written');
    assert.equal(r1['Alpha Re'].written_pct, 40);
    assert.equal(r1['Alpha Re'].signed_pct, null);
    assert.equal(r1['Alpha Re'].underwriter, 'Ann Alpha');
    assert.equal(r1['Delta Re'].status, 'declined');
    assert.equal(r1['Delta Re'].written_pct, 0, 'a declinature stays in the table at nil');
    assert.equal(r1['Delta Re'].notes, 'Minimum ROL not met');
    const L2 = ctx.layers[1];
    assert.equal(L2.fot, null);
    assert.equal(L2.rows.length, 4, 'the markets written to are rows on a layer nobody has answered on');
    assert.ok(L2.rows.every((r) => r.status === 'awaiting'));
    assert.ok(L2.rows.every((r) => r.emailed_at));

    // The release refuses while any layer is off its order, naming them.
    const held = await api('POST', `/api/renewal-analyses/${a.id}/release`, { token: broker.token });
    assert.equal(held.status, 409);
    assert.match(held.body.error, /Layer 1 \(0\.00% of 100\.00%\)/);
    assert.match(held.body.error, /Layer 2/);

    // Signing down through the engine: 120 written signs to exactly 100.
    const signed = await api('POST', `/api/layers/${l1.id}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.equal(signed.body.state, 'OVERSUBSCRIBED');
    assert.equal(signed.body.signedTotal, 100);
    const afterSign = (await api('GET', `/api/renewal-analyses/${a.id}/responses`, { token: broker.token })).body;
    assert.equal(afterSign.layers[0].signed_total, 100);
    assert.equal(afterSign.layers[0].signed_to_order, true);
    const shares = afterSign.layers[0].rows.filter((r) => r.status === 'written').map((r) => r.signed_pct);
    assert.deepEqual(shares.sort(), [33.3333, 33.3333, 33.3334], 'largest remainder: the column sums to the order exactly');
    assert.equal(afterSign.layers[0].rows.find((r) => r.market_name === 'Alpha Re').premium_signed > 0, true);

    // The broker's override: never above the written line; the premium follows.
    const tooHigh = await api('PATCH', `/api/layers/${l1.id}/lines/${alpha.id}`, { token: broker.token, body: { signed_pct: 45 } });
    assert.equal(tooHigh.status, 409);
    const over = await api('PATCH', `/api/layers/${l1.id}/lines/${alpha.id}`, { token: broker.token, body: { signed_pct: 30 } });
    assert.equal(over.status, 200);
    assert.equal(Number(over.body.signed_pct), 30);
    assert.equal(Number(over.body.premium_signed), 495000);
    const uwOverride = await api('PATCH', `/api/layers/${l1.id}/lines/${alpha.id}`, { token: uw.token, body: { signed_pct: 30 } });
    assert.equal(uwOverride.status, 403);
    const offOrder = (await api('GET', `/api/renewal-analyses/${a.id}/responses`, { token: broker.token })).body;
    assert.equal(offOrder.layers[0].signed_to_order, false, 'a hand-set cell can take the layer off its order');
    const offHeld = await api('POST', `/api/renewal-analyses/${a.id}/release`, { token: broker.token });
    assert.match(offHeld.body.error, /Layer 1 \(96\.67% of 100\.00%\)/);
    await api('PATCH', `/api/layers/${l1.id}/lines/${alpha.id}`, { token: broker.token, body: { signed_pct: 33.3334 } });

    // Layer 2: firm order terms, two lines to exactly the order, signed as written.
    await fot(api, l2.id);
    await api('POST', `/api/layers/${l2.id}/lines`, { token: broker.token, body: { market_id: alpha.id, written_pct: 60 } });
    await api('POST', `/api/layers/${l2.id}/lines`, { token: broker.token, body: { market_id: beta.id, written_pct: 40 } });
    const exact = await api('POST', `/api/layers/${l2.id}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(exact.body.state, 'EXACT');

    const released = await api('POST', `/api/renewal-analyses/${a.id}/release`, { token: broker.token });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.released, true);
    assert.deepEqual(released.body.layers.map((l) => l.signed_total), [100, 100]);
    const { rows: audits } = await pool.query(
      `SELECT entity_type FROM audit_event WHERE action = 'release_signed_lines' ORDER BY entity_type`,
    );
    assert.deepEqual(audits.map((r) => r.entity_type), ['placement', 'renewal_pack_analysis']);
    const final = (await api('GET', `/api/renewal-analyses/${a.id}/responses`, { token: broker.token })).body;
    assert.equal(final.placement.status, 'SIGNED', 'the engine moved the placement on');
  });
});
