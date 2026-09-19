// The renewal desk's signed lines: one signing advice merged per reinsurer —
// its own rows and nothing of anyone else's — through the final placement
// module, audited per recipient; declinatures get the courtesy note.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox, readOutbox } from '../../src/integrations/mailer.js';
import { treatmentSentence, mergeBlock } from '../../src/modules/analysis/renewalDesk.signed.js';

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
  let contact = null;
  if (person) {
    const c = await api('POST', `/api/markets/${m.body.id}/contacts`, {
      token: broker.token,
      body: { name: person, email: `${person.split(' ')[0]}@${name.split(' ')[0]}.example`.toLowerCase(), is_primary: true },
    });
    contact = c.body;
  }
  return { ...m.body, contact };
}

async function fot(api, layerId) {
  await api('POST', `/api/layers/${layerId}/fot`, { token: broker.token, body: { agreed_terms: { order_pct: 100 } } });
  const ok = await api('POST', `/api/layers/${layerId}/fot/authorise`, { token: uw.token });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
}

test('the treatment sentence and the merge block read from the layers as signed', () => {
  assert.equal(
    treatmentSentence([
      { name: 'Layer 1', oversubscribed: true, has_lines: true },
      { name: 'Layer 2', oversubscribed: true, has_lines: true },
      { name: 'Layer 3', oversubscribed: false, has_lines: true },
      { name: 'Layer 4', oversubscribed: false, has_lines: false },
    ]),
    'Layer 1 and Layer 2 were oversubscribed and have been signed down pro rata to the order; Layer 3 is signed as written. No line has been signed above the amount written.',
  );
  assert.equal(treatmentSentence([]), 'No line has been signed above the amount written.');
  assert.equal(
    mergeBlock([{ layer_name: 'Layer 1', cover: 'USD 2.5m xs 2.5m', written_pct: 60, signed_pct: 50, premium_signed: 825000 }], 'USD'),
    '  Layer 1 — USD 2.5m xs 2.5m: written 60.00%, signed 50.00%, signed premium USD 825,000.00',
  );
});

