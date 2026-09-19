// Final placement, reshaped: the firm order terms carry the approved pack as
// Excel and PDF, or a pack uploaded by hand with a reason; the lines can be
// read off a reinsurer's email by the AI and overridden by the broker, with
// every change kept.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox, readOutbox } from '../../src/integrations/mailer.js';

let broker;
let senior;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  clearOutbox();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
});

const STRUCTURES = [
  { basis: 'NP', layers: [
    { name: 'Layer 1', limit: 5_000_000, attachment: 1_000_000, premium: 400_000, rate_pct: 8 },
    { name: 'Layer 2', limit: 10_000_000, attachment: 6_000_000, premium: 250_000 },
  ], prop: {} },
];

/** A placement with the final terms saved from Alpha's quotes on both layers, Beta also on the panel. */
async function finalised(api) {
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
  const negotiationOf = (marketId) => sent.body.markets.find((m) => m.market_id === marketId).id;
  const quote = (marketId, body) => api('PUT', `/api/negotiations/${negotiationOf(marketId)}/quotes`, { token: broker.token, body });
  const alphaL1 = (await quote(markets['Alpha Re'].id, { structure_index: 1, layer_index: 0, premium: 432_000, line_pct: 25 })).body;
  const alphaL2 = (await quote(markets['Alpha Re'].id, { structure_index: 1, layer_index: 1, premium: 270_000, line_pct: 25 })).body;
  const saved = await api('PUT', `/api/placements/${pid}/final`, {
    token: broker.token,
    body: { lead_won: true, terms: [{ key: 's1:l0', quote_id: alphaL1.id }, { key: 's1:l1', quote_id: alphaL2.id }] },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  return { pid, pack, markets };
}

const recipientsOf = (markets) => Object.values(markets).map((m) => ({ market_id: m.id, contact_id: m.contact_id }));

test('the firm order terms carry the approved pack as both its Excel and its PDF', async () => {
  await withServer(async (api) => {
    const { pid, pack, markets } = await finalised(api);
    const draft = await api('GET', `/api/placements/${pid}/final/email-draft?kind=fot`, { token: broker.token });
    assert.equal(draft.status, 200);
    assert.deepEqual(draft.body.attachments.map((a) => a.format), ['xlsx', 'pdf']);
    assert.ok(draft.body.attachments.every((a) => a.bytes > 0));

    const sent = await api('POST', `/api/placements/${pid}/final/emails`, {
      token: broker.token, body: { kind: 'fot', recipients: recipientsOf(markets), attach_pack: true },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.email.attached_formats, ['xlsx', 'pdf']);
    assert.equal(sent.body.email.pack_id, pack.id);
    const mails = readOutbox();
    assert.equal(mails.length, 2);
    for (const m of mails) {
      assert.deepEqual(m.attachments.map((a) => a.filename.split('.').pop()), ['xlsx', 'pdf']);
      assert.ok(m.attachments.every((a) => a.bytes > 0));
    }
  });
});

test('a pack uploaded by hand at this stage needs a reason, and goes instead of the approved version', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await finalised(api);
    const content_base64 = Buffer.from('Expiring pack,as sent by the cedant\nLayer 1,5m xs 1m\n').toString('base64');
    const noReason = await api('POST', `/api/placements/${pid}/final/pack-upload`, {
      token: broker.token, body: { filename: 'cedant-pack.csv', mime_type: 'text/csv', content_base64 },
    });
    assert.equal(noReason.status, 422, 'a reason is mandatory');
    const short = await api('POST', `/api/placements/${pid}/final/pack-upload`, {
      token: broker.token, body: { filename: 'cedant-pack.csv', mime_type: 'text/csv', content_base64, reason: 'ok' },
    });
    assert.equal(short.status, 422);

    const uploaded = await api('POST', `/api/placements/${pid}/final/pack-upload`, {
      token: broker.token,
      body: { filename: 'cedant-pack.csv', mime_type: 'text/csv', content_base64, reason: 'The cedant asked for its own pack to go with the order, restated after the FOT call.' },
    });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.upload.filename, 'cedant-pack.csv');
    assert.equal(uploaded.body.pack_uploads.length, 1);
    assert.match(uploaded.body.pack_uploads[0].reason, /restated after the FOT call/);
    assert.equal(uploaded.body.pack_uploads[0].uploaded_by_name, broker.user.name);

    const sent = await api('POST', `/api/placements/${pid}/final/emails`, {
      token: broker.token, body: { kind: 'fot', recipients: recipientsOf(markets), pack_upload_id: uploaded.body.upload.id },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.deepEqual(sent.body.email.attached_formats, ['upload']);
    assert.equal(sent.body.email.pack_upload_id, uploaded.body.upload.id);
    assert.equal(sent.body.email.attach_pack, false);
    assert.deepEqual(readOutbox()[0].attachments.map((a) => a.filename), ['cedant-pack.csv']);

    const { rows } = await pool.query("SELECT detail FROM audit_event WHERE entity_type = 'final_placement' AND action = 'pack_upload'");
    assert.equal(rows.length, 1);
    assert.match(rows[0].detail.reason, /restated/);
  });
});

test('the AI reads written lines off the reinsurers\' emails; the broker overrides, and every change is kept', async () => {
  await withServer(async (api) => {
    const { pid, markets } = await finalised(api);
    await api('POST', `/api/placements/${pid}/final/emails`, { token: broker.token, body: { kind: 'fot', recipients: recipientsOf(markets) } });

    // An email from Alpha's underwriter, pasted in: a line across the programme.
    const read = await api('POST', `/api/placements/${pid}/final/lines/read-emails`, {
      token: broker.token,
      body: { emails: [{ from_email: 'jo@alpha.test', from_name: 'Jo Smith', subject: 'RE: Firm order terms', body: 'Dear broker,\n\nThank you for the firm order terms. We are pleased to confirm we will write a line of 12.5% across the programme.\n\nKind regards, Jo' }] },
    });
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal(read.body.outcome.emails, 1);
    assert.equal(read.body.outcome.entered, 2, 'one line per layer of the final terms');
    const alpha = markets['Alpha Re'].id;
    const alphaLines = read.body.lines.filter((l) => l.market_id === alpha);
    assert.deepEqual(alphaLines.map((l) => [l.term_key, l.written_pct, l.source]).sort(), [['s1:l0', 12.5, 'ai'], ['s1:l1', 12.5, 'ai']]);
    assert.equal(alphaLines[0].ai_read.written_pct, 12.5);
    assert.equal(alphaLines[0].ai_read.source, 'fallback', 'no model configured: the keyword read stands in');
    assert.deepEqual(read.body.line_changes.map((c) => c.action), ['ai_entered', 'ai_entered']);
    assert.equal(read.body.signing['s1:l0'].written_total, 12.5);

    // An address the register does not know is skipped, never guessed at.
    const unknown = await api('POST', `/api/placements/${pid}/final/lines/read-emails`, {
      token: broker.token, body: { emails: [{ from_email: 'nobody@nowhere.test', body: 'We will write 50% of the programme.' }] },
    });
    assert.equal(unknown.body.outcome.entered, 0);
    assert.match(unknown.body.outcome.skipped[0].reason, /no reinsurer on the register/);

    // The broker overrides Layer 1 to 15%: the line is the broker's, with what it said before kept.
    const over = await api('PUT', `/api/placements/${pid}/final/lines`, {
      token: broker.token, body: { lines: [{ market_id: alpha, term_key: 's1:l0', written_pct: 15 }] },
    });
    assert.equal(over.status, 200, JSON.stringify(over.body));
    const l1 = over.body.lines.find((l) => l.market_id === alpha && l.term_key === 's1:l0');
    assert.equal(l1.written_pct, 15);
    assert.equal(l1.source, 'broker');
    const overridden = over.body.line_changes.find((c) => c.action === 'overridden');
    assert.equal(overridden.before_state.written_pct, 12.5);
    assert.equal(overridden.after_state.written_pct, 15);
    assert.equal(overridden.changed_by_name, broker.user.name);

    // A later email moves the AI line, never the broker's.
    const again = await api('POST', `/api/placements/${pid}/final/lines/read-emails`, {
      token: broker.token, body: { emails: [{ from_email: 'jo@alpha.test', body: 'Further to our earlier note, please take our line as 10% across the programme.' }] },
    });
    assert.equal(again.body.outcome.updated, 1);
    assert.ok(again.body.outcome.skipped.some((s) => /broker's line stands/.test(s.reason)));
    assert.equal(again.body.lines.find((l) => l.market_id === alpha && l.term_key === 's1:l0').written_pct, 15, 'the broker\'s figure stands');
    assert.equal(again.body.lines.find((l) => l.market_id === alpha && l.term_key === 's1:l1').written_pct, 10);

    // The broker accepts the AI's Layer 2 line as it stands.
    const accepted = await api('POST', `/api/placements/${pid}/final/lines/accept`, { token: broker.token, body: { market_id: alpha, term_key: 's1:l1' } });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.lines.find((l) => l.term_key === 's1:l1').source, 'broker');
    assert.equal(accepted.body.line_changes[0].action, 'accepted');
    assert.equal((await api('POST', `/api/placements/${pid}/final/lines/accept`, { token: broker.token, body: { market_id: alpha, term_key: 's1:l1' } })).status, 409);

    // A decline by email clears an AI line; the history is append-only.
    await api('PUT', `/api/placements/${pid}/final/lines`, { token: broker.token, body: { lines: [{ market_id: markets['Beta Re'].id, term_key: 's1:l0', written_pct: 0 }] } });
    const beta = await api('POST', `/api/placements/${pid}/final/lines/read-emails`, {
      token: broker.token, body: { emails: [{ from_email: 'anders@beta.test', body: 'We can support the programme with a 20% line.' }] },
    });
    assert.equal(beta.body.outcome.entered, 2);
    const declined = await api('POST', `/api/placements/${pid}/final/lines/read-emails`, {
      token: broker.token, body: { emails: [{ from_email: 'anders@beta.test', body: 'Regret we are unable to support this programme after all and must decline.' }] },
    });
    assert.equal(declined.body.outcome.updated, 2);
    assert.equal(declined.body.lines.filter((l) => l.market_id === markets['Beta Re'].id).length, 0);
    await assert.rejects(pool.query('DELETE FROM final_placement_line_change'), /append-only/);
  });
});
