import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let uw;

before(async () => {
  await resetDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

const details = {
  cedant_name: 'Acme Insurance',
  cedant_domicile: 'GB',
  class_of_business: 'Property CAT',
  treaty_type: 'Cat XL (Per Event)',
  cedant_notes: 'Long-standing client, growing book.',
};

const b64 = (s) => Buffer.from(s).toString('base64');

const expiringPack = {
  role: 'expiring',
  filename: 'expiring-pack.txt',
  mime_type: 'text/plain',
  content_base64: b64('Expiring programme: 10m xs 10m, premium 1,000,000, loss ratio 45%'),
};
const currentPack = {
  role: 'current',
  filename: 'current-pack.txt',
  mime_type: 'text/plain',
  content_base64: b64('Renewal programme: 12m xs 10m, premium 1,150,000, loss ratio 52%'),
};

test('renewal pack analysis: create → upload → run without providers → 503 recorded as failed', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/renewal-analyses', { token: broker.token, body: details });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, 'draft');
    const id = created.body.id;

    // Running with no packs uploaded conflicts.
    const early = await api('POST', `/api/renewal-analyses/${id}/run`, { token: broker.token });
    assert.equal(early.status, 409);

    // Upload the expiring and current packs.
    const up1 = await api('POST', `/api/renewal-analyses/${id}/documents`, { token: broker.token, body: expiringPack });
    assert.equal(up1.status, 201);
    assert.equal(up1.body.role, 'expiring');
    assert.ok(!('content' in up1.body), 'raw content must not be echoed back');
    const up2 = await api('POST', `/api/renewal-analyses/${id}/documents`, { token: broker.token, body: currentPack });
    assert.equal(up2.status, 201);

    // Detail lists documents without blobs, plus provider availability.
    const detail = await api('GET', `/api/renewal-analyses/${id}`, { token: uw.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.documents.length, 2);
    assert.ok(Array.isArray(detail.body.providers));

    // No AI keys in the test environment: the run reports 503 with the
    // attempted providers, and the analysis records the failure.
    const run = await api('POST', `/api/renewal-analyses/${id}/run`, { token: broker.token });
    assert.equal(run.status, 503);
    assert.equal(run.body.code, 'llm_unavailable');
    assert.ok(Array.isArray(run.body.attempts));

    const failed = await api('GET', `/api/renewal-analyses/${id}`, { token: broker.token });
    assert.equal(failed.body.status, 'failed');
    assert.ok(failed.body.error);

    // Listing shows counts, roles and the recorded status.
    const list = await api('GET', '/api/renewal-analyses', { token: broker.token });
    assert.equal(list.status, 200);
    const row = list.body.find((a) => a.id === id);
    assert.equal(row.doc_count, 2);
    assert.deepEqual([...row.doc_roles].sort(), ['current', 'expiring']);
    assert.equal(row.status, 'failed');

    // Documents can be removed; the analysis can be deleted (cascades).
    const del = await api('DELETE', `/api/renewal-analyses/${id}/documents/${up2.body.id}`, { token: broker.token });
    assert.equal(del.status, 204);
    const gone = await api('DELETE', `/api/renewal-analyses/${id}`, { token: broker.token });
    assert.equal(gone.status, 204);
    const after404 = await api('GET', `/api/renewal-analyses/${id}`, { token: broker.token });
    assert.equal(after404.status, 404);
  });
});

test('renewal pack analysis: validation and role gating', async () => {
  await withServer(async (api) => {
    const bad = await api('POST', '/api/renewal-analyses', { token: broker.token, body: { cedant_name: 'X' } });
    assert.equal(bad.status, 422);

    // Underwriters can read and run, but not create/upload.
    const denied = await api('POST', '/api/renewal-analyses', { token: uw.token, body: details });
    assert.equal(denied.status, 403);

    const created = await api('POST', '/api/renewal-analyses', { token: broker.token, body: details });
    const id = created.body.id;

    const uwUpload = await api('POST', `/api/renewal-analyses/${id}/documents`, { token: uw.token, body: expiringPack });
    assert.equal(uwUpload.status, 403);
    const canRead = await api('GET', '/api/renewal-analyses', { token: uw.token });
    assert.equal(canRead.status, 200);

    // Bad uploads: unknown role, empty content.
    const badRole = await api('POST', `/api/renewal-analyses/${id}/documents`, {
      token: broker.token, body: { ...expiringPack, role: 'renewal' },
    });
    assert.equal(badRole.status, 422);
    const empty = await api('POST', `/api/renewal-analyses/${id}/documents`, {
      token: broker.token, body: { ...expiringPack, content_base64: '!!!' },
    });
    assert.equal(empty.status, 422);

    const anon = await api('GET', '/api/renewal-analyses');
    assert.equal(anon.status, 401);
  });
});

