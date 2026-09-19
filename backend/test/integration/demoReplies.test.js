// Demo: the underwriters reply — every awaited underwriter answers, in a
// mix of scenarios, recorded and read like any other reply.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { templateReply, scenarioFor } from '../../src/modules/negotiation/demoReplies.js';

let broker;
let senior;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
  uw = await makeUser('underwriter');
});

const STRUCTURES = [
  { basis: 'NP', layers: [{ name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 }], prop: {} },
  { basis: 'PROP', layers: [], prop: { treatyType: 'QS', qsLimit: 4_000_000, commissionPct: 30, epi: 9_000_000 } },
];

async function sentSubmission(api, marketNames) {
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
  await api('POST', '/api/wordings/drafts', { token: broker.token, body: { title: 'Wording', placement_id: pid, cob: 'Property' } });
  const recipients = [];
  for (const name of marketNames) {
    const market = await api('POST', '/api/markets', { token: broker.token, body: { name: `${name} ${Math.random()}` } });
    const contact = await api('POST', `/api/markets/${market.body.id}/contacts`, {
      token: broker.token, body: { name: `UW at ${name}`, email: `${name.toLowerCase().replace(/\s+/g, '')}@example.test`, is_primary: true },
    });
    recipients.push({ market_id: market.body.id, contact_id: contact.body.id });
  }
  const created = await api('POST', `/api/placements/${pid}/negotiation/submissions`, {
    token: broker.token, body: { recipients },
  });
  const id = created.body.id;
  await api('PATCH', `/api/negotiation-submissions/${id}`, { token: broker.token, body: { broker_reviewed: true } });
  await api('POST', `/api/negotiation-submissions/${id}/request-approval`, { token: broker.token, body: {} });
  const released = await api('POST', `/api/negotiation-submissions/${id}/approve`, { token: uw.token, body: {} });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  return { pid, submission: released.body };
}

test('the scenarios cycle across the recipients, so the first always quotes', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => scenarioFor(i)), ['quote', 'question', 'decline', 'acknowledgement', 'quote']);
  assert.equal(scenarioFor(0, 'decline'), 'decline', 'a pinned scenario applies to everyone');
  assert.equal(scenarioFor(3, 'rant'), 'acknowledgement', 'an unknown pin is ignored');
});

test('the template underwriter writes terms from the structures', () => {
  const context = {
    cedant: 'Meridian', class: 'Property Cat XoL', currency: 'USD',
    structures: [
      { structure: 'Structure 1', basis: 'NP', layers: [{ label: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 }] },
      { structure: 'Structure 2', basis: 'PROP', layers: [{ label: 'whole', commissionPct: 30 }] },
    ],
  };
  const quote = templateReply({ scenario: 'quote', recipient: { name: 'Jo', market_name: 'Alpha Re' }, context, subject: 'Pack v1 [BIQ-1]', index: 0 });
  assert.equal(quote.subject, 'RE: Pack v1 [BIQ-1]');
  assert.match(quote.body, /rate on line 8\.64%/, 'a little firmer than the 8% asked');
  assert.match(quote.body, /premium USD 432,000/);
  assert.match(quote.body, /line 10%/);
  assert.match(quote.body, /commission of 27\.5%/);
  assert.match(quote.body, /valid until \d{4}-\d{2}-\d{2}/);
  assert.match(quote.body, /Jo\nAlpha Re$/);
  assert.match(templateReply({ scenario: 'decline', recipient: {}, context, subject: 's' }).body, /unable to support/);
  assert.match(templateReply({ scenario: 'question', recipient: {}, context, subject: 's' }).body, /\?/);
  assert.match(templateReply({ scenario: 'acknowledgement', recipient: {}, context, subject: 's' }).body, /revert with terms/);
});

test('simulating replies answers every awaited underwriter, recorded and read like real ones', async () => {
  await withServer(async (api) => {
    const { pid, submission } = await sentSubmission(api, ['Alpha Re', 'Beta Re', 'Gamma Re', 'Delta Re']);

    const sim = await api('POST', `/api/placements/${pid}/negotiation/replies/simulate`, { token: broker.token, body: {} });
    assert.equal(sim.status, 201, JSON.stringify(sim.body));
    assert.equal(sim.body.awaiting, 4);
    assert.equal(sim.body.replies.length, 4);
    assert.deepEqual(sim.body.replies.map((r) => r.scenario), ['quote', 'question', 'decline', 'acknowledgement']);
    assert.ok(sim.body.replies.every((r) => r.generated_by === 'template'), 'no key in tests');
    assert.ok(sim.body.replies.every((r) => r.source === 'demo'));

    // Read by the usual reader: the scenarios come back as the kinds.
    const list = await api('GET', `/api/placements/${pid}/negotiation/replies`, { token: broker.token });
    assert.equal(list.body.summary.replied, 4);
    assert.equal(list.body.summary.awaiting, 0);
    assert.equal(list.body.summary.quotes, 1);
    assert.equal(list.body.summary.declines, 1);
    assert.equal(list.body.summary.questions, 1);
    // The first reinsurer by name is the first answered, and it quoted.
    const first = list.body.recipients.find((r) => /^Alpha Re/.test(r.market_name));
    assert.equal(first.last_kind, 'quote');
    const quote = list.body.replies.find((r) => r.kind === 'quote');
    assert.ok(quote.ai_read.terms.length >= 1, 'the terms are extracted from the demo reply');
    assert.equal(quote.ai_read.terms[0].rate_pct, 8.64);
    assert.match(quote.subject, new RegExp(`^RE: .*${submission.reference_tag.replace('-', '\\-')}`));

    // Nobody is awaited now, so a second run does nothing; a pinned scenario is refused when unknown.
    const again = await api('POST', `/api/placements/${pid}/negotiation/replies/simulate`, { token: broker.token, body: {} });
    assert.equal(again.body.replies.length, 0);
    assert.equal((await api('POST', `/api/placements/${pid}/negotiation/replies/simulate`, { token: broker.token, body: { only: 'rant' } })).status, 422);
    assert.equal((await api('POST', `/api/placements/${pid}/negotiation/replies/simulate`, { token: uw.token, body: {} })).status, 403);
  });
});

test('a pinned scenario makes everyone answer the same way', async () => {
  await withServer(async (api) => {
    const { pid } = await sentSubmission(api, ['Alpha Re', 'Beta Re']);
    const sim = await api('POST', `/api/placements/${pid}/negotiation/replies/simulate`, { token: broker.token, body: { only: 'decline' } });
    assert.deepEqual(sim.body.replies.map((r) => r.scenario), ['decline', 'decline']);
    const list = await api('GET', `/api/placements/${pid}/negotiation/replies`, { token: broker.token });
    assert.equal(list.body.summary.declines, 2);
  });
});
