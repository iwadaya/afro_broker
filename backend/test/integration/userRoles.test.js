// An admin changes a user's role — the way an existing broker becomes a
// Senior Broker who approves renewal packs.
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
  broker = await makeUser('broker', 'edwin@test.local');
});

test('an admin makes a broker a Senior Broker, and they can then approve a pack', async () => {
  await withServer(async (api) => {
    // Not before.
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'C', domicile: 'Kenya' } });
    const placement = await api('POST', '/api/placements', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
    });
    const pack = await api('POST', `/api/placements/${placement.body.id}/packs`, { token: admin.token, body: {} });
    await api('POST', `/api/packs/${pack.body.id}/submit`, { token: admin.token, body: {} });
    assert.equal((await api('POST', `/api/packs/${pack.body.id}/approve`, { token: broker.token, body: {} })).status, 403);

    assert.equal((await api('PATCH', `/api/auth/users/${broker.user.id}`, { token: broker.token, body: { role: 'senior_broker' } })).status, 403, 'only an admin');
    const changed = await api('PATCH', `/api/auth/users/${broker.user.id}`, { token: admin.token, body: { role: 'senior_broker' } });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.role, 'senior_broker');
    assert.equal(changed.body.password_hash, undefined);

    // A fresh token carries the new role; the pack can now be approved.
    const login = await api('POST', '/api/auth/login', { body: { email: 'edwin@test.local', password: 'password123' } });
    assert.equal(login.body.user.role, 'senior_broker');
    const approved = await api('POST', `/api/packs/${pack.body.id}/approve`, { token: login.body.token, body: {} });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));

    assert.equal((await api('PATCH', `/api/auth/users/${broker.user.id}`, { token: admin.token, body: { role: 'ceo' } })).status, 422);
    assert.equal((await api('PATCH', `/api/auth/users/${admin.user.id}`, { token: admin.token, body: { role: 'broker' } })).status, 409, 'an admin cannot demote themselves');
    const off = await api('PATCH', `/api/auth/users/${broker.user.id}`, { token: admin.token, body: { active: false } });
    assert.equal(off.body.active, false);
    assert.equal((await api('POST', '/api/auth/login', { body: { email: 'edwin@test.local', password: 'password123' } })).status, 401, 'deactivated users cannot sign in');
  });
});
