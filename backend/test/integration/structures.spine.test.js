import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { installTermSchemas } from '../../src/domain/termSchemas/index.js';

/**
 * Phase 2 acceptance — a broker can build a placement with proportional and
 * non-proportional structures and see expiring alongside current (§4).
 */

let broker;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
});

const catXlTerms = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  layer_no: 1,
  layer_of: 2,
  rate_pct: 3.75,
  rate_type: 'FLAT',
  egnpi: '80000000',
  brokerage_pct: 10,
  reinstatements: [{ count: 1, rate_pct: 100 }],
  ...over,
});

const surplusTerms = (over = {}) => ({
  currency: 'USD',
  lines_ceded: 9,
  retention: '1000000',
  max_cession: '9000000',
  commission_pct: 30,
  epi: '45000000',
  brokerage_pct: 10,
  ...over,
});

async function setupYear(api, { yearLabel = '2026' } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Structure Mutual' } });
  const contract = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, name: 'Property Programme', cob: 'Property' },
  });
  const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
    token: broker.token,
    body: { year_label: yearLabel, inception: `${yearLabel}-01-01`, expiry: `${yearLabel}-12-31`, currency: 'USD' },
  });
  assert.equal(year.status, 201, JSON.stringify(year.body));
  return { cedantId: cedant.body.id, contractId: contract.body.id, yearId: year.body.id };
}

async function addStructure(api, yearId, body) {
  const res = await api('POST', `/api/contract-years/${yearId}/structures`, { token: broker.token, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('a year carries proportional and non-proportional structures as siblings (§1.3)', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);

    const layer = await addStructure(api, yearId, {
      label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      terms: catXlTerms(),
    });
    const section = await addStructure(api, yearId, {
      label: 'Surplus', treaty_type: 'PROPERTY_SURPLUS', cob: 'Property', position: 1,
      terms: surplusTerms(),
    });

    assert.equal(layer.basis, 'NP', 'basis comes from the schema, not from the caller');
    assert.equal(section.basis, 'PROP');

    const list = await api('GET', `/api/contract-years/${yearId}/structures`, { token: uw.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.structures.map((s) => s.basis), ['NP', 'PROP'],
      'they are siblings under one contract year, not separate placements');
  });
});

test('money in terms is stored as integer minor units and read back as decimals (§2.6)', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const s = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      terms: catXlTerms({ limit: '20000000.50' }),
    });

    const { rows } = await pool.query('SELECT terms FROM structure_version WHERE structure_id = $1', [s.id]);
    assert.equal(rows[0].terms.limit, 2000000050, 'stored as minor units, never a float');
    assert.equal(rows[0].terms.deductible, 500000000);

    const read = await api('GET', `/api/structures/${s.id}`, { token: uw.token });
    assert.equal(read.body.versions[0].terms.limit, 2000000050);
    assert.equal(read.body.versions[0].terms_display.limit, '20000000.50');
  });
});

test('terms that do not satisfy the schema are refused with every failure at once', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const bad = catXlTerms();
    delete bad.limit;
    delete bad.brokerage_pct;

    const res = await api('POST', `/api/contract-years/${yearId}/structures`, {
      token: broker.token,
      body: { label: 'Bad', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: bad },
    });
    assert.equal(res.status, 422);
    const missing = res.body.details.termErrors.map((e) => e.params?.missingProperty).filter(Boolean);
    assert.ok(missing.includes('limit') && missing.includes('brokerage_pct'));

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM structure');
    assert.equal(rows[0].n, 0, 'nothing is written when the terms are rejected');
  });
});

test('D9 ships two treaty types and nothing else', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const res = await api('POST', `/api/contract-years/${yearId}/structures`, {
      token: broker.token,
      body: { label: 'Marine XL', treaty_type: 'MARINE_XL', cob: 'Marine', terms: catXlTerms() },
    });
    assert.equal(res.status, 422, 'an unshipped treaty type is not a valid input');

    const schemas = await api('GET', '/api/term-schemas', { token: uw.token });
    assert.deepEqual(schemas.body.map((s) => s.treaty_type).sort(), ['PROPERTY_CAT_XL', 'PROPERTY_SURPLUS']);
  });
});

test('every state is a version of one entity, not a row in another table (§1.2)', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const s = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      status: 'SUBMITTED', terms: catXlTerms(),
    });
    const submitted = (await api('GET', `/api/structures/${s.id}`, { token: uw.token })).body.versions[0];

    const market = await api('POST', '/api/markets', {
      token: broker.token, body: { name: 'Counter Re' },
    });

    // A reinsurer's alternative quote: a new version, origin REINSURER,
    // status ALTERNATIVE, linked to what was submitted (M6).
    const alt = await api('POST', `/api/structures/${s.id}/versions`, {
      token: broker.token,
      body: {
        status: 'ALTERNATIVE', origin: 'REINSURER', origin_party_id: market.body.id,
        parent_version_id: submitted.id,
        terms: catXlTerms({ deductible: '7500000' }),
      },
    });
    assert.equal(alt.status, 201, JSON.stringify(alt.body));
    assert.equal(alt.body.version_no, 2);
    assert.equal(alt.body.parent_version_id, submitted.id);

    const detail = await api('GET', `/api/structures/${s.id}`, { token: uw.token });
    assert.equal(detail.body.versions.length, 2);
    assert.equal(detail.body.versions[1].origin_party_name, 'Counter Re',
      'the version chain answers "which reinsurer countered, and with what"');
  });
});

