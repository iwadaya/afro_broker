import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

/**
 * §1.1 — Cedant → Contract → ContractYear, and the renewal chain.
 */

let broker;
let uw;
let admin;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  uw = await makeUser('underwriter');
  admin = await makeUser('admin');
});

async function makeCedant(api, name = 'Spine Mutual') {
  const res = await api('POST', '/api/cedants', { token: broker.token, body: { name } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.id;
}

async function makeContract(api, cedantId, overrides = {}) {
  const res = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedantId, name: 'Property Surplus', cob: 'Property', territory: 'MENA', ...overrides },
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

async function makeYear(api, contractId, body) {
  const res = await api('POST', `/api/contracts/${contractId}/years`, { token: broker.token, body });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

test('a broker builds cedant → contract → contract year', async () => {
  await withServer(async (api) => {
    const cedantId = await makeCedant(api);
    const contract = await makeContract(api, cedantId);
    const year = await makeYear(api, contract.id, {
      year_label: '2025', inception: '2025-01-01', expiry: '2025-12-31', currency: 'USD',
    });
    assert.equal(year.prior_contract_year_id, null);

    const read = await api('GET', `/api/contracts/${contract.id}`, { token: uw.token });
    assert.equal(read.status, 200);
    assert.equal(read.body.cedant_name, 'Spine Mutual');
    assert.equal(read.body.years.length, 1);
  });
});

test('renewal is a linked chain, readable in both directions', async () => {
  await withServer(async (api) => {
    const contract = await makeContract(api, await makeCedant(api));
    const y2024 = await makeYear(api, contract.id, {
      year_label: '2024', inception: '2024-01-01', expiry: '2024-12-31', currency: 'USD',
    });

    const y2025 = await api('POST', `/api/contract-years/${y2024.id}/renew`, {
      token: broker.token, body: { year_label: '2025' },
    });
    assert.equal(y2025.status, 201);
    assert.equal(y2025.body.prior_contract_year_id, y2024.id);
    assert.equal(String(y2025.body.inception).slice(0, 10), '2025-01-01');
    assert.equal(String(y2025.body.expiry).slice(0, 10), '2025-12-31');
    assert.equal(y2025.body.currency, 'USD', 'currency rolls forward unless overridden');

    await api('POST', `/api/contract-years/${y2025.body.id}/renew`, {
      token: broker.token, body: { year_label: '2026' },
    });

    const chain = await api('GET', `/api/contract-years/${y2025.body.id}/chain`, { token: uw.token });
    assert.equal(chain.status, 200);
    assert.equal(chain.body.length, 3);
    assert.deepEqual(chain.body.chain.map((y) => y.year_label), ['2024', '2025', '2026']);
    assert.deepEqual(chain.body.chain.map((y) => y.is_current), [false, true, false]);
  });
});

test('a year cannot renew twice — a chain, not a fork', async () => {
  await withServer(async (api) => {
    const contract = await makeContract(api, await makeCedant(api));
    const y2025 = await makeYear(api, contract.id, {
      year_label: '2025', inception: '2025-01-01', expiry: '2025-12-31', currency: 'USD',
    });
    await api('POST', `/api/contract-years/${y2025.id}/renew`, { token: broker.token, body: { year_label: '2026' } });

    const second = await api('POST', `/api/contract-years/${y2025.id}/renew`, {
      token: broker.token, body: { year_label: '2026 alt' },
    });
    assert.equal(second.status, 409);
    assert.match(second.body.error, /chain, not a fork/i);

    // The unique index holds against a direct write too.
    await assert.rejects(
      pool.query(
        `INSERT INTO contract_year (contract_id, year_label, inception, expiry, currency, prior_contract_year_id)
         VALUES ($1,'sneaky','2026-01-01','2026-12-31','USD',$2)`,
        [contract.id, y2025.id],
      ),
      /idx_contract_year_one_successor/,
    );
  });
});

test('the renewal link cannot cross programmes', async () => {
  await withServer(async (api) => {
    const cedantId = await makeCedant(api);
    const property = await makeContract(api, cedantId, { name: 'Property Surplus' });
    const motor = await makeContract(api, cedantId, { name: 'Motor QS', cob: 'Motor' });
    const propertyYear = await makeYear(api, property.id, {
      year_label: '2025', inception: '2025-01-01', expiry: '2025-12-31', currency: 'USD',
    });

    const crossed = await api('POST', `/api/contracts/${motor.id}/years`, {
      token: broker.token,
      body: {
        year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
        prior_contract_year_id: propertyYear.id,
      },
    });
    assert.equal(crossed.status, 409);
    assert.match(crossed.body.error, /different contract/i);

    // A cross-contract link would corrupt the expiring slip diff (M1), the
    // expiring-panel flag (M9) and the expiring structures in M5, so the
    // composite foreign key refuses it at the table as well.
    await assert.rejects(
      pool.query(
        `INSERT INTO contract_year (contract_id, year_label, inception, expiry, currency, prior_contract_year_id)
         VALUES ($1,'2026','2026-01-01','2026-12-31','USD',$2)`,
        [motor.id, propertyYear.id],
      ),
      /contract_year_prior_same_contract/,
    );
  });
});

test('a placement attaches to the year it places, and only one does', async () => {
  await withServer(async (api) => {
    const cedantId = await makeCedant(api);
    const contract = await makeContract(api, cedantId);
    const year = await makeYear(api, contract.id, {
      year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
    });

    const mkPlacement = async (ref) => (await api('POST', '/api/placements', {
      token: broker.token,
      body: {
        reference: ref, cedant_id: cedantId, class: 'Property',
        inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
      },
    })).body;

    const first = await mkPlacement('SPINE-1');
    const second = await mkPlacement('SPINE-2');

    const attached = await api('POST', `/api/contract-years/${year.id}/placement`, {
      token: broker.token, body: { placement_id: first.id },
    });
    assert.equal(attached.status, 200);
    assert.equal(attached.body.contract_year_id, year.id);

    const clash = await api('POST', `/api/contract-years/${year.id}/placement`, {
      token: broker.token, body: { placement_id: second.id },
    });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already placed by SPINE-1/);

    // The year now reports its placement, and the contract view shows it too.
    const read = await api('GET', `/api/contract-years/${year.id}`, { token: uw.token });
    assert.equal(read.body.placement.reference, 'SPINE-1');
  });
});

test('existing placements are left unattached — nothing is backfilled by guesswork', async () => {
  await withServer(async (api) => {
    const cedantId = await makeCedant(api);
    await api('POST', '/api/placements', {
      token: broker.token,
      body: {
        reference: 'LEGACY-1', cedant_id: cedantId, class: 'Property',
        inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
      },
    });
    const { rows } = await pool.query(
      'SELECT contract_year_id FROM placement WHERE reference = $1', ['LEGACY-1'],
    );
    assert.equal(rows[0].contract_year_id, null,
      'grouping a book into programmes is a judgement, not something to infer from (cedant, class)');
  });
});

test('a contract year rejects an expiry before its inception', async () => {
  await withServer(async (api) => {
    const contract = await makeContract(api, await makeCedant(api));
    const bad = await api('POST', `/api/contracts/${contract.id}/years`, {
      token: broker.token,
      body: { year_label: '2026', inception: '2026-12-31', expiry: '2026-01-01', currency: 'USD' },
    });
    assert.equal(bad.status, 422);
  });
});

test('the spine is broker-write and audited with its actor', async () => {
  await withServer(async (api) => {
    const cedantId = await makeCedant(api);
    const contract = await makeContract(api, cedantId);
    await makeYear(api, contract.id, {
      year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD',
    });

    const { rows } = await pool.query(
      `SELECT entity_type, action, user_id, after_state FROM audit_event
       WHERE entity_type IN ('contract','contract_year') ORDER BY id`,
    );
    assert.deepEqual(rows.map((r) => `${r.entity_type}:${r.action}`), ['contract:create', 'contract_year:create']);
    assert.ok(rows.every((r) => r.user_id === broker.user.id));
    assert.equal(rows[0].after_state.name, 'Property Surplus');
  });
});