test('renewal pack analysis: linking to a placement, and back off again', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/renewal-analyses', { token: broker.token, body: details });
    const id = created.body.id;
    assert.equal(created.body.placement_id, null, 'an analysis starts unlinked');

    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Acme Insurance' } });
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: {
        cedant_id: cedant.body.id, class: 'Property CAT',
        inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD',
      },
    });
    const pid = placement.body.id;

    // Only a broker may link.
    const denied = await api('PUT', `/api/renewal-analyses/${id}/placement`, {
      token: uw.token, body: { placement_id: pid },
    });
    assert.equal(denied.status, 403);

    // A placement that does not exist is a 404, not a dangling link.
    const missing = await api('PUT', `/api/renewal-analyses/${id}/placement`, {
      token: broker.token, body: { placement_id: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(missing.status, 404);

    const linked = await api('PUT', `/api/renewal-analyses/${id}/placement`, {
      token: broker.token, body: { placement_id: pid },
    });
    assert.equal(linked.status, 200);
    assert.equal(linked.body.placement_id, pid);
    assert.equal(linked.body.placement.reference, placement.body.reference);
    assert.equal(linked.body.placement.cedant_name, 'Acme Insurance');

    // The detail carries the placement, and the list can be filtered by it —
    // that is how the pack builder finds the upload behind its placement.
    const detail = await api('GET', `/api/renewal-analyses/${id}`, { token: broker.token });
    assert.equal(detail.body.placement.id, pid);
    const filtered = await api('GET', `/api/renewal-analyses?placement_id=${pid}`, { token: broker.token });
    assert.deepEqual(filtered.body.map((r) => r.id), [id]);
    assert.equal(filtered.body[0].placement_reference, placement.body.reference);
    // Never analysed, so there are no standardised sections — the counts the
    // placement page reads have to say 0 of 0, not fail on a null result.
    assert.equal(filtered.body[0].sections_total, 0);
    assert.equal(filtered.body[0].sections_supplied, 0);

    // With a standardised pack on the row they are counted in SQL, so the
    // list never has to carry the result itself.
    await pool.query(
      'UPDATE renewal_pack_analysis SET result = $1 WHERE id = $2',
      [JSON.stringify({
        standard_pack: [
          { section: 'Programme structure', status: 'supplied' },
          { section: 'Large loss listing', status: 'supplied' },
          { section: 'Cat model output', status: 'partial' },
          { section: 'Cedant financials & ESG', status: 'missing' },
        ],
      }), id],
    );
    const counted = await api('GET', `/api/renewal-analyses?placement_id=${pid}`, { token: broker.token });
    assert.equal(counted.body[0].sections_total, 4);
    assert.equal(counted.body[0].sections_supplied, 2);

    // A built pack records the upload it was composed from.
    const pack = await api('POST', `/api/placements/${pid}/packs`, {
      token: broker.token,
      body: { source_analysis_id: id, source_label: 'Uploaded renewal pack' },
    });
    assert.equal(pack.status, 201);
    assert.equal(pack.body.source_analysis_id, id);

    // Unlinking clears it without touching the analysis itself.
    const cleared = await api('PUT', `/api/renewal-analyses/${id}/placement`, {
      token: broker.token, body: { placement_id: null },
    });
    assert.equal(cleared.body.placement_id, null);
    assert.equal(cleared.body.placement, null);
    assert.equal(cleared.body.cedant_name, details.cedant_name);
    const none = await api('GET', `/api/renewal-analyses?placement_id=${pid}`, { token: broker.token });
    assert.deepEqual(none.body, []);
  });
});

