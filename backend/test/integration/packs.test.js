import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { sectionKeys } from '../../src/modules/packs/packs.template.js';

let broker;
let senior;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
});

const PREMIUM_ROWS = [
  { policy_ref: 'P-001', insured: 'Acme Mills', class_of_business: 'Property', territory: 'Kenya',
    sum_insured_100: '5000000', si_ceded: '4000000', premium_ceded: '20000', gross_premium_100: '25000' },
];
const CLAIMS_ROWS = [
  { claim_ref: 'C-001', policy_ref: 'P-001', date_of_loss: '2026-03-04', cause_of_loss: 'Fire',
    paid: '20000', outstanding: '5000' },
];

async function seedPlacement(api, overrides = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Pack Cedant', domicile: 'Kenya' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2026-01-01',
      expiry: '2026-12-31', currency: 'USD', ...overrides,
    },
  });
  assert.equal(placement.status, 201);
  return placement.body.id;
}

test('a pack built with no data still carries the whole template', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const built = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(built.status, 201);
    assert.equal(built.body.version, 1);
    assert.equal(built.body.basis, 'NP', 'a cat XoL placement runs the NP template');
    assert.equal(built.body.template_version, 2);

    const snapshot = built.body.snapshot;
    assert.deepEqual(snapshot.sections.map((s) => s.key), sectionKeys('NP'));
    assert.equal(snapshot.summary.sections_total, sectionKeys('NP').length);
    assert.equal(snapshot.summary.sections_filled, 1, 'only treaty detail');
    assert.ok(snapshot.groups.some((g) => g.label === 'Structure'));
    // The empty sections are still there, each saying what would fill it.
    const claims = snapshot.sections.find((s) => s.key === 'claims_experience');
    assert.equal(claims.status, 'empty');
    assert.match(claims.note, /claims bordereau/i);
  });
});

test('a proportional placement runs the proportional template', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api, { class: 'Property Quota Share' });
    const built = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(built.body.basis, 'PROP');
    const keys = built.body.snapshot.sections.map((s) => s.key);
    assert.ok(keys.includes('historical_epi'), 'prop-only section present');
    assert.ok(!keys.includes('premiums_table'), 'NP-only section absent');
  });
});

test('versions are cut in order, record what changed, and never rewrite an earlier one', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const v1 = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(v1.body.version, 1);
    assert.deepEqual(v1.body.changes, [], 'the first version has nothing to compare against');

    // Import bordereaux, then cut v2.
    for (const [type, rows] of [['premium', PREMIUM_ROWS], ['claims', CLAIMS_ROWS]]) {
      await api('POST', `/api/placements/${pid}/bordereaux`, {
        token: broker.token, body: { type, source_file: `${type}.csv`, rows },
      });
    }
    const v2 = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(v2.body.version, 2);
    assert.ok(v2.body.summary.sections_filled > v1.body.summary.sections_filled);
    const changed = Object.fromEntries(v2.body.changes.map((c) => [c.key, c.change]));
    assert.equal(changed.premium_experience, 'filled');
    assert.equal(changed.claims_experience, 'filled');
    assert.equal(changed.large_loss_list, 'filled');
    assert.equal(v2.body.snapshot.summary.loss_ratio_pct, 125);

    // v1 is untouched by v2 — a market already sent v1 still reads v1.
    const readV1 = await api('GET', `/api/packs/${v1.body.id}`, { token: broker.token });
    assert.equal(readV1.body.summary.sections_filled, 1);
    assert.equal(
      readV1.body.snapshot.sections.find((s) => s.key === 'premium_experience').status,
      'empty',
    );

    // The history lists newest first, without the heavy snapshots.
    const list = await api('GET', `/api/placements/${pid}/packs`, { token: broker.token });
    assert.deepEqual(list.body.map((p) => p.version), [2, 1]);
    assert.equal(list.body[0].snapshot, undefined, 'the list stays light');
    assert.equal(list.body[0].summary.sections_filled, v2.body.summary.sections_filled);
  });
});

