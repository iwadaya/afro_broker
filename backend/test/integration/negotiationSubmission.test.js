// Taking the pack to market: underwriter addresses, the drafted covering email
// the broker must read, and the second pair of eyes that releases it.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox, readOutbox } from '../../src/integrations/mailer.js';

let broker;
let senior;
let uw;
let admin;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  clearOutbox();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
  uw = await makeUser('underwriter');
  admin = await makeUser('admin');
});

/** The approval trail: the broker submits, the Senior Broker approves. */
async function approvePack(api, id) {
  await api('POST', `/api/packs/${id}/submit`, { token: broker.token, body: {} });
  const res = await api('POST', `/api/packs/${id}/approve`, { token: senior.token, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const STRUCTURES = [
  {
    basis: 'NP',
    layers: [
      { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 },
      { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
    ],
    prop: {},
  },
];

/**
 * A placement with structures, a built pack, a wording draft, and two markets
 * each carrying a named underwriter's address — everything a submission needs.
 */
async function setup(api, { withPack = true, withWording = true, approvePack: approve = true } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: `Meridian ${Math.random()}` } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property Cat XoL',
      inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD',
    },
  });
  const pid = placement.body.id;
  await api('PATCH', `/api/placements/${pid}`, { token: broker.token, body: { quote_structures: STRUCTURES } });

  let pack = null;
  if (withPack) {
    pack = (await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} })).body;
    if (approve) await approvePack(api, pack.id);
  }
  let wording = null;
  if (withWording) {
    wording = (await api('POST', '/api/wordings/drafts', {
      token: broker.token,
      body: { title: 'Property Cat XoL wording', placement_id: pid, cob: 'Property' },
    })).body;
  }

  const markets = [];
  for (const [name, person] of [['Helvetia Re', 'Jo Smith'], ['Nordic Re', 'Anders Vik']]) {
    const m = await api('POST', '/api/markets', { token: broker.token, body: { name: `${name} ${Math.random()}` } });
    const c = await api('POST', `/api/markets/${m.body.id}/contacts`, {
      token: broker.token,
      body: { name: person, email: `${person.split(' ')[0]}@${name.split(' ')[0]}.example`.toLowerCase(), is_primary: true },
    });
    markets.push({ ...m.body, contact: c.body });
  }
  return { pid, pack, wording, markets, cedant: cedant.body };
}

const recipients = (markets) => markets.map((m) => ({ market_id: m.id, contact_id: m.contact.id }));

/** Draft → the broker reads and edits → awaiting the second pair of eyes. */
async function draftAndRequest(api, ctx, { token = broker.token } = {}) {
  const created = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
    token, body: { recipients: recipients(ctx.markets) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  await api('PATCH', `/api/negotiation-submissions/${id}`, {
    token, body: { body: `${created.body.body}\n\nP.S. checked by the broker.`, broker_reviewed: true },
  });
  const asked = await api('POST', `/api/negotiation-submissions/${id}/request-approval`, { token });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  return id;
}

test('a submission needs a pack, a wording and structures to quote', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api, { withPack: false, withWording: false });

    const noPack = await api('GET', `/api/placements/${ctx.pid}/negotiation/submission-context`, { token: broker.token });
    assert.equal(noPack.body.ready, false);
    assert.match(noPack.body.blockers.join(' '), /renewal pack/i);
    assert.match(noPack.body.blockers.join(' '), /wording/i);

    const refused = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
      token: broker.token, body: { recipients: recipients(ctx.markets) },
    });
    assert.equal(refused.status, 409);

    const pack = await api('POST', `/api/placements/${ctx.pid}/packs`, { token: broker.token, body: {} });
    await api('POST', '/api/wordings/drafts', {
      token: broker.token, body: { title: 'Wording', placement_id: ctx.pid },
    });
    // A pack that has not been approved by a Senior Broker blocks the send.
    const unapproved = await api('GET', `/api/placements/${ctx.pid}/negotiation/submission-context`, { token: broker.token });
    assert.equal(unapproved.body.ready, false);
    assert.match(unapproved.body.blockers.join(' '), /has not been approved/i);

    await approvePack(api, pack.body.id);
    const ready = await api('GET', `/api/placements/${ctx.pid}/negotiation/submission-context`, { token: broker.token });
    assert.equal(ready.body.ready, true);
    assert.deepEqual(ready.body.blockers, []);
    // An unissued wording is the broker's call, but they are told.
    assert.match(ready.body.warnings.join(' '), /not issued/i);
  });
});

