// The placement modelling store: per-screen sections saved by the modelling
// workflow (triangles, straight stats, losses, dev factors, …). One upsert per
// section, replaced wholesale on save, readable together for hydration.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let underwriter;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  underwriter = await makeUser('underwriter');
});

async function makePlacement(api) {
  const cedant = await api('POST', '/api/cedants', {
    token: broker.token,
    body: { name: 'Acme Insurance', domicile: 'GB' },
  });
  assert.equal(cedant.status, 201);
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property QS', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  assert.equal(placement.status, 201);
  return placement.body;
}

test('sections upsert, replace wholesale, and read back individually or together', async () => {
  await withServer(async (api) => {
    const p = await makePlacement(api);

    // Nothing saved yet.
    const empty = await api('GET', `/api/placements/${p.id}/modelling`, { token: broker.token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.sections, {});

    // Save a triangle section.
    const cells = { MODIFIED: { cells: [{ origin_year: 2022, dev_months: 12, cum_value: 1000 }] }, ACTUAL: { cells: [] } };
    const put = await api('PUT', `/api/placements/${p.id}/modelling/triangle_premium`, {
      token: broker.token, body: { data: cells },
    });
    assert.equal(put.status, 200);
    assert.equal(put.body.section, 'triangle_premium');
    assert.equal(put.body.data.MODIFIED.cells[0].cum_value, 1000);

    // Second save replaces, never merges.
    const replaced = await api('PUT', `/api/placements/${p.id}/modelling/triangle_premium`, {
      token: broker.token, body: { data: { MODIFIED: { cells: [] }, ACTUAL: { cells: [] } } },
    });
    assert.equal(replaced.status, 200);
    assert.deepEqual(replaced.body.data.MODIFIED.cells, []);

    // A second section sits beside it.
    await api('PUT', `/api/placements/${p.id}/modelling/straight_stats`, {
      token: broker.token, body: { data: { stats: [{ year: 2024, premium: 5000, paid: 100, os: 50 }] } },
    });

    const all = await api('GET', `/api/placements/${p.id}/modelling`, { token: broker.token });
    assert.deepEqual(Object.keys(all.body.sections).sort(), ['straight_stats', 'triangle_premium']);

    const single = await api('GET', `/api/placements/${p.id}/modelling/straight_stats`, { token: broker.token });
    assert.equal(single.status, 200);
    assert.equal(single.body.data.stats[0].premium, 5000);

    // Missing section reads as null, not 404 — screens hydrate from nothing.
    const missing = await api('GET', `/api/placements/${p.id}/modelling/cresta`, { token: broker.token });
    assert.equal(missing.status, 200);
    assert.equal(missing.body.data, null);
  });
});

test('writes need broker/admin; reads need only a signed-in user; keys are validated', async () => {
  await withServer(async (api) => {
    const p = await makePlacement(api);

    // Underwriter can read but not write.
    const denied = await api('PUT', `/api/placements/${p.id}/modelling/cresta`, {
      token: underwriter.token, body: { data: { zones: [] } },
    });
    assert.equal(denied.status, 403);
    await api('PUT', `/api/placements/${p.id}/modelling/cresta`, { token: broker.token, body: { data: { zones: [] } } });
    const read = await api('GET', `/api/placements/${p.id}/modelling`, { token: underwriter.token });
    assert.equal(read.status, 200);
    assert.ok(read.body.sections.cresta);

    // Anonymous is rejected.
    assert.equal((await api('GET', `/api/placements/${p.id}/modelling`)).status, 401);

    // A section key that fails the pattern is refused.
    const bad = await api('PUT', `/api/placements/${p.id}/modelling/Bad%20Key!`, {
      token: broker.token, body: { data: {} },
    });
    assert.equal(bad.status, 422);

    // Unknown placement is a 404.
    const ghost = await api('GET', '/api/placements/00000000-0000-0000-0000-000000000000/modelling', { token: broker.token });
    assert.equal(ghost.status, 404);
  });
});

test('delete removes a section and is idempotent about reporting', async () => {
  await withServer(async (api) => {
    const p = await makePlacement(api);
    await api('PUT', `/api/placements/${p.id}/modelling/event_loss_tables`, {
      token: broker.token, body: { data: { vendor: 'AIR', rows: [] } },
    });
    const del = await api('DELETE', `/api/placements/${p.id}/modelling/event_loss_tables`, { token: broker.token });
    assert.equal(del.status, 200);
    assert.equal(del.body.deleted, true);
    const again = await api('DELETE', `/api/placements/${p.id}/modelling/event_loss_tables`, { token: broker.token });
    assert.equal(again.body.deleted, false);
    const all = await api('GET', `/api/placements/${p.id}/modelling`, { token: broker.token });
    assert.deepEqual(all.body.sections, {});
  });
});

/* ── The standardised modelling pack and its AI analysis ── */

test('the modelling pack lists a sheet per screen per class, exports as Excel, and the analysis reports 503 without an AI key', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Two Class Mutual', domicile: 'GB' } });
    const created = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property / Motor Quota Share', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    assert.equal(created.status, 201);
    const p = created.body;

    // Nothing entered: no sheets, no analysis, and the analysis refuses to run.
    const empty = await api('GET', `/api/placements/${p.id}/modelling/pack`, { token: broker.token });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.classes.map((c) => [c.name, c.screens.length]), [['Property', 0], ['Motor', 0]]);
    assert.equal(empty.body.analysis, null);
    const nothing = await api('POST', `/api/placements/${p.id}/modelling/analysis`, { token: broker.token, body: {} });
    assert.equal(nothing.status, 422);

    // Property's premium triangle and Motor's large losses.
    await api('PUT', `/api/placements/${p.id}/modelling/triangle_premium:property`, {
      token: broker.token,
      body: { data: { MODIFIED: { cells: [{ origin_year: 2022, dev_months: 12, cum_value: 1000000 }] }, ACTUAL: { cells: [] } } },
    });
    await api('PUT', `/api/placements/${p.id}/modelling/large_losses:motor`, {
      token: broker.token,
      body: { data: { rows: [{ uw_year: 2024, insured_name: 'Fleet Co', gross_loss: 400000, paid: 100000, os: 250000 }] } },
    });

    const pack = await api('GET', `/api/placements/${p.id}/modelling/pack`, { token: broker.token });
    assert.equal(pack.status, 200);
    assert.deepEqual(
      pack.body.classes.map((c) => [c.name, c.screens.map((s) => s.title)]),
      [['Property', ['Premium Triangle']], ['Motor', ['Large Loss List']]],
    );
    assert.equal(pack.body.providers[0].provider, 'openai');

    // The Excel pack: a real workbook named for the placement.
    const xlsx = await api('GET', `/api/placements/${p.id}/modelling/pack.xlsx`, { token: broker.token, raw: true });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
    assert.match(xlsx.headers.get('content-disposition'), new RegExp(`${p.reference}-modelling-pack.xlsx`));
    const bytes = Buffer.from(await xlsx.arrayBuffer());
    assert.equal(bytes.slice(0, 2).toString(), 'PK');
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Cover', 'Property · Premium Triangle', 'Motor · Large Loss List']);

    // The underwriter can read and export but not analyse.
    const uwPack = await api('GET', `/api/placements/${p.id}/modelling/pack.xlsx`, { token: underwriter.token, raw: true });
    assert.equal(uwPack.status, 200);

    // No AI key in the test environment: 503 with the provider list, and nothing stored.
    const run = await api('POST', `/api/placements/${p.id}/modelling/analysis`, { token: broker.token, body: {} });
    assert.equal(run.status, 503);
    assert.equal(run.body.code, 'llm_unavailable');
    assert.equal(run.body.providers[0].configured, false);
    const after = await api('GET', `/api/placements/${p.id}/modelling/pack`, { token: broker.token });
    assert.equal(after.body.analysis, null);
  });
});

