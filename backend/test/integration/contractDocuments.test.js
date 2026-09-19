// The Documents step under Contracts, as the Universe modelling tool keeps
// it: files uploaded against a contract with a document type, a title and a
// description — listed newest first, viewed inline, downloaded byte for
// byte, re-labelled and deleted; a broker or admin writes, everyone signed
// in reads.
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

test('a broker uploads documents, anyone signed in lists, views and downloads them, and the broker re-labels and deletes one', async () => {
  const broker = await makeUser('broker');
  const uw = await makeUser('underwriter');
  await withServer(async (api) => {
    const p = await seedContract(api, broker.token);

    const up = await api('POST', `/api/placements/${p.id}/contract-documents`, {
      token: broker.token,
      body: {
        doc_type: 'Final Slip', title: 'Final Signed Slip', description: 'From the cedant',
        filename: 'slip 2027.txt', mime_type: 'text/plain', content_base64: b64('Slip text'),
      },
    });
    assert.equal(up.status, 201);
    assert.equal(up.body.doc_type, 'Final Slip');
    assert.equal(up.body.title, 'Final Signed Slip');
    assert.equal(up.body.description, 'From the cedant');
    assert.equal(up.body.filename, 'slip 2027.txt');
    assert.equal(up.body.size_bytes, 9);
    assert.equal(up.body.uploaded_by_name, broker.user.name);
    assert.ok(up.body.uploaded_at, 'when it was uploaded');
    assert.equal(up.body.content, undefined, 'the bytes never ride on the list');

    // No title typed: the file's name, without its extension, and the type defaults to Other.
    const second = await api('POST', `/api/placements/${p.id}/contract-documents`, {
      token: broker.token,
      body: { filename: 'Large losses 2026.csv', mime_type: 'text/csv', content_base64: b64('loss,amount\n') },
    });
    assert.equal(second.status, 201);
    assert.equal(second.body.doc_type, 'Other');
    assert.equal(second.body.title, 'Large losses 2026');
    assert.equal(second.body.description, null);

    const list = await api('GET', `/api/placements/${p.id}/contract-documents`, { token: uw.token });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.map((d) => d.id), [second.body.id, up.body.id], 'newest first');

    const view = await api('GET', `/api/contract-documents/${up.body.id}/view`, { token: uw.token, raw: true });
    assert.equal(view.status, 200);
    assert.equal(view.headers.get('content-type'), 'text/plain');
    assert.match(view.headers.get('content-disposition'), /^inline; filename="slip 2027.txt"/);
    assert.equal(view.headers.get('content-security-policy'), null, 'plain text renders as it is');
    assert.equal(await view.text(), 'Slip text');

    const dl = await api('GET', `/api/contract-documents/${up.body.id}/download`, { token: uw.token, raw: true });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'text/plain');
    assert.match(dl.headers.get('content-disposition'), /^attachment; filename="slip 2027.txt"/);
    assert.equal(await dl.text(), 'Slip text', 'the same bytes come back');

    // An HTML upload shown inline is sandboxed out of the app's origin.
    const html = await api('POST', `/api/placements/${p.id}/contract-documents`, {
      token: broker.token,
      body: { filename: 'note.html', mime_type: 'text/html', content_base64: b64('<script>1</script>') },
    });
    assert.equal(html.status, 201);
    const htmlView = await api('GET', `/api/contract-documents/${html.body.id}/view`, { token: uw.token, raw: true });
    assert.equal(htmlView.headers.get('content-security-policy'), 'sandbox');
    await htmlView.text();

    const patched = await api('PATCH', `/api/contract-documents/${up.body.id}`, {
      token: broker.token, body: { doc_type: 'Draft Slip', title: 'Draft slip v2', description: null },
    });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.doc_type, 'Draft Slip');
    assert.equal(patched.body.title, 'Draft slip v2');
    assert.equal(patched.body.description, null);

    assert.equal((await api('DELETE', `/api/contract-documents/${up.body.id}`, { token: broker.token })).status, 204);
    const after = await api('GET', `/api/placements/${p.id}/contract-documents`, { token: broker.token });
    assert.deepEqual(after.body.map((d) => d.id), [html.body.id, second.body.id]);
    assert.equal((await api('GET', `/api/contract-documents/${up.body.id}/download`, { token: broker.token, raw: true })).status, 404);
  });
});

test('only a broker or admin uploads or deletes; a bad upload is refused; nothing is served without a session', async () => {
  const broker = await makeUser('broker');
  const uw = await makeUser('underwriter');
  await withServer(async (api) => {
    const p = await seedContract(api, broker.token);
    const body = { doc_type: 'Other', filename: 'x.txt', mime_type: 'text/plain', content_base64: b64('x') };
    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: uw.token, body })).status, 403);
    const up = await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body });
    assert.equal(up.status, 201);
    assert.equal((await api('DELETE', `/api/contract-documents/${up.body.id}`, { token: uw.token })).status, 403);
    assert.equal((await api('PATCH', `/api/contract-documents/${up.body.id}`, { token: uw.token, body: { doc_type: 'Final Slip' } })).status, 403);

    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body: { ...body, doc_type: 'Invoice' } })).status, 422, 'a type off the list');
    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body: { ...body, content_base64: '!!!' } })).status, 422, 'not base64');
    assert.equal((await api('POST', `/api/placements/${p.id}/contract-documents`, { token: broker.token, body: { ...body, filename: '' } })).status, 422, 'no name');
    assert.equal((await api('PATCH', `/api/contract-documents/${up.body.id}`, { token: broker.token, body: { title: '' } })).status, 422, 'a title cannot be blanked');
    assert.equal((await api('POST', '/api/placements/00000000-0000-0000-0000-000000000000/contract-documents', { token: broker.token, body })).status, 404, 'no such contract');
    assert.equal((await api('GET', `/api/placements/${p.id}/contract-documents`)).status, 401, 'signed in only');
    assert.equal((await api('GET', `/api/contract-documents/${up.body.id}/view`, { raw: true })).status, 401);
    assert.equal((await api('GET', `/api/contract-documents/${up.body.id}/download`, { raw: true })).status, 401);
  });
});
