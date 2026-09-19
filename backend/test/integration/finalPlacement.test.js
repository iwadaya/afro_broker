// Final placement: the final terms (from the negotiation's quotes when we
// lead, entered when another broker does), the firm order terms email, the
// written lines signed down to the order, and the confirmations.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox, readOutbox } from '../../src/integrations/mailer.js';

let broker;
let senior;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  clearOutbox();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
  uw = await makeUser('underwriter');
});

const STRUCTURES = [
  { basis: 'NP', layers: [
    { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 },
    { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
  ], prop: {} },
  { basis: 'PROP', layers: [], prop: { treatyType: 'QS', qsLimit: 4_000_000, commissionPct: 30, epi: 9_000_000 } },
];

/** A placement negotiated with two markets: Alpha quoted every line, Beta quoted Layer 1 and declined Layer 2. */
async function negotiated(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: `Meridian ${Math.random()}` } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
  });
  const pid = placement.body.id;
  await api('PATCH', `/api/placements/${pid}`, { token: broker.token, body: { quote_structures: STRUCTURES } });
  const pack = (await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} })).body;
  await api('POST', `/api/packs/${pack.id}/submit`, { token: broker.token, body: {} });
  await api('POST', `/api/packs/${pack.id}/approve`, { token: senior.token, body: {} });

  const markets = {};
  for (const [name, person, email] of [['Alpha Re', 'Jo Smith', 'jo@alpha.test'], ['Beta Re', 'Anders Vik', 'anders@beta.test']]) {
    const m = await api('POST', '/api/markets', { token: broker.token, body: { name: `${name} ${Math.random()}` } });
    const c = await api('POST', `/api/markets/${m.body.id}/contacts`, { token: broker.token, body: { name: person, email, is_primary: true } });
    markets[name] = { id: m.body.id, name: m.body.name, contact_id: c.body.id, email };
  }
  const sent = await api('POST', `/api/placements/${pid}/negotiation/send`, {
    token: broker.token, body: { market_ids: [markets['Alpha Re'].id, markets['Beta Re'].id] },
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const negotiationOf = (marketId) => sent.body.markets.find((m) => m.market_id === marketId).id;

  const quote = (marketId, body) => api('PUT', `/api/negotiations/${negotiationOf(marketId)}/quotes`, { token: broker.token, body });
  const alpha = markets['Alpha Re'].id;
  const beta = markets['Beta Re'].id;
  const q = {};
  q.alphaL1 = (await quote(alpha, { structure_index: 1, layer_index: 0, premium: 432_000, rate_pct: 8.64, line_pct: 25 })).body;
  q.alphaL2 = (await quote(alpha, { structure_index: 1, layer_index: 1, premium: 270_000, line_pct: 25 })).body;
  q.alphaQs = (await quote(alpha, { structure_index: 2, layer_index: null, commission_pct: 27.5, line_pct: 15 })).body;
  q.betaL1 = (await quote(beta, { structure_index: 1, layer_index: 0, premium: 450_000, line_pct: 20 })).body;
  q.betaL2 = (await quote(beta, { structure_index: 1, layer_index: 1, status: 'declined' })).body;
  for (const [k, v] of Object.entries(q)) assert.ok(v.id, `${k}: ${JSON.stringify(v)}`);
  return { pid, pack, markets, q };
}

test('the tab offers every line of the structures with the quotes captured against it', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await negotiated(api);
    const res = await api('GET', `/api/placements/${pid}/final`, { token: broker.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.final.status, 'draft');
    assert.equal(res.body.final.lead_won, true);
    assert.equal(res.body.final.lead_broker, 'Afro-Asian Insurance Services');
    assert.deepEqual(res.body.candidates.map((c) => c.key), ['s1:l0', 's1:l1', 's2:whole']);
    const l1 = res.body.candidates[0];
    assert.equal(l1.label, 'Layer 1');
    assert.equal(l1.quotes.length, 2);
    assert.equal(l1.quotes[0].kind, 'lead', 'a quote is a lead quote unless captured as an indication');
    assert.equal(l1.quotes[0].premium, 432000);
    assert.equal(res.body.candidates[1].quotes.find((x) => x.market_id === markets['Beta Re'].id).status, 'declined');
    assert.equal(res.body.pack.version, 1);
    assert.ok(res.body.markets.find((m) => m.market_id === markets['Alpha Re'].id).on_negotiation);
    assert.equal(res.body.markets.find((m) => m.market_id === markets['Alpha Re'].id).contacts.length, 1);
  });
});

