// The renewal desk's market submission: the verified summary goes to market
// through the existing submission machinery — the panel from last year's
// signed lines, the template from the summary, the four-eyes release, the
// attachments, the reminder before the deadline.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { clearOutbox, readOutbox } from '../../src/integrations/mailer.js';
import { sendDueReminders } from '../../src/modules/analysis/renewalDesk.service.js';

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
  assert.equal(m.status, 201, JSON.stringify(m.body));
  let contact = null;
  if (person) {
    const c = await api('POST', `/api/markets/${m.body.id}/contacts`, {
      token: broker.token,
      body: { name: person, email: `${person.split(' ')[0]}@${name.split(' ')[0]}.example`.toLowerCase(), is_primary: true },
    });
    assert.equal(c.status, 201, JSON.stringify(c.body));
    contact = c.body;
  }
  return { ...m.body, contact };
}

const RESULT = {
  programme: {
    treaty_name: 'Risk Excess of Loss — 2027', structure: 'USD 82.5m xs 2.5m', basis: 'Losses occurring',
    inception: '1 January 2027', expiry: '31 December 2027', currency: 'USD', layer_count: '6',
    epi: 'USD 96.4m', deposit_premium: '', retention: 'USD 2.5m each and every risk', prose: 'Six layers.',
  },
  layers: [{ name: 'Layer 1', cover: 'USD 2.5m xs 2.5m', deposit_premium: 'USD 1.65m', rol: '66%', reinstatements: '3 @ 100%', expiring_line: '' }],
  experience: [], experience_note: '', flags: [], trace: [],
  executive_summary: 'Draft.', standard_pack: [], pack_reviews: [], changes: [], detailed_analysis: '', recommendations: [], data_quality: [],
};