test('the drafted email carries reviewable commentary and per-underwriter tokens', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api, { approvePack: true });
    const created = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
      token: broker.token, body: { recipients: recipients(ctx.markets) },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const s = created.body;

    assert.equal(s.broker_reviewed, false, 'a fresh draft is never pre-reviewed');
    assert.equal(s.status, 'draft');
    assert.equal(s.pack_version, 1);
    assert.equal(s.wording_id, ctx.wording.id);
    assert.equal(s.ai_meta.source, 'fallback', 'no provider configured in test — the offline draft stands in');
    assert.ok(s.ai_commentary.includes('['), 'the draft leaves the judgement calls to the broker');
    assert.match(s.body, /\{\{contact_name\}\}/, 'the salutation stays a token until send');
    assert.match(s.body, /Structure 1 — non-proportional/);
    assert.match(s.body, /Layer 1: 5,000,000 xs 1,000,000/);
    assert.match(s.subject, /renewal pack v1/);
    assert.equal(s.recipients.length, 2);
    assert.ok(s.recipients.every((r) => r.role === 'lead'), 'every underwriter approached is asked for a lead quote');

    const fetched = await api('GET', `/api/negotiation-submissions/${s.id}`, { token: uw.token });
    assert.doesNotMatch(fetched.body.preview, /\{\{/, 'the preview resolves them for the first underwriter');
    assert.match(fetched.body.preview, /Dear Jo Smith,/);
  });
});

test('the broker must read the draft before it can go for approval', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);
    const created = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
      token: broker.token, body: { recipients: recipients(ctx.markets) },
    });
    const id = created.body.id;

    const unread = await api('POST', `/api/negotiation-submissions/${id}/request-approval`, { token: broker.token });
    assert.equal(unread.status, 409);
    assert.match(unread.body.error, /confirm it before/i);

    // Confirming and then editing again clears the confirmation.
    await api('PATCH', `/api/negotiation-submissions/${id}`, { token: broker.token, body: { broker_reviewed: true } });
    const edited = await api('PATCH', `/api/negotiation-submissions/${id}`, {
      token: broker.token, body: { body: 'Reworded by the broker.' },
    });
    assert.equal(edited.body.broker_reviewed, false);
    assert.equal((await api('POST', `/api/negotiation-submissions/${id}/request-approval`, { token: broker.token })).status, 409);

    await api('PATCH', `/api/negotiation-submissions/${id}`, { token: broker.token, body: { broker_reviewed: true } });
    assert.equal((await api('POST', `/api/negotiation-submissions/${id}/request-approval`, { token: broker.token })).status, 200);
  });
});

test('four-eyes: the drafter cannot release their own submission', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);

    // A broker has no release role at all.
    const byBroker = await draftAndRequest(api, ctx);
    assert.equal((await api('POST', `/api/negotiation-submissions/${byBroker}/approve`, { token: broker.token })).status, 403);
    await api('POST', `/api/negotiation-submissions/${byBroker}/cancel`, { token: broker.token, body: {} });

    // An admin holds it, so this is the four-eyes guard itself.
    const byAdmin = await draftAndRequest(api, ctx, { token: admin.token });
    const own = await api('POST', `/api/negotiation-submissions/${byAdmin}/approve`, { token: admin.token });
    assert.equal(own.status, 409);
    assert.match(own.body.error, /cannot authorise their own/i);
    assert.equal(readOutbox().length, 0, 'nothing leaves without a second pair of eyes');

    const second = await api('POST', `/api/negotiation-submissions/${byAdmin}/approve`, { token: uw.token });
    assert.equal(second.status, 200);
    assert.equal(second.body.status, 'sent');
  });
});

test('the release emails every underwriter and puts their market on the board', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api, { approvePack: true });
    const id = await draftAndRequest(api, ctx);

    const released = await api('POST', `/api/negotiation-submissions/${id}/approve`, { token: uw.token });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.status, 'sent');
    assert.equal(released.body.approved_by, uw.user.id);
    assert.ok(released.body.recipients.every((r) => r.status === 'sent' && r.message_id));

    const outbox = readOutbox();
    assert.equal(outbox.length, 2);
    assert.match(outbox[0].to, /Jo Smith <jo@helvetia\.example>/);
    assert.doesNotMatch(outbox[0].text, /\{\{/, 'tokens resolve per underwriter');
    assert.match(outbox[0].text, /Dear Jo Smith,/);
    assert.match(outbox[1].text, /Dear Anders Vik,/);
    assert.match(outbox[0].text, /P\.S\. checked by the broker\./, 'what the broker edited is what goes out');
    assert.equal(outbox[0].attachments.length, 2, 'the pack goes with it as its Excel and its PDF');
    assert.match(outbox[0].attachments[0].filename, /\.xlsx$/);
    assert.match(outbox[0].attachments[1].filename, /\.pdf$/);
    assert.ok(outbox[0].attachments.every((a) => a.bytes > 1000));

    // The markets now hold the pack — every one a lead — at the version emailed.
    const board = await api('GET', `/api/placements/${ctx.pid}/negotiation`, { token: broker.token });
    assert.equal(board.body.markets.length, 2);
    assert.ok(board.body.markets.every((m) => m.role === 'lead'));
    assert.ok(board.body.markets.every((m) => m.status === 'SENT' && m.pack_version === 1));

    // ...and each keeps track of who at the reinsurer was emailed, and what
    // became of it — the register of everyone approached for a quote.
    const lead = board.body.markets[0];
    assert.equal(lead.underwriters.length, 1);
    assert.match(lead.underwriters[0].email, /jo@helvetia\.example/);
    assert.equal(lead.underwriters[0].name, 'Jo Smith');
    assert.equal(lead.underwriters[0].role, 'lead');
    assert.equal(lead.underwriters[0].delivery, 'sent');
    assert.ok(lead.underwriters[0].sent_at, 'when it went');
    assert.equal(lead.underwriters[0].pack_version, 1);
    assert.equal(lead.underwriters[0].reply_status, 'awaiting');
    assert.equal(lead.underwriters[0].reply_count, 0);
    assert.equal(lead.underwriters[0].last_kind, null);
    assert.equal(board.body.markets[1].underwriters[0].name, 'Anders Vik');
  });
});

