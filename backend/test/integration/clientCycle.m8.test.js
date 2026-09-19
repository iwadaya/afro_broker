import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { withTransaction } from '../../src/db/pool.js';
import { createApproval, approve } from '../../src/lib/approvals.js';

/**
 * M8 — the quote-to-client cycle on StructureVersion, and D7 on the way out.
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

/** Terms complete enough to be firm order terms for a Cat XL layer. */
const fotReady = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  egnpi: '80000000',
  mdp: '2400000',
  reinstatements: [{ count: 1, rate_pct: 100 }],
  aggregate_limit: '40000000',
  ...over,
});

/** A quote: enough to go to market, not yet enough to be firm. */
const quoteOnly = (over = {}) => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  ...over,
});

async function setup(api, { terms = quoteOnly() } = {}) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Client Mutual' } });
  const contract = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, name: 'Property Programme', cob: 'Property' },
  });
  const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
    token: broker.token,
    body: { year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const structure = await api('POST', `/api/contract-years/${year.body.id}/structures`, {
    token: broker.token,
    body: { label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms },
  });
  assert.equal(structure.status, 201, JSON.stringify(structure.body));
  const detail = await api('GET', `/api/structures/${structure.body.id}`, { token: uw.token });
  return {
    yearId: year.body.id,
    structureId: structure.body.id,
    versionId: detail.body.versions[0].id,
  };
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------
test('a negotiated structure is just a version — no separate machinery', async () => {
  await withServer(async (api) => {
    const { structureId, versionId } = await setup(api);

    const negotiated = await api('POST', `/api/structures/${structureId}/versions`, {
      token: broker.token,
      body: {
        status: 'NEGOTIATED', origin: 'CEDANT', parent_version_id: versionId,
        terms: quoteOnly({ deductible: '4000000' }),
      },
    });
    assert.equal(negotiated.status, 201, JSON.stringify(negotiated.body));
    assert.equal(negotiated.body.origin, 'CEDANT');
    assert.equal(negotiated.body.parent_version_id, versionId);
  });
});

test('comments thread against a version, and a reply cannot jump threads', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    const other = await setup(api);

    const root = await api('POST', `/api/structure-versions/${versionId}/comments`, {
      token: broker.token, body: { body: 'Cedant wants the attachment down to 4m.', audience: 'INTERNAL' },
    });
    assert.equal(root.status, 201);

    const reply = await api('POST', `/api/structure-versions/${versionId}/comments`, {
      token: broker.token,
      body: { body: 'Agreed, putting it back to the market.', parent_comment_id: root.body.id },
    });
    assert.equal(reply.status, 201);

    const crossed = await api('POST', `/api/structure-versions/${other.versionId}/comments`, {
      token: broker.token, body: { body: 'Wrong thread', parent_comment_id: root.body.id },
    });
    assert.equal(crossed.status, 409);

    await assert.rejects(
      pool.query(
        `INSERT INTO structure_comment (structure_version_id, parent_comment_id, body)
         VALUES ($1,$2,'sneaky')`,
        [other.versionId, root.body.id],
      ),
      /structure_comment_parent_same_version/,
    );

    const thread = await api('GET', `/api/structure-versions/${versionId}/comments`, { token: uw.token });
    assert.equal(thread.body.length, 1, 'one root');
    assert.equal(thread.body[0].replies.length, 1, 'with its reply nested under it');
    assert.equal(thread.body[0].replies[0].body, 'Agreed, putting it back to the market.');
  });
});

test('a comment is marked for whom it is', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api);
    await api('POST', `/api/structure-versions/${versionId}/comments`, {
      token: broker.token, body: { body: 'Internal: lead is soft on price.' },
    });
    await api('POST', `/api/structure-versions/${versionId}/comments`, {
      token: broker.token, body: { body: 'Confirming terms as discussed.', audience: 'CEDANT' },
    });
    const thread = await api('GET', `/api/structure-versions/${versionId}/comments`, { token: uw.token });
    assert.deepEqual(thread.body.map((c) => c.audience).sort(), ['CEDANT', 'INTERNAL']);
    assert.equal(thread.body.find((c) => c.audience === 'INTERNAL').audience, 'INTERNAL',
      'an internal note must be distinguishable from something said to the client');
  });
});

