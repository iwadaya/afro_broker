// Claim-notification intake: an inbound loss advice is read and matched;
// loading it creates the loss event, runs the calculation and issues the
// preliminary advice to every market with a signed line on any layer —
// once per market, once per notification.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox, readOutbox } from '../../src/integrations/mailer.js';

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
  await api('POST', `/api/layers/${layerId}/fot`, { token: broker.token, body: { agreed_terms: { order_pct: 100 } } });
  await api('POST', `/api/layers/${layerId}/fot/authorise`, { token: uw.token });
}

/** A signed two-layer XoL placement: Alpha on both layers, Beta on the first, Gamma declined. */
async function signedPlacement(api, { reference = 'KE-RXL-2027' } = {}) {
  const alpha = await market(api, 'Alpha Re', 'Ann Alpha');
  const beta = await market(api, 'Beta Re', 'Ben Beta');
  const gamma = await market(api, 'Gamma Re', 'Gil Gamma');
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Kenya Reinsurance Corporation' } });
  const placement = (await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, reference, class: 'Property Risk XL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
  })).body;
  const { rows: [l1, l2] } = await pool.query(
    `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, currency, premium100, position, reinstatements, reinstatement_pct) VALUES
       ($1, 'Layer 1', 'XoL', 2500000, 2500000, 'USD', 1650000, 1, '1', 100),
       ($1, 'Layer 2', 'XoL', 5000000, 5000000, 'USD', 1120000, 2, '1', 100)
     RETURNING id`,
    [placement.id],
  );
  for (const l of [l1, l2]) await fot(api, l.id);
  await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: alpha.id, written_pct: 60 } });
  await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: beta.id, written_pct: 60 } });
  await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: gamma.id, written_pct: 0 } });
  await api('POST', `/api/layers/${l1.id}/lines/${gamma.id}/decline`, { token: broker.token });
  await api('POST', `/api/layers/${l2.id}/lines`, { token: broker.token, body: { market_id: alpha.id, written_pct: 100 } });
  await api('POST', `/api/layers/${l1.id}/signing/apply`, { token: broker.token, body: {} });
  await api('POST', `/api/layers/${l2.id}/signing/apply`, { token: broker.token, body: {} });
  return { placement, l1, l2, alpha, beta, gamma };
}

const NOTICE = {
  source: 'cedant_claims_inbox',
  message_id: '<advice-0091@kenyare.co.ke>',
  sender: 'j.kariuki@kenyare.co.ke',
  subject: 'Loss advice — Eldoret Textile Mills — Risk XL 2027 — reserve USD 4.0m',
  body: [
    'Treaty reference: KE-RXL-2027',
    'Claim reference: KR/CL/2027/0091',
    'Insured: Eldoret Textile Mills',
    'Date of loss: 02 September 2027',
    'Cause: Fire — carding hall',
    'Advised reserve: USD 4,000,000',
  ].join('\n'),
};