test('a REINSURER version must name its reinsurer, and others must not', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const s = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms(),
    });
    const market = await api('POST', '/api/markets', { token: broker.token, body: { name: 'Anon Re' } });

    const unattributed = await api('POST', `/api/structures/${s.id}/versions`, {
      token: broker.token,
      body: { status: 'ALTERNATIVE', origin: 'REINSURER', terms: catXlTerms() },
    });
    assert.equal(unattributed.status, 409);

    const contradictory = await api('POST', `/api/structures/${s.id}/versions`, {
      token: broker.token,
      body: { status: 'NEGOTIATED', origin: 'BROKER', origin_party_id: market.body.id, terms: catXlTerms() },
    });
    assert.equal(contradictory.status, 409);

    // The table refuses it too, so a bug in the route cannot produce one.
    await assert.rejects(
      pool.query(
        `INSERT INTO structure_version (structure_id, version_no, status, origin)
         VALUES ($1, 99, 'ALTERNATIVE', 'REINSURER')`,
        [s.id],
      ),
      /structure_version_party_matches_origin/,
    );
  });
});

test('a version chain cannot wander between structures', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const a = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms(),
    });
    const b = await addStructure(api, yearId, {
      label: 'L2', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', position: 1, terms: catXlTerms(),
    });
    const aVersion = (await api('GET', `/api/structures/${a.id}`, { token: uw.token })).body.versions[0];

    const crossed = await api('POST', `/api/structures/${b.id}/versions`, {
      token: broker.token,
      body: { status: 'NEGOTIATED', origin: 'BROKER', parent_version_id: aVersion.id, terms: catXlTerms() },
    });
    assert.equal(crossed.status, 409);
    assert.match(crossed.body.error, /same structure/i);

    await assert.rejects(
      pool.query(
        `INSERT INTO structure_version (structure_id, version_no, status, origin, parent_version_id)
         VALUES ($1, 99, 'NEGOTIATED', 'BROKER', $2)`,
        [b.id, aVersion.id],
      ),
      /structure_version_parent_same_structure/,
    );
  });
});

test('diffing any two versions is one generic call (§1.2)', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const s = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms(),
    });
    const submitted = (await api('GET', `/api/structures/${s.id}`, { token: uw.token })).body.versions[0];
    const counter = await api('POST', `/api/structures/${s.id}/versions`, {
      token: broker.token,
      body: {
        status: 'NEGOTIATED', origin: 'CEDANT',
        parent_version_id: submitted.id,
        terms: catXlTerms({ deductible: '7500000', rate_pct: 4.1 }),
      },
    });

    const diff = await api('GET', `/api/structure-versions/${submitted.id}/diff/${counter.body.id}`, { token: uw.token });
    assert.equal(diff.status, 200);
    assert.deepEqual(diff.body.changes.map((c) => c.path), ['deductible', 'rate_pct']);
    assert.equal(diff.body.from.status, 'SUBMITTED');
    assert.equal(diff.body.to.status, 'NEGOTIATED');
  });
});

test('expiring structures come from the prior year through the link, not a copy (§1.1, M5)', async () => {
  await withServer(async (api) => {
    const { contractId, yearId: y2025 } = await setupYear(api, { yearLabel: '2025' });
    await addStructure(api, y2025, {
      label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      terms: catXlTerms({ deductible: '5000000' }),
    });

    const y2026 = (await api('POST', `/api/contract-years/${y2025}/renew`, {
      token: broker.token, body: { year_label: '2026' },
    })).body;

    await addStructure(api, y2026.id, {
      label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      terms: catXlTerms({ deductible: '6000000' }),
    });

    const view = await api('GET', `/api/contract-years/${y2026.id}/structures?include_expiring=1`, { token: uw.token });
    assert.equal(view.status, 200);
    assert.equal(view.body.structures.length, 1, 'this year');
    assert.equal(view.body.expiring.source, 'PRIOR_YEAR');
    assert.equal(view.body.expiring.contract_year_id, y2025);
    assert.equal(view.body.expiring.structures.length, 1, 'read through the link, not duplicated');
    assert.equal(view.body.expiring.structures[0].latest_version.terms.deductible, 500000000);

    // Nothing was copied: the expiring structures still belong to 2025.
    const { rows } = await pool.query(
      'SELECT contract_year_id, COUNT(*)::int AS n FROM structure GROUP BY contract_year_id',
    );
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.n === 1), 'one structure each, no duplication across the renewal');
    assert.ok(contractId);
  });
});

test('a year with no linked predecessor reports that, rather than pretending', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const view = await api('GET', `/api/contract-years/${yearId}/structures?include_expiring=1`, { token: uw.token });
    assert.equal(view.body.expiring.source, 'UNLINKED');
    assert.deepEqual(view.body.expiring.structures, [],
      'M5: unlinked expiring structures are entered or extracted, not invented');
  });
});

