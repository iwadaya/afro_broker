import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { presentSection } from '../../src/modules/packs/packs.present.js';

let broker;

before(async () => {
  await resetDb();
});

after(async () => {
  await pool.end();
});

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
});

/** Create a cedant + placement and return the placement id. */
async function seedPlacement(api) {
  const cedant = await api('POST', '/api/cedants', {
    token: broker.token,
    body: { name: 'Structure Test Insurance', domicile: 'GB' },
  });
  assert.equal(cedant.status, 201);
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: {
      cedant_id: cedant.body.id, class: 'Property QS', inception: '2026-01-01',
      expiry: '2026-12-31', currency: 'EUR',
    },
  });
  assert.equal(placement.status, 201);
  return placement.body.id;
}

test('expiring structure defaults to empty and round-trips a proportional basis', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);

    const fresh = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.body.expiring_structure, {});

    const expiring = {
      basis: 'PROP',
      layers: [],
      prop: {
        treatyType: 'QS + Surplus', qsLimit: 10_000_000, retentionPct: 40,
        surplusMaxRetention: 1_000_000, numLines: 5, commissionPct: 27.5, epi: 5_000_000,
      },
    };
    const saved = await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token,
      body: { expiring_structure: expiring },
    });
    assert.equal(saved.status, 200);

    const read = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(read.body.expiring_structure.basis, 'PROP');
    assert.deepEqual(read.body.expiring_structure.layers, []);
    assert.equal(read.body.expiring_structure.prop.treatyType, 'QS + Surplus');
    assert.equal(read.body.expiring_structure.prop.numLines, 5);
  });
});

test('expiring structure round-trips a non-proportional layer list', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);

    const expiring = {
      basis: 'NP',
      layers: [
        { name: 'Layer 1', type: 'XoL', attachment: 5_000_000, limit: 10_000_000, order: 100, premium: 750_000, risk: true, cat: false },
        { name: 'Layer 2', type: 'XoL', attachment: 15_000_000, limit: 20_000_000, order: 100, premium: 400_000, risk: true, cat: true },
      ],
      prop: {},
    };
    const saved = await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token,
      body: { expiring_structure: expiring },
    });
    assert.equal(saved.status, 200);

    const read = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(read.body.expiring_structure.basis, 'NP');
    assert.equal(read.body.expiring_structure.layers.length, 2);
    assert.equal(read.body.expiring_structure.layers[0].limit, 10_000_000);
    assert.equal(read.body.expiring_structure.layers[1].cat, true);

    // Editing another structure field leaves the expiring structure alone.
    const other = await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token,
      body: { quote_structures: [{ basis: 'NP', layers: [], prop: {}, cobs: [] }] },
    });
    assert.equal(other.status, 200);
    const after = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(after.body.expiring_structure.layers.length, 2);
  });
});

test('non-proportional layer terms: reinstatements, EGNPI, rate and AAD round-trip', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);

    const created = await api('POST', `/api/placements/${pid}/layers`, {
      token: broker.token,
      body: {
        name: 'Layer 1 xs', type: 'XoL', attachment: 5_000_000, limit_amt: 10_000_000,
        order_pct: 100, premium100: 1_500_000, currency: 'EUR',
        reinstatements: 'UNLIMITED', reinstatement_pct: 125, egnpi: 40_000_000,
        rate_pct: 3.75, aad: 250_000,
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.reinstatements, 'UNLIMITED');
    assert.equal(Number(created.body.reinstatement_pct), 125);
    assert.equal(Number(created.body.egnpi), 40_000_000);
    assert.equal(Number(created.body.rate_pct), 3.75);
    assert.equal(Number(created.body.aad), 250_000);

    // A count replaces "unlimited", and a null clears a term.
    const patched = await api('PATCH', `/api/layers/${created.body.id}`, {
      token: broker.token,
      body: { reinstatements: '3', aad: null },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.reinstatements, '3');
    assert.equal(patched.body.aad, null);
    assert.equal(Number(patched.body.egnpi), 40_000_000, 'untouched terms survive a PATCH');

    // Out-of-range reinstatement counts are rejected rather than stored.
    const bad = await api('PATCH', `/api/layers/${created.body.id}`, {
      token: broker.token,
      body: { reinstatements: '11' },
    });
    assert.equal(bad.status, 422);
  });
});

