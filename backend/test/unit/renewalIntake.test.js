import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIDENCE, DOC_ROLES, INTAKE_FIELDS, REVIEW_STATES,
  intakeSchema, buildIntakePrompt, normaliseIntake, extractIntake, intakeValues, reviewIntake, listNames,
} from '../../src/modules/analysis/renewalIntake.llm.js';
import { FLAG_KINDS } from '../../src/modules/analysis/renewalPack.llm.js';

/* The dropdowns' rows, as the lookups serve them. */
const lists = {
  countries: [
    { id: 'c1', name: 'United Kingdom', code: 'GB' },
    { id: 'c2', name: 'Kenya', code: 'KE' },
    { id: 'c3', name: 'United Arab Emirates', code: 'AE' },
  ],
  treatyTypes: [
    { id: 't1', name: 'Quota Share', category: 'PROPORTIONAL' },
    { id: 't2', name: 'CAT XL', category: 'NON_PROPORTIONAL' },
    { id: 't3', name: 'Risk XL', category: 'NON_PROPORTIONAL' },
  ],
  classes: [
    { id: 'k1', name: 'Property', code: 'PROP' },
    { id: 'k2', name: 'Motor', code: 'MOT' },
    { id: 'k3', name: 'Engineering', code: 'ENG' },
  ],
};

const doc = (over = {}) => ({
  filename: 'pack.pdf',
  mime_type: 'application/pdf',
  content: Buffer.from('%PDF-1.4 fake'),
  text_content: null,
  ...over,
});

/** A complete answer, as the live model returns one. */
const ANSWER = {
  cedant: { value: 'Acme Insurance Company', source: 'PDF p.1 cover', confidence: 'high' },
  domicile: { value: 'United Kingdom', as_written: 'London, UK', source: 'PDF p.1 cover', confidence: 'high' },
  treaty_type: { value: 'CAT XL', as_written: 'Property Catastrophe Excess of Loss', source: 'PDF p.2 §1', confidence: 'medium' },
  classes_of_business: { values: ['Property', 'Engineering'], as_written: 'Fire, Engineering', source: 'PDF p.2 §1', confidence: 'medium' },
  notes: 'Renewal of the 2027 property cat programme, USD, four layers.',
  documents: [{ index: 1, role: 'current', year: '2027', reason: 'Titled 2027 renewal submission.' }],
  flags: [{ kind: 'judgement', claim: '"Fire" read as Property.', source: 'PDF p.2 §1' }],
};

test('the intake schema is built from the house lists, strict, and allows "not in the pack"', () => {
  const schema = intakeSchema(lists);
  assert.deepEqual(schema.required, ['cedant', 'domicile', 'treaty_type', 'classes_of_business', 'notes', 'documents', 'flags']);
  assert.equal(schema.additionalProperties, false);
  // Each pick is one of the dropdown's rows or empty — never free text.
  assert.deepEqual(schema.properties.domicile.properties.value.enum, ['', 'United Kingdom', 'Kenya', 'United Arab Emirates']);
  assert.deepEqual(schema.properties.treaty_type.properties.value.enum, ['', 'Quota Share', 'CAT XL', 'Risk XL']);
  assert.deepEqual(schema.properties.classes_of_business.properties.values.items.enum, ['Property', 'Motor', 'Engineering']);
  // The cedant is free text: the register is not a closed list.
  assert.equal(schema.properties.cedant.properties.value.enum, undefined);
  // Provenance on every pick (spec §2.1), and the flag kinds the desk already knows.
  for (const key of ['cedant', 'domicile', 'treaty_type', 'classes_of_business']) {
    assert.ok(schema.properties[key].required.includes('source'), `${key} carries its source`);
    assert.deepEqual(schema.properties[key].properties.confidence.enum, CONFIDENCE);
    assert.equal(schema.properties[key].additionalProperties, false);
  }
  assert.deepEqual(schema.properties.documents.items.properties.role.enum, DOC_ROLES);
  assert.deepEqual(schema.properties.flags.items.properties.kind.enum, FLAG_KINDS);
});

test('listNames dedupes and trims the rows\' names', () => {
  assert.deepEqual(listNames([{ name: ' Property ' }, { name: 'Property' }, { name: '' }, { name: 'Motor' }]), ['Property', 'Motor']);
});