test('renewal pack analysis: broker sign-off is server-side, gated, audited, and cleared by a new draft', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/renewal-analyses', { token: broker.token, body: details });
    const id = created.body.id;

    // Nothing to sign off before a draft exists.
    const early = await api('POST', `/api/renewal-analyses/${id}/verify`, { token: broker.token });
    assert.equal(early.status, 409);

    // A draft written straight to the record — the model is not reachable in tests.
    const draft = { executive_summary: 'Draft.', programme: { prose: 'Six layers.', epi: 'USD 96.4m' }, flags: [] };
    await pool.query(
      `UPDATE renewal_pack_analysis SET status = 'complete', analysed_at = now(), result = $1 WHERE id = $2`,
      [JSON.stringify(draft), id],
    );

    // An underwriter reads the draft but cannot sign it off.
    const denied = await api('POST', `/api/renewal-analyses/${id}/verify`, { token: uw.token });
    assert.equal(denied.status, 403);

    const verified = await api('POST', `/api/renewal-analyses/${id}/verify`, { token: broker.token });
    assert.equal(verified.status, 200);
    assert.ok(verified.body.verified_at);
    assert.equal(verified.body.verified_by, broker.user.id);
    assert.equal(verified.body.verified_by_name, broker.user.name);
    assert.equal(verified.body.created_by_name, broker.user.name);
    assert.equal(verified.body.documents.length, 0, 'the verify response is the detail shape');

    // A second sign-off leaves the first broker's stamp in place.
    const again = await api('POST', `/api/renewal-analyses/${id}/verify`, { token: broker.token });
    assert.equal(again.body.verified_at, verified.body.verified_at);

    // A correction to the prose is the broker's to make, and re-flags the draft.
    const edited = await api('PATCH', `/api/renewal-analyses/${id}/summary`, {
      token: broker.token, body: { programme_prose: 'Six layers, retention USD 2.5m.' },
    });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.verified_at, null);
    assert.equal(edited.body.result.programme.prose, 'Six layers, retention USD 2.5m.');
    assert.equal(edited.body.result.programme.epi, 'USD 96.4m', 'the rest of the programme is kept');
    assert.equal(edited.body.result.executive_summary, 'Draft.');
    const nothing = await api('PATCH', `/api/renewal-analyses/${id}/summary`, { token: broker.token, body: {} });
    assert.equal(nothing.status, 422);

    // Signed off again; a pack added afterwards clears it — the sign-off was
    // given for the packs as they were.
    await api('POST', `/api/renewal-analyses/${id}/verify`, { token: broker.token });
    const up = await api('POST', `/api/renewal-analyses/${id}/documents`, { token: broker.token, body: expiringPack });
    assert.equal(up.status, 201);
    const afterUpload = await api('GET', `/api/renewal-analyses/${id}`, { token: broker.token });
    assert.equal(afterUpload.body.verified_at, null);
    assert.equal(afterUpload.body.verified_by_name, null);

    // Signed off, then withdrawn.
    await api('POST', `/api/renewal-analyses/${id}/verify`, { token: broker.token });
    const withdrawn = await api('DELETE', `/api/renewal-analyses/${id}/verify`, { token: broker.token });
    assert.equal(withdrawn.status, 200);
    assert.equal(withdrawn.body.verified_at, null);

    // The list carries the stamp, and the audit trail carries every step
    // with the state either side.
    const list = await api('GET', '/api/renewal-analyses', { token: broker.token });
    assert.ok('verified_at' in list.body.find((a) => a.id === id));
    const { rows: audits } = await pool.query(
      `SELECT action, before_state, after_state FROM audit_event
       WHERE entity_id = $1 AND action IN ('verify', 'unverify', 'edit_summary') ORDER BY created_at, id`,
      [id],
    );
    assert.deepEqual(audits.map((r) => r.action), ['verify', 'edit_summary', 'verify', 'verify', 'unverify']);
    assert.equal(audits[0].before_state.verified_at, null);
    assert.equal(audits[0].after_state.verified_by, broker.user.id);
    assert.equal(audits[4].after_state.verified_at, null);
  });
});
