import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUser, withServer, pool } from '../helpers.js';
import { withTransaction } from '../../src/db/pool.js';
import { createApproval, approve, breakGlass, assertApproved } from '../../src/lib/approvals.js';

/**
 * D7 — four-eyes with a mandatory break-glass override, and §2.2's before/after.
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

const target = { actionType: 'submission_send', entityType: 'placement', entityId: 'p-1' };

test('an outbound action is blocked until a second user approves it', async () => {
  await withTransaction(async (client) => {
    await assert.rejects(
      assertApproved(client, target),
      /requires approval by a second user/i,
    );
  });

  await withTransaction((client) => createApproval(client, { ...target, proposedBy: broker.user.id }));

  await withTransaction(async (client) => {
    await assert.rejects(assertApproved(client, target), /requires approval/i,
      'a pending request is not an approval');
  });

  await withTransaction((client) => approve(client, { ...target, approver: uw.user }));

  const granted = await withTransaction((client) => assertApproved(client, target));
  assert.equal(granted.status, 'approved');

  // The approval is spent: it authorises one action, not a standing permission.
  await withTransaction(async (client) => {
    await assert.rejects(assertApproved(client, target), /requires approval/i);
  });
});

test('the preparer cannot approve their own action', async () => {
  await withTransaction((client) => createApproval(client, { ...target, proposedBy: broker.user.id }));
  await assert.rejects(
    withTransaction((client) => approve(client, { ...target, approver: broker.user })),
    /cannot authorise their own/i,
  );
  // And the table refuses a self-approved row even if the service is bypassed.
  await assert.rejects(
    pool.query("UPDATE approval SET status = 'approved', approved_by = proposed_by"),
    /approval_check/,
  );
});

test('break-glass is admin-only and demands a stated reason', async () => {
  await assert.rejects(
    withTransaction((client) => breakGlass(client, { ...target, admin: broker.user, reason: 'Deadline tonight, no cover' })),
    /admin-authorised/i,
  );
  await assert.rejects(
    withTransaction((client) => breakGlass(client, { ...target, admin: admin.user, reason: 'urgent' })),
    /at least 10 characters/i,
  );
});

test('break-glass overrides the gate, works with no pending request, and is loudly audited', async () => {
  const row = await withTransaction((client) => breakGlass(client, {
    ...target,
    admin: admin.user,
    reason: 'Inception at midnight; second approver unreachable. Ref INC-4821.',
  }));
  assert.equal(row.status, 'overridden');
  assert.equal(row.overridden_by, admin.user.id);

  // It satisfies the gate, exactly once.
  const granted = await withTransaction((client) => assertApproved(client, target));
  assert.equal(granted.status, 'overridden');
  await withTransaction(async (client) => {
    await assert.rejects(assertApproved(client, target), /requires approval/i);
  });

  const { rows } = await pool.query("SELECT * FROM audit_event WHERE action = 'BREAK_GLASS_OVERRIDE'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, admin.user.id);
  assert.match(rows[0].detail.reason, /INC-4821/);
});

test('an override missing its reason cannot be written directly either', async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO approval (action_type, entity_type, entity_id, status, proposed_by, overridden_by, overridden_at)
       SELECT 'submission_send','placement','x','overridden', id, id, now() FROM users LIMIT 1`,
    ),
    /approval_override_complete/,
  );
});

test('the break-glass report surfaces every override with who and why', async () => {
  await withServer(async (api) => {
    await withTransaction((client) => breakGlass(client, {
      ...target, admin: admin.user, reason: 'No second user on shift; cedant deadline. Ref INC-9002.',
    }));

    const report = await api('GET', '/api/admin/break-glass', { token: uw.token });
    assert.equal(report.status, 200);
    assert.equal(report.body.count, 1);
    assert.match(report.body.overrides[0].override_reason, /INC-9002/);
    assert.equal(report.body.overrides[0].overridden_by_email, admin.user.email);

    const asBroker = await api('GET', '/api/admin/break-glass', { token: broker.token });
    assert.equal(asBroker.status, 403, 'the report is an oversight view');
  });
});

test('the audit log records before and after, and is append-only in the schema', async () => {
  await withServer(async (api) => {
    const cedant = await api('POST', '/api/cedants', { token: broker.token, body: { name: 'Audited Mutual' } });
    const contract = await api('POST', '/api/contracts', {
      token: broker.token,
      body: { cedant_id: cedant.body.id, name: 'Property Surplus', cob: 'Property' },
    });
    await api('PATCH', `/api/contracts/${contract.body.id}`, {
      token: broker.token, body: { territory: 'MENA' },
    });

    const history = await api('GET', `/api/admin/audit/contract/${contract.body.id}/history`, { token: admin.token });
    assert.equal(history.status, 200);
    assert.equal(history.body.events.length, 2);

    const [created, updated] = history.body.events;
    assert.equal(created.before_state, null, 'a create has no before');
    assert.equal(created.after_state.name, 'Property Surplus');
    assert.equal(updated.before_state.territory, null);
    assert.equal(updated.after_state.territory, 'MENA');
    assert.deepEqual(
      updated.changed_fields.filter((c) => c.field === 'territory'),
      [{ field: 'territory', from: null, to: 'MENA' }],
    );

    await assert.rejects(pool.query("UPDATE audit_event SET action = 'rewritten'"), /append-only/);
    await assert.rejects(pool.query('DELETE FROM audit_event'), /append-only/);
  });
});
