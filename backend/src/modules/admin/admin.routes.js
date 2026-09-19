import { Router } from 'express';
import { query } from '../../db/pool.js';
import { asyncHandler, pageParams } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { changedFields } from '../../lib/audit.js';

const router = Router();
router.use(authenticate);

// Audit trail, filterable by entity. Admin/underwriter (oversight) only.
router.get(
  '/audit',
  requireRole('admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const params = [];
    const filters = [];
    if (req.query.entity_type) {
      params.push(req.query.entity_type);
      filters.push(`entity_type = $${params.length}`);
    }
    if (req.query.entity_id) {
      params.push(req.query.entity_id);
      filters.push(`entity_id = $${params.length}`);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT a.*, u.name AS user_name, u.role AS user_role
       FROM audit_event a LEFT JOIN users u ON u.id = a.user_id
       ${where} ORDER BY a.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  }),
);

// Pending four-eyes approvals (proposed but not yet authorised).
router.get(
  '/approvals',
  requireRole('admin', 'underwriter', 'broker'),
  asyncHandler(async (req, res) => {
    const params = [];
    let where = "WHERE status = 'pending'";
    if (req.query.action_type) {
      params.push(req.query.action_type);
      where += ` AND action_type = $${params.length}`;
    }
    const { rows } = await query(
      `SELECT a.*, u.name AS proposed_by_name
       FROM approval a LEFT JOIN users u ON u.id = a.proposed_by
       ${where} ORDER BY a.created_at`,
      params,
    );
    res.json(rows);
  }),
);

/**
 * D7 — the break-glass report. An override nobody reads is not a control, so
 * this is a view of its own rather than a filter people have to know to apply.
 */
router.get(
  '/break-glass',
  requireRole('admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 1), 3650);
    const { rows } = await query(
      `SELECT a.id, a.action_type, a.entity_type, a.entity_id, a.override_reason,
              a.overridden_at, a.detail,
              ov.name AS overridden_by_name, ov.email AS overridden_by_email
       FROM approval a
       LEFT JOIN users ov ON ov.id = a.overridden_by
       WHERE a.status = 'overridden'
         AND a.overridden_at >= now() - ($1 || ' days')::interval
       ORDER BY a.overridden_at DESC`,
      [days],
    );
    res.json({ window_days: days, count: rows.length, overrides: rows });
  }),
);

/**
 * §2.2 — the change history of one entity, oldest first. The "prove what it was
 * on the day" view that the before/after pair exists for.
 */
router.get(
  '/audit/:entityType/:entityId/history',
  requireRole('admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.action, a.created_at, a.before_state, a.after_state, a.detail,
              u.name AS user_name, u.email AS user_email
       FROM audit_event a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.entity_type = $1 AND a.entity_id = $2
       ORDER BY a.created_at, a.id`,
      [req.params.entityType, req.params.entityId],
    );
    res.json({
      entity_type: req.params.entityType,
      entity_id: req.params.entityId,
      events: rows.map((r) => ({ ...r, changed_fields: changedFields(r.before_state, r.after_state) })),
    });
  }),
);

export default router;