test('the preview shows what a version would contain without cutting one', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const preview = await api('GET', `/api/placements/${pid}/pack-preview`, { token: broker.token });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.snapshot.sections.length, sectionKeys('NP').length);
    const list = await api('GET', `/api/placements/${pid}/packs`, { token: broker.token });
    assert.equal(list.body.length, 0, 'previewing does not cut a version');
  });
});

test('the template is readable before any pack exists', async () => {
  await withServer(async (api) => {
    const res = await api('GET', '/api/pack-template?basis=PROP', { token: broker.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.basis, 'PROP');
    assert.deepEqual(res.body.groups.flatMap((g) => g.keys), sectionKeys('PROP'));
    assert.deepEqual(Object.keys(res.body.bases).sort(), ['NP', 'PROP']);
  });
});

test('a version is submitted by the broker and approved by a Senior Broker, once', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    const id = pack.body.id;

    // Nothing is approved before it is submitted, and a broker cannot approve at all.
    assert.equal((await api('POST', `/api/packs/${id}/approve`, { token: senior.token, body: {} })).status, 409);
    assert.equal((await api('POST', `/api/packs/${id}/approve`, { token: broker.token, body: {} })).status, 403);

    const submitted = await api('POST', `/api/packs/${id}/submit`, { token: broker.token, body: {} });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, 'submitted');
    assert.equal(submitted.body.submitted_by, broker.user.id);
    assert.ok(submitted.body.submitted_at);
    assert.equal((await api('POST', `/api/packs/${id}/submit`, { token: broker.token, body: {} })).status, 409, 'submitted once');

    // Four-eyes: a senior broker who submitted it cannot also approve it.
    const seniorPack = await api('POST', `/api/placements/${pid}/packs`, { token: senior.token, body: {} });
    await api('POST', `/api/packs/${seniorPack.body.id}/submit`, { token: senior.token, body: {} });
    const own = await api('POST', `/api/packs/${seniorPack.body.id}/approve`, { token: senior.token, body: {} });
    assert.equal(own.status, 409);
    assert.match(own.body.error, /four-eyes/i);

    const approved = await api('POST', `/api/packs/${id}/approve`, { token: senior.token, body: {} });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.approved_by, senior.user.id);
    assert.ok(approved.body.approved_at);
    assert.equal((await api('POST', `/api/packs/${id}/approve`, { token: senior.token, body: {} })).status, 409);

    // The version list carries the approval trail.
    const list = await api('GET', `/api/placements/${pid}/packs`, { token: broker.token });
    const v1 = list.body.find((p) => p.id === id);
    assert.equal(v1.status, 'approved');
    assert.equal(v1.approved_by_name, senior.user.name);
    assert.equal(v1.submitted_by_name, broker.user.name);
  });
});

test('a version created without data on a required screen cannot be submitted', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const rows = [
      { key: 'detail', label: 'Treaty Detail', group: 'Placement', scope: 'placement', done: [true], required: true },
      { key: 'm:large_list', label: 'Large Loss List', group: 'Large Losses', scope: 'class', done: [false], required: true },
      { key: 'm:cat_list', label: 'Cat Loss List', group: 'Cat Losses', scope: 'class', done: [false], required: false },
    ];
    const blocked = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: { screens: { cobs: [], rows } } });
    const refused = await api('POST', `/api/packs/${blocked.body.id}/submit`, { token: broker.token, body: {} });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Large Loss List/);
    assert.doesNotMatch(refused.body.error, /Cat Loss List/, 'only the required screens block');
    assert.equal((await api('GET', `/api/packs/${blocked.body.id}`, { token: broker.token })).body.status, 'draft');

    // With the required screen filled, the next version goes through.
    rows[1].done = [true];
    const ok = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: { screens: { cobs: [], rows } } });
    assert.equal((await api('POST', `/api/packs/${ok.body.id}/submit`, { token: broker.token, body: {} })).status, 200);
  });
});

