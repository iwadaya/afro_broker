import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

const router = Router();
router.use(authenticate);

/** Build the per-market premium allocation for a layer from its signed lines. */
async function premiumAllocation(runner, layerId) {
  const { rows: layerRows } = await runner.query('SELECT * FROM layer WHERE id = $1', [layerId]);
  if (!layerRows[0]) throw new NotFoundError('Layer');
  const layer = layerRows[0];
  const { rows } = await runner.query(
    `SELECT l.market_id, m.name AS market_name, l.written_pct, l.signed_pct, l.signing_factor,
            l.premium_signed, l.brokerage_amount, l.to_stand
     FROM line l JOIN market m ON m.id = l.market_id
     WHERE l.layer_id = $1 AND l.status = 'SIGNED' ORDER BY m.name`,
    [layerId],
  );
  const signedTotal = rows.reduce((a, r) => a + Number(r.signed_pct || 0), 0);
  const premiumTotal = rows.reduce((a, r) => a + Number(r.premium_signed || 0), 0);
  const brokerageTotal = rows.reduce((a, r) => a + Number(r.brokerage_amount || 0), 0);
  return {
    layer: {
      id: layer.id, name: layer.name, order_pct: Number(layer.order_pct),
      premium100: Number(layer.premium100), brokerage_pct: Number(layer.brokerage_pct || 0),
      signing_method: layer.signing_method, currency: layer.currency,
    },
    signed_total_pct: Math.round(signedTotal * 1e4) / 1e4,
    premium_allocated: Math.round(premiumTotal * 100) / 100,
    brokerage_total: Math.round(brokerageTotal * 100) / 100,
    lines: rows.map((r) => ({
      market_id: r.market_id,
      market_name: r.market_name,
      written_pct: Number(r.written_pct),
      signed_pct: Number(r.signed_pct),
      signing_factor: r.signing_factor != null ? Number(r.signing_factor) : null,
      to_stand: r.to_stand,
      premium_signed: Number(r.premium_signed || 0),
      brokerage_amount: Number(r.brokerage_amount || 0),
    })),
  };
}

router.get(
  '/layers/:layerId/premium-allocation',
  asyncHandler(async (req, res) => {
    res.json(await premiumAllocation({ query }, req.params.layerId));
  }),
);

router.get(
  '/placements/:placementId/documents',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM document WHERE placement_id = $1 ORDER BY created_at',
      [req.params.placementId],
    );
    res.json(rows);
  }),
);

router.get(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM document WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Document');
    res.json(rows[0]);
  }),
);

const docTypes = ['mrc_slip', 'cover_note', 'signing_slip', 'closing'];

// Generate a document. Signing-slip / closing snapshot the premium allocation.
router.post(
  '/layers/:layerId/documents',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ type: z.enum(docTypes) }), req.body);
    const doc = await withTransaction(async (client) => {
      const { rows: layerRows } = await client.query('SELECT * FROM layer WHERE id = $1', [req.params.layerId]);
      if (!layerRows[0]) throw new NotFoundError('Layer');
      const layer = layerRows[0];

      let content = {};
      if (body.type === 'signing_slip' || body.type === 'closing') {
        if (!['SIGNED', 'BOUND'].includes(layer.status)) {
          throw new ConflictError(`Layer must be SIGNED/BOUND to issue a ${body.type}`);
        }
        content = await premiumAllocation(client, req.params.layerId);
      } else {
        content = { layer: { id: layer.id, name: layer.name, type: layer.type, order_pct: Number(layer.order_pct) } };
      }

      const { rows: verRows } = await client.query(
        'SELECT COALESCE(MAX(version),0)+1 AS next FROM document WHERE layer_id = $1 AND type = $2',
        [req.params.layerId, body.type],
      );
      const { rows } = await client.query(
        `INSERT INTO document (placement_id, layer_id, type, version, content, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [layer.placement_id, layer.id, body.type, verRows[0].next, JSON.stringify(content), req.user.id],
      );
      await audit({ entityType: 'document', entityId: rows[0].id, action: 'generate', userId: req.user.id, detail: { type: body.type } }, client);
      return rows[0];
    });
    res.status(201).json(doc);
  }),
);

export default router;