test('content and recipients freeze once approval is asked for', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);
    const id = await draftAndRequest(api, ctx);

    assert.equal((await api('PATCH', `/api/negotiation-submissions/${id}`, {
      token: broker.token, body: { body: 'Quietly changed.' },
    })).status, 409);
    assert.equal((await api('POST', `/api/negotiation-submissions/${id}/redraft`, { token: broker.token })).status, 409);

    // Sending it back unfreezes it, unreviewed, with the reason attached.
    const sentBack = await api('POST', `/api/negotiation-submissions/${id}/reject`, {
      token: uw.token, body: { reason: 'Tighten the second paragraph' },
    });
    assert.equal(sentBack.status, 200);
    assert.equal(sentBack.body.status, 'draft');
    assert.equal(sentBack.body.broker_reviewed, false);
    assert.equal(sentBack.body.reject_reason, 'Tighten the second paragraph');
    assert.equal(readOutbox().length, 0);
    assert.equal((await api('PATCH', `/api/negotiation-submissions/${id}`, {
      token: broker.token, body: { body: 'Tightened.', broker_reviewed: true },
    })).status, 200);
  });
});

test('a market with no address, or declined security, cannot be sent to', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);
    const bare = await api('POST', '/api/markets', { token: broker.token, body: { name: `No Contact Re ${Math.random()}` } });
    const noEmail = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
      token: broker.token, body: { recipients: [{ market_id: bare.body.id }] },
    });
    assert.equal(noEmail.status, 422);
    assert.match(noEmail.body.error, /No underwriter email on file/i);

    await api('PATCH', `/api/markets/${ctx.markets[0].id}`, { token: broker.token, body: { security_status: 'declined' } });
    const declined = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
      token: broker.token, body: { recipients: recipients(ctx.markets) },
    });
    assert.equal(declined.status, 409);
    assert.match(declined.body.error, /declined-security/i);
  });
});

test('the underwriter list carries the live addresses per market', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);
    const deputy = await api('POST', `/api/markets/${ctx.markets[0].id}/contacts`, {
      token: broker.token, body: { name: 'Alpha Deputy', email: 'DEPUTY@Helvetia.example' },
    });
    assert.equal(deputy.body.email, 'deputy@helvetia.example', 'addresses are normalised');

    const list = await api('GET', '/api/underwriters', { token: broker.token });
    const market = list.body.find((m) => m.market_id === ctx.markets[0].id);
    assert.equal(market.contacts.length, 2);
    assert.equal(market.contacts[0].is_primary, true, 'the primary contact leads');

    await api('DELETE', `/api/market-contacts/${deputy.body.id}`, { token: broker.token });
    const after = await api('GET', '/api/underwriters', { token: broker.token });
    assert.equal(after.body.find((m) => m.market_id === ctx.markets[0].id).contacts.length, 1);
  });
});

test('a submission awaiting release shows in the four-eyes approval queue', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);
    const id = await draftAndRequest(api, ctx);

    const queue = await api('GET', '/api/admin/approvals?action_type=submission_send', { token: uw.token });
    assert.equal(queue.body.length, 1);
    assert.equal(queue.body[0].entity_id, id);
    assert.equal(queue.body[0].proposed_by, broker.user.id);

    await api('POST', `/api/negotiation-submissions/${id}/approve`, { token: uw.token });
    assert.equal((await api('GET', '/api/admin/approvals?action_type=submission_send', { token: uw.token })).body.length, 0);
  });
});

test('only the drafter, or an admin, can withdraw a submission', async () => {
  await withServer(async (api) => {
    const ctx = await setup(api);
    const created = await api('POST', `/api/placements/${ctx.pid}/negotiation/submissions`, {
      token: broker.token, body: { recipients: recipients(ctx.markets) },
    });
    const other = await makeUser('broker');
    assert.equal((await api('POST', `/api/negotiation-submissions/${created.body.id}/cancel`, {
      token: other.token, body: {},
    })).status, 409);
    const own = await api('POST', `/api/negotiation-submissions/${created.body.id}/cancel`, {
      token: broker.token, body: {},
    });
    assert.equal(own.status, 200);
    assert.equal(own.body.status, 'cancelled');
  });
});