test('we won the lead: the final terms are the quotes ticked, the lead reinsurer follows from them', async () => {
  await withServer(async (api) => {
    const { pid, markets, q } = await negotiated(api);
    const saved = await api('PUT', `/api/placements/${pid}/final`, {
      token: broker.token,
      body: { lead_won: true, terms: [{ key: 's1:l0', quote_id: q.alphaL1.id }, { key: 's1:l1', quote_id: q.alphaL2.id }, { key: 's2:whole', quote_id: q.alphaQs.id }] },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const f = saved.body.final;
    assert.equal(f.lead_broker, 'Afro-Asian Insurance Services');
    assert.equal(f.lead_reinsurer_id, markets['Alpha Re'].id, 'the lead reinsurer is the market whose terms were taken');
    assert.equal(f.lead_reinsurer_name, markets['Alpha Re'].name);
    assert.equal(f.terms.length, 3);
    assert.equal(f.terms[0].premium, 432000, 'the terms are re-read from the quote');
    assert.equal(f.terms[0].rate_pct, 8.64);
    assert.equal(f.terms[0].limit, 5000000);
    assert.equal(f.terms[0].source, 'quote');
    assert.equal(f.terms[2].commission_pct, 27.5);
    assert.equal(f.terms[2].basis, 'PROP');

    // A decline cannot be the final terms; an unknown line is refused.
    assert.equal((await api('PUT', `/api/placements/${pid}/final`, { token: broker.token, body: { terms: [{ key: 's1:l1', quote_id: q.betaL2.id }] } })).status, 422);
    assert.equal((await api('PUT', `/api/placements/${pid}/final`, { token: broker.token, body: { terms: [{ key: 's9:l0', premium: 1 }] } })).status, 422);
    assert.equal((await api('PUT', `/api/placements/${pid}/final`, { token: uw.token, body: {} })).status, 403);
  });
});

test('another broker leads: the terms are entered with the type of treaty, and the lead is captured', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await negotiated(api);
    const saved = await api('PUT', `/api/placements/${pid}/final`, {
      token: broker.token,
      body: {
        lead_won: false, lead_broker: 'Rival Re Brokers', lead_reinsurer_id: markets['Beta Re'].id, treaty_type: 'Cat XL',
        terms: [{ key: 's1:l0', premium: 440000, rate_pct: 8.8 }, { key: 's1:l1', premium: 260000 }],
        notes: 'Following the lead terms set by Rival.',
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const f = saved.body.final;
    assert.equal(f.lead_won, false);
    assert.equal(f.lead_broker, 'Rival Re Brokers');
    assert.equal(f.lead_reinsurer_name, markets['Beta Re'].name);
    assert.equal(f.treaty_type, 'Cat XL');
    assert.equal(f.terms[0].source, 'entered');
    assert.equal(f.terms[0].premium, 440000);
    assert.equal(f.terms[0].limit, 5000000, 'limit and attachment come from the structure');
    assert.equal((await api('PUT', `/api/placements/${pid}/final`, { token: broker.token, body: { lead_won: false, terms: [] } })).status, 422, 'the lead broker must be named');
  });
});

test('the firm order terms go to the chosen underwriters with the pack, then lines are written, signed down and confirmed', async () => {
  await withServer(async (api) => {
    const { pid, markets, q } = await negotiated(api);
    await api('PUT', `/api/placements/${pid}/final`, {
      token: broker.token, body: { terms: [{ key: 's1:l0', quote_id: q.alphaL1.id }, { key: 's1:l1', quote_id: q.alphaL2.id }] },
    });

    const draft = await api('GET', `/api/placements/${pid}/final/email-draft`, { token: broker.token });
    assert.equal(draft.status, 200);
    assert.match(draft.body.subject, /^Firm order terms — Meridian/);
    assert.match(draft.body.body, /Layer 1: USD 5,000,000 xs USD 1,000,000, premium USD 432,000, rate 8.64%/);
    assert.match(draft.body.body, new RegExp(`led by ${markets['Alpha Re'].name}`));
    assert.match(draft.body.body, /Renewal pack v1/);
    assert.equal(draft.body.attach_pack, true);

    const sent = await api('POST', `/api/placements/${pid}/final/emails`, {
      token: broker.token,
      body: {
        kind: 'fot',
        recipients: [
          { market_id: markets['Alpha Re'].id, contact_id: markets['Alpha Re'].contact_id },
          { market_id: markets['Beta Re'].id, contact_id: markets['Beta Re'].contact_id },
        ],
        subject: draft.body.subject, body: draft.body.body,
      },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.email.kind, 'fot');
    assert.equal(sent.body.email.delivered, 2);
    assert.equal(sent.body.final.status, 'fot_sent');
    const outbox = readOutbox();
    assert.equal(outbox.length, 2);
    assert.match(outbox[0].text, /Dear Jo Smith/);
    assert.equal(outbox[0].attachments.length, 2, 'the pack rides along as its Excel and its PDF');
    assert.match(outbox[0].attachments[0].filename, /RenewalPack_v1.*\.xlsx$/);
    assert.match(outbox[0].attachments[1].filename, /RenewalPack_v1.*\.pdf$/);
    clearOutbox();

    // Written lines: Layer 1 oversubscribed (60 + 60), Layer 2 short (50).
    const lines = await api('PUT', `/api/placements/${pid}/final/lines`, {
      token: broker.token,
      body: { lines: [
        { market_id: markets['Alpha Re'].id, term_key: 's1:l0', written_pct: 60, contact_id: markets['Alpha Re'].contact_id },
        { market_id: markets['Beta Re'].id, term_key: 's1:l0', written_pct: 60 },
        { market_id: markets['Alpha Re'].id, term_key: 's1:l1', written_pct: 50 },
      ] },
    });
    assert.equal(lines.status, 200, JSON.stringify(lines.body));
    assert.equal(lines.body.lines.length, 3);
    const l1 = lines.body.signing['s1:l0'];
    assert.equal(l1.state, 'OVERSUBSCRIBED');
    assert.equal(l1.written_total, 120);
    assert.equal(l1.signed_total, 100);
    assert.equal(l1.signing_factor, 0.8333, 'the factor as the signing engine rounds it');
    for (const l of lines.body.lines.filter((x) => x.term_key === 's1:l0')) assert.equal(l.signed_pct, 50, 'signed down pro rata');
    const l2 = lines.body.signing['s1:l1'];
    assert.equal(l2.state, 'UNDERSUBSCRIBED');
    assert.equal(l2.shortfall, 50);
    assert.equal(lines.body.lines.find((x) => x.term_key === 's1:l1').signed_pct, 50);
    assert.equal((await api('PUT', `/api/placements/${pid}/final/lines`, { token: broker.token, body: { lines: [{ market_id: markets['Alpha Re'].id, term_key: 's9:l0', written_pct: 1 }] } })).status, 422);

    // A to-stand line keeps its written share; the other signs down for it.
    const stand = await api('PUT', `/api/placements/${pid}/final/lines`, {
      token: broker.token,
      body: { lines: [{ market_id: markets['Alpha Re'].id, term_key: 's1:l0', written_pct: 60, to_stand: true }] },
    });
    assert.equal(stand.body.lines.find((x) => x.term_key === 's1:l0' && x.market_id === markets['Alpha Re'].id).signed_pct, 60);
    assert.equal(stand.body.lines.find((x) => x.term_key === 's1:l0' && x.market_id === markets['Beta Re'].id).signed_pct, 40);

    // Confirm: lines signed, placement confirmed, each underwriter told their lines.
    const confirmed = await api('POST', `/api/placements/${pid}/final/confirm`, { token: broker.token, body: {} });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(confirmed.body.final.status, 'confirmed');
    assert.ok(confirmed.body.lines.every((l) => l.status === 'signed'));
    assert.equal(confirmed.body.email.kind, 'confirmation');
    assert.equal(confirmed.body.email.delivered, 2);
    const mails = readOutbox();
    const toJo = mails.find((m) => m.to.includes('jo@alpha.test'));
    assert.match(toJo.text, /Layer 1: written 60%, signed 60%/);
    assert.match(toJo.text, /Layer 2: written 50%, signed 50%/);
    const toAnders = mails.find((m) => m.to.includes('anders@beta.test'));
    assert.match(toAnders.text, /Layer 1: written 60%, signed 40%/);
    assert.doesNotMatch(toAnders.text, /Layer 2: written/, 'only their own lines are confirmed');
    assert.match(toAnders.text, new RegExp(`signed to ${markets['Beta Re'].name}`));

    // Frozen once confirmed.
    assert.equal((await api('POST', `/api/placements/${pid}/final/confirm`, { token: broker.token, body: {} })).status, 409);
    assert.equal((await api('PUT', `/api/placements/${pid}/final/lines`, { token: broker.token, body: { lines: [] } })).status, 409);
    assert.equal((await api('PUT', `/api/placements/${pid}/final`, { token: broker.token, body: {} })).status, 409);
    const emails = (await api('GET', `/api/placements/${pid}/final`, { token: broker.token })).body.emails;
    assert.deepEqual(emails.map((e) => e.kind), ['confirmation', 'fot']);
  });
});

test('nothing goes out or is written before the final terms are saved', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await negotiated(api);
    assert.equal((await api('GET', `/api/placements/${pid}/final/email-draft`, { token: broker.token })).status, 409);
    assert.equal((await api('POST', `/api/placements/${pid}/final/emails`, { token: broker.token, body: { recipients: [{ market_id: markets['Alpha Re'].id, contact_id: markets['Alpha Re'].contact_id }] } })).status, 409);
    assert.equal((await api('PUT', `/api/placements/${pid}/final/lines`, { token: broker.token, body: { lines: [] } })).status, 409);
    assert.equal((await api('POST', `/api/placements/${pid}/final/confirm`, { token: broker.token, body: {} })).status, 409);
  });
});
