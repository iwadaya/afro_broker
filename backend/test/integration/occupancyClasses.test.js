import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let admin;
let broker;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  admin = await makeUser('admin');
  broker = await makeUser('broker');
});

const list = (api, token) => api('GET', '/api/occupancy-classes', { token });

test('the seeded grading is readable by any signed-in user', async () => {
  await withServer(async (api) => {
    const res = await list(api, broker.token);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((k) => k.code), ['A', 'B', 'C']);
    assert.deepEqual(res.body.map((k) => k.capacity_pct), [100, 75, 50]);
    assert.ok(res.body[2].occupancies.includes('textile mill'));
    assert.equal(res.body[0].name, 'Non-hazardous');

    const anon = await api('GET', '/api/occupancy-classes');
    assert.equal(anon.status, 401);
  });
});

test('only an admin may add, change or remove a class', async () => {
  await withServer(async (api) => {
    const klass = { code: 'D', name: 'Special', capacity_pct: 10 };
    assert.equal((await api('POST', '/api/occupancy-classes', { token: broker.token, body: klass })).status, 403);

    const created = await api('POST', '/api/occupancy-classes', { token: admin.token, body: klass });
    assert.equal(created.status, 201);
    assert.equal(created.body.position, 4, 'a new class lands at the end');

    const id = created.body.id;
    assert.equal((await api('PATCH', `/api/occupancy-classes/${id}`, { token: broker.token, body: { capacity_pct: 5 } })).status, 403);
    assert.equal((await api('DELETE', `/api/occupancy-classes/${id}`, { token: broker.token })).status, 403);
    assert.equal((await api('DELETE', `/api/occupancy-classes/${id}`, { token: admin.token })).status, 204);
    assert.equal((await list(api, admin.token)).body.length, 3);
  });
});

test('every column can be changed', async () => {
  await withServer(async (api) => {
    const before = (await list(api, admin.token)).body[1];
    const patched = await api('PATCH', `/api/occupancy-classes/${before.id}`, {
      token: admin.token,
      body: {
        code: 'B2', name: 'Light commercial', description: 'Shops and stores.',
        capacity_pct: 62.5, occupancies: ['warehouse', 'shopping mall'], position: 9,
      },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.code, 'B2');
    assert.equal(patched.body.name, 'Light commercial');
    assert.equal(patched.body.description, 'Shops and stores.');
    assert.equal(patched.body.capacity_pct, 62.5);
    assert.deepEqual(patched.body.occupancies, ['warehouse', 'shopping mall']);
    assert.equal(patched.body.position, 9);
    // Re-ordered to the end by its new position.
    assert.deepEqual((await list(api, admin.token)).body.map((k) => k.code), ['A', 'C', 'B2']);
  });
});

test('a class code stays unique, whatever its case', async () => {
  await withServer(async (api) => {
    const clash = await api('POST', '/api/occupancy-classes', {
      token: admin.token, body: { code: 'a', name: 'Duplicate', capacity_pct: 10 },
    });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /already exists/i);

    const [, b] = (await list(api, admin.token)).body;
    const rename = await api('PATCH', `/api/occupancy-classes/${b.id}`, { token: admin.token, body: { code: 'C' } });
    assert.equal(rename.status, 409);
  });
});

test('validation rejects a share outside 0–100 and an empty code', async () => {
  await withServer(async (api) => {
    for (const body of [
      { code: 'D', name: 'Too much', capacity_pct: 140 },
      { code: 'D', name: 'Negative', capacity_pct: -1 },
      { code: '', name: 'No code', capacity_pct: 10 },
      { code: 'D', name: '', capacity_pct: 10 },
    ]) {
      assert.equal((await api('POST', '/api/occupancy-classes', { token: admin.token, body })).status, 422);
    }
    assert.equal((await list(api, admin.token)).body.length, 3);
  });
});