// ---------------------------------------------------------------------------
// FOT promotion
// ---------------------------------------------------------------------------
test('promotion to FOT refuses terms M11 could not compute from', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api); // quote-only terms
    const res = await api('POST', `/api/structure-versions/${versionId}/promote-fot`, { token: broker.token });
    assert.equal(res.status, 422);
    const missing = res.body.details.termErrors.map((e) => e.path).sort();
    assert.deepEqual(missing, ['egnpi', 'mdp', 'reinstatements'],
      'the claims and premium engine reads from here');
  });
});

test('promotion creates a new FOT version rather than rewriting the one taken up', async () => {
  await withServer(async (api) => {
    const { structureId, versionId } = await setup(api, { terms: fotReady() });

    const negotiated = await api('POST', `/api/structures/${structureId}/versions`, {
      token: broker.token,
      body: { status: 'NEGOTIATED', origin: 'CEDANT', parent_version_id: versionId, terms: fotReady() },
    });

    const fot = await api('POST', `/api/structure-versions/${negotiated.body.id}/promote-fot`, {
      token: broker.token,
    });
    assert.equal(fot.status, 201, JSON.stringify(fot.body));
    assert.equal(fot.body.status, 'FOT');
    assert.equal(fot.body.parent_version_id, negotiated.body.id);
    assert.deepEqual(fot.body.terms, negotiated.body.terms, 'the same terms, firmed');

    const detail = await api('GET', `/api/structures/${structureId}`, { token: uw.token });
    assert.deepEqual(detail.body.versions.map((v) => v.status), ['SUBMITTED', 'NEGOTIATED', 'FOT'],
      'the negotiated step still records that it was negotiated');
  });
});

test('the live FOT is the latest FOT version, and re-firming does not erase the first', async () => {
  await withServer(async (api) => {
    const { structureId, versionId } = await setup(api, { terms: fotReady() });
    await api('POST', `/api/structure-versions/${versionId}/promote-fot`, { token: broker.token });

    // Terms move again after the first firm order.
    const revised = await api('POST', `/api/structures/${structureId}/versions`, {
      token: broker.token,
      body: { status: 'NEGOTIATED', origin: 'BROKER', terms: fotReady({ rate_pct: 4.1 }) },
    });
    const second = await api('POST', `/api/structure-versions/${revised.body.id}/promote-fot`, {
      token: broker.token,
    });

    const live = await api('GET', `/api/structures/${structureId}/fot`, { token: uw.token });
    assert.equal(live.body.id, second.body.id);
    assert.equal(live.body.terms.rate_pct, 4.1);

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM structure_version WHERE structure_id = $1 AND status = 'FOT'",
      [structureId],
    );
    assert.equal(rows[0].n, 2, 'both firm orders survive; the live one is simply the later');
  });
});

test('an already-firm version is not promoted again', async () => {
  await withServer(async (api) => {
    const { versionId } = await setup(api, { terms: fotReady() });
    const fot = await api('POST', `/api/structure-versions/${versionId}/promote-fot`, { token: broker.token });
    const again = await api('POST', `/api/structure-versions/${fot.body.id}/promote-fot`, { token: broker.token });
    assert.equal(again.status, 409);
  });
});

test('a structure with no firm order says so', async () => {
  await withServer(async (api) => {
    const { structureId } = await setup(api);
    const live = await api('GET', `/api/structures/${structureId}/fot`, { token: uw.token });
    assert.equal(live.body, null);
  });
});

