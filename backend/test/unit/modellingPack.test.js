// The standardised modelling pack: sections grouped by class and screen, a
// screen's JSON rendered as tables, the workbook with a sheet per screen per
// class, and the AI digest/analysis over a stub client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import {
  classesOf, organiseSections, blocksOf, buildModellingWorkbook, digestOf, buildAnalysisPrompt, analyseModelling,
  MODELLING_ANALYSIS_SCHEMA, CROSSCHECK_SCHEMA, crosscheckModelling,
} from '../../src/modules/modelling/modellingPack.js';

const TYPES = ['Quota Share', 'Surplus', 'Risk XL', 'Cat XL (Per Event)'];

const sections = {
  triangle_premium: { data: { MODIFIED: { cells: [{ origin_year: 2022, dev_months: 12, cum_value: 1000 }, { origin_year: 2022, dev_months: 24, cum_value: 1500 }, { origin_year: 2023, dev_months: 12, cum_value: 1200 }] }, ACTUAL: { cells: [] } }, updated_at: '2026-09-01T10:00:00Z' },
  'triangle_premium:property': { data: { MODIFIED: { cells: [{ origin_year: 2022, dev_months: 12, cum_value: 900 }] }, ACTUAL: { cells: [] } }, updated_at: '2026-09-02T10:00:00Z' },
  'large_losses:motor': { data: { rows: [{ uw_year: 2024, insured_name: 'A', gross_loss: 500000, paid: 100000, os: 50000 }], threshold: 250000 }, updated_at: '2026-09-02T11:00:00Z' },
  'straight_stats:motor': { data: {} },
  ai_summary: { data: { summary: 'old' } },
  ai_crosscheck: { data: { summary: 'old check' } },
};

test('classesOf splits the class string on " / " and strips the treaty type', () => {
  assert.deepEqual(classesOf('Property / Motor Quota Share', TYPES), ['Property', 'Motor']);
  assert.deepEqual(classesOf('Property Cat XL (Per Event)', TYPES), ['Property']);
  assert.deepEqual(classesOf('Marine QS', TYPES), ['Marine']);
  assert.deepEqual(classesOf('', TYPES), []);
});

test('organiseSections groups by class in the wizard order; a scoped section beats the plain one; empty and AI sections are skipped', () => {
  const classes = organiseSections(sections, ['Property', 'Motor']);
  assert.deepEqual(classes.map((c) => c.name), ['Property', 'Motor']);
  const property = classes[0];
  assert.deepEqual(property.screens.map((s) => s.key), ['triangle_premium']);
  assert.equal(property.screens[0].data.MODIFIED.cells[0].cum_value, 900, 'the scoped section wins');
  assert.equal(property.screens[0].title, 'Premium Triangle');
  const motor = classes[1];
  assert.deepEqual(motor.screens.map((s) => s.key), ['large_losses'], 'the empty straight stats and the AI sections are not screens');

  // A single-class treaty reads the plain keys.
  const single = organiseSections({ triangle_premium: sections.triangle_premium, cat_losses: { data: { rows: [{ x: 1 }] } } }, ['Property']);
  assert.deepEqual(single[0].screens.map((s) => s.key), ['triangle_premium', 'cat_losses']);
  // No classes named: everything under "All classes".
  assert.equal(organiseSections({ triangle_premium: sections.triangle_premium }, [])[0].name, 'All classes');
});

test('blocksOf pivots triangles, tables arrays of objects and lists scalars as facts', () => {
  const tri = blocksOf(sections.triangle_premium.data);
  const grid = tri.find((b) => b.headers && b.headers[0] === 'Origin year');
  assert.deepEqual(grid.headers, ['Origin year', '12 months', '24 months']);
  assert.deepEqual(grid.rows, [[2022, 1000, 1500], [2023, 1200, null]]);

  const losses = blocksOf(sections['large_losses:motor'].data);
  const facts = losses.find((b) => b.facts);
  assert.deepEqual(facts.facts, [['Threshold', 250000]]);
  const table = losses.find((b) => b.rows);
  assert.deepEqual(table.headers, ['Uw Year', 'Insured Name', 'Gross Loss', 'Paid', 'Os']);
  assert.deepEqual(table.rows, [[2024, 'A', 500000, 100000, 50000]]);
});

const placement = {
  id: 'p1', reference: 'PL-0001', cedant_name: 'Acme', class: 'Property / Motor Quota Share', currency: 'USD',
  inception: '2027-01-01', expiry: '2027-12-31',
};

test('the workbook carries a cover and a sheet per screen per class, with the AI summary on the cover', async () => {
  const classes = organiseSections(sections, ['Property', 'Motor']);
  const aiSummary = { summary: 'Stable book.', highlights: ['Premium grows 20%'], data_gaps: ['No cat losses'], per_class: [{ class: 'Motor', summary: 'One large loss.' }] };
  const buffer = await buildModellingWorkbook({ placement, classes, aiSummary, generatedAt: new Date('2026-09-03T00:00:00Z') });
  assert.equal(buffer.slice(0, 2).toString(), 'PK');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Cover', 'Property · Premium Triangle', 'Motor · Large Loss List']);
  const cover = wb.getWorksheet('Cover');
  const text = [];
  cover.eachRow((r) => r.eachCell((c) => { if (typeof c.value === 'string') text.push(c.value); }));
  assert.ok(text.includes('PL-0001') && text.includes('Stable book.') && text.includes('Premium grows 20%') && text.includes('No cat losses'));
  assert.ok(text.includes('Motor') && text.includes('One large loss.'));

  const tri = wb.getWorksheet('Property · Premium Triangle');
  const cells = [];
  tri.eachRow((r) => r.eachCell((c) => cells.push(c.value)));
  assert.ok(cells.includes('Origin year') && cells.includes('12 months') && cells.includes(900));
});