test('the editor saves the whole table: add, remove, re-order, re-letter', async () => {
  await withServer(async (api) => {
    const [a, b, c] = (await list(api, admin.token)).body;
    const saved = await api('PUT', '/api/occupancy-classes', {
      token: admin.token,
      body: {
        classes: [
          // C first, re-lettered; B dropped; a new class appended.
          { id: c.id, code: '1', name: 'Heavy', capacity_pct: 40, occupancies: ['factory', 'mill'] },
          { id: a.id, code: '2', name: 'Simple', capacity_pct: 100, occupancies: ['office'] },
          { code: '3', name: 'Special', description: 'By referral.', capacity_pct: 0, occupancies: ['explosives'] },
        ],
      },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.map((k) => k.code), ['1', '2', '3']);
    assert.deepEqual(saved.body.map((k) => k.position), [1, 2, 3]);
    assert.deepEqual(saved.body.map((k) => k.capacity_pct), [40, 100, 0]);
    assert.equal(saved.body[0].id, c.id, 'a kept class keeps its identity');
    assert.equal(saved.body[2].description, 'By referral.');
    assert.ok(!saved.body.some((k) => k.id === b.id), 'the dropped class is gone');
    assert.deepEqual((await list(api, broker.token)).body.map((k) => k.code), ['1', '2', '3']);
  });
});

test('two classes can swap codes in one save', async () => {
  await withServer(async (api) => {
    const [a, b, c] = (await list(api, admin.token)).body;
    const swapped = await api('PUT', '/api/occupancy-classes', {
      token: admin.token,
      body: {
        classes: [
          { id: a.id, code: 'B', name: a.name, capacity_pct: a.capacity_pct, occupancies: a.occupancies },
          { id: b.id, code: 'A', name: b.name, capacity_pct: b.capacity_pct, occupancies: b.occupancies },
          { id: c.id, code: c.code, name: c.name, capacity_pct: c.capacity_pct, occupancies: c.occupancies },
        ],
      },
    });
    assert.equal(swapped.status, 200);
    assert.deepEqual(swapped.body.map((k) => k.code), ['B', 'A', 'C']);
    assert.equal(swapped.body[0].name, 'Non-hazardous', 'the row kept its own grading');
  });
});

test('a rejected save leaves the table exactly as it was', async () => {
  await withServer(async (api) => {
    const before = (await list(api, admin.token)).body;
    const clash = await api('PUT', '/api/occupancy-classes', {
      token: admin.token,
      body: {
        classes: [
          { id: before[0].id, code: 'X', name: 'One', capacity_pct: 100 },
          { id: before[1].id, code: 'x', name: 'Two', capacity_pct: 50 },
          { id: before[2].id, code: 'C', name: 'Three', capacity_pct: 20 },
        ],
      },
    });
    assert.equal(clash.status, 409);
    assert.match(clash.body.error, /duplicate/i);

    const missing = await api('PUT', '/api/occupancy-classes', {
      token: admin.token,
      body: { classes: [{ id: '00000000-0000-0000-0000-000000000000', code: 'Z', name: 'Ghost', capacity_pct: 10 }] },
    });
    assert.equal(missing.status, 404);

    const after = (await list(api, admin.token)).body;
    assert.deepEqual(after.map((k) => [k.code, k.name, k.capacity_pct]),
      before.map((k) => [k.code, k.name, k.capacity_pct]));
  });
});

test('a save by a broker is refused', async () => {
  await withServer(async (api) => {
    const res = await api('PUT', '/api/occupancy-classes', {
      token: broker.token, body: { classes: [{ code: 'A', name: 'Only', capacity_pct: 100 }] },
    });
    assert.equal(res.status, 403);
    assert.equal((await list(api, admin.token)).body.length, 3);
  });
});

test('match terms are trimmed and de-duplicated', async () => {
  await withServer(async (api) => {
    const created = await api('POST', '/api/occupancy-classes', {
      token: admin.token,
      body: { code: 'D', name: 'Tidy', capacity_pct: 30, occupancies: [' mill ', 'MILL', 'sawmill', 'mill'] },
    });
    assert.deepEqual(created.body.occupancies, ['mill', 'sawmill']);
  });
});

test('changes to the grading are audited', async () => {
  await withServer(async (api) => {
    const [a] = (await list(api, admin.token)).body;
    await api('PATCH', `/api/occupancy-classes/${a.id}`, { token: admin.token, body: { capacity_pct: 90 } });
    const audit = await api(`GET`, `/api/admin/audit?entity_type=occupancy_class`, { token: admin.token });
    assert.equal(audit.status, 200);
    const entry = audit.body.find((e) => e.action === 'update' && e.entity_id === a.id);
    assert.ok(entry, 'the change is on the audit trail');
    assert.equal(entry.detail.from.capacity_pct, 100);
  });
});