// ---------------------------------------------------------------------------
// The client stage, under D7
// ---------------------------------------------------------------------------
test('nothing reaches the cedant on one persons authority (D7)', async () => {
  await withServer(async (api) => {
    const { yearId, versionId } = await setup(api);

    const send = await api('POST', `/api/contract-years/${yearId}/cedant-sends`, {
      token: broker.token, body: { structure_version_ids: [versionId] },
    });
    assert.equal(send.status, 201);
    assert.equal(send.body.status, 'DRAFT');

    const ungated = await api('POST', `/api/cedant-sends/${send.body.id}/send`, { token: broker.token });
    assert.equal(ungated.status, 403);
    assert.match(ungated.body.error, /requires approval by a second user/i);

    await withTransaction((client) => createApproval(client, {
      actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: send.body.id,
      proposedBy: broker.user.id,
    }));
    await withTransaction((client) => approve(client, {
      actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: send.body.id,
      approver: uw.user,
    }));

    const sent = await api('POST', `/api/cedant-sends/${send.body.id}/send`, { token: broker.token });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.status, 'SENT');
    assert.ok(sent.body.approval_id, 'the send records the authorisation that permitted it');

    // The table refuses a send that claims no approval.
    await assert.rejects(
      pool.query("UPDATE cedant_quote_send SET approval_id = NULL WHERE id = $1", [send.body.id]),
      /cedant_quote_send_sent_has_approval/,
    );
  });
});

test('a send cannot carry versions from another year', async () => {
  await withServer(async (api) => {
    const a = await setup(api);
    const b = await setup(api);
    const res = await api('POST', `/api/contract-years/${a.yearId}/cedant-sends`, {
      token: broker.token, body: { structure_version_ids: [a.versionId, b.versionId] },
    });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /belong to this contract year/i);
  });
});

test('taken up or not, and not taken up needs a reason', async () => {
  await withServer(async (api) => {
    const { yearId, versionId } = await setup(api);
    const send = await api('POST', `/api/contract-years/${yearId}/cedant-sends`, {
      token: broker.token, body: { structure_version_ids: [versionId] },
    });

    const early = await api('POST', `/api/cedant-sends/${send.body.id}/outcome`, {
      token: broker.token, body: { taken_up: true },
    });
    assert.equal(early.status, 409, 'an outcome only follows a send that went out');

    await withTransaction((client) => createApproval(client, {
      actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: send.body.id,
      proposedBy: broker.user.id,
    }));
    await withTransaction((client) => approve(client, {
      actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: send.body.id,
      approver: admin.user,
    }));
    await api('POST', `/api/cedant-sends/${send.body.id}/send`, { token: broker.token });

    const bare = await api('POST', `/api/cedant-sends/${send.body.id}/outcome`, {
      token: broker.token, body: { taken_up: false },
    });
    assert.equal(bare.status, 409, 'not taken up without a reason tells nobody anything');

    const ntu = await api('POST', `/api/cedant-sends/${send.body.id}/outcome`, {
      token: broker.token, body: { taken_up: false, not_taken_up_reason: 'Cedant retained the layer.' },
    });
    assert.equal(ntu.status, 200);
    assert.equal(ntu.body.status, 'NOT_TAKEN_UP');
  });
});

test('one approval authorises one send, not a standing permission', async () => {
  await withServer(async (api) => {
    const { yearId, versionId } = await setup(api);
    const mk = async () => (await api('POST', `/api/contract-years/${yearId}/cedant-sends`, {
      token: broker.token, body: { structure_version_ids: [versionId] },
    })).body.id;

    const first = await mk();
    await withTransaction((client) => createApproval(client, {
      actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: first,
      proposedBy: broker.user.id,
    }));
    await withTransaction((client) => approve(client, {
      actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: first,
      approver: uw.user,
    }));
    assert.equal((await api('POST', `/api/cedant-sends/${first}/send`, { token: broker.token })).status, 200);

    const second = await mk();
    const unapproved = await api('POST', `/api/cedant-sends/${second}/send`, { token: broker.token });
    assert.equal(unapproved.status, 403, 'the second send needs its own approval');
  });
});