test('the desk goes to market from the verified summary, through the four-eyes release', async () => {
  await withServer(async (api) => {
    const helvetia = await market(api, 'Helvetia Re', 'Jo Smith');
    const nordic = await market(api, 'Nordic Re', 'Anders Vik');
    const newco = await market(api, 'Newco Re', 'Ada Okoye');
    const silent = await market(api, 'Silent Re', null);

    // Last year: one layer, written by Helvetia and Nordic; Silent Re declined.
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Kenya Re' } });
    const prior = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property Risk XL', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    const { rows: [layer] } = await pool.query(
      `INSERT INTO layer (placement_id, name, type, attachment, limit_amt, currency) VALUES ($1, 'Layer 1', 'XoL', 2500000, 2500000, 'USD') RETURNING id`,
      [prior.body.id],
    );
    await pool.query(
      `INSERT INTO line (layer_id, market_id, written_pct, signed_pct, status) VALUES
         ($1, $2, 10, 7.5, 'SIGNED'), ($1, $3, 5, NULL, 'WRITTEN'), ($1, $4, 0, NULL, 'DECLINED')`,
      [layer.id, helvetia.id, nordic.id, silent.id],
    );

    // This year renews it.
    const current = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property Risk XL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
    });
    const pid = current.body.id;
    await pool.query('UPDATE placement SET renewal_of = $1 WHERE id = $2', [prior.body.id, pid]);

    // The uploaded pack: linked, drafted, not yet verified.
    const a = (await api('POST', '/api/renewal-analyses', {
      token: broker.token,
      body: { cedant_name: 'Kenya Re', class_of_business: 'Property', treaty_type: 'Risk XL' },
    })).body;
    await api('POST', `/api/renewal-analyses/${a.id}/documents`, {
      token: broker.token,
      body: { role: 'current', filename: 'Kenya_Re_2027.txt', mime_type: 'text/plain', content_base64: Buffer.from('Programme 2027').toString('base64') },
    });
    await api('PUT', `/api/renewal-analyses/${a.id}/placement`, { token: broker.token, body: { placement_id: pid } });
    await pool.query(
      `UPDATE renewal_pack_analysis SET status = 'complete', analysed_at = now(), result = $1 WHERE id = $2`,
      [JSON.stringify(RESULT), a.id],
    );

    // Unverified: the context says so and the send is refused — the gate is the API's.
    const unverified = await api('GET', `/api/renewal-analyses/${a.id}/submission`, { token: broker.token });
    assert.equal(unverified.status, 200);
    assert.equal(unverified.body.ready, false);
    assert.match(unverified.body.blockers.join(' '), /verified/);
    const blocked = await api('POST', `/api/renewal-analyses/${a.id}/submission`, {
      token: broker.token, body: { recipients: [{ market_id: helvetia.id, contact_id: helvetia.contact.id }] },
    });
    assert.equal(blocked.status, 409);

    await api('POST', `/api/renewal-analyses/${a.id}/verify`, { token: broker.token });
    const ctx = (await api('GET', `/api/renewal-analyses/${a.id}/submission`, { token: broker.token })).body;
    assert.equal(ctx.ready, true, JSON.stringify(ctx.blockers));
    assert.equal(ctx.prior_year.reference, prior.body.reference);
    assert.equal(ctx.prior_year.year, '2026');

    // The panel leads with last year's writers, then the rest of the register.
    const byName = Object.fromEntries(ctx.panel.map((m) => [m.name, m]));
    assert.deepEqual(ctx.panel.slice(0, 3).map((m) => m.name), ['Helvetia Re', 'Nordic Re', 'Silent Re']);
    assert.equal(byName['Helvetia Re'].prior_line, 7.5);
    assert.equal(byName['Helvetia Re'].wrote_last_year, true);
    assert.equal(byName['Helvetia Re'].default_selected, true);
    assert.equal(byName['Helvetia Re'].contact.email, 'jo@helvetia.example');
    assert.equal(byName['Nordic Re'].prior_line, 5, 'written where nothing was signed');
    assert.equal(byName['Nordic Re'].default_selected, true);
    assert.equal(byName['Silent Re'].prior_declined, true);
    assert.equal(byName['Silent Re'].wrote_last_year, false);
    assert.equal(byName['Silent Re'].selectable, false, 'no underwriter on file');
    assert.equal(byName['Newco Re'].prior_line, null);
    assert.equal(byName['Newco Re'].default_selected, false);
    assert.equal(byName['Newco Re'].selectable, true);
    assert.equal(byName['Helvetia Re'].standard_line, 7.5, 'the standing line reads across the book');

    // The template is drafted from the verified summary; the attachments are the pack and the two PDFs.
    assert.equal(ctx.template.subject, 'Kenya Re — Risk Excess of Loss 2027 — Firm Order Terms Invited');
    assert.match(ctx.template.body, /Dear \{\{contact_name\}\}/);
    assert.match(ctx.template.body, /EPI\s+USD 96\.4m/);
    assert.doesNotMatch(ctx.template.body, /Deposit premium/);
    assert.match(ctx.template.body, new RegExp(`close of business .*${ctx.template.response_deadline.slice(0, 4)}`));
    assert.deepEqual(ctx.attachments.map((x) => x.kind), ['source', 'summary', 'schedule']);
    assert.ok(ctx.attachments.every((x) => x.size_bytes > 0));
    assert.equal(ctx.submission, null);

    // The broker's send: awaiting the second pair of eyes.
    const sent = await api('POST', `/api/renewal-analyses/${a.id}/submission`, {
      token: broker.token,
      body: {
        subject: ctx.template.subject,
        body: `${ctx.template.body}\n\nP.S. checked by the broker.`,
        response_deadline: '2027-01-08',
        recipients: [
          { market_id: helvetia.id, contact_id: helvetia.contact.id },
          { market_id: nordic.id, contact_id: nordic.contact.id },
        ],
      },
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.equal(sent.body.status, 'pending_approval');
    assert.equal(sent.body.analysis_id, a.id);
    assert.equal(sent.body.pack_id, null);
    assert.equal(sent.body.broker_reviewed, true);
    assert.match(sent.body.subject, /\[BIQ-[0-9A-F]{8}\]$/);
    assert.equal(sent.body.recipients.length, 2);
    assert.equal(sent.body.recipients[0].role, 'lead');

    // One at a time; and an underwriter cannot draft, a broker cannot release.
    const again = await api('POST', `/api/renewal-analyses/${a.id}/submission`, {
      token: broker.token, body: { recipients: [{ market_id: newco.id, contact_id: newco.contact.id }] },
    });
    assert.equal(again.status, 409);
    const uwDraft = await api('POST', `/api/renewal-analyses/${a.id}/submission`, {
      token: uw.token, body: { recipients: [{ market_id: newco.id, contact_id: newco.contact.id }] },
    });
    assert.equal(uwDraft.status, 403);
    const selfRelease = await api('POST', `/api/negotiation-submissions/${sent.body.id}/approve`, { token: broker.token });
    assert.equal(selfRelease.status, 403);

    // The record and its detail carry the state for the tab strip.
    const pending = await api('GET', `/api/renewal-analyses/${a.id}`, { token: broker.token });
    assert.equal(pending.body.submission.status, 'pending_approval');
    assert.equal(pending.body.submission.recipients, 2);
    assert.equal(pending.body.submission.response_deadline, '2027-01-08');

    // The release mails each underwriter individually with the three attachments.
    const released = await api('POST', `/api/negotiation-submissions/${sent.body.id}/approve`, { token: uw.token });
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal(released.body.status, 'sent');
    const outbox = readOutbox();
    assert.equal(outbox.length, 2);
    assert.deepEqual(outbox.map((m) => m.to).sort(), ['Anders Vik <anders@nordic.example>', 'Jo Smith <jo@helvetia.example>']);
    assert.match(outbox.find((m) => m.to.startsWith('Jo')).text, /^Dear Jo Smith,/);
    assert.deepEqual(outbox[0].attachments.map((x) => x.filename), [
      'Kenya_Re_2027.txt', 'Kenya_Re_renewal_summary_verified.pdf', 'Kenya_Re_layer_schedule.pdf',
    ]);
    assert.ok(outbox[0].attachments.every((x) => x.bytes > 0));

    const done = await api('GET', `/api/renewal-analyses/${a.id}`, { token: broker.token });
    assert.equal(done.body.submission.status, 'sent');
    assert.equal(done.body.submission.delivered, 2);
    const register = await api('GET', `/api/placements/${pid}/negotiation/submissions`, { token: broker.token });
    assert.equal(register.body.length, 1, 'the submission is on the placement register');
    assert.equal(register.body[0].analysis_id, a.id);

    // The pack that went to market keeps its submission.
    const del = await api('DELETE', `/api/renewal-analyses/${a.id}`, { token: broker.token });
    assert.equal(del.status, 409);

    // Three days before the deadline, everyone who has not replied is reminded — once.
    await pool.query(`UPDATE negotiation_submission SET response_deadline = CURRENT_DATE + 2 WHERE id = $1`, [sent.body.id]);
    const first = await sendDueReminders();
    assert.deepEqual(first, { due: 2, reminded: 2 });
    assert.equal(readOutbox().length, 4);
    assert.match(readOutbox()[2].subject, /^Reminder: Kenya Re/);
    const second = await sendDueReminders();
    assert.deepEqual(second, { due: 0, reminded: 0 });
    const { rows: audits } = await pool.query(
      `SELECT action FROM audit_event WHERE entity_type = 'negotiation_submission' AND entity_id = $1 ORDER BY created_at, id`,
      [sent.body.id],
    );
    assert.deepEqual(audits.map((r) => r.action), ['draft', 'request_approval', 'release', 'remind', 'remind']);
  });
});

