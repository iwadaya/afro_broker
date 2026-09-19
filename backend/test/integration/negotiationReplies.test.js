// The underwriters' replies: logged by hand or read from the connected
// Outlook inbox, tied to the underwriter they came from, read by the AI (the
// keyword read here — no key in tests), and listed against the placement.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox } from '../../src/integrations/mailer.js';
import { setFetchForTests } from '../../src/integrations/outlook.js';

let broker;
let senior;
let uw;

before(async () => { await resetDb(); });
after(async () => { setFetchForTests(null); await pool.end(); });

beforeEach(async () => {
  await resetDb();
  clearOutbox();
  setFetchForTests(null);
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
  uw = await makeUser('underwriter');
});

const STRUCTURES = [{
  basis: 'NP',
  layers: [{ name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 }],
  prop: {},
}];

/** A placement with an approved pack, a wording, two markets with underwriters, and a sent submission. */
async function sentSubmission(api) {
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
  for (const [name, person, email] of [['Alpha Re', 'Jo Smith', 'jo@alpha.test'], ['Beta Re', 'Anders Vik', 'anders@beta.test']]) {
    const market = await api('POST', '/api/markets', { token: broker.token, body: { name: `${name} ${Math.random()}` } });
    const contact = await api('POST', `/api/markets/${market.body.id}/contacts`, {
      token: broker.token, body: { name: person, email, is_primary: true },
    });
    recipients.push({ market_id: market.body.id, contact_id: contact.body.id });
  }
  const created = await api('POST', `/api/placements/${pid}/negotiation/submissions`, {
    token: broker.token, body: { recipients },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  await api('PATCH', `/api/negotiation-submissions/${id}`, { token: broker.token, body: { broker_reviewed: true } });
  await api('POST', `/api/negotiation-submissions/${id}/request-approval`, { token: broker.token, body: {} });
  const released = await api('POST', `/api/negotiation-submissions/${id}/approve`, { token: uw.token, body: {} });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  return { pid, submission: released.body };
}

test('a sent submission carries a reference tag in its subject and the ids the send produced', async () => {
  await withServer(async (api) => {
    const { submission } = await sentSubmission(api);
    assert.match(submission.subject, /\[BIQ-[0-9A-F]{8}\]$/);
    assert.equal(submission.reference_tag, /\[(BIQ-[0-9A-F]{8})\]$/.exec(submission.subject)[1]);
    for (const r of submission.recipients) {
      assert.equal(r.status, 'sent');
      assert.ok(r.internet_message_id, 'the message id is kept on the recipient');
      assert.ok(r.conversation_id, 'so is the conversation');
      assert.equal(r.reply_status, 'awaiting');
    }
  });
});

test('a reply logged by hand is tied to its underwriter, read, and counted', async () => {
  await withServer(async (api) => {
    const { pid, submission } = await sentSubmission(api);
    const jo = submission.recipients.find((r) => r.email === 'jo@alpha.test');

    const before = await api('GET', `/api/placements/${pid}/negotiation/replies`, { token: broker.token });
    assert.equal(before.body.summary.sent_to, 2);
    assert.equal(before.body.summary.awaiting, 2);

    const logged = await api('POST', `/api/negotiation-submissions/${submission.id}/replies`, {
      token: broker.token,
      body: {
        from_email: 'jo@alpha.test',
        subject: `RE: ${submission.subject}`,
        body: 'Dear Broker,\n\nThank you for the pack. We are pleased to offer a line of 20% on Layer 1 at a rate on line of 8.5%, subject to satisfactory cat model output. Valid until 20 December 2026.\n\nJo',
      },
    });
    assert.equal(logged.status, 201, JSON.stringify(logged.body));
    assert.equal(logged.body.recipient_id, jo.id, 'matched to the underwriter by address');
    assert.equal(logged.body.kind, 'quote');
    assert.equal(logged.body.source, 'manual');
    assert.equal(logged.body.ai_read.source, 'fallback', 'no key configured in tests');
    assert.equal(logged.body.ai_read.terms[0].rate_pct, 8.5);
    assert.equal(logged.body.ai_read.terms[0].line_pct, 20);
    assert.match(logged.body.ai_read.next_action, /capture/i);

    const after = await api('GET', `/api/placements/${pid}/negotiation/replies`, { token: broker.token });
    assert.equal(after.body.summary.replied, 1);
    assert.equal(after.body.summary.quotes, 1);
    assert.equal(after.body.summary.unhandled, 1);
    const standing = after.body.recipients.find((r) => r.recipient_id === jo.id);
    assert.equal(standing.reply_status, 'replied');
    assert.equal(standing.reply_count, 1);
    assert.equal(standing.last_kind, 'quote');
    assert.equal(after.body.recipients.find((r) => r.email === 'anders@beta.test').reply_status, 'awaiting');

    // Handled, and read again.
    const handled = await api('POST', `/api/negotiation-replies/${logged.body.id}/handled`, { token: broker.token, body: {} });
    assert.equal(handled.body.handled, true);
    assert.equal(handled.body.handled_by_name, broker.user.name);
    const reread = await api('POST', `/api/negotiation-replies/${logged.body.id}/reread`, { token: broker.token, body: {} });
    assert.equal(reread.body.kind, 'quote');

    // An underwriter cannot log replies; an unknown sender needs a recipient or an address.
    assert.equal((await api('POST', `/api/negotiation-submissions/${submission.id}/replies`, { token: uw.token, body: { from_email: 'x@y.test', body: 'hi' } })).status, 403);
    assert.equal((await api('POST', `/api/negotiation-submissions/${submission.id}/replies`, { token: broker.token, body: { body: 'hi' } })).status, 422);
  });
});

test('the connected inbox is read for replies and matched by conversation', async () => {
  await withServer(async (api) => {
    const { pid, submission } = await sentSubmission(api);
    const anders = submission.recipients.find((r) => r.email === 'anders@beta.test');

    // Nothing to read until a mailbox is connected.
    assert.equal((await api('GET', '/api/outlook/status', { token: broker.token })).body.connected, false);
    const nothing = await api('POST', '/api/outlook/sync', { token: broker.token, body: {} });
    assert.equal(nothing.body.skipped, 'no_mailbox');
    assert.equal((await api('POST', '/api/outlook/connect', { token: broker.token, body: {} })).status, 422, 'not configured in tests');

    // A mailbox, connected — with Microsoft standing in.
    await pool.query(
      `INSERT INTO mail_account (address, display_name, access_token, refresh_token, expires_at)
       VALUES ('me@outlook.test', 'Me', 'token', 'refresh', now() + interval '1 hour')`,
    );
    const calls = [];
    setFetchForTests(async (url, init) => {
      calls.push({ url: String(url), init });
      assert.match(init.headers.authorization, /^Bearer token$/);
      return {
        ok: true, status: 200,
        json: async () => ({
          value: [
            { // our own sent mail echoed in the inbox: ignored
              id: 'm0', internetMessageId: '<m0@outlook>', conversationId: anders.conversation_id,
              from: { emailAddress: { address: 'me@outlook.test', name: 'Me' } }, subject: 'FW', receivedDateTime: '2026-09-06T09:00:00Z',
              body: { contentType: 'text', content: 'me' },
            },
            { // the underwriter's reply on the thread the send started
              id: 'm1', internetMessageId: '<m1@beta.test>', conversationId: anders.conversation_id,
              from: { emailAddress: { address: 'Anders@beta.test', name: 'Anders Vik' } },
              subject: 'RE: renewal pack', receivedDateTime: '2026-09-06T10:00:00Z',
              body: { contentType: 'html', content: '<p>Thanks for the pack.</p><p>Unfortunately we are unable to support this programme this year.</p>' },
            },
            { // unrelated
              id: 'm2', internetMessageId: '<m2@nowhere>', conversationId: 'other',
              from: { emailAddress: { address: 'news@nowhere.test' } }, subject: 'Newsletter', receivedDateTime: '2026-09-06T11:00:00Z',
              body: { contentType: 'text', content: 'buy now' },
            },
          ],
        }),
      };
    });

    const status = await api('GET', '/api/outlook/status', { token: broker.token });
    assert.equal(status.body.connected, true);
    assert.equal(status.body.account.address, 'me@outlook.test');
    assert.equal(status.body.account.access_token, undefined, 'tokens never reach the UI');

    const synced = await api('POST', '/api/outlook/sync', { token: broker.token, body: {} });
    assert.equal(synced.status, 200, JSON.stringify(synced.body));
    assert.equal(synced.body.checked, 3);
    assert.equal(synced.body.matched, 1);
    assert.equal(synced.body.recorded, 1);
    assert.match(calls[0].url, /\/me\/mailFolders\/inbox\/messages\?/);

    const replies = await api('GET', `/api/placements/${pid}/negotiation/replies`, { token: broker.token });
    assert.equal(replies.body.replies.length, 1);
    const reply = replies.body.replies[0];
    assert.equal(reply.recipient_id, anders.id);
    assert.equal(reply.source, 'outlook');
    assert.equal(reply.kind, 'decline');
    assert.equal(reply.message_id, '<m1@beta.test>');
    assert.match(reply.body, /unable to support/);
    assert.doesNotMatch(reply.body, /<p>/, 'HTML is read as text');
    assert.equal(replies.body.summary.declines, 1);

    // Reading again does not record the same message twice, and the cursor moved on.
    const again = await api('POST', '/api/outlook/sync', { token: broker.token, body: {} });
    assert.equal(again.body.recorded, 0);
    assert.match(decodeURIComponent(calls[1].url).replace(/\+/g, ' '), /receivedDateTime ge 2026-09-06T10:59/, 'reads from a minute before the newest message');
    assert.equal((await api('GET', `/api/placements/${pid}/negotiation/replies`, { token: broker.token })).body.replies.length, 1);
    const after = await api('GET', '/api/outlook/status', { token: broker.token });
    assert.ok(after.body.account.last_sync_at);
    assert.equal(after.body.account.last_sync_error, null);

    // Disconnecting drops the mailbox.
    await api('POST', '/api/outlook/disconnect', { token: broker.token, body: {} });
    assert.equal((await api('GET', '/api/outlook/status', { token: broker.token })).body.connected, false);
  });
});

test('with a mailbox connected the submission goes out through it and keeps the ids Graph returns', async () => {
  // .env may pin MAIL_TRANSPORT=stub for development; here the transport follows the connected mailbox.
  const savedTransport = process.env.MAIL_TRANSPORT;
  process.env.MAIL_TRANSPORT = '';
  try {
  await withServer(async (api) => {
    await pool.query(
      `INSERT INTO mail_account (address, display_name, access_token, refresh_token, expires_at)
       VALUES ('me@outlook.test', 'Me', 'token', 'refresh', now() + interval '1 hour')`,
    );
    const sent = [];
    setFetchForTests(async (url, init) => {
      const u = String(url);
      if (u.endsWith('/me/messages') && init.method === 'POST') {
        const draft = JSON.parse(init.body);
        sent.push(draft);
        return { ok: true, status: 201, json: async () => ({ id: `draft-${sent.length}`, internetMessageId: `<sent-${sent.length}@outlook.test>`, conversationId: `conv-${sent.length}` }) };
      }
      if (/\/me\/messages\/draft-\d+\/send$/.test(u)) return { ok: true, status: 202, json: async () => ({}) };
      throw new Error(`unexpected call ${u}`);
    });
    const { submission } = await sentSubmission(api);
    assert.equal(sent.length, 2, 'one message per underwriter');
    assert.equal(sent[0].toRecipients[0].emailAddress.address, 'jo@alpha.test');
    assert.match(sent[0].subject, /\[BIQ-/);
    assert.equal(sent[0].attachments.length, 2, 'the pack rides along as its Excel and its PDF');
    assert.match(sent[0].attachments[0].name, /RenewalPack_v1.*\.xlsx$/);
    assert.match(sent[0].attachments[1].name, /RenewalPack_v1.*\.pdf$/);
    assert.match(sent[0].body.content, /Dear Jo Smith/);
    const jo = submission.recipients.find((r) => r.email === 'jo@alpha.test');
    assert.equal(jo.internet_message_id, '<sent-1@outlook.test>');
    assert.equal(jo.conversation_id, 'conv-1');
    const ctx = await api('GET', `/api/placements/${submission.placement_id}/negotiation/submission-context`, { token: broker.token });
    assert.equal(ctx.body.mail_transport, 'outlook');
  });
  } finally {
    process.env.MAIL_TRANSPORT = savedTransport;
  }
});