test('sheet names stay unique and within Excel\'s 31 characters', async () => {
  const long = { 'event_loss_tables:commercial-property-and-engineering': { data: { rows: [{ a: 1 }] } }, 'event_loss_tables:commercial-property-and-engineering-2': { data: { rows: [{ a: 2 }] } } };
  const classes = organiseSections(long, ['Commercial Property and Engineering', 'Commercial Property and Engineering 2']);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildModellingWorkbook({ placement, classes, aiSummary: null }));
  const names = wb.worksheets.map((w) => w.name);
  assert.equal(names.length, 3);
  assert.equal(new Set(names).size, 3);
  assert.ok(names.every((n) => n.length <= 31));
});

test('the digest names every class and screen with figures; the prompt carries the placement; analysis returns the model\'s JSON', async () => {
  const classes = organiseSections(sections, ['Property', 'Motor']);
  const digest = digestOf(classes);
  assert.match(digest, /## Class of business: Property/);
  assert.match(digest, /### Premium Triangle/);
  assert.match(digest, /### Large Loss List/);
  assert.match(digest, /Threshold=250000/);
  assert.match(digest, /Gross Loss total 500,000/);
  assert.ok(digestOf(classes, 200).endsWith('… (digest truncated)'));

  const prompt = buildAnalysisPrompt({ placement, classes });
  assert.match(prompt, /PL-0001 — cedant Acme/);
  assert.match(prompt, /Classes of business: Property, Motor/);

  const reply = { summary: 'S', highlights: ['h'], data_gaps: [], per_class: [{ class: 'Property', summary: 'p' }] };
  let seen;
  const openai = async (req) => { seen = req; return { data: reply, model: 'gpt-test' }; };
  const out = await analyseModelling({ placement, classes }, { openai });
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-test');
  assert.deepEqual(out.data, reply);
  assert.ok(JSON.stringify(seen).includes('Large Loss List'), 'the digest reaches the model');
  assert.deepEqual(Object.keys(MODELLING_ANALYSIS_SCHEMA.properties), ['summary', 'highlights', 'data_gaps', 'per_class']);
});

test('the cross-check reads the raw data beside the screens, and its result lands on the cover', async () => {
  const classes = organiseSections(sections, ['Property', 'Motor']);
  const documents = [
    { filename: 'loss-run.csv', mime_type: 'text/csv', content: Buffer.from('uw_year,insured,gross\n2024,A,450000'), text_content: 'uw_year,insured,gross\n2024,A,450000', note: '2024 loss run' },
    { filename: 'scan.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: Buffer.from('x'), text_content: null },
  ];
  const reply = {
    summary: 'One difference.', consistent: ['Premium 2022@12m = 900'],
    discrepancies: [{ class: 'Motor', screen: 'Large Loss List', item: 'Loss A gross', screen_value: '500,000', raw_value: '450,000', severity: 'medium', note: 'Loss run shows 450,000' }],
    unverified: ['Property triangle beyond 12 months'], data_quality: [],
  };
  let seen;
  const openai = async (req) => { seen = req; return { data: reply, model: 'gpt-test' }; };
  const out = await crosscheckModelling({ placement, classes, documents }, { openai });
  assert.equal(out.data.summary, 'One difference.');
  assert.match(seen.prompt, /=== WHAT IS ON THE MODELLING SCREENS ===/);
  assert.match(seen.prompt, /### Large Loss List/);
  assert.match(seen.prompt, /=== THE RAW DATA ===/);
  assert.match(seen.prompt, /2024,A,450000/);
  assert.match(seen.prompt, /"loss-run.csv" \(2024 loss run\)/);
  assert.match(seen.prompt, /"scan.docx"/, 'the unreadable upload is named for data_quality');
  assert.equal(seen.schema, CROSSCHECK_SCHEMA);
  assert.equal(out.data.data_quality.length, 1, 'the unreadable upload is reported');

  // Nothing readable: a 422, not a model call.
  await assert.rejects(
    crosscheckModelling({ placement, classes, documents: [documents[1]] }, { openai }),
    (e) => e.code === 'no_readable_documents',
  );

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildModellingWorkbook({ placement, classes, aiSummary: null, crosscheck: { ...reply, documents: ['loss-run.csv'] } }));
  const text = [];
  wb.getWorksheet('Cover').eachRow((r) => r.eachCell((c) => { if (typeof c.value === 'string') text.push(c.value); }));
  assert.ok(text.includes('One difference.') && text.includes('Loss A gross') && text.includes('450,000') && text.includes('loss-run.csv'));
});
