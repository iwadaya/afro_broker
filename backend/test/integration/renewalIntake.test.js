import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { ensureReferenceData } from '../../src/db/ensureReferenceData.js';

/*
 * The quick renewal pack: the AI reads the intake details off the uploaded
 * pack (POST /renewal-analyses/intake) and the create carries what it read
 * beside what the broker saved. No AI key in the test environment, so the
 * read itself answers 503 — the shape the browser handles — and the create
 * is exercised with an extraction written as the model would return it.
 */

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
  await ensureReferenceData();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

const b64 = (s) => Buffer.from(s).toString('base64');

const pack = {
  filename: 'renewal-2027.txt',
  mime_type: 'text/plain',
  content_base64: b64('Acme Insurance Company, London. Property Catastrophe Excess of Loss, 2027 renewal.'),
};

/** What the model returns for that pack, normalised as extractIntake would hand it back. */
const extraction = {
  cedant: { value: 'Acme Insurance Company', source: 'p.1', confidence: 'high' },
  domicile: { value: 'United Kingdom', as_written: 'London', source: 'p.1', confidence: 'medium' },
  treaty_type: { value: 'CAT XL', as_written: 'Property Catastrophe Excess of Loss', source: 'p.1', confidence: 'high' },
  classes_of_business: { values: ['Property'], as_written: 'Property Catastrophe', source: 'p.1', confidence: 'high' },
  notes: '2027 renewal.',
  documents: [{ index: 1, filename: 'renewal-2027.txt', role: 'current', year: '2027', reason: 'Titled 2027 renewal.' }],
  flags: [{ kind: 'judgement', claim: 'Excess of loss read as CAT XL.', source: 'p.1' }],
};

test('quick intake: what the route needs to know, and a read with no provider is a 503', async () => {
  await withServer(async (api) => {
    // Anyone signed in may ask whether the quick route is on offer.
    const info = await api('GET', '/api/renewal-analyses/intake', { token: uw.token });
    assert.equal(info.status, 200);
    assert.ok(Array.isArray(info.body.providers));
    assert.equal(info.body.providers.every((p) => p.configured === false), true, 'no key in tests');
    assert.equal(info.body.limits.max_documents, 6);
    assert.equal(info.body.limits.max_total_bytes, 18 * 1024 * 1024);

    // Only a broker reads a pack in.
    const denied = await api('POST', '/api/renewal-analyses/intake', { token: uw.token, body: { documents: [pack] } });
    assert.equal(denied.status, 403);

    // Nothing to read, or nothing readable, is a validation error — not a model call.
    const none = await api('POST', '/api/renewal-analyses/intake', { token: broker.token, body: { documents: [] } });
    assert.equal(none.status, 422);
    const empty = await api('POST', '/api/renewal-analyses/intake', {
      token: broker.token, body: { documents: [{ ...pack, content_base64: '!!!' }] },
    });
    assert.equal(empty.status, 422);
    const unreadable = await api('POST', '/api/renewal-analyses/intake', {
      token: broker.token, body: { documents: [{ ...pack, filename: 'pack.docx', mime_type: 'application/msword' }] },
    });
    assert.equal(unreadable.status, 422);
    assert.equal(unreadable.body.code, 'no_readable_documents');

    // A readable pack with no AI configured: the same 503 the run reports,
    // with the providers, so the browser can offer the full route instead.
    const read = await api('POST', '/api/renewal-analyses/intake', { token: broker.token, body: { documents: [pack] } });
    assert.equal(read.status, 503);
    assert.equal(read.body.code, 'llm_unavailable');
    assert.ok(Array.isArray(read.body.providers));

    // Nothing was created by any of that.
    const list = await api('GET', '/api/renewal-analyses', { token: broker.token });
    assert.deepEqual(list.body, []);
  });
});

test('quick intake: the create keeps the model\'s picks beside the broker\'s corrections', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/renewal-analyses', {
      token: broker.token,
      body: {
        cedant_name: 'Acme Insurance Company', // as read
        cedant_domicile: 'Kenya', // corrected
        treaty_type: 'CAT XL', // as read
        class_of_business: 'Property, Engineering', // added to
        cedant_notes: '2027 renewal.',
        intake: { mode: 'quick', provider: 'openai', model: 'gpt-test', extraction },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.intake_mode, 'quick');
    assert.equal(created.body.intake.provider, 'openai');
    assert.equal(created.body.intake.model, 'gpt-test');
    assert.equal(created.body.intake.extraction.cedant.value, 'Acme Insurance Company');
    assert.equal(created.body.intake.extraction.domicile.as_written, 'London');
    // The review is the server's reading of the two sides, not the client's claim.
    assert.deepEqual(created.body.intake.review, {
      cedant_name: 'accepted',
      cedant_domicile: 'corrected',
      treaty_type: 'accepted',
      class_of_business: 'corrected',
      cedant_notes: 'accepted',
    });
    assert.equal(created.body.intake.reviewed_by, broker.user.id);
    assert.ok(created.body.intake.reviewed_at);

    // The detail and the list both say how the details arrived.
    const detail = await api('GET', `/api/renewal-analyses/${created.body.id}`, { token: uw.token });
    assert.equal(detail.body.intake_mode, 'quick');
    assert.equal(detail.body.intake.review.cedant_domicile, 'corrected');
    const list = await api('GET', '/api/renewal-analyses', { token: broker.token });
    assert.equal(list.body.find((a) => a.id === created.body.id).intake_mode, 'quick');

    // The audit trail carries the mode and the review with the create.
    const { rows } = await pool.query(
      `SELECT detail FROM audit_event WHERE entity_id = $1 AND action = 'create'`, [created.body.id],
    );
    assert.equal(rows[0].detail.intake_mode, 'quick');
    assert.equal(rows[0].detail.review.cedant_domicile, 'corrected');
  });
});

test('quick intake: the full route is the default, and a quick create needs its extraction', async () => {
  await withServer(async (api) => {
    const typed = await api('POST', '/api/renewal-analyses', {
      token: broker.token,
      body: { cedant_name: 'Acme Insurance', class_of_business: 'Property', treaty_type: 'CAT XL' },
    });
    assert.equal(typed.status, 201);
    assert.equal(typed.body.intake_mode, 'full');
    assert.equal(typed.body.intake, null);

    const explicit = await api('POST', '/api/renewal-analyses', {
      token: broker.token,
      body: { cedant_name: 'Acme Insurance', class_of_business: 'Property', treaty_type: 'CAT XL', intake: { mode: 'full' } },
    });
    assert.equal(explicit.status, 201);
    assert.equal(explicit.body.intake_mode, 'full');
    assert.equal(explicit.body.intake, null);

    const noExtraction = await api('POST', '/api/renewal-analyses', {
      token: broker.token,
      body: { cedant_name: 'Acme Insurance', class_of_business: 'Property', treaty_type: 'CAT XL', intake: { mode: 'quick' } },
    });
    assert.equal(noExtraction.status, 422);

    const badExtraction = await api('POST', '/api/renewal-analyses', {
      token: broker.token,
      body: {
        cedant_name: 'Acme Insurance', class_of_business: 'Property', treaty_type: 'CAT XL',
        intake: { mode: 'quick', extraction: { ...extraction, domicile: { ...extraction.domicile, confidence: 'certain' } } },
      },
    });
    assert.equal(badExtraction.status, 422);
  });
});
