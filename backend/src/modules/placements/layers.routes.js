import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './placements.service.js';

const router = Router();
router.use(authenticate);

const REINSTATEMENTS = z.enum([...Array.from({ length: 10 }, (_, i) => String(i + 1)), 'UNLIMITED']);

const layerPatchSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(['QS', 'Surplus', 'XoL', 'Fac']).optional(),
  attachment: z.number().nonnegative().optional(),
  limit_amt: z.number().nonnegative().nullable().optional(),
  section_pct: z.number().min(0).max(100).optional(),
  order_pct: z.number().min(0).max(100).optional(),
  premium100: z.number().nonnegative().optional(),
  brokerage_pct: z.number().min(0).max(100).optional(),
  currency: z.string().min(1).optional(),
  technical_ref: z.string().nullable().optional(),
  position: z.number().int().optional(),
  risk_cover: z.boolean().optional(),
  cat_cover: z.boolean().optional(),
  reinstatements: REINSTATEMENTS.nullable().optional(),
  reinstatement_pct: z.number().min(0).nullable().optional(),
  egnpi: z.number().nonnegative().nullable().optional(),
  rate_pct: z.number().min(0).nullable().optional(),
  aad: z.number().nonnegative().nullable().optional(),
});

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json(await svc.getLayer(req.params.id));
  }),
);

// Recent audit trail scoped to one layer (and its lines/FOT/documents) — the
// signing worksheet's audit panel. Available to every authenticated role; the
// full cross-entity trail stays admin-gated under /api/admin/audit.
router.get(
  '/:id/audit',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.id, a.entity_type, a.entity_id, a.action, a.detail, a.created_at,
              u.name AS user_name, u.role AS user_role
       FROM audit_event a LEFT JOIN users u ON u.id = a.user_id
       WHERE (a.entity_type = 'layer' AND a.entity_id = $1)
          OR (a.entity_type = 'line' AND a.entity_id IN (SELECT id::text FROM line WHERE layer_id = $1::uuid))
          OR (a.entity_type = 'fot' AND a.entity_id IN (SELECT id::text FROM fot WHERE layer_id = $1::uuid))
          OR (a.entity_type = 'document' AND a.entity_id IN (SELECT id::text FROM document WHERE layer_id = $1::uuid))
       ORDER BY a.created_at DESC LIMIT 30`,
      [req.params.id],
    );
    res.json(rows);
  }),
);

router.patch(
  '/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(layerPatchSchema, req.body);
    res.json(await svc.updateLayer(req.params.id, body, req.user.id));
  }),
);

router.delete(
  '/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await svc.deleteLayer(req.params.id, req.user.id);
    res.status(204).end();
  }),
);

export default router;
