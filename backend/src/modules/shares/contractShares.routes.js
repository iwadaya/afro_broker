import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

/**
 * The shares of the programme — the Shares step under Contracts, after
 * Documents on both workflows: the broker share (this desk, and a co-broker
 * where the order is split) and the reinsurer shares, each with a written
 * share (the line put down) and a signed share (what it was signed down
 * to), in percent of the programme. On a broker row the written share is
 * its order (100% unless split) and the signed share goes unused: the
 * placed order is the reinsurers' signed total, which the page derives.
 * The page saves the whole table at once, so a PUT replaces it. Everyone
 * signed in reads; a broker or admin writes.
 */
const router = Router();
router.use(authenticate);

export const SHARE_PARTIES = ['broker', 'reinsurer'];
export const SHARE_ROLES = ['lead', 'follow'];

const COLUMNS = `s.id, s.placement_id, s.party, s.market_id, s.name, s.role, s.written_pct, s.signed_pct, s.reference, s.note, s.position,
                 m.domicile AS market_domicile, m.rating AS market_rating, m.security_status AS market_security_status`;

async function placementExists(id) {
  const { rows } = await query('SELECT id FROM placement WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Placement');
}

const round4 = (n) => Math.round(n * 10000) / 10000;
const num = (v) => (v == null ? null : Number(v));
const shapeRow = (r) => ({ ...r, written_pct: num(r.written_pct), signed_pct: num(r.signed_pct) });
const sum = (list, key) => round4(list.reduce((t, r) => t + (r[key] || 0), 0));

/** The table as the page reads it: the broker rows, the reinsurer rows, and each side's totals. */
export async function sharesOf(placementId, runner = { query }) {
  const { rows } = await runner.query(
    `SELECT ${COLUMNS} FROM contract_share s LEFT JOIN market m ON m.id = s.market_id
      WHERE s.placement_id = $1 ORDER BY s.party, s.position, s.created_at`,
    [placementId],
  );
  const all = rows.map(shapeRow);
  const broker = all.filter((r) => r.party === 'broker');
  const reinsurers = all.filter((r) => r.party === 'reinsurer');
  return {
    broker,
    reinsurers,
    totals: {
      broker: { written_pct: sum(broker, 'written_pct'), signed_pct: sum(broker, 'signed_pct') },
      reinsurers: { written_pct: sum(reinsurers, 'written_pct'), signed_pct: sum(reinsurers, 'signed_pct') },
    },
  };
}

router.get(
  '/placements/:id/shares',
  asyncHandler(async (req, res) => {
    await placementExists(req.params.id);
    res.json(await sharesOf(req.params.id));
  }),
);

const pct = z.number().min(0).max(100).nullable().optional();
const shareSchema = z.object({
  market_id: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
  role: z.enum(SHARE_ROLES).default('follow'),
  written_pct: pct,
  signed_pct: pct,
  reference: z.string().trim().max(200).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
});
const putSchema = z.object({
  broker: z.array(shareSchema).max(50).default([]),
  reinsurers: z.array(shareSchema).max(200).default([]),
});

router.put(
  '/placements/:id/shares',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await placementExists(req.params.id);
    const body = validate(putSchema, req.body);
    const rows = [
      ...body.broker.map((s, i) => ({ ...s, party: 'broker', position: i })),
      ...body.reinsurers.map((s, i) => ({ ...s, party: 'reinsurer', position: i })),
    ];
    // A share bound to a market must be bound to one on the register.
    const marketIds = [...new Set(rows.map((s) => s.market_id).filter(Boolean))];
    if (marketIds.length) {
      const known = await query('SELECT id FROM market WHERE id = ANY($1)', [marketIds]);
      const missing = marketIds.filter((id) => !known.rows.some((m) => m.id === id));
      if (missing.length) throw new ValidationError(`Unknown market: ${missing.join(', ')}`);
    }
    const summary = (t) => ({
      broker: t.broker.map((s) => [s.name, s.written_pct, s.signed_pct]),
      reinsurers: t.reinsurers.map((s) => [s.name, s.written_pct, s.signed_pct]),
    });
    const result = await withTransaction(async (client) => {
      const before = await sharesOf(req.params.id, client);
      await client.query('DELETE FROM contract_share WHERE placement_id = $1', [req.params.id]);
      for (const s of rows) {
        await client.query(
          `INSERT INTO contract_share (placement_id, party, market_id, name, role, written_pct, signed_pct, reference, note, position)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [req.params.id, s.party, s.market_id || null, s.name, s.role, s.written_pct ?? null, s.signed_pct ?? null,
            s.reference || null, s.note || null, s.position],
        );
      }
      const after = await sharesOf(req.params.id, client);
      await audit(
        { entityType: 'placement', entityId: req.params.id, action: 'shares', userId: req.user.id, before: summary(before), after: summary(after) },
        client,
      );
      return after;
    });
    res.json(result);
  }),
);

export default router;
