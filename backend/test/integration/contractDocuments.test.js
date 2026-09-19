// The Documents step under Contracts: files uploaded against a contract —
// listed, downloaded byte for byte, re-labelled and removed; a broker or
// admin writes, everyone signed in reads.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });
beforeEach(async () => { await resetDb(); });

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/** A cedant and a contract (placement) through the API, as the pages create them. */
async function seedContract(api, token) {
  const cedant = (await api('POST', '/api/cedants', { token, body: { name: 'Atlas Mutual', domicile: 'GB' } })).body;
  const res = await api('POST', '/api/placements', {
    token,
    body: { cedant_id: cedant.id, class: 'Property CAT XL', inception: '2027-01-01', expiry: '2027-12-31', currency: 'USD' },
  });
  assert.equal(res.status, 201);
  return res.body;
}

test('a broker uploads a document, anyone signed in lists and downloads it, and the broker re-labels and removes it', async () => {
  const broker = await makeUser('broker');
  const uw = await makeUser('underwriter');
  await withServer(async (api) => {
    const p = await seedContract(api, broker.token);

    const up = await api('POST', `/api/placements/${p.id}/contract-documents`, {
      token: broker.token,
      body: { kind: 'slip', filename: 'slip 2027.txt', mime_type: 'text/plain', content_base64: b64('Slip text'), note: 'From the cedant' },
    });
    assert.equal(up.status, 201);
    assert.equal(up.body.kind, 'slip');
    assert.equal(up.body.filename, 'slip 2027.txt');
    assert.equal(up.body.size_bytes, 9);
    assert.equal(up.body.note, 'From the cedant');
    assert.equal(up.body.uploaded_by_name, broker.user.name);
    assert.equal(up.body.content, undefined, 'the bytes never ride on the list');

    const list = await api('GET', `/api/placements/${p.id}/contract-documents`, { token: uw.token });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].id, up.body.id);

    const dl = await api('GET', `/api/contract-documents/${up.body.id}/download`, { token: uw.token, raw: true });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'text/plain');
    assert.match(dl.headers.get('content-disposition'), /^attachment; filename="slip 2027.txt"/);
    assert.equal(await dl.text(), 'Slip text', 'the same bytes come back');

    const patched = await api('PATCH', `/api/contract-documents/${up.body.id}`, { token: broker.token, body: { kind: 'wording', note: null } });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.kind, 'wording');
    assert.equal(patched.body.note, null);

    assert.equal((await api('DELETE', `/api/contract-documents/${up.body.id}`, { token: broker.token })).status, 204);
    assert.deepEqual((await api('GET', `/api/placements/${p.id}/contract-documents`, { token: broker.token })).body, []);
    assert.equal((await api('GET', `/api/contract-documents/${up.body.id}/download`, { token: broker.token, raw: true })).status, 404);
  });
});

test('only a broker or admin uploads or removes; a bad upload is refused; nothing is served without a session', async () => {
  const broker = await makeUser('broker');
  const uw = await makeUser('underwriter');
  await withServer(async (api) => {
    const p = await seedContract(api, broker.token);
    const body = { kind: 'other', filename: 'x.txt', mime_type: 'text/plain', content_base64: b64('x') };
    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: uw.token, body })).status, 403);
    const up = await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body });
    assert.equal(up.status, 201);
    assert.equal((await api('DELETE', `/api/contract-documents/${up.body.id}`, { token: uw.token })).status, 403);
    assert.equal((await api('PATCH', `/api/contract-documents/${up.body.id}`, { token: uw.token, body: { kind: 'slip' } })).status, 403);

    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body: { ...body, kind: 'invoice' } })).status, 422, 'an unknown kind');
    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body: { ...body, content_base64: '!!!' } })).status, 422, 'not base64');
    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body: { ...body, filename: '' } })).status, 422, 'no name');
    assert.equal((await api('POST', '/api/placements/00000000-0000-0000-0000-000000000000/contract-documents', { token: broker.token, body })).status, 404, 'no such contract');
    assert.equal((await api('GET', `/api/placements/${p.id}/contract-documents`)).status, 401, 'signed in only');
    assert.equal((await api('GET', `/api/contract-documents/${up.body.id}/download`, { raw: true })).status, 401);
  });
});
