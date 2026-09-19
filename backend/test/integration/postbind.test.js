import { issueMdp } from '../../src/modules/mdp/mdp.service.js';
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
 * Build a placement with one XoL layer (2m xs 1m, premium 400k at 100%,
 * brokerage 2.5%, 1 reinstatement @ 100%) carrying an authorised FOT.
 */
async function readyLayer(api, { order = 100 } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'XoL Cedant' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  const layer = await api('POST', `/api/placements/${pid}/layers`, {
    token: broker.token,
    body: {
      name: '2m xs 1m', type: 'XoL', attachment: 1_000_000, limit_amt: 2_000_000,
      order_pct: order, premium100: 400_000, brokerage_pct: 2.5,
      reinstatements: '1', reinstatement_pct: 100, currency: 'USD',
    },
  });
  const lid = layer.body.id;
  for (const status of ['DATA', 'PACK', 'LEAD_MARKETING', 'QUOTED']) {
    await api('POST', `/api/placements/${pid}/transition`, { token: broker.token, body: { status } });
  }
  await api('POST', `/api/layers/${lid}/fot`, { token: broker.token, body: { agreed_terms: {} } });
  await api('POST', `/api/layers/${lid}/fot/authorise`, { token: uw.token });
  return { pid, lid };
}

async function addLine(api, lid, name, written) {
  const m = await api('POST', '/api/markets', { token: broker.token, body: { name } });
  await api('POST', `/api/layers/${lid}/lines`, { token: broker.token, body: { market_id: m.body.id, written_pct: written } });
  return m.body.id;
}

async function bind(api, lid) {
  await api('POST', `/api/layers/${lid}/bind/propose`, { token: broker.token });
  await api('POST', `/api/layers/${lid}/bind/authorise`, { token: uw.token });
}

test('client signing instruction overrides pro-rata and carries brokerage', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const mA = await addLine(api, lid, 'Alpha Re', 60);
    const mB = await addLine(api, lid, 'Beta Re', 60); // 120 written vs order 100

    // The client's instruction deviates from proportional (which would be 50/50).
    const badTotal = await api('POST', `/api/layers/${lid}/signing/instruction`, {
      token: broker.token,
      body: { allocations: [{ market_id: mA, signed_pct: 60 }, { market_id: mB, signed_pct: 30 }] },
    });
    assert.equal(badTotal.status, 409);
    assert.match(badTotal.body.error, /must equal the order/);

    const aboveWritten = await api('POST', `/api/layers/${lid}/signing/instruction`, {
      token: broker.token,
      body: { allocations: [{ market_id: mA, signed_pct: 70 }, { market_id: mB, signed_pct: 30 }] },
    });
    assert.equal(aboveWritten.status, 409);
    assert.match(aboveWritten.body.error, /above its written line/);

    const applied = await api('POST', `/api/layers/${lid}/signing/instruction`, {
      token: broker.token,
      body: { allocations: [{ market_id: mA, signed_pct: 60 }, { market_id: mB, signed_pct: 40 }] },
    });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.state, 'INSTRUCTED');
    assert.equal(applied.body.signedTotal, 100);
    // Brokerage: 2.5% of the signed premium. 60% of 400k = 240k → 6k; 40% → 160k → 4k.
    assert.equal(applied.body.brokerage_total, 10_000);

    const layer = await api('GET', `/api/layers/${lid}`, { token: broker.token });
    assert.equal(layer.body.signing_method, 'client_instruction');

    const alloc = await api('GET', `/api/layers/${lid}/premium-allocation`, { token: broker.token });
    assert.equal(alloc.body.brokerage_total, 10_000);
    const a = alloc.body.lines.find((l) => l.market_id === mA);
    assert.equal(a.signed_pct, 60);
    assert.equal(a.premium_signed, 240_000);
    assert.equal(a.brokerage_amount, 6_000);
  });
});