test('a Senior Broker can return a submitted version with a note, and it goes back to draft', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    const id = pack.body.id;
    assert.equal((await api('POST', `/api/packs/${id}/reject`, { token: senior.token, body: { note: 'x' } })).status, 409, 'only a submitted pack is returned');
    await api('POST', `/api/packs/${id}/submit`, { token: broker.token, body: {} });
    assert.equal((await api('POST', `/api/packs/${id}/reject`, { token: senior.token, body: {} })).status, 422, 'a note is required');
    assert.equal((await api('POST', `/api/packs/${id}/reject`, { token: broker.token, body: { note: 'x' } })).status, 403);

    const returned = await api('POST', `/api/packs/${id}/reject`, { token: senior.token, body: { note: 'Large losses need the 2025 run.' } });
    assert.equal(returned.status, 200);
    assert.equal(returned.body.status, 'draft');
    assert.equal(returned.body.rejected_by_name, senior.user.name);
    assert.equal(returned.body.rejection_note, 'Large losses need the 2025 run.');
    assert.equal(returned.body.submitted_by, null);

    // Resubmitting clears the note; approval then follows.
    const again = await api('POST', `/api/packs/${id}/submit`, { token: broker.token, body: {} });
    assert.equal(again.body.rejection_note, null);
    assert.equal((await api('POST', `/api/packs/${id}/approve`, { token: senior.token, body: {} })).body.status, 'approved');
  });
});

test('a senior broker can do what a broker does', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', { token: senior.token, body: { name: 'Senior Cedant', domicile: 'Kenya' } });
    assert.equal(cedant.status, 201);
    const placement = await api('POST', '/api/placements', {
      token: senior.token,
      body: { cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    assert.equal(placement.status, 201);
    const built = await api('POST', `/api/placements/${placement.body.id}/packs`, { token: senior.token, body: {} });
    assert.equal(built.status, 201);
  });
});

test('a built version exports to Excel, CSV and PDF', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    for (const [type, rows] of [['premium', PREMIUM_ROWS], ['claims', CLAIMS_ROWS]]) {
      await api('POST', `/api/placements/${pid}/bordereaux`, {
        token: broker.token, body: { type, source_file: `${type}.csv`, rows },
      });
    }
    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });

    // Excel — a real zip container (xlsx files start "PK"), named for the pack.
    const xlsx = await api('GET', `/api/packs/${pack.body.id}/export?format=xlsx`, { token: broker.token, raw: true });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-type'), /spreadsheetml/);
    assert.match(xlsx.headers.get('content-disposition'), /RenewalPack_v1_.*\.xlsx/);
    const xlsxBody = Buffer.from(await xlsx.arrayBuffer());
    assert.equal(xlsxBody.subarray(0, 2).toString(), 'PK');
    assert.ok(xlsxBody.length > 5000, 'a workbook with a sheet per section is not tiny');

    // CSV — every section titled, in template order, empties included.
    const csv = await api('GET', `/api/packs/${pack.body.id}/export?format=csv`, { token: broker.token, raw: true });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    const text = await csv.text();
    assert.match(text, /Renewal Pack v1/);
    assert.match(text, /SECTION 1: Treaty Detail,FILLED/);
    assert.match(text, /SECTION \d+: Premium Experience,FILLED/);
    assert.match(text, /SECTION \d+: Event Loss Tables,EMPTY/, 'empty sections still appear');
    assert.match(text, /Premium ceded,20000/);

    // PDF — a real PDF header, and a document of some substance.
    const pdf = await api('GET', `/api/packs/${pack.body.id}/export?format=pdf`, { token: broker.token, raw: true });
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get('content-type'), /application\/pdf/);
    const pdfBody = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBody.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdfBody.length > 3000);
  });
});

test('an unknown export format is refused', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    const res = await api('GET', `/api/packs/${pack.body.id}/export?format=docx`, { token: broker.token });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /xlsx, csv or pdf/);
  });
});