test('raw data uploads sit beside the screens; the cross-check needs uploads and an AI key', async () => {
  await withServer(async (api) => {
    const p = await makePlacement(api);
    // Nothing on the screens yet: the cross-check refuses before looking for uploads.
    const early = await api('POST', `/api/placements/${p.id}/modelling/crosscheck`, { token: broker.token, body: {} });
    assert.equal(early.status, 422);
    await api('PUT', `/api/placements/${p.id}/modelling/large_losses`, {
      token: broker.token, body: { data: { rows: [{ uw_year: 2024, insured_name: 'A', gross_loss: 500000 }] } },
    });
    const noDocs = await api('POST', `/api/placements/${p.id}/modelling/crosscheck`, { token: broker.token, body: {} });
    assert.equal(noDocs.status, 422);
    assert.match(noDocs.body.error, /Upload the raw data/);

    // Upload a CSV loss run; it lists on the pack, with its note.
    const csv = 'uw_year,insured,gross\n2024,A,450000\n';
    const up = await api('POST', `/api/placements/${p.id}/modelling/documents`, {
      token: broker.token,
      body: { filename: 'loss-run.csv', mime_type: 'text/csv', content_base64: Buffer.from(csv).toString('base64'), note: '2024 loss run' },
    });
    assert.equal(up.status, 201);
    assert.equal(up.body.filename, 'loss-run.csv');
    assert.equal(up.body.size_bytes, csv.length);
    assert.equal(up.body.content, undefined, 'the bytes stay on the server');
    const pack = await api('GET', `/api/placements/${p.id}/modelling/pack`, { token: broker.token });
    assert.deepEqual(pack.body.documents.map((d) => [d.filename, d.note]), [['loss-run.csv', '2024 loss run']]);
    assert.equal(pack.body.crosscheck, null);

    // Underwriters read but cannot upload; empty uploads are refused.
    const uw = await api('POST', `/api/placements/${p.id}/modelling/documents`, {
      token: underwriter.token, body: { filename: 'x.csv', mime_type: 'text/csv', content_base64: 'YQ==' },
    });
    assert.equal(uw.status, 403);
    const empty = await api('POST', `/api/placements/${p.id}/modelling/documents`, {
      token: broker.token, body: { filename: 'x.csv', mime_type: 'text/csv', content_base64: '====' },
    });
    assert.equal(empty.status, 422);

    // No AI key in the test environment: 503, and nothing stored.
    const run = await api('POST', `/api/placements/${p.id}/modelling/crosscheck`, { token: broker.token, body: {} });
    assert.equal(run.status, 503);
    assert.equal(run.body.code, 'llm_unavailable');

    // Delete, and it is gone from the pack.
    const del = await api('DELETE', `/api/placements/${p.id}/modelling/documents/${up.body.id}`, { token: broker.token });
    assert.equal(del.status, 204);
    const again = await api('DELETE', `/api/placements/${p.id}/modelling/documents/${up.body.id}`, { token: broker.token });
    assert.equal(again.status, 404);
    const after = await api('GET', `/api/placements/${p.id}/modelling/pack`, { token: broker.token });
    assert.deepEqual(after.body.documents, []);
  });
});
