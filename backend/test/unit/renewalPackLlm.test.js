import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {
  RENEWAL_PACK_SCHEMA, STANDARD_SECTIONS,
  prepareDocuments, buildPrompt, analyseRenewalPacks,
} from '../../src/modules/analysis/renewalPack.llm.js';

const doc = (over = {}) => ({
  filename: 'pack.pdf',
  role: 'expiring',
  mime_type: 'application/pdf',
  content: Buffer.from('%PDF-1.4 fake'),
  text_content: null,
  ...over,
});

const analysis = {
  cedant_name: 'Acme Insurance',
  cedant_domicile: 'GB',
  cedant_notes: 'Growing book.',
  class_of_business: 'Property CAT',
  treaty_type: 'Cat XL (Per Event)',
};

const RESULT = {
  executive_summary: 'Summary.',
  standard_pack: STANDARD_SECTIONS.map((section) => ({
    section, status: 'missing', summary: '', key_figures: [], gap: 'Not supplied.',
  })),
  pack_reviews: [{ document: 'pack.pdf', role: 'expiring', commentary: 'c', key_figures: [] }],
  changes: [],
  detailed_analysis: 'Detail.',
  recommendations: [],
  data_quality: [],
};

test('the house pack skeleton is the schema\'s section enum, and is required output', () => {
  const pack = RENEWAL_PACK_SCHEMA.properties.standard_pack;
  assert.ok(RENEWAL_PACK_SCHEMA.required.includes('standard_pack'));
  assert.deepEqual(pack.items.properties.section.enum, STANDARD_SECTIONS);
  assert.deepEqual(pack.items.properties.status.enum, ['supplied', 'partial', 'missing']);
  // Every field is required and the object is closed — structured outputs
  // reject a partially specified item.
  assert.deepEqual(pack.items.required, ['section', 'status', 'summary', 'key_figures', 'gap']);
  assert.equal(pack.items.additionalProperties, false);
});

test('prepareDocuments splits attachments, inline text and unreadable files', () => {
  const pdf = doc();
  const txt = doc({ filename: 'notes.txt', mime_type: 'text/plain', content: Buffer.from('hello'), text_content: 'hello', role: 'current' });
  const img = doc({ filename: 'scan.png', mime_type: 'image/png' });
  const docx = doc({ filename: 'pack.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });

  const { attachments, inline, unreadable } = prepareDocuments([pdf, txt, img, docx]);
  assert.deepEqual(attachments.map((a) => a.media_type), ['application/pdf', 'image/png']);
  assert.equal(attachments[0].data, pdf.content.toString('base64'));
  assert.match(attachments[0].label, /expiring pack/);
  assert.equal(inline.length, 1);
  assert.match(inline[0], /BEGIN CONTENT/);
  assert.deepEqual(unreadable.map((d) => d.filename), ['pack.docx']);
});

function xlsxBuffer() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Layer', 'Limit', 'Premium'],
    ['1', '10m xs 10m', '1,000,000'],
    ['2', '20m xs 20m', '650,000'],
  ]), 'Structure');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Year', 'Loss ratio'],
    ['2024', '45%'],
  ]), 'Losses');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

test('prepareDocuments inlines Excel workbooks sheet by sheet', () => {
  const xlsx = doc({
    filename: 'pack.xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: xlsxBuffer(),
  });

  const { attachments, inline, unreadable } = prepareDocuments([xlsx]);
  assert.equal(attachments.length, 0);
  assert.equal(unreadable.length, 0);
  assert.equal(inline.length, 1);
  assert.match(inline[0], /Document "pack\.xlsx"/);
  assert.match(inline[0], /Sheet "Structure" \(2 rows\)/);
  assert.match(inline[0], /Layer \| Limit \| Premium/);
  assert.match(inline[0], /10m xs 10m/);
  assert.match(inline[0], /Sheet "Losses" \(1 row\)/);
  assert.match(inline[0], /45%/);
});

test('prepareDocuments reads Excel by extension when the browser sends octet-stream', () => {
  const xlsx = doc({ filename: 'PACK.XLSX', mime_type: 'application/octet-stream', content: xlsxBuffer() });
  const { inline, unreadable } = prepareDocuments([xlsx]);
  assert.equal(unreadable.length, 0);
  assert.equal(inline.length, 1);
  assert.match(inline[0], /Sheet "Structure"/);
});