test('creating a renewal pack stores its Excel and PDF with the version and records the screen checklist', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const screens = {
      cobs: ['Fire', 'Motor'],
      rows: [
        { key: 'detail', label: 'Treaty Detail', group: 'Placement', scope: 'placement', done: [true] },
        { key: 'm:large_list', label: 'Large Loss List', group: 'Large Losses', scope: 'class', done: [true, false] },
        { key: 'm:cat_list', label: 'Cat Loss List', group: 'Cat Losses', scope: 'class', done: [false, false], required: true },
      ],
    };
    const created = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: { screens } });
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1);

    // The files are rendered at creation and reported with the version.
    assert.match(created.body.files.xlsx.filename, /RenewalPack_v1_.*\.xlsx$/);
    assert.match(created.body.files.pdf.filename, /RenewalPack_v1_.*\.pdf$/);
    assert.ok(created.body.files.xlsx.bytes > 5000, 'the workbook is a real file');
    assert.ok(created.body.files.pdf.bytes > 3000, 'the PDF is a real file');

    // ... and held in SQL beside the snapshot.
    const { rows: stored } = await pool.query(
      'SELECT format, bytes, octet_length(content) AS actual FROM renewal_pack_file WHERE pack_id = $1 ORDER BY format',
      [created.body.id],
    );
    assert.deepEqual(stored.map((r) => r.format), ['pdf', 'xlsx']);
    for (const r of stored) assert.equal(r.bytes, r.actual);

    // The checklist of screens is on the snapshot, counted.
    const rec = created.body.snapshot.screens;
    assert.deepEqual(rec.cobs, ['Fire', 'Motor']);
    assert.equal(rec.total, 5, 'one cell for the placement screen, one per class for the modelling screens');
    assert.equal(rec.filled, 2);
    assert.deepEqual(rec.missing, ['Large Loss List', 'Cat Loss List']);
    assert.deepEqual(rec.required_missing, ['Cat Loss List']);

    // The version list says which files each version carries, without the bytes.
    const list = await api('GET', `/api/placements/${pid}/packs`, { token: broker.token });
    assert.equal(list.body[0].files.xlsx.bytes, created.body.files.xlsx.bytes);
    assert.equal(list.body[0].files.xlsx.content, undefined);

    // Exporting serves the stored bytes, and the workbook carries the Screens sheet.
    const xlsx = await api('GET', `/api/packs/${created.body.id}/export?format=xlsx`, { token: broker.token, raw: true });
    assert.equal(xlsx.status, 200);
    assert.match(xlsx.headers.get('content-disposition'), new RegExp(created.body.files.xlsx.filename));
    const xlsxBody = Buffer.from(await xlsx.arrayBuffer());
    assert.equal(xlsxBody.length, created.body.files.xlsx.bytes, 'the download is the stored file');
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBody);
    assert.deepEqual(wb.worksheets.slice(0, 2).map((w) => w.name), ['Cover', 'Screens']);
    const screensSheet = wb.getWorksheet('Screens');
    assert.deepEqual(screensSheet.getRow(4).values.slice(1), ['Group', 'Screen', 'Fire', 'Motor']);
    assert.deepEqual(screensSheet.getRow(5).values.slice(1), ['Placement', 'Treaty Detail', '✓', '✓']);
    assert.deepEqual(screensSheet.getRow(6).values.slice(1), ['Large Losses', 'Large Loss List', '✓', '—']);
    assert.deepEqual(screensSheet.getRow(7).values.slice(1), ['Cat Losses', 'Cat Loss List *', '—', '—']);

    const pdf = await api('GET', `/api/packs/${created.body.id}/export?format=pdf`, { token: broker.token, raw: true });
    assert.equal(Buffer.from(await pdf.arrayBuffer()).length, created.body.files.pdf.bytes);

    // CSV is still rendered on demand.
    const csv = await api('GET', `/api/packs/${created.body.id}/export?format=csv`, { token: broker.token, raw: true });
    assert.equal(csv.status, 200);
    assert.match(await csv.text(), /Renewal Pack v1/);

    // A version created without a checklist has no Screens sheet and no files reported for it.
    const plain = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(plain.body.snapshot.screens, undefined);
    assert.ok(plain.body.files.xlsx.bytes > 5000);
  });
});