test('renewal clone carries the layer rating terms across', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    await api('POST', `/api/placements/${pid}/layers`, {
      token: broker.token,
      body: {
        name: 'Layer 1 xs', type: 'XoL', attachment: 5_000_000, limit_amt: 10_000_000,
        currency: 'EUR', reinstatements: '2', reinstatement_pct: 100,
        egnpi: 40_000_000, rate_pct: 3.75, aad: 250_000,
      },
    });

    const renewal = await api('POST', `/api/placements/${pid}/renew`, {
      token: broker.token,
      body: { inception: '2027-01-01', expiry: '2027-12-31' },
    });
    assert.equal(renewal.status, 201);

    const cloned = await api('GET', `/api/placements/${renewal.body.id}`, { token: broker.token });
    const layer = cloned.body.layers[0];
    assert.equal(layer.reinstatements, '2');
    assert.equal(Number(layer.reinstatement_pct), 100);
    assert.equal(Number(layer.egnpi), 40_000_000);
    assert.equal(Number(layer.rate_pct), 3.75);
    assert.equal(Number(layer.aad), 250_000);
  });
});

test('expiring structure round-trips BOTH, keeping the proportional and non-proportional sections', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);

    const expiring = {
      basis: 'BOTH',
      layers: [
        { name: 'Layer 1', type: 'XoL', attachment: 5_000_000, limit: 10_000_000, order: 100, premium: 750_000, risk: true, cat: true },
      ],
      prop: {
        treatyType: 'QS + Surplus', qsLimit: 10_000_000, retentionPct: 40,
        surplusMaxRetention: 1_000_000, numLines: 5, commissionPct: 27.5, epi: 5_000_000,
      },
    };
    const saved = await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token, body: { expiring_structure: expiring },
    });
    assert.equal(saved.status, 200);

    const read = await api('GET', `/api/placements/${pid}`, { token: broker.token });
    assert.equal(read.body.expiring_structure.basis, 'BOTH');
    // Neither section is dropped for the other.
    assert.equal(read.body.expiring_structure.prop.treatyType, 'QS + Surplus');
    assert.equal(read.body.expiring_structure.layers.length, 1);
    assert.equal(read.body.expiring_structure.layers[0].limit, 10_000_000);
  });
});

test('a renewal pack shows both sections of a BOTH expiring structure', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token,
      body: {
        expiring_structure: {
          basis: 'BOTH',
          layers: [{ name: 'Layer 1', type: 'XoL', attachment: 5_000_000, limit: 10_000_000, order: 100, premium: 750_000 }],
          prop: { treatyType: 'QS + Surplus', commissionPct: 27.5, epi: 5_000_000 },
        },
      },
    });

    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    assert.equal(pack.status, 201);
    const section = pack.body.snapshot.sections.find((s) => s.key === 'expiring_structure');
    assert.ok(section, 'the pack carries an expiring structure section');
    assert.equal(section.data.basis, 'BOTH');

    // Presented — as the pack renders and exports — it carries the
    // proportional facts and the non-proportional layer table.
    const shown = presentSection(section);
    const labels = shown.facts.map((f) => f.label);
    assert.ok(labels.includes('Treaty type'), 'proportional terms are presented');
    assert.equal(shown.facts.find((f) => f.label === 'Basis').value, 'Both — proportional and non-proportional');
    assert.equal(shown.tables.length, 1, 'the non-proportional layers are presented');
    assert.equal(shown.tables[0].rows.length, 1);
  });
});

test('an expiring structure on a BOTH basis is kept even when only its terms are filled in', async () => {
  await withServer(async (api) => {
    const pid = await seedPlacement(api);
    await api('PATCH', `/api/placements/${pid}`, {
      token: broker.token,
      body: {
        expiring_structure: { basis: 'BOTH', layers: [], prop: { treatyType: 'Quota Share', commissionPct: 30 } },
      },
    });

    const pack = await api('POST', `/api/placements/${pid}/packs`, { token: broker.token, body: {} });
    const section = pack.body.snapshot.sections.find((s) => s.key === 'expiring_structure');
    assert.ok(section?.data, 'the section is not dropped for having no layers');
    assert.equal(section.data.prop.treatyType, 'Quota Share');
  });
});