test('notification → load → preliminary advice to the whole signed panel, once; then the claim advice with each share', async () => {
  await withServer(async (api) => {
    const { placement, alpha, beta } = await signedPlacement(api);

    // Ingest: read (no provider in tests — the keyword read), matched on the treaty reference.
    const ingested = await api('POST', '/api/claim-notifications/ingest', { token: broker.token, body: NOTICE });
    assert.equal(ingested.status, 201, JSON.stringify(ingested.body));
    const n = ingested.body.notification;
    assert.equal(n.status, 'matched');
    assert.equal(n.placement_id, placement.id);
    assert.equal(n.placement_reference, 'KE-RXL-2027');
    assert.equal(n.match_basis, 'treaty reference and date of loss');
    assert.ok(Number(n.match_confidence) >= 0.9);
    assert.equal(n.parsed.insured, 'Eldoret Textile Mills');
    assert.equal(n.parsed.advised_reserve, 4000000);
    assert.equal(n.parsed.source, 'fallback');

    // The same message again is the same notification.
    const again = await api('POST', '/api/claim-notifications/ingest', { token: broker.token, body: NOTICE });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.notification.id, n.id);

    // Load: the loss event from the parsed fields, calculated, and the PLA to every market with a
    // signed line on any layer — Alpha once though it is on two layers, Beta, never Gamma.
    const loaded = await api('POST', `/api/claim-notifications/${n.id}/load`, { token: broker.token, body: {} });
    assert.equal(loaded.status, 201, JSON.stringify(loaded.body));
    assert.equal(loaded.body.notification.status, 'loaded');
    const event = loaded.body.loss_event;
    assert.equal(event.insured, 'Eldoret Textile Mills');
    assert.equal(event.reference, 'KR/CL/2027/0091');
    assert.equal(String(event.loss_date).slice(0, 10), '2027-09-02');
    assert.equal(Number(event.gross_loss), 4000000);
    assert.equal(event.status, 'advised');
    // 4.0m gross: 1.5m into Layer 1 (2.5m xs 2.5m), nothing into Layer 2. RIP on L1 = 1.5/2.5 × 1.65m.
    assert.equal(event.settlement.ladder.gross_to_layer, 1500000);
    assert.equal(event.settlement.ladder.reinstatement_premium, 990000);
    assert.equal(event.settlement.ladder.attaching_layer.name, 'Layer 1');
    assert.deepEqual(event.settlement.markets.map((m) => [m.market_name, m.gross, m.reinstatement_premium]), [['Alpha Re', 750000, 495000], ['Beta Re', 750000, 495000]]);
    const pla = loaded.body.advice;
    assert.equal(pla.kind, 'preliminary');
    assert.equal(pla.delivered, 2);
    assert.deepEqual(pla.recipients.map((r) => r.market_name).sort(), ['Alpha Re', 'Beta Re']);
    let outbox = readOutbox();
    assert.equal(outbox.length, 2, 'one PLA per market, the two-layer market once');
    assert.match(outbox[0].subject, /^PRELIMINARY LOSS ADVICE — KE-RXL-2027 — KR\/CL\/2027\/0091 — Eldoret Textile Mills/);
    assert.match(outbox[0].text, /No payment is requested at this stage/);
    assert.match(outbox[0].text, /Reserve advised\s+USD 4,000,000\.00/);

    // Idempotent: a second load makes nothing and sends nothing.
    const reload = await api('POST', `/api/claim-notifications/${n.id}/load`, { token: broker.token, body: {} });
    assert.equal(reload.status, 200);
    assert.equal(reload.body.already, true);
    assert.equal(reload.body.loss_event.id, event.id);
    assert.equal(readOutbox().length, 2);
    const { rows: events } = await pool.query('SELECT COUNT(*)::int AS n FROM loss_event WHERE placement_id = $1', [placement.id]);
    assert.equal(events[0].n, 1);

    // The workspace: the ladder's inputs PATCH the event and re-calculate; the waiver is honoured.
    const edited = await api('PATCH', `/api/losses/${event.id}`, { token: broker.token, body: { lae: 30000, salvage: 10000, cash_funded: 200000 } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const recalculated = await api('POST', `/api/losses/${event.id}/calculate`, { token: broker.token });
    assert.equal(recalculated.status, 200, JSON.stringify(recalculated.body));
    assert.equal(recalculated.body.settlement.ladder.net_due, 1500000 + 30000 - 10000 - 990000 - 200000);
    await api('PATCH', `/api/losses/${event.id}`, { token: broker.token, body: { waive_reinstatement: true } });
    const waived = await api('POST', `/api/losses/${event.id}/calculate`, { token: broker.token });
    assert.equal(waived.body.settlement.ladder.reinstatement_premium, 0);
    assert.equal(waived.body.settlement.ladder.net_due, 1500000 + 30000 - 10000 - 200000);
    const read = await api('GET', `/api/losses/${event.id}`, { token: broker.token });
    assert.equal(read.body.settlement.ladder.reinstatement_waived, true);
    assert.equal(read.body.settlement.markets.find((m) => m.market_name === 'Alpha Re').net_due, 750000 + 15000 - 5000 - 100000);

    // The loss-advice document carries the full breakdown.
    const { rows: docs } = await pool.query(
      `SELECT content FROM document WHERE placement_id = $1 AND type = 'loss_advice' ORDER BY version DESC LIMIT 1`, [placement.id],
    );
    assert.equal(docs[0].content.settlement.ladder.net_due, 1320000);
    assert.equal(docs[0].content.settlement.markets.length, 2);

    // The claim advice: one template, each market's own share merged in.
    const draft = await api('GET', `/api/losses/${event.id}/advice-draft`, { token: broker.token });
    assert.match(draft.body.subject, /^CLAIM ADVICE — KE-RXL-2027 — KR\/CL\/2027\/0091/);
    assert.match(draft.body.body, /\{\{schedule\}\}/);
    assert.match(draft.body.body, /Less reinstatement premium\s+waived/);
    const advised = await api('POST', `/api/losses/${event.id}/claim-advice`, { token: broker.token, body: { body: `${draft.body.body}\n\nP.S.` } });
    assert.equal(advised.status, 201, JSON.stringify(advised.body));
    assert.equal(advised.body.delivered, 2);
    outbox = readOutbox();
    assert.equal(outbox.length, 4);
    const toAlpha = outbox.find((m) => m.to.startsWith('Ann Alpha') && /CLAIM ADVICE/.test(m.subject));
    const toBeta = outbox.find((m) => m.to.startsWith('Ben Beta') && /CLAIM ADVICE/.test(m.subject));
    assert.match(toAlpha.text, /YOUR SHARE — Alpha Re/);
    assert.match(toAlpha.text, /Share of gross loss to layer\s+USD 750,000\.00/);
    assert.match(toAlpha.text, /Net amount due\s+USD 660,000\.00/);
    assert.match(toAlpha.text, /Reinstatement premium offset\s+waived/);
    assert.match(toAlpha.text, /no separate reinstatement invoice will follow/);
    assert.doesNotMatch(toAlpha.text, /Beta Re/, 'no market sees another\'s share');
    assert.match(toBeta.text, /YOUR SHARE — Beta Re/);
    const advicesList = await api('GET', `/api/losses/${event.id}/advices`, { token: broker.token });
    assert.deepEqual(advicesList.body.map((a) => a.kind), ['claim', 'preliminary']);
    assert.equal(advicesList.body[0].recipients[0].share.net_due, 660000);

    // Audited per recipient, on the loss event and the notification.
    const { rows: audits } = await pool.query(
      `SELECT action FROM audit_event WHERE entity_type IN ('loss_event', 'claim_notification') AND action LIKE '%advice%' OR action IN ('ingest', 'load') ORDER BY created_at, id`,
    );
    const actions = audits.map((r) => r.action);
    assert.equal(actions.filter((a) => a === 'preliminary_advice_recipient').length, 2);
    assert.equal(actions.filter((a) => a === 'claim_advice_recipient').length, 2);
    assert.ok(actions.includes('ingest') && actions.includes('load'));

    // The PLA can be re-issued from the workspace, explicitly.
    const resent = await api('POST', `/api/losses/${event.id}/preliminary-advice`, { token: broker.token, body: {} });
    assert.equal(resent.status, 201);
    assert.equal(readOutbox().length, 6);
    assert.equal(alpha.id !== beta.id, true);
  });
});

test('a low-confidence notice waits for triage: matched by the broker, or parked', async () => {
  await withServer(async (api) => {
    const { placement } = await signedPlacement(api);
    const vague = await api('POST', '/api/claim-notifications/ingest', {
      token: broker.token,
      body: { source: 'broker_claims_inbox', body: 'Cedant: Kenya Reinsurance Corporation\nDate of loss: 12 March 2027\nWe will revert with particulars.' },
    });
    assert.equal(vague.status, 201);
    const n = vague.body.notification;
    assert.equal(n.status, 'unmatched', 'cedant and period alone is not enough');
    assert.equal(n.placement_id, null);
    assert.equal(n.parsed.suggestion.reference, 'KE-RXL-2027', 'the best candidate is kept for triage');
    assert.equal(n.parsed.suggestion.basis, 'cedant and period');

    // Unmatched: nothing loads.
    const refused = await api('POST', `/api/claim-notifications/${n.id}/load`, { token: broker.token, body: {} });
    assert.equal(refused.status, 409);
    assert.equal(readOutbox().length, 0);

    // Parked for triage, then matched by the broker, then loadable.
    const parked = await api('POST', `/api/claim-notifications/${n.id}/park`, { token: broker.token, body: { notes: 'Ask the cedant for the reference' } });
    assert.equal(parked.body.status, 'parked');
    assert.equal(parked.body.notes, 'Ask the cedant for the reference');
    const list = await api('GET', '/api/claim-notifications?status=parked', { token: broker.token });
    assert.deepEqual(list.body.map((x) => x.id), [n.id]);
    const matched = await api('POST', `/api/claim-notifications/${n.id}/match`, { token: broker.token, body: { placement_id: placement.id } });
    assert.equal(matched.body.status, 'matched');
    assert.equal(matched.body.match_basis, 'broker');
    const loaded = await api('POST', `/api/claim-notifications/${n.id}/load`, { token: broker.token, body: {} });
    assert.equal(loaded.status, 201, JSON.stringify(loaded.body));
    assert.equal(Number(loaded.body.loss_event.gross_loss), 0, 'no reserve was advised — none is invented');
    assert.equal(readOutbox().length, 2, 'the PLA still goes to the whole signed panel');

    // An underwriter reads but does not load.
    const denied = await api('POST', `/api/claim-notifications/${n.id}/park`, { token: uw.token, body: {} });
    assert.equal(denied.status, 403);
  });
});

test('the desk read model: contracts by reference, and the tab context with the loaded claim', async () => {
  await withServer(async (api) => {
    const { placement } = await signedPlacement(api);
    const ingested = await api('POST', '/api/claim-notifications/ingest', { token: broker.token, body: NOTICE });
    await api('POST', `/api/claim-notifications/${ingested.body.notification.id}/load`, { token: broker.token, body: {} });

    const found = await api('GET', '/api/claims/contracts?q=ke-rxl', { token: broker.token });
    assert.equal(found.status, 200);
    assert.deepEqual(found.body.map((c) => [c.reference, c.cedant, c.structure, c.sections.label]),
      [['KE-RXL-2027', 'Kenya Reinsurance Corporation', '2 excess layers', 'Non-proportional only']]);
    const none = await api('GET', '/api/claims/contracts?q=nothing-like-this', { token: broker.token });
    assert.deepEqual(none.body, []);

    const ctx = await api('GET', `/api/claims/contracts/${placement.id}`, { token: broker.token });
    assert.equal(ctx.status, 200, JSON.stringify(ctx.body));
    assert.equal(ctx.body.basis, 'np');
    assert.equal(ctx.body.written_as, 'excess of loss only');
    assert.equal(ctx.body.p, null, 'no proportional section, no bordereaux side');
    assert.equal(ctx.body.contract.period, '2027-01-01 – 2027-12-31');
    assert.equal(ctx.body.np.panel_size, 2);
    assert.equal(ctx.body.np.notifications.length, 0, 'a loaded notice leaves the inbox card');
    assert.equal(ctx.body.np.inbox.length, 3);
    const [row] = ctx.body.np.advices;
    assert.equal(row.reference, 'KR/CL/2027/0091');
    assert.equal(row.insured, 'Eldoret Textile Mills');
    assert.equal(row.layer, 'Layer 1');
    assert.equal(row.erosion_pct, 60);
    assert.equal(row.incurred, 4000000);
    assert.equal(row.gross_to_layer, 1500000);
    assert.equal(row.cash_status, 'PLA sent');
    assert.equal(row.pla_sent, true);
    assert.equal(row.advice_sent, false);
    assert.equal(ctx.body.np.kpis.open, 1);
    assert.equal(ctx.body.np.kpis.incurred_to_layers, 1500000);
    assert.deepEqual(ctx.body.np.kpis.layers_reached, ['Layer 1']);

    const missing = await api('GET', '/api/claims/contracts/00000000-0000-0000-0000-000000000000', { token: broker.token });
    assert.equal(missing.status, 404);
  });
});