test('the workbook of a version opens sheet by sheet, as the file that went to market', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    await api('POST', `/api/placements/${pid}/bordereaux`, {
      token: broker.token,
      body: { type: 'premium', source_file: 'premium.xlsx', period_start: '2025-01-01', period_end: '2025-12-31', rows: PREMIUM_ROWS },
    });
    const created = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(created.status, 201);

    const res = await api('GET', `/api/packs/${created.body.id}/workbook`, { token: broker.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.pack.version, 1);
    assert.equal(res.body.pack.status, 'draft');
    // Read from the stored file, not re-rendered: the same bytes the export serves.
    assert.equal(res.body.file.stored, true);
    assert.equal(res.body.file.filename, created.body.files.xlsx.filename);
    assert.equal(res.body.file.bytes, created.body.files.xlsx.bytes);

    const names = res.body.sheets.map((sh) => sh.name);
    assert.equal(names[0], 'Cover');
    assert.equal(names.length, sectionKeys('NP').length + 1, 'the cover, then a sheet per section');

    // The cover: the title bar as one merged range, the facts beneath it, and
    // every row the full width of the sheet so the grid lines up.
    const cover = res.body.sheets[0];
    const text = cover.rows.flat().filter(Boolean).map((c) => c.w);
    assert.ok(text.some((t) => /BROKER IQ/.test(t) && /Renewal Pack v1/.test(t)), 'the title bar reads');
    assert.ok(text.includes('Cedant') && text.includes('Pack version'), 'the cover facts are there');
    assert.ok(text.includes('v1 · draft'));
    assert.ok(cover.merges.some((m) => m.rows === 3 && m.cols === 2), 'the title bar is a merged range');
    assert.ok(cover.rows.every((r) => r.length === cover.col_count));
    assert.equal(cover.row_count, cover.rows.length);
    assert.equal(cover.truncated, false);

    // A section with figures: they come through as Excel shows them, typed as
    // numbers so the screen can right-align them.
    const withNumbers = res.body.sheets.find((sh) => sh.rows.some((r) => r.some((c) => c && c.t === 'n')));
    assert.ok(withNumbers, 'a sheet carries numeric cells');
    const numeric = withNumbers.rows.flat().find((c) => c && c.t === 'n');
    assert.match(numeric.w, /^[\d,.%-]+$/, `formatted, not raw: ${numeric.w}`);
    // Every section sheet opens with the same title bar (rows 1–2 merged).
    assert.ok(res.body.sheets.slice(1).every((sh) => sh.merges.some((m) => m.r === 0 && m.rows === 2)));

    // Anyone signed in can open it; an unknown version is a 404.
    const uw = await makeUser('underwriter');
    assert.equal((await api('GET', `/api/packs/${created.body.id}/workbook`, { token: uw.token })).status, 200);
    assert.equal((await api('GET', '/api/packs/00000000-0000-0000-0000-000000000000/workbook', { token: broker.token })).status, 404);

    // A version from before files were stored renders now, and says so.
    await pool.query('DELETE FROM renewal_pack_file WHERE pack_id = $1', [created.body.id]);
    const rendered = await api('GET', `/api/packs/${created.body.id}/workbook`, { token: broker.token });
    assert.equal(rendered.status, 200);
    assert.equal(rendered.body.file.stored, false);
    assert.deepEqual(rendered.body.sheets.map((sh) => sh.name), names);
  });
});

test('a malformed screen checklist is refused before anything is cut', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    const res = await api('POST', `/api/placements/${pid}/packs`, {
      token: broker.token, body: { screens: { cobs: 'Fire', rows: [{ key: 'x' }] } },
    });
    assert.equal(res.status, 422);
    const list = await api('GET', `/api/placements/${pid}/packs`, { token: broker.token });
    assert.equal(list.body.length, 0);
  });
});