test('buildIntakePrompt numbers the uploads, inlines text and gives the lists to pick from', () => {
  const txt = doc({ filename: 'notes.txt', mime_type: 'text/plain', text_content: 'premium 1m' });
  const bad = doc({ filename: 'x.docx', mime_type: 'application/msword' });
  const prompt = buildIntakePrompt({
    documents: [doc(), txt, bad],
    inline: ['Document "notes.txt" — uploaded pack (text/plain)\n--- BEGIN CONTENT ---\npremium 1m\n--- END CONTENT ---'],
    unreadable: [bad],
    lists,
  });
  assert.match(prompt, /1\. "pack\.pdf" \(application\/pdf\)/);
  assert.match(prompt, /2\. "notes\.txt"/);
  assert.match(prompt, /3\. "x\.docx"/);
  assert.match(prompt, /premium 1m/);
  assert.match(prompt, /not machine-readable.*x\.docx/);
  assert.match(prompt, /Countries: United Kingdom; Kenya; United Arab Emirates/);
  assert.match(prompt, /Treaty types: Quota Share \(PROPORTIONAL\); CAT XL \(NON_PROPORTIONAL\)/);
  assert.match(prompt, /Classes of business: Property; Motor; Engineering/);
});

test('normaliseIntake keeps a well-formed answer, and adds the filename to each document', () => {
  const out = normaliseIntake(structuredClone(ANSWER), { documents: [doc()], lists });
  assert.equal(out.cedant.value, 'Acme Insurance Company');
  assert.equal(out.domicile.value, 'United Kingdom');
  assert.equal(out.domicile.as_written, 'London, UK');
  assert.equal(out.treaty_type.value, 'CAT XL');
  assert.deepEqual(out.classes_of_business.values, ['Property', 'Engineering']);
  assert.equal(out.notes, ANSWER.notes);
  assert.deepEqual(out.documents, [{ index: 1, filename: 'pack.pdf', role: 'current', year: '2027', reason: 'Titled 2027 renewal submission.' }]);
  assert.deepEqual(out.flags, ANSWER.flags);
});

test('normaliseIntake holds an off-list pick to the list: the value empties, the words are kept', () => {
  const out = normaliseIntake({
    ...structuredClone(ANSWER),
    domicile: { value: 'Ruritania', as_written: '', source: 'p.1', confidence: 'high' },
    // A code or a different case still lands on the row, spelt the list's way.
    treaty_type: { value: 'cat xl', as_written: '', source: 'p.2', confidence: 'weird' },
    classes_of_business: { values: ['PROP', 'Property', 'Cyber'], as_written: '', source: 'p.2', confidence: 'medium' },
  }, { documents: [doc()], lists });
  assert.equal(out.domicile.value, '');
  assert.equal(out.domicile.as_written, 'Ruritania', 'the pack\'s own word survives for the broker');
  assert.equal(out.treaty_type.value, 'CAT XL');
  assert.equal(out.treaty_type.confidence, 'low', 'an unknown confidence reads as low, never as sure');
  assert.deepEqual(out.classes_of_business.values, ['Property'], 'deduped, and only the list\'s rows');
});

test('normaliseIntake gives every upload a documents entry, and flags the unreadable ones', () => {
  const pdf = doc();
  const bad = doc({ filename: 'x.docx', mime_type: 'application/msword' });
  const out = normaliseIntake({
    ...structuredClone(ANSWER),
    // Out of range, duplicated, and one upload never mentioned.
    documents: [{ index: 9, role: 'current', year: '', reason: '' }, { index: 1, role: 'expiring', year: '2026', reason: 'Dated 2026.' }, { index: 1, role: 'other', year: '', reason: 'dup' }],
    flags: [{ kind: 'nonsense', claim: 'dropped', source: '' }, { kind: 'missing', claim: '', source: '' }],
  }, { documents: [pdf, bad], lists, unreadable: [bad] });
  assert.deepEqual(out.documents.map((d) => [d.index, d.filename, d.role, d.year]), [
    [1, 'pack.pdf', 'expiring', '2026'],
    [2, 'x.docx', 'other', ''],
  ]);
  assert.match(out.documents[1].reason, /did not say/);
  assert.equal(out.flags.length, 1, 'bad flags dropped, the unreadable upload flagged');
  assert.equal(out.flags[0].kind, 'unreadable');
  assert.match(out.flags[0].claim, /x\.docx/);
});

