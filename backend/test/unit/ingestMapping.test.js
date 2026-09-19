import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  TEMPLATES, classifyHeader, profileColumn, unsupervisedSuggest, standardMatch,
  detectType, combinedTemplate, splitCombinedId, standardMatchCombined,
} from '../../src/modules/ingest/ingest.service.js';
import { parseXlsx, parseCsvTable } from '../../src/lib/tabular.js';

/** Seed-only training docs (what loadTrainingSet builds before any imports). */
function seedDocs(type) {
  const docs = [];
  const tok = (s) => {
    const n = String(s).toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();
    return [...n.split(' ').filter(Boolean), n.replace(/ /g, '')];
  };
  for (const f of TEMPLATES[type]) {
    docs.push({ field: f.field, toks: tok(f.label) });
    for (const a of f.aliases) docs.push({ field: f.field, toks: tok(a) });
  }
  return docs;
}

test('supervised classifier maps common premium headers from seeds alone', () => {
  const docs = seedDocs('premium');
  assert.equal(classifyHeader('Policy Reference', docs).field, 'policy_ref');
  assert.equal(classifyHeader('Sum Insured 100% ($)', docs).field, 'sum_insured_100');
  assert.equal(classifyHeader('Premium Ceded to Surplus ($)', docs).field, 'premium_ceded');
  assert.equal(classifyHeader('GWP', docs).field, 'gross_premium_100');
});

test('standard match is strict, one field per column', () => {
  const res = standardMatch('premium', ['Premium Ceded to Surplus', 'Premium to Facultative', 'Made Up Column']);
  assert.equal(res[0].field, 'premium_ceded');
  assert.equal(res[1].field, 'premium_fac');
  assert.equal(res[2].field, 'ignore');
  const fields = res.filter((r) => r.field !== 'ignore').map((r) => r.field);
  assert.equal(new Set(fields).size, fields.length);
});

test('column profiling types dates, currency codes and numbers', () => {
  assert.equal(profileColumn(['2026-01-01', '2026-02-01', '2026-03-05']).kind, 'date');
  assert.equal(profileColumn(['USD', 'USD', 'EUR']).kind, 'currency');
  const num = profileColumn(['1,000', '2500', '3,750.5']);
  assert.equal(num.kind, 'number');
  assert.equal(profileColumn(['ZGI/FIR/2026/0101', 'ZGI/PAR/2026/0107']).refLike, true);
});

test('unsupervised suggest splits SI-scale from premium-scale columns', () => {
  const headers = ['A', 'B', 'C', 'D'];
  const samples = {
    A: ['2026-01-01', '2026-01-05', '2026-02-01'],
    B: ['2027-01-01', '2027-01-05', '2027-02-01'],
    C: ['14500000', '8250000', '6400000'],
    D: ['30450', '22687', '11840'],
  };
  const out = unsupervisedSuggest('premium', headers, samples);
  assert.equal(out.A.field, 'inception');
  assert.equal(out.B.field, 'expiry');
  assert.equal(out.C.field, 'sum_insured_100');
  assert.equal(out.D.field, 'gross_premium_100');
});

test('xlsx parsing returns one table per sheet with ISO dates', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Policy', 'Inception', 'Premium'],
    ['P-1', new Date(Date.UTC(2026, 0, 1)), 1000],
    ['P-2', new Date(Date.UTC(2026, 5, 15)), 2500],
  ]), 'Premiums');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Claim', 'Paid'], ['C-1', 400],
  ]), 'Claims');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', cellDates: true });
  const tables = parseXlsx(buf);
  assert.equal(tables.length, 2);
  assert.deepEqual(tables[0].headers, ['Policy', 'Inception', 'Premium']);
  assert.equal(tables[0].rows[0].Inception, '2026-01-01');
  assert.equal(tables[1].name, 'Claims');
});

test('csv parsing keeps the tabular shape', () => {
  const [t] = parseCsvTable('policy,premium\nP-1,"1,000"\nP-2,2500\n', 'bdx.csv');
  assert.equal(t.row_count, 2);
  assert.equal(t.rows[0].premium, '1,000');
});

/* ── Auto-detect: premium, claims, or one sheet carrying both ───────── */

test('detects a premium bordereau from its marker columns', () => {
  const d = detectType(
    ['Item', 'Policy No', 'Insured', 'Inception', 'Expiry', 'Sum Insured 100%', 'Premium Ceded'],
    { name: 'Sheet1' },
  );
  assert.equal(d.type, 'premium');
  assert.ok(d.scores.premium > d.scores.claims);
});

test('detects a claims bordereau from its marker columns', () => {
  const d = detectType(
    ['Claim No', 'Policy No', 'Insured', 'Date of Loss', 'Cause of Loss', 'Paid', 'Outstanding'],
    { name: 'Sheet1' },
  );
  assert.equal(d.type, 'claims');
  assert.ok(d.scores.claims > d.scores.premium);
});

test('detects a combined sheet carrying premium and claims', () => {
  const d = detectType([
    'Policy No', 'Insured', 'Inception', 'Expiry', 'Sum Insured 100%', 'Premium Ceded to Surplus',
    'Claim No', 'Date of Loss', 'Paid', 'Outstanding',
  ], { name: 'Bordereau' });
  assert.equal(d.type, 'both');
  assert.ok(d.scores.premium >= 0.3 && d.scores.claims >= 0.3);
});

test('a sheet with no marker columns is reported as unknown, not guessed', () => {
  const d = detectType(['Column A', 'Column B', 'Notes'], { name: 'Data' });
  assert.equal(d.type, 'unknown');
});

test('the sheet name only breaks ties — headers win', () => {
  const headers = ['Claim No', 'Date of Loss', 'Paid', 'Outstanding'];
  assert.equal(detectType(headers, { name: 'Premium 2026' }).type, 'claims');
});

test('combined template shares the columns both templates define', () => {
  const cols = combinedTemplate();
  const ids = cols.map((c) => c.field);
  assert.ok(ids.includes('shared:policy_ref'), 'policy reference is shared');
  assert.ok(ids.includes('shared:insured'), 'insured is shared');
  assert.ok(ids.includes('premium:sum_insured_100'), 'sum insured belongs to premium');
  assert.ok(ids.includes('claims:paid'), 'paid belongs to claims');
  assert.equal(ids.filter((i) => i === 'shared:policy_ref').length, 1, 'no duplicate shared entry');
  // Every combined id splits back into a real template field.
  for (const c of cols) {
    const { group, field } = splitCombinedId(c.field);
    const inPremium = TEMPLATES.premium.some((f) => f.field === field);
    const inClaims = TEMPLATES.claims.some((f) => f.field === field);
    if (group === 'shared') assert.ok(inPremium && inClaims, `${field} should be in both`);
    if (group === 'premium') assert.ok(inPremium && !inClaims, `${field} should be premium-only`);
    if (group === 'claims') assert.ok(inClaims && !inPremium, `${field} should be claims-only`);
  }
});

test('standard match over the combined catalogue namespaces each hit', () => {
  const out = standardMatchCombined(['Policy Reference', 'Sum Insured 100%', 'Claim Reference', 'Paid']);
  const byHeader = Object.fromEntries(out.map((o) => [o.header, o.field]));
  assert.equal(byHeader['Policy Reference'], 'shared:policy_ref');
  assert.equal(byHeader['Sum Insured 100%'], 'premium:sum_insured_100');
  assert.equal(byHeader['Claim Reference'], 'claims:claim_ref');
  assert.equal(byHeader.Paid, 'claims:paid');
});
