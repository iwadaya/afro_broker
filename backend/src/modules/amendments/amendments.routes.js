import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

const router = Router();
router.use(authenticate);

const createSchema = z.object({
  type: z.enum(['special_acceptance', 'endorsement']),
  title: z.string().min(1),
  detail: z.string().optional(),
  effective_date: z.string().optional(),
});

const resolveSchema = z.object({
  status: z.enum(['agreed', 'declined', 'withdrawn']),
});

router.get(
  '/placements/:placementId/amendments',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM amendment WHERE placement_id = $1 ORDER BY created_at DESC',
      [req.params.placementId],
    );
    res.json(rows);
  }),
);

router.post(
  '/placements/:placementId/amendments',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(createSchema, req.body);
    const placement = await query('SELECT 1 FROM placement WHERE id = $1', [req.params.placementId]);
    if (!placement.rowCount) throw new NotFoundError('Placement');
    const { rows } = await query(
      `INSERT INTO amendment (placement_id, type, title, detail, effective_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.params.placementId, body.type, body.title, body.detail || null,
        body.effective_date || null, req.user.id],
    );
    await audit({ entityType: 'amendment', entityId: rows[0].id, action: 'create', userId: req.user.id, detail: { type: body.type } });
    res.status(201).json(rows[0]);
  }),
);

// Resolve an outstanding special acceptance / endorsement.
router.post(
  '/amendments/:id/resolve',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(resolveSchema, req.body);
    const { rows: existing } = await query('SELECT * FROM amendment WHERE id = $1', [req.params.id]);
    if (!existing[0]) throw new NotFoundError('Amendment');
    if (existing[0].status !== 'outstanding') throw new ConflictError('Amendment already resolved');
    const { rows } = await query(
      `UPDATE amendment SET status = $1, resolved_by = $2, resolved_at = now()
       WHERE id = $3 RETURNING *`,
      [body.status, req.user.id, req.params.id],
    );
    await audit({ entityType: 'amendment', entityId: req.params.id, action: body.status, userId: req.user.id });
    res.json(rows[0]);
  }),
);

export default router;