test('pro-rata signing records brokerage and the signing method', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    await addLine(api, lid, 'A', 60);
    await addLine(api, lid, 'B', 40);
    const applied = await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });
    assert.equal(applied.status, 200);
    // Full order: premium 400k, brokerage 2.5% = 10k in total.
    assert.equal(applied.body.brokerage_total, 10_000);

    const layer = await api('GET', `/api/layers/${lid}`, { token: broker.token });
    assert.equal(layer.body.signing_method, 'pro_rata');

    const dash = await api('GET', '/api/dashboards/brokerage', { token: broker.token });
    assert.equal(dash.body.by_currency.USD.brokerage, 10_000);
    assert.equal(dash.body.layers[0].premium_signed, 400_000);
  });
});

test('direct MDP issue is blocked; historical schedules and settlement remain supported', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    const mA = await addLine(api, lid, 'A', 60);
    await addLine(api, lid, 'B', 40);
    await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });
    await bind(api, lid);

    const blocked = await api('POST', `/api/layers/${lid}/mdp`, {
      token: broker.token, body: { minimum_premium: 320_000, deposit_premium: 360_000, instalments: 4 },
    });
    assert.equal(blocked.status, 409); // All new issuance now uses the four-eyes workspace.
    // Historical schedules remain readable and settleable. Seed one through
    // the legacy engine to retain its allocation and versioning regression.
    const issued = { body: await issueMdp(lid, { minimum_premium: 320_000, deposit_premium: 360_000, instalments: 4 }, broker.user.id) };
    assert.equal(issued.body.schedule.length, 4);
    assert.equal(issued.body.schedule[0].due_date, '2026-01-01'); // defaults to inception
    assert.equal(issued.body.schedule[1].due_date, '2026-04-01'); // quarterly
    // 2 markets × 4 instalments.
    assert.equal(issued.body.notes.length, 8);

    // Market A signs 60%: each instalment 90k → gross 54k, brokerage 2.5% = 1,350, net 52,650.
    const noteA1 = issued.body.notes.find((n) => n.market_id === mA && n.instalment_no === 1);
    assert.equal(Number(noteA1.gross_amount), 54_000);
    assert.equal(Number(noteA1.brokerage_amount), 1_350);
    assert.equal(Number(noteA1.net_amount), 52_650);

    // Gross across all notes reconciles to the deposit premium.
    const grossTotal = issued.body.notes.reduce((a, n) => a + Number(n.gross_amount), 0);
    assert.equal(Math.round(grossTotal * 100) / 100, 360_000);

    // pending → sent → paid; paid before sent is rejected.
    const early = await api('POST', `/api/mdp-notes/${noteA1.id}/status`, { token: broker.token, body: { status: 'paid' } });
    assert.equal(early.status, 409);
    const sent = await api('POST', `/api/mdp-notes/${noteA1.id}/status`, { token: broker.token, body: { status: 'sent' } });
    assert.equal(sent.body.status, 'sent');
    const paid = await api('POST', `/api/mdp-notes/${noteA1.id}/status`, { token: broker.token, body: { status: 'paid' } });
    assert.equal(paid.body.status, 'paid');

    // The schedule document landed in the worklist.
    const layer = await api('GET', `/api/layers/${lid}`, { token: broker.token });
    const docs = await api('GET', `/api/placements/${layer.body.placement_id}/documents`, { token: broker.token });
    assert.ok(docs.body.some((d) => d.type === 'mdp_schedule'));

    // Reissue supersedes: the active MDP is version 2.
    await issueMdp(lid, { minimum_premium: 320_000, deposit_premium: 360_000, instalments: 2 }, broker.user.id);
    const current = await api('GET', `/api/layers/${lid}/mdp`, { token: broker.token });
    assert.equal(current.body.mdp.version, 2);
    assert.equal(current.body.history.length, 2);
    assert.equal(current.body.notes.length, 4); // 2 markets × 2 instalments
  });
});

test('MDP is rejected on an unsigned layer', async () => {
  await withServer(async (api) => {
    const { lid } = await readyLayer(api);
    await addLine(api, lid, 'A', 100);
    // Not signed yet.
    const early = await api('POST', `/api/layers/${lid}/mdp`, {
      token: broker.token, body: { minimum_premium: 1, deposit_premium: 1 },
    });
    assert.equal(early.status, 409);
  });
});