test('structures are broker-write and audited', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const viewerAttempt = await api('POST', `/api/contract-years/${yearId}/structures`, {
      token: uw.token,
      body: { label: 'X', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms() },
    });
    assert.equal(viewerAttempt.status, 403, 'underwriter is not a placement writer here');

    const s = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms(),
    });
    const { rows } = await pool.query(
      `SELECT entity_type, action, user_id FROM audit_event
       WHERE entity_type IN ('structure','structure_version') ORDER BY id`,
    );
    assert.deepEqual(rows.map((r) => `${r.entity_type}:${r.action}`),
      ['structure:create', 'structure_version:create']);
    assert.ok(rows.every((r) => r.user_id === broker.user.id));
    assert.ok(s.id);
  });
});

test('a version records the schema it was validated against, for later re-validation', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const s = await addStructure(api, yearId, {
      label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: catXlTerms(),
    });
    const { rows } = await pool.query(
      `SELECT ts.treaty_type, ts.version FROM structure_version sv
       JOIN term_schema ts ON ts.id = sv.term_schema_id WHERE sv.structure_id = $1`,
      [s.id],
    );
    assert.deepEqual(rows[0], { treaty_type: 'PROPERTY_CAT_XL', version: 1 });
  });
});

test('cross-field inconsistency is refused at the API, with what it should have been', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    const res = await api('POST', `/api/contract-years/${yearId}/structures`, {
      token: broker.token,
      body: {
        label: 'L1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
        terms: catXlTerms({
          reinstatements: [{ count: 2, rate_pct: 100 }],
          aggregate_limit: '40000000', // 20m x (1 + 2) = 60m, not 40m
        }),
      },
    });
    assert.equal(res.status, 422);
    assert.match(res.body.error, /internally inconsistent/);
    assert.match(res.body.details.termErrors[0].message, /expected USD 60000000\.00/);

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM structure');
    assert.equal(rows[0].n, 0, 'a structure whose terms disagree with themselves is never stored');
  });
});

test('layer contiguity is reported as a warning, and does not block the placement', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);

    // 15m xs 5m tops out at 20m; the second layer attaches at 25m.
    await addStructure(api, yearId, {
      label: 'Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      terms: catXlTerms({ deductible: '5000000', limit: '15000000', layer_no: 1, layer_of: 2 }),
    });
    await addStructure(api, yearId, {
      label: 'Layer 2', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', position: 1,
      terms: catXlTerms({ deductible: '25000000', limit: '30000000', layer_no: 2, layer_of: 2 }),
    });

    const view = await api('GET', `/api/contract-years/${yearId}/structures`, { token: uw.token });
    assert.equal(view.status, 200);
    assert.equal(view.body.structures.length, 2, 'both layers were accepted');
    assert.equal(view.body.warnings.length, 1);
    assert.equal(view.body.warnings[0].code, 'LAYER_GAP');
    assert.match(view.body.warnings[0].message, /may be deliberate/);
  });
});

test('a contiguous tower raises nothing', async () => {
  await withServer(async (api) => {
    const { yearId } = await setupYear(api);
    await addStructure(api, yearId, {
      label: 'Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property',
      terms: catXlTerms({ deductible: '5000000', limit: '15000000', layer_no: 1, layer_of: 2 }),
    });
    await addStructure(api, yearId, {
      label: 'Layer 2', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', position: 1,
      terms: catXlTerms({ deductible: '20000000', limit: '30000000', layer_no: 2, layer_of: 2 }),
    });
    const view = await api('GET', `/api/contract-years/${yearId}/structures`, { token: uw.token });
    assert.deepEqual(view.body.warnings, []);
  });
});

test('installing schemas is idempotent, and an edited schema is reported not applied', async () => {
  // resetDb has already installed the shipped schemas once.
  const second = await installTermSchemas();
  assert.deepEqual(second.installed, [], 'installing twice adds nothing');
  assert.deepEqual(second.drifted, [], 'and the definitions match what is stored');

  // Simulate someone editing a shipped schema without bumping its version.
  // The stored row must stay in force — it is what validated the structures
  // already in the database — but the divergence must not pass in silence.
  await pool.query(
    `UPDATE term_schema SET schema = jsonb_set(schema, '{properties,brokerage_pct,maximum}', '5')
     WHERE treaty_type = 'PROPERTY_CAT_XL'`,
  );
  const third = await installTermSchemas();
  assert.deepEqual(third.installed, []);
  assert.equal(third.drifted.length, 1);
  assert.equal(third.drifted[0].treaty_type, 'PROPERTY_CAT_XL');
  assert.match(third.drifted[0].message, /ship the change as a new version/);

  const { rows } = await pool.query(
    `SELECT schema#>>'{properties,brokerage_pct,maximum}' AS max FROM term_schema
     WHERE treaty_type = 'PROPERTY_CAT_XL'`,
  );
  assert.equal(rows[0].max, '5', 'the stored schema was not quietly overwritten');
});