test('extractIntake sends the packs as attachments, the intake schema, and the light effort', async () => {
  let seen;
  const pdf = doc();
  const out = await extractIntake(
    { documents: [pdf, doc({ filename: 'x.docx', mime_type: 'application/msword' })], lists },
    { openai: async (args) => { seen = args; return { data: structuredClone(ANSWER), model: 'gpt-test' }; } },
  );
  assert.equal(out.provider, 'openai');
  assert.equal(out.model, 'gpt-test');
  assert.deepEqual(out.attempts, [{ provider: 'openai', status: 'ok' }]);
  assert.equal(seen.attachments.length, 1);
  assert.equal(seen.attachments[0].data, pdf.content.toString('base64'));
  assert.equal(seen.schemaName, 'renewal_pack_intake');
  assert.equal(seen.effort, 'low');
  assert.deepEqual(seen.schema.properties.domicile.properties.value.enum, ['', 'United Kingdom', 'Kenya', 'United Arab Emirates']);
  assert.match(seen.prompt, /Countries: United Kingdom/);
  // The answer comes back normalised, with the unreadable upload flagged.
  assert.equal(out.extraction.cedant.value, 'Acme Insurance Company');
  assert.equal(out.extraction.documents.length, 2);
  assert.ok(out.extraction.flags.some((f) => f.kind === 'unreadable' && /x\.docx/.test(f.claim)));
});

test('extractIntake refuses when nothing uploaded can be read, and surfaces llm_unavailable', async () => {
  await assert.rejects(
    extractIntake({ documents: [doc({ filename: 'x.docx', mime_type: 'application/msword' })], lists }, { openai: async () => ({ data: ANSWER, model: 'x' }) }),
    (e) => { assert.equal(e.code, 'no_readable_documents'); assert.equal(e.status, 422); return true; },
  );
  await assert.rejects(
    extractIntake({ documents: [doc()], lists }, { openai: async () => { throw new Error('boom'); } }),
    (e) => { assert.equal(e.code, 'llm_unavailable'); assert.equal(e.status, 503); return true; },
  );
});

test('intakeValues reads the extraction as the create body names its fields', () => {
  assert.deepEqual(intakeValues(ANSWER), {
    cedant_name: 'Acme Insurance Company',
    cedant_domicile: 'United Kingdom',
    treaty_type: 'CAT XL',
    class_of_business: ['Property', 'Engineering'],
    cedant_notes: ANSWER.notes,
  });
  assert.deepEqual(Object.keys(intakeValues(ANSWER)), INTAKE_FIELDS);
});

test('reviewIntake reads what the broker did with each field the model filled', () => {
  const review = reviewIntake(ANSWER, {
    cedant_name: 'ACME INSURANCE COMPANY', // kept, in the register's case
    cedant_domicile: 'Kenya', // changed
    treaty_type: 'CAT XL', // kept
    class_of_business: 'Engineering, Property', // the same set, another order
    cedant_notes: '', // cleared
  });
  assert.deepEqual(review, {
    cedant_name: 'accepted',
    cedant_domicile: 'corrected',
    treaty_type: 'accepted',
    class_of_business: 'accepted',
    cedant_notes: 'corrected',
  });
  for (const s of Object.values(review)) assert.ok(REVIEW_STATES.includes(s));

  // Where the model had nothing, what the broker typed is added — and a
  // field neither side has is empty.
  const blank = { ...ANSWER, domicile: { ...ANSWER.domicile, value: '' }, classes_of_business: { ...ANSWER.classes_of_business, values: [] }, notes: '' };
  assert.deepEqual(reviewIntake(blank, {
    cedant_name: 'Acme Insurance Company', cedant_domicile: 'United Kingdom', treaty_type: 'CAT XL',
    class_of_business: 'Property', cedant_notes: '',
  }), {
    cedant_name: 'accepted', cedant_domicile: 'added', treaty_type: 'accepted', class_of_business: 'added', cedant_notes: 'empty',
  });
});