test('the desk submission falls back to the whole register with no prior year, and can be sent back and withdrawn', async () => {
  await withServer(async (api) => {
    const helvetia = await market(api, 'Helvetia Re', 'Jo Smith');
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Acme' } });
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
    });
    const a = (await api('POST', '/api/renewal-analyses', {
      token: broker.token, body: { cedant_name: 'Acme', class_of_business: 'Property', treaty_type: 'Quota Share' },
    })).body;
    await api('PUT', `/api/renewal-analyses/${a.id}/placement`, { token: broker.token, body: { placement_id: placement.body.id } });
    await pool.query(
      `UPDATE renewal_pack_analysis SET status = 'complete', analysed_at = now(), result = $1 WHERE id = $2`,
      [JSON.stringify(RESULT), a.id],
    );
    await api('POST', `/api/renewal-analyses/${a.id}/verify`, { token: broker.token });

    const ctx = (await api('GET', `/api/renewal-analyses/${a.id}/submission`, { token: broker.token })).body;
    assert.equal(ctx.prior_year, null);
    assert.equal(ctx.panel.length, 1);
    assert.equal(ctx.panel[0].default_selected, false, 'nothing wrote last year');
    assert.equal(ctx.panel[0].selectable, true);

    const sent = await api('POST', `/api/renewal-analyses/${a.id}/submission`, {
      token: broker.token, body: { recipients: [{ market_id: helvetia.id, contact_id: helvetia.contact.id }] },
    });
    assert.equal(sent.status, 201);
    const back = await api('POST', `/api/negotiation-submissions/${sent.body.id}/reject`, { token: uw.token, body: { reason: 'Name the deadline.' } });
    assert.equal(back.status, 200);
    assert.equal(back.body.status, 'draft');
    const state = await api('GET', `/api/renewal-analyses/${a.id}`, { token: broker.token });
    assert.equal(state.body.submission.status, 'draft');
    assert.equal(state.body.submission.reject_reason, 'Name the deadline.');

    // Withdrawn, the desk is clear for a fresh send.
    const gone = await api('POST', `/api/negotiation-submissions/${sent.body.id}/cancel`, { token: broker.token });
    assert.equal(gone.status, 200);
    const cleared = await api('GET', `/api/renewal-analyses/${a.id}`, { token: broker.token });
    assert.equal(cleared.body.submission, null);
  });
});