test('the signing advice goes to every reinsurer with a signed line, merged with its own rows only', async () => {
  await withServer(async (api) => {
    const alpha = await market(api, 'Alpha Re', 'Ann Alpha');
    const beta = await market(api, 'Beta Re', 'Ben Beta');
    const gamma = await market(api, 'Gamma Re', 'Gil Gamma');

    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Kenya Re' } });
    const placement = (await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property Risk XL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
    })).body;
    const { rows: [l1, l2] } = await pool.query(
      `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, currency, premium100, position) VALUES
         ($1, 'Layer 1', 'XoL', 2500000, 2500000, 'USD', 1650000, 1),
         ($1, 'Layer 2', 'XoL', 5000000, 5000000, 'USD', 1120000, 2)
       RETURNING id`,
      [placement.id],
    );
    const a = (await api('POST', '/api/renewal-analyses', {
      token: broker.token, body: { cedant_name: 'Kenya Re', class_of_business: 'Property', treaty_type: 'Risk XL' },
    })).body;
    await api('PUT', `/api/renewal-analyses/${a.id}/placement`, { token: broker.token, body: { placement_id: placement.id } });
    await pool.query(
      `UPDATE renewal_pack_analysis SET status = 'complete', analysed_at = now(), verified_at = now(), verified_by = $2,
              result = '{"programme":{"treaty_name":"Risk Excess of Loss — 2027","prose":"x"},"executive_summary":"x"}'::jsonb
        WHERE id = $1`,
      [a.id, broker.user.id],
    );

    // Not released yet: the tab says so, and nothing goes out.
    const held = await api('GET', `/api/renewal-analyses/${a.id}/signed-lines`, { token: broker.token });
    assert.equal(held.body.ready, false);
    assert.match(held.body.blockers.join(' '), /release the signed lines/i);
    const refused = await api('POST', `/api/renewal-analyses/${a.id}/signed-lines/send`, { token: broker.token, body: {} });
    assert.equal(refused.status, 409);

    // Layer 1 oversubscribed (60 + 60 → 50 + 50), Gamma declines; Layer 2 Alpha alone at 100.
    await fot(api, l1.id);
    await fot(api, l2.id);
    await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: alpha.id, written_pct: 60 } });
    await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: beta.id, written_pct: 60 } });
    await api('POST', `/api/layers/${l1.id}/lines`, { token: broker.token, body: { market_id: gamma.id, written_pct: 0 } });
    await api('POST', `/api/layers/${l1.id}/lines/${gamma.id}/decline`, { token: broker.token });
    await api('POST', `/api/layers/${l2.id}/lines`, { token: broker.token, body: { market_id: alpha.id, written_pct: 100 } });
    await api('POST', `/api/layers/${l1.id}/signing/apply`, { token: broker.token, body: {} });
    await api('POST', `/api/layers/${l2.id}/signing/apply`, { token: broker.token, body: {} });
    const released = await api('POST', `/api/renewal-analyses/${a.id}/release`, { token: broker.token });
    assert.equal(released.status, 200, JSON.stringify(released.body));

    const ctx = (await api('GET', `/api/renewal-analyses/${a.id}/signed-lines`, { token: broker.token })).body;
    assert.equal(ctx.ready, true, JSON.stringify(ctx.blockers));
    assert.equal(ctx.released, true);
    assert.deepEqual(ctx.recipients.map((r) => [r.name, r.layers, r.layers_total]), [['Alpha Re', 2, 2], ['Beta Re', 1, 2]]);
    assert.equal(ctx.recipients[0].signed_premium, 825000 + 1120000);
    assert.equal(ctx.recipients[0].sent, null);
    assert.deepEqual(ctx.declinatures.map((d) => [d.name, d.layers]), [['Gamma Re', ['Layer 1']]]);
    assert.equal(ctx.treatment, 'Layer 1 was oversubscribed and has been signed down pro rata to the order; Layer 2 is signed as written. No line has been signed above the amount written.');
    assert.equal(ctx.template.subject, 'SIGNED LINES — Kenya Re Risk Excess of Loss 2027 — Final Signing Advice');
    assert.match(ctx.template.body, /\{\{lines\}\}/);
    assert.match(ctx.template.body, /Layer 1 was oversubscribed/);
    assert.equal(ctx.advice, null);

    // The send: one message per reinsurer, each with its own rows and no one else's.
    const sent = await api('POST', `/api/renewal-analyses/${a.id}/signed-lines/send`, {
      token: broker.token, body: { body: `${ctx.template.body}\n\nP.S. edited by the broker.` },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.email.kind, 'confirmation');
    assert.equal(sent.body.email.delivered, 2);
    assert.deepEqual(sent.body.skipped, []);
    const outbox = readOutbox();
    assert.equal(outbox.length, 2);
    const toAlpha = outbox.find((m) => m.to.startsWith('Ann Alpha'));
    const toBeta = outbox.find((m) => m.to.startsWith('Ben Beta'));
    assert.match(toAlpha.text, /Dear Ann Alpha,/);
    assert.match(toAlpha.text, /The final signed lines of Alpha Re are confirmed/);
    assert.match(toAlpha.text, /Layer 1 — USD 2\.5m xs 2\.5m: written 60\.00%, signed 50\.00%, signed premium USD 825,000\.00/);
    assert.match(toAlpha.text, /Layer 2 — USD 5m xs 5m: written 100\.00%, signed 100\.00%, signed premium USD 1,120,000\.00/);
    assert.match(toBeta.text, /Layer 1 — USD 2\.5m xs 2\.5m: written 60\.00%, signed 50\.00%/);
    assert.doesNotMatch(toBeta.text, /Layer 2 — USD/, 'a market sees only its own lines — the treatment names layers, never lines');
    assert.doesNotMatch(toBeta.text, /Alpha/, 'no market sees another\'s line');
    assert.match(toBeta.text, /P\.S\. edited by the broker\./);
    assert.ok(sent.body.recipients.every((r) => r.sent?.status === 'sent'), 'the tab now shows each advice as sent');

    // Audited per recipient on the placement's final record, and on the pack.
    const { rows: audits } = await pool.query(
      `SELECT action, detail FROM audit_event WHERE action LIKE 'send_confirmation%' OR action = 'signing_advice' ORDER BY created_at, id`,
    );
    assert.deepEqual(audits.map((r) => r.action), ['send_confirmation', 'send_confirmation_recipient', 'send_confirmation_recipient', 'signing_advice']);
    assert.deepEqual(audits.slice(1, 3).map((r) => r.detail.market_name).sort(), ['Alpha Re', 'Beta Re']);
    const detail = await api('GET', `/api/renewal-analyses/${a.id}`, { token: broker.token });
    assert.equal(detail.body.signed_advice.recipients, 2);
    assert.equal(detail.body.signed_advice.delivered, 2);

    // Declinatures are not in the advice; they get the courtesy note.
    const courtesy = await api('POST', `/api/renewal-analyses/${a.id}/signed-lines/courtesy`, { token: broker.token, body: {} });
    assert.equal(courtesy.status, 201, JSON.stringify(courtesy.body));
    assert.equal(courtesy.body.email.kind, 'declinature');
    const note = readOutbox()[2];
    assert.match(note.to, /^Gil Gamma/);
    assert.match(note.text, /we have noted that Gamma Re was not able to support it this year/);
    assert.doesNotMatch(note.text, /signed/i);
    assert.equal(courtesy.body.declinatures[0].sent.status, 'sent');
  });
});
