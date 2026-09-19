import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

/*
 * Signing by contract: the chooser's list (every placement with a
 * programme, with where its signing stands) and one contract's programme
 * with the written and signed line of every market on every layer.
 */

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

/** A placement with a programme of `layers` layers; the first has an authorised FOT. */
async function contractWithProgramme(api, { cedant = 'Sign Cedant', reference, cls = 'Property CAT XL', layers = 1, order = 100, premium100 = 1_000_000 } = {}) {
  const c = await api('POST', '/api/cedants', { token: broker.token, body: { name: cedant, domicile: 'GB' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { reference, cedant_id: c.body.id, class: cls, inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  const lids = [];
  for (let i = 0; i < layers; i += 1) {
    const layer = await api('POST', `/api/placements/${pid}/layers`, {
      token: broker.token,
      body: {
        name: `Layer ${i + 1}`, type: 'XoL', order_pct: order, premium100, currency: 'USD',
        attachment: 10e6 * (i + 1), limit_amt: 10e6, position: i + 1,
      },
    });
    lids.push(layer.body.id);
  }
  for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
  }
  await api('POST', `/api/layers/${lids[0]}/fot`, { token: broker.token, body: { agreed_terms: { rol: 12.5 } } });
  await api('POST', `/api/layers/${lids[0]}/fot/authorise`, { token: uw.token });
  return { pid, lids };
}

async function addLine(api, lid, name, written, toStand = false) {
  const m = await api('POST', '/api/markets', { token: broker.token, body: { name } });
  const line = await api('POST', `/api/layers/${lid}/lines`, {
    token: broker.token, body: { market_id: m.body.id, written_pct: written, to_stand: toStand },
  });
  assert.equal(line.status, 201);
  return m.body.id;
}

test('the chooser lists only placements with a programme, with their counts and signing state', async () => {
  await withServer(async (api) => {
    // A placement with no layers has no programme, so it is not a contract to sign.
    const bare = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Bare Cedant' } });
    await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: bare.body.id, class: 'Motor QS', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
    });
    const { pid, lids } = await contractWithProgramme(api, { reference: 'SGN-27-ONE' });
    await addLine(api, lids[0], 'Alpha Re', 60);
    await addLine(api, lids[0], 'Beta Re', 60);

    const list = await api('GET', '/api/signing/contracts', { token: broker.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    const row = list.body[0];
    assert.equal(row.id, pid);
    assert.equal(row.reference, 'SGN-27-ONE');
    assert.equal(row.cedant, 'Sign Cedant');
    assert.equal(row.cedant_domicile, 'GB');
    assert.equal(row.uy, '2027');
    assert.equal(row.layer_count, 1);
    assert.equal(row.layers_with_lines, 1);
    assert.equal(row.layers_signed, 0);
    assert.equal(row.markets, 2);
    assert.equal(row.lines_written, 2);
    assert.equal(row.lines_signed, 0);
    assert.equal(row.signing_state, 'LINES_WRITTEN');

    // The search reads cedant, reference, class and year — and misses cleanly.
    for (const q of ['sign ced', 'SGN-27', 'cat xl', '2027']) {
      const hit = await api('GET', `/api/signing/contracts?q=${encodeURIComponent(q)}`, { token: broker.token });
      assert.equal(hit.body.length, 1, `search "${q}" finds the contract`);
    }
    const miss = await api('GET', '/api/signing/contracts?q=nothing-like-it', { token: broker.token });
    assert.equal(miss.body.length, 0);

    // Once signing is applied the state moves on.
    const applied = await api('POST', `/api/layers/${lids[0]}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(applied.status, 200);
    const after = await api('GET', '/api/signing/contracts', { token: broker.token });
    assert.equal(after.body[0].signing_state, 'SIGNED');
    assert.equal(after.body[0].lines_signed, 2);
    assert.equal(after.body[0].lines_written, 0);
    assert.equal(after.body[0].layers_signed, 1);
  });
});

test('one contract: the programme in tower order, written lines, and the signed line as a preview until applied', async () => {
  await withServer(async (api) => {
    const { pid, lids } = await contractWithProgramme(api, { reference: 'SGN-27-TWO', layers: 2 });
    // 120% written against a 100% order: the standing line keeps its 30, the
    // other 90 written share the remaining 70.
    await addLine(api, lids[0], 'Alpha Re', 30, true);
    await addLine(api, lids[0], 'Beta Re', 40);
    await addLine(api, lids[0], 'Gamma Re', 50);

    const before = await api('GET', `/api/signing/contracts/${pid}`, { token: broker.token });
    assert.equal(before.status, 200);
    assert.equal(before.body.contract.id, pid);
    assert.equal(before.body.contract.cedant, 'Sign Cedant');
    assert.equal(before.body.contract.reference, 'SGN-27-TWO');
    assert.deepEqual(before.body.programme.map((l) => l.position), [1, 2]);
    assert.deepEqual(before.body.programme.map((l) => l.name), ['Layer 1', 'Layer 2']);

    const l1 = before.body.programme[0];
    assert.equal(l1.fot.status, 'authorised');
    assert.equal(l1.fot.rol, 12.5);
    assert.equal(l1.signing.applied, false);
    assert.equal(l1.signing.written_total, 120);
    assert.equal(l1.signing.signed_total, null);
    assert.equal(l1.signing.preview.state, 'OVERSUBSCRIBED');
    assert.equal(l1.signing.preview.signed_total, 100);
    assert.equal(l1.signing.preview.standing_total, 30);
    // Largest line first, as a signing panel is read.
    assert.deepEqual(l1.lines.map((x) => x.market_name), ['Gamma Re', 'Beta Re', 'Alpha Re']);
    const alpha = l1.lines.find((x) => x.market_name === 'Alpha Re');
    assert.equal(alpha.written_pct, 30);
    assert.equal(alpha.to_stand, true);
    assert.equal(alpha.signed_pct, null, 'nothing is signed until signing is applied');
    assert.equal(alpha.preview_signed_pct, 30, 'a standing line previews at written');
    const gamma = l1.lines.find((x) => x.market_name === 'Gamma Re');
    assert.equal(gamma.preview_signed_pct, 38.8889);
    const beta = l1.lines.find((x) => x.market_name === 'Beta Re');
    assert.equal(beta.preview_signed_pct, 31.1111);
    assert.equal(beta.preview_premium + gamma.preview_premium + alpha.preview_premium, 1_000_000);

    const l2 = before.body.programme[1];
    assert.equal(l2.lines.length, 0);
    assert.equal(l2.fot, null);
    assert.equal(l2.signing.preview.state, 'EMPTY');

    assert.equal(before.body.signing_state, 'LINES_WRITTEN');
    assert.equal(before.body.totals.layers, 2);
    assert.equal(before.body.totals.layers_with_lines, 1);
    assert.equal(before.body.totals.markets, 3);
    assert.equal(before.body.totals.lines_written, 3);
    assert.equal(before.body.totals.lines_signed, 0);

    // Apply the signing: the signed column now reads from the ledger.
    const applied = await api('POST', `/api/layers/${lids[0]}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(applied.status, 200);
    const after = await api('GET', `/api/signing/contracts/${pid}`, { token: broker.token });
    const s1 = after.body.programme[0];
    assert.equal(s1.signing.applied, true);
    assert.equal(s1.signing.method, 'pro_rata');
    assert.equal(s1.signing.signed_total, 100);
    assert.equal(s1.signing.premium_signed_total, 1_000_000);
    assert.equal(s1.signing.factor, applied.body.signingFactor);
    const gammaAfter = s1.lines.find((x) => x.market_name === 'Gamma Re');
    assert.equal(gammaAfter.status, 'SIGNED');
    assert.equal(gammaAfter.signed_pct, 38.8889);
    assert.equal(gammaAfter.signed_pct, gammaAfter.preview_signed_pct, 'the ledger and the preview agree once applied');
    assert.equal(after.body.signing_state, 'SIGNED');
    assert.equal(after.body.totals.lines_signed, 3);

    // The same lines by reinsurer: each market carries its line on each layer it wrote.
    assert.deepEqual(after.body.markets.map((m) => m.market_name), ['Alpha Re', 'Beta Re', 'Gamma Re']);
    const alphaMkt = after.body.markets.find((m) => m.market_name === 'Alpha Re');
    assert.equal(alphaMkt.lines.length, 1);
    assert.equal(alphaMkt.lines[0].layer_position, 1);
    assert.equal(alphaMkt.lines[0].written_pct, 30);
    assert.equal(alphaMkt.lines[0].signed_pct, 30);
    assert.equal(alphaMkt.lines[0].applied, true);
  });
});

test('a declined market is listed apart from the panel, and unknown ids answer cleanly', async () => {
  await withServer(async (api) => {
    const { pid, lids } = await contractWithProgramme(api, { reference: 'SGN-27-THREE' });
    const declinedMarket = await addLine(api, lids[0], 'Delta Re', 25);
    await addLine(api, lids[0], 'Alpha Re', 100);
    await api('POST', `/api/layers/${lids[0]}/lines/${declinedMarket}/decline`, { token: broker.token });

    const view = await api('GET', `/api/signing/contracts/${pid}`, { token: broker.token });
    const l1 = view.body.programme[0];
    assert.deepEqual(l1.lines.map((x) => x.market_name), ['Alpha Re']);
    assert.deepEqual(l1.declined.map((x) => x.market_name), ['Delta Re']);
    assert.equal(l1.signing.preview.state, 'EXACT');
    assert.equal(view.body.totals.declined, 1);
    assert.equal(view.body.totals.markets, 1);

    const missing = await api('GET', '/api/signing/contracts/00000000-0000-0000-0000-000000000000', { token: broker.token });
    assert.equal(missing.status, 404);
    const malformed = await api('GET', '/api/signing/contracts/not-a-uuid', { token: broker.token });
    assert.equal(malformed.status, 400);
    const anonymous = await api('GET', '/api/signing/contracts');
    assert.equal(anonymous.status, 401);
  });
});