test('prepareDocuments flags a corrupt Excel upload as unreadable', () => {
  const bad = doc({ filename: 'pack.xlsx', mime_type: 'application/vnd.ms-excel', content: Buffer.from('not a workbook') });
  const { inline, unreadable } = prepareDocuments([bad]);
  assert.equal(inline.length, 0);
  assert.deepEqual(unreadable.map((d) => d.filename), ['pack.xlsx']);
});

test('an Excel-only upload set is inlined into the prompt, with no attachments', async () => {
  const xlsx = doc({
    filename: 'pack.xlsx',
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: xlsxBuffer(),
  });
  const out = await analyseRenewalPacks(
    { analysis, documents: [xlsx] },
    {
      openai: async (args) => {
        assert.equal(args.attachments.length, 0);
        assert.match(args.prompt, /10m xs 10m/);
        return { data: structuredClone(RESULT), model: 'gpt-test' };
      },
    },
  );
  assert.equal(out.provider, 'openai');
});

test('prepareDocuments rejects an over-size attachment set', () => {
  const big = doc({ content: Buffer.alloc(29 * 1024 * 1024) });
  assert.throws(() => prepareDocuments([big]), /size limit/);
});

test('buildPrompt carries the broker details, inline packs and unreadable flags', () => {
  const txt = doc({ filename: 'notes.txt', mime_type: 'text/plain', text_content: 'premium 1m', role: 'current' });
  const bad = doc({ filename: 'x.docx', mime_type: 'application/msword' });
  const prompt = buildPrompt({
    analysis,
    documents: [txt, bad],
    inline: ['Document "notes.txt" — current pack (text/plain)\n--- BEGIN CONTENT ---\npremium 1m\n--- END CONTENT ---'],
    unreadable: [bad],
  });
  assert.match(prompt, /Acme Insurance \(GB\)/);
  assert.match(prompt, /Property CAT/);
  assert.match(prompt, /Cat XL \(Per Event\)/);
  assert.match(prompt, /premium 1m/);
  assert.match(prompt, /x\.docx/);
  // The model cannot map onto the house skeleton without being given it.
  assert.match(prompt, /House renewal pack skeleton/);
  for (const section of STANDARD_SECTIONS) assert.ok(prompt.includes(section), `prompt lists "${section}"`);
});

test('analyseRenewalPacks passes attachments to ChatGPT and appends unreadable flags', async () => {
  let seen;
  const pdf = doc();
  const docx = doc({ filename: 'pack.docx', mime_type: 'application/msword' });
  const out = await analyseRenewalPacks(
    { analysis, documents: [pdf, docx] },
    { openai: async (args) => { seen = args; return { data: structuredClone(RESULT), model: 'gpt-test' }; } },
  );

  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-test');
  assert.equal(seen.attachments.length, 1);
  assert.equal(seen.attachments[0].media_type, 'application/pdf');
  assert.equal(seen.attachments[0].data, pdf.content.toString('base64'));
  assert.equal(seen.schema, RENEWAL_PACK_SCHEMA);
  assert.ok(out.data.data_quality.some((q) => /pack\.docx/.test(q)), 'unreadable upload is flagged');
});

test('analyseRenewalPacks refuses when nothing uploaded is machine-readable', async () => {
  const docx = doc({ filename: 'pack.docx', mime_type: 'application/msword' });
  await assert.rejects(
    analyseRenewalPacks({ analysis, documents: [docx] }, { openai: async () => ({ data: RESULT, model: 'x' }) }),
    /machine-readable/,
  );
});

test('a ChatGPT failure surfaces as llm_unavailable — there is no fallback provider', async () => {
  await assert.rejects(
    analyseRenewalPacks({ analysis, documents: [doc()] }, { openai: async () => { throw new Error('boom'); } }),
    (e) => {
      assert.equal(e.code, 'llm_unavailable');
      assert.deepEqual(e.attempts, [{ provider: 'openai', status: 'failed', error: 'boom' }]);
      return true;
    },
  );
});
