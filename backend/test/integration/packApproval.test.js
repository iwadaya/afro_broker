// The Pack Approval screen: the trail of every version and the versioned
// comments on it.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

let broker;
let senior;
let uw;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  senior = await makeUser('senior_broker');
  uw = await makeUser('underwriter');
});

async function seedPack(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Approval Cedant', domicile: 'Kenya' } });
  const placement = await api('POST', '/api/placements', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, class: 'Property Cat XoL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
  });
  const pack = await api('POST', `/api/placements/${placement.body.id}/packs`, { token: broker.token, body: {} });
  assert.equal(pack.status, 201);
  return { pid: placement.body.id, pack: pack.body };
}

test('the approval screen lists every version with its trail, and the steps land on it as they are taken', async () => {
  await withServer(async (api) => {
    const { pid, pack } = await seedPack(api);
    let res = await api('GET', `/api/placements/${pid}/pack-approval`, { token: broker.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.versions.length, 1);
    assert.equal(res.body.approved, null);
    const [v1] = res.body.versions;
    assert.equal(v1.status, 'draft');
    assert.deepEqual(v1.trail.map((e) => e.action), ['build']);
    assert.equal(v1.trail[0].user_name, broker.user.name);
    assert.deepEqual(v1.required_missing, []);

    await api('POST', `/api/packs/${pack.id}/submit`, { token: broker.token, body: {} });
    await api('POST', `/api/packs/${pack.id}/reject`, { token: senior.token, body: { note: 'Large losses need the 2025 run.' } });
    await api('POST', `/api/packs/${pack.id}/submit`, { token: broker.token, body: {} });
    await api('POST', `/api/packs/${pack.id}/approve`, { token: senior.token, body: {} });

    res = await api('GET', `/api/placements/${pid}/pack-approval`, { token: broker.token });
    const v = res.body.versions[0];
    assert.equal(v.status, 'approved');
    assert.equal(res.body.approved, pack.id);
    assert.deepEqual(v.trail.map((e) => e.action), ['build', 'submit', 'reject', 'submit', 'approve']);
    assert.equal(v.trail[2].detail.note, 'Large losses need the 2025 run.');
    assert.equal(v.trail[2].user_name, senior.user.name);
    assert.equal(v.trail[4].user_role, 'senior_broker');
    assert.equal(v.approved_by_name, senior.user.name);
  });
});

test('comments are kept as versions: a revision is a new wording with the old one underneath', async () => {
  await withServer(async (api) => {
    const { pid, pack } = await seedPack(api);
    const first = await api('POST', `/api/packs/${pack.id}/comments`, { token: uw.token, body: { body: 'Is the cat load in the premium?' } });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.body, 'Is the cat load in the premium?');
    assert.equal(first.body.edits, 0);
    assert.equal(first.body.created_by_name, uw.user.name);

    const reply = await api('POST', `/api/packs/${pack.id}/comments`, { token: broker.token, body: { body: 'Yes — see the premiums screen.' } });
    assert.equal(reply.status, 201);

    // The underwriter revises the question; the first wording stays readable.
    const revised = await api('POST', `/api/packs/${pack.id}/comments`, { token: uw.token, body: { body: 'Is the cat load in the premium, and at what rate?', replaces_id: first.body.id } });
    assert.equal(revised.status, 201, JSON.stringify(revised.body));
    assert.equal(revised.body.edits, 1);
    assert.equal(revised.body.history[0].body, 'Is the cat load in the premium?');
    assert.equal(revised.body.root_id, first.body.id);

    const res = await api('GET', `/api/placements/${pid}/pack-approval`, { token: broker.token });
    const comments = res.body.versions[0].comments;
    assert.deepEqual(comments.map((c) => c.body), ['Is the cat load in the premium, and at what rate?', 'Yes — see the premiums screen.'], 'threads in the order first written, latest wording shown');
    assert.equal(comments[0].edits, 1);
    assert.deepEqual(res.body.versions[0].trail.map((e) => e.action), ['build', 'comment', 'comment', 'comment.revise']);

    // Nobody else revises an underwriter's comment; a wording already revised is not revised twice.
    assert.equal((await api('POST', `/api/packs/${pack.id}/comments`, { token: broker.token, body: { body: 'x', replaces_id: first.body.id } })).status, 409);
    assert.equal((await api('POST', `/api/packs/${pack.id}/comments`, { token: uw.token, body: { body: 'again', replaces_id: first.body.id } })).status, 409);
    assert.equal((await api('POST', `/api/packs/${pack.id}/comments`, { token: uw.token, body: { body: '   ' } })).status, 422);

    // Append-only at the database: nothing updates or deletes a comment.
    await assert.rejects(pool.query('DELETE FROM renewal_pack_comment WHERE id = $1', [first.body.id]), /append-only/);
    await assert.rejects(pool.query("UPDATE renewal_pack_comment SET body = 'edited' WHERE id = $1", [first.body.id]), /append-only/);
  });
});
