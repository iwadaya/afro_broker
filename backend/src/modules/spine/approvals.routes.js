import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { createApproval, approve, breakGlass } from '../../lib/approvals.js';

/**
 * D7 over HTTP — the four-eyes cycle for the spine's outbound actions.
 *
 * The gates already exist: every send calls assertApproved inside its own
 * transaction. What was missing was a way for two people to work the cycle
 * from the UI — propose, authorise, and (when there is nobody to ask at 11pm
 * on 31 December) break the glass. The rules all live in lib/approvals.js;
 * these routes only put HTTP in front of them.
 */
const router = Router();
router.use(authenticate);

/**
 * Only the spine's outbound sends are proposable here. The pre-spine flows
 * (fot_authorise, bind) have endpoints of their own, and the rest of the D7
 * vocabulary (claim_calculation, clause_promotion, kyc_hard_delete) belongs to
 * modules that do not exist yet — widening this list is how those arrive.
 */
const PROPOSABLE = ['submission_send', 'quote_to_cedant', 'fot_send', 'written_line_advice'];

const proposeSchema = z.object({
  action_type: z.enum(PROPOSABLE),
  entity_type: z.string().min(1),
  entity_id: z.string().min(1),
  detail: z.record(z.any()).optional(),
});

/**
 * The approvals held against one entity, newest first, so the UI can show
 * where an action stands. `consumed_at` is surfaced from detail because an
 * approval spends itself on the send it authorised (one approval, one send).
 */
router.get(
  '/approvals',
  asyncHandler(async (req, res) => {
    const { entity_type: entityType, entity_id: entityId } = req.query;
    if (!entityType || !entityId) {
      throw new NotFoundError('Approvals are listed per entity — pass entity_type and entity_id');
    }
    const { rows } = await query(
      `SELECT a.id, a.action_type, a.entity_type, a.entity_id, a.status,
              a.override_reason, a.created_at, a.resolved_at, a.overridden_at,
              a.detail->>'consumed_at' AS consumed_at,
              p.name AS proposed_by_name, ap.name AS approved_by_name,
              ov.name AS overridden_by_name
       FROM approval a
       LEFT JOIN users p ON p.id = a.proposed_by
       LEFT JOIN users ap ON ap.id = a.approved_by
       LEFT JOIN users ov ON ov.id = a.overridden_by
       WHERE a.entity_type = $1 AND a.entity_id = $2
       ORDER BY a.created_at DESC`,
      [entityType, String(entityId)],
    );
    res.json(rows);
  }),
);

/**
 * Propose. Idempotent on a still-pending request: asking twice is one ask,
 * not a queue of them.
 */
router.post(
  '/approvals',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(proposeSchema, req.body);
    const { row, created } = await withTransaction(async (client) => {
      const { rows: pending } = await client.query(
        `SELECT * FROM approval
         WHERE action_type = $1 AND entity_type = $2 AND entity_id = $3 AND status = 'pending'
         FOR UPDATE`,
        [body.action_type, body.entity_type, String(body.entity_id)],
      );
      if (pending[0]) return { row: pending[0], created: false };
      const approval = await createApproval(client, {
        actionType: body.action_type,
        entityType: body.entity_type,
        entityId: body.entity_id,
        proposedBy: req.user.id,
        detail: body.detail ?? {},
      });
      return { row: approval, created: true };
    });
    res.status(created ? 201 : 200).json(row);
  }),
);

/**
 * Authorise a pending request. The library enforces the two rules that
 * matter: the approver is a different user from the proposer, and holds a
 * role that can authorise.
 */
router.post(
  '/approvals/:id/approve',
  requireRole('underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM approval WHERE id = $1', [req.params.id]);
      if (!rows[0]) throw new NotFoundError('Approval');
      await approve(client, {
        actionType: rows[0].action_type,
        entityType: rows[0].entity_type,
        entityId: rows[0].entity_id,
        approver: req.user,
        allowedRoles: ['underwriter', 'admin'],
      });
      const { rows: updated } = await client.query('SELECT * FROM approval WHERE id = $1', [req.params.id]);
      return updated[0];
    });
    res.json(row);
  }),
);

/**
 * D7's mandatory escape hatch. Admin-only, reason mandatory, loudly audited
 * and reported at GET /api/admin/break-glass — all enforced by the library.
 */
router.post(
  '/approvals/break-glass',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      proposeSchema.extend({ reason: z.string().min(1) }),
      req.body,
    );
    const row = await withTransaction((client) => breakGlass(client, {
      actionType: body.action_type,
      entityType: body.entity_type,
      entityId: body.entity_id,
      admin: req.user,
      reason: body.reason,
      detail: body.detail ?? {},
    }));
    res.json(row);
  }),
);

export default router;
