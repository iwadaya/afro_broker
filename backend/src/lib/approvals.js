import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors.js';
import { audit } from './audit.js';

/**
 * Four-eyes helpers. A sensitive action is proposed by one user and approved by
 * a different, suitably-authorised user. Proposal and approval rows live in the
 * `approval` table; these helpers operate inside a transaction client.
 */

export async function createApproval(client, { actionType, entityType, entityId, proposedBy, detail = {} }) {
  const { rows } = await client.query(
    `INSERT INTO approval (action_type, entity_type, entity_id, proposed_by, detail)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [actionType, entityType, String(entityId), proposedBy, detail],
  );
  return rows[0];
}

/**
 * Approve a pending request. Enforces that the approver differs from the
 * proposer and holds one of `allowedRoles`.
 */
export async function approve(client, { actionType, entityType, entityId, approver, allowedRoles }) {
  const { rows } = await client.query(
    `SELECT * FROM approval
     WHERE action_type = $1 AND entity_type = $2 AND entity_id = $3 AND status = 'pending'
     FOR UPDATE`,
    [actionType, entityType, String(entityId)],
  );
  const request = rows[0];
  if (!request) throw new NotFoundError('Pending approval');
  if (request.proposed_by === approver.id) {
    throw new ConflictError('Four-eyes: the proposer cannot authorise their own action');
  }
  if (allowedRoles && !allowedRoles.includes(approver.role)) {
    throw new ForbiddenError(`Four-eyes: authorisation requires role ${allowedRoles.join(' or ')}`);
  }
  await client.query(
    `UPDATE approval SET status = 'approved', approved_by = $1, resolved_at = now() WHERE id = $2`,
    [approver.id, request.id],
  );
  return request;
}

/**
 * D7 — break-glass single-user override.
 *
 * "Not because it should be used, but because a control with no legitimate
 * escape hatch at 11pm on 31 December gets bypassed with a shared login — and
 * then you have neither the control nor the audit trail."
 *
 * Admin-authorised, reason mandatory, loudly audited, and reportable via
 * GET /api/admin/break-glass. Works with or without a pending request, because
 * the 11pm case is often "there is nobody to raise it with either".
 */
export async function breakGlass(
  client,
  { actionType, entityType, entityId, admin, reason, detail = {} },
) {
  if (admin.role !== 'admin') {
    throw new ForbiddenError('Break-glass override is admin-authorised');
  }
  const stated = String(reason || '').trim();
  if (stated.length < 10) {
    throw new ValidationError('Break-glass requires a stated reason of at least 10 characters');
  }

  const { rows: pending } = await client.query(
    `SELECT * FROM approval
     WHERE action_type = $1 AND entity_type = $2 AND entity_id = $3 AND status = 'pending'
     FOR UPDATE`,
    [actionType, entityType, String(entityId)],
  );

  let row;
  if (pending[0]) {
    const { rows } = await client.query(
      `UPDATE approval SET status = 'overridden', overridden_by = $1, overridden_at = now(),
              override_reason = $2, resolved_at = now()
       WHERE id = $3 RETURNING *`,
      [admin.id, stated, pending[0].id],
    );
    row = rows[0];
  } else {
    const { rows } = await client.query(
      `INSERT INTO approval (action_type, entity_type, entity_id, status, proposed_by,
                             overridden_by, overridden_at, override_reason, resolved_at, detail)
       VALUES ($1,$2,$3,'overridden',$4,$4,now(),$5,now(),$6) RETURNING *`,
      [actionType, entityType, String(entityId), admin.id, stated, detail],
    );
    row = rows[0];
  }

  await audit(
    {
      entityType: 'approval',
      entityId: row.id,
      action: 'BREAK_GLASS_OVERRIDE',
      userId: admin.id,
      before: pending[0] || null,
      after: row,
      detail: { action_type: actionType, entity_type: entityType, entity_id: String(entityId), reason: stated },
    },
    client,
  );
  return row;
}

/**
 * The D7 gate: an outbound action calls this inside its own transaction before
 * doing anything the outside world can see.
 *
 * Consumes the authorisation, so one approval cannot cover two sends. Returns
 * the approval that permitted the action, for the caller to record against
 * whatever it sent.
 */
export async function assertApproved(client, { actionType, entityType, entityId }) {
  const { rows } = await client.query(
    `SELECT * FROM approval
     WHERE action_type = $1 AND entity_type = $2 AND entity_id = $3
       AND status IN ('approved', 'overridden')
       AND NOT (detail ? 'consumed_at')
     ORDER BY resolved_at DESC
     LIMIT 1
     FOR UPDATE`,
    [actionType, entityType, String(entityId)],
  );
  const approval = rows[0];
  if (!approval) {
    throw new ForbiddenError(
      `Four-eyes: "${actionType}" requires approval by a second user before it can proceed (D7)`,
    );
  }
  await client.query(
    `UPDATE approval SET detail = detail || jsonb_build_object('consumed_at', now()::text)
     WHERE id = $1`,
    [approval.id],
  );
  return approval;
}
