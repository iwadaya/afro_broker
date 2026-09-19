import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';

/**
 * D7 over HTTP — the four-eyes cycle the UI works: propose, authorise,
 * break-glass, and the send that consumes what was granted.
 */

let broker;
let broker2;
let uw;
let admin;

before(async () => { await resetDb(); });
after(async () => { await pool.end(); });

beforeEach(async () => {
  await resetDb();
  broker = await makeUser('broker');
  broker2 = await makeUser('broker');
  uw = await makeUser('underwriter');
  admin = await makeUser('admin');
});

const fotTerms = () => ({
  currency: 'USD',
  deductible: '5000000',
  limit: '20000000',
  rate_pct: 3.75,
  rate_type: 'FLAT',
  brokerage_pct: 10,
  egnpi: '80000000',
  mdp: '1000000',
  reinstatements: [{ count: 1, rate_pct: 100 }],
  aggregate_limit: '40000000',
});

/** A contract year with a submitted structure and one reinsurer to send to. */
async function setup(api) {
  const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Gate Mutual' } });
  const contract = await api('POST', '/api/contracts', {
    token: broker.token,
    body: { cedant_id: cedant.body.id, name: 'Property Cat', cob: 'Property' },
  });
  const year = await api('POST', `/api/contracts/${contract.body.id}/years`, {
    token: broker.token,
    body: { year_label: '2026', inception: '2026-01-01', expiry: '2026-12-31', currency: 'USD' },
  });
  const structure = await api('POST', `/api/contract-years/${year.body.id}/structures`, {
    token: broker.token,
    body: { label: 'Cat XL Layer 1', treaty_type: 'PROPERTY_CAT_XL', cob: 'Property', terms: fotTerms() },
  });
  const submitted = (await api('GET', `/api/structures/${structure.body.id}`, { token: broker.token }))
    .body.versions[0];

  const market = await api('POST', '/api/markets', {
    token: broker.token, body: { name: 'Gate Re', type: 'reinsurer' },
  });

  const dist = await api('POST', `/api/contract-years/${year.body.id}/distributions`, {
    token: broker.token,
    body: {
      stage: 'QUOTING',
      subject: 'Gate Mutual 2026 — Cat XL',
      body: 'Terms attached.',
      structure_version_ids: [submitted.id],
      recipients: [{ reinsurer_id: market.body.id, email: 'uw@gatere.example' }],
    },
  });
  assert.equal(dist.status, 201, JSON.stringify(dist.body));
  return { distId: dist.body.id };
}

test('the cycle over HTTP: propose, authorise by a second user, send consumes it', async () => {
  await withServer(async (api) => {
    const { distId } = await setup(api);

    const proposed = await api('POST', '/api/approvals', {
      token: broker.token,
      body: { action_type: 'submission_send', entity_type: 'distribution', entity_id: distId },
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    assert.equal(proposed.body.status, 'pending');

    // Proposing again while pending is the same ask, not a second one.
    const again = await api('POST', '/api/approvals', {
      token: broker2.token,
      body: { action_type: 'submission_send', entity_type: 'distribution', entity_id: distId },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.id, proposed.body.id);

    const granted = await api('POST', `/api/approvals/${proposed.body.id}/approve`, { token: uw.token });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.status, 'approved');

    const sent = await api('POST', `/api/distributions/${distId}/send`, { token: broker.token });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.approval_id, proposed.body.id);

    // The listing shows the whole story, consumption included.
    const list = await api(
      'GET', `/api/approvals?entity_type=distribution&entity_id=${distId}`, { token: broker.token },
    );
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].status, 'approved');
    assert.ok(list.body[0].consumed_at, 'the send consumed the approval');
    assert.ok(list.body[0].proposed_by_name);
    assert.ok(list.body[0].approved_by_name);
  });
});

test('four-eyes holds over HTTP: no self-approval, and no broker authorisation', async () => {
  await withServer(async (api) => {
    const { distId } = await setup(api);
    const proposed = await api('POST', '/api/approvals', {
      token: admin.token,
      body: { action_type: 'submission_send', entity_type: 'distribution', entity_id: distId },
    });

    // The proposer cannot authorise their own action, whatever their role.
    const self = await api('POST', `/api/approvals/${proposed.body.id}/approve`, { token: admin.token });
    assert.equal(self.status, 409);
    assert.match(self.body.error, /proposer cannot authorise/i);

    // A broker cannot authorise at all — the route is not theirs.
    const asBroker = await api('POST', `/api/approvals/${proposed.body.id}/approve`, { token: broker.token });
    assert.equal(asBroker.status, 403);

    // Nothing granted, so the send stays gated.
    const sent = await api('POST', `/api/distributions/${distId}/send`, { token: broker.token });
    assert.equal(sent.status, 403);
    assert.match(sent.body.error, /requires approval by a second user/i);
  });
});

test('only the spine sends are proposable here', async () => {
  await withServer(async (api) => {
    const bad = await api('POST', '/api/approvals', {
      token: broker.token,
      body: { action_type: 'bind', entity_type: 'distribution', entity_id: 'x' },
    });
    assert.equal(bad.status, 422);
  });
});

test('break-glass over HTTP: admin-only, reason mandatory, unblocks the send', async () => {
  await withServer(async (api) => {
    const { distId } = await setup(api);
    const target = { action_type: 'submission_send', entity_type: 'distribution', entity_id: distId };

    const asBroker = await api('POST', '/api/approvals/break-glass', {
      token: broker.token, body: { ...target, reason: 'Deadline tonight, no cover' },
    });
    assert.equal(asBroker.status, 403);

    const curt = await api('POST', '/api/approvals/break-glass', {
      token: admin.token, body: { ...target, reason: 'urgent' },
    });
    assert.equal(curt.status, 422);
    assert.match(curt.body.error, /at least 10 characters/i);

    const broken = await api('POST', '/api/approvals/break-glass', {
      token: admin.token, body: { ...target, reason: 'Inception is tomorrow and the underwriter is unreachable' },
    });
    assert.equal(broken.status, 200, JSON.stringify(broken.body));
    assert.equal(broken.body.status, 'overridden');

    const sent = await api('POST', `/api/distributions/${distId}/send`, { token: broker.token });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    // And it lands on the report an oversight role reads.
    const report = await api('GET', '/api/admin/break-glass', { token: uw.token });
    assert.equal(report.status, 200);
    assert.ok(report.body.overrides.some((o) => o.entity_id === distId));
  });
});

test('the listing is per entity — asking without one is refused', async () => {
  await withServer(async (api) => {
    const bare = await api('GET', '/api/approvals', { token: broker.token });
    assert.equal(bare.status, 404);
  });
});