test('loss event: recovery, market shares and reinstatement premium; aggregate erodes', async () => {
  await withServer(async (api) => {
    const { pid, lid } = await readyLayer(api);
    const mA = await addLine(api, lid, 'A', 60);
    await addLine(api, lid, 'B', 40);
    await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });

    // No losses before bind.
    const early = await api('POST', `/api/placements/${pid}/losses`, {
      token: broker.token, body: { name: 'Too early', loss_date: '2026-02-01', gross_loss: 1 },
    });
    assert.equal(early.status, 409);

    await bind(api, lid);

    // Loss 1: 2.5m gross → 1.5m into 2m xs 1m. RIP = (1.5m/2m)×400k = 300k.
    const loss1 = await api('POST', `/api/placements/${pid}/losses`, {
      token: broker.token,
      body: { name: 'Warehouse fire', loss_date: '2026-03-10', gross_loss: 2_500_000 },
    });
    assert.equal(loss1.status, 201);
    const calc1 = await api('POST', `/api/losses/${loss1.body.id}/calculate`, { token: broker.token });
    assert.equal(calc1.status, 200);
    assert.equal(calc1.body.status, 'advised');
    const rec1 = calc1.body.recoveries[0];
    assert.equal(Number(rec1.loss_to_layer), 1_500_000);
    assert.equal(Number(rec1.reinstatement_premium), 300_000);
    // Market A (60%) owes 900k recovery and receives 180k RIP.
    const shareA = rec1.detail.markets.find((m) => m.market_id === mA);
    assert.equal(shareA.recovery, 900_000);
    assert.equal(shareA.reinstatement_premium, 180_000);

    // Loss 2 (later date): full-limit loss. Reinstatement capacity left: 500k.
    const loss2 = await api('POST', `/api/placements/${pid}/losses`, {
      token: broker.token,
      body: { name: 'Cat 26A', loss_date: '2026-08-01', gross_loss: 5_000_000, cat_event: true },
    });
    const calc2 = await api('POST', `/api/losses/${loss2.body.id}/calculate`, { token: broker.token });
    const rec2 = calc2.body.recoveries[0];
    assert.equal(Number(rec2.loss_to_layer), 2_000_000);
    // RIP only on the remaining 500k of reinstatement capacity: (500k/2m)×400k = 100k.
    assert.equal(Number(rec2.reinstatement_premium), 100_000);
    assert.equal(rec2.detail.remaining_aggregate, 500_000);

    // Loss advice documents were issued.
    const docs = await api('GET', `/api/placements/${pid}/documents`, { token: broker.token });
    assert.equal(docs.body.filter((d) => d.type === 'loss_advice').length, 2);

    // Settle after advice; a second settle is rejected.
    const settled = await api('POST', `/api/losses/${loss1.body.id}/settle`, { token: broker.token });
    assert.equal(settled.body.status, 'settled');
    const again = await api('POST', `/api/losses/${loss1.body.id}/settle`, { token: broker.token });
    assert.equal(again.status, 409);

    const listed = await api('GET', `/api/placements/${pid}/losses`, { token: broker.token });
    assert.equal(listed.body.length, 2);
    assert.equal(listed.body[0].recoveries.length, 1);
  });
});

test('editing a loss event voids its advice and requires recalculation', async () => {
  await withServer(async (api) => {
    const { pid, lid } = await readyLayer(api);
    await addLine(api, lid, 'A', 100);
    await api('POST', `/api/layers/${lid}/signing/apply`, { token: broker.token, body: {} });
    await bind(api, lid);

    const loss = await api('POST', `/api/placements/${pid}/losses`, {
      token: broker.token, body: { name: 'Flood', loss_date: '2026-05-05', gross_loss: 1_200_000 },
    });
    await api('POST', `/api/losses/${loss.body.id}/calculate`, { token: broker.token });

    const updated = await api('PATCH', `/api/losses/${loss.body.id}`, {
      token: broker.token, body: { gross_loss: 1_800_000 },
    });
    assert.equal(updated.body.status, 'open');

    const detail = await api('GET', `/api/losses/${loss.body.id}`, { token: broker.token });
    assert.equal(detail.body.recoveries.length, 0);

    const recalc = await api('POST', `/api/losses/${loss.body.id}/calculate`, { token: broker.token });
    assert.equal(Number(recalc.body.recoveries[0].loss_to_layer), 800_000);
  });
});

