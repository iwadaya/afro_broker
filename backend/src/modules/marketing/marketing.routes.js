import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { assertLineTransition } from '../../domain/statusMachine.js';
import { pullTechnical } from '../../integrations/universe.js';

const router = Router();
router.use(authenticate);

// ---- Approaches ----
const approachSchema = z.object({
  market_id: z.string().uuid(),
  role: z.enum(['lead', 'follow']),
  sent_date: z.string().optional(),
  notes: z.string().optional(),
});

router.get(
  '/layers/:layerId/approaches',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT a.*, m.name AS market_name, m.rating AS market_rating, m.security_status
       FROM approach a JOIN market m ON m.id = a.market_id
       WHERE a.layer_id = $1 ORDER BY a.created_at`,
      [req.params.layerId],
    );
    res.json(rows);
  }),
);

router.post(
  '/layers/:layerId/approaches',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(approachSchema, req.body);
    const layer = await query('SELECT 1 FROM layer WHERE id = $1', [req.params.layerId]);
    if (!layer.rowCount) throw new NotFoundError('Layer');
    const market = await query('SELECT security_status, type FROM market WHERE id = $1', [body.market_id]);
    if (!market.rowCount) throw new NotFoundError('Market');
    // Only reinsurers write lines; insurers and brokers are register entries.
    if (market.rows[0].type !== 'reinsurer') {
      throw new ConflictError('Only reinsurers can be approached for capacity');
    }
    if (market.rows[0].security_status === 'declined') {
      throw new ConflictError('Market is on the declined-security list');
    }
    const { rows } = await query(
      `INSERT INTO approach (layer_id, market_id, role, sent_date, notes)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.params.layerId, body.market_id, body.role, body.sent_date || null, body.notes || null],
    );
    await audit({ entityType: 'approach', entityId: rows[0].id, action: 'create', userId: req.user.id, detail: { role: body.role } });
    res.status(201).json(rows[0]);
  }),
);

// Decline an approach (market passes).
router.post(
  '/approaches/:id/decline',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const { rows: cur } = await query('SELECT * FROM approach WHERE id = $1', [req.params.id]);
    if (!cur[0]) throw new NotFoundError('Approach');
    assertLineTransition(cur[0].status, 'DECLINED');
    const { rows } = await query(
      "UPDATE approach SET status = 'DECLINED', updated_at = now() WHERE id = $1 RETURNING *",
      [req.params.id],
    );
    await audit({ entityType: 'approach', entityId: req.params.id, action: 'decline', userId: req.user.id });
    res.json(rows[0]);
  }),
);

// ---- Quotes ----
const quoteSchema = z.object({
  type: z.enum(['indicative', 'firm']),
  rate: z.number().optional(),
  rol: z.number().optional(),
  premium: z.number().nonnegative().optional(),
  line_offered: z.number().min(0).max(100).optional(),
  terms: z.record(z.any()).optional(),
  validity: z.string().optional(),
  subjectivities: z.array(z.string()).optional(),
});

router.get(
  '/approaches/:approachId/quotes',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM quote WHERE approach_id = $1 ORDER BY created_at',
      [req.params.approachId],
    );
    res.json(rows);
  }),
);

// Capture a quote. A new quote supersedes the prior active quote on the same
// approach and advances the approach to QUOTED.
router.post(
  '/approaches/:approachId/quotes',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(quoteSchema, req.body);
    const quote = await withTransaction(async (client) => {
      const { rows: aRows } = await client.query('SELECT * FROM approach WHERE id = $1 FOR UPDATE', [req.params.approachId]);
      if (!aRows[0]) throw new NotFoundError('Approach');
      const approach = aRows[0];

      await client.query(
        "UPDATE quote SET status = 'superseded' WHERE approach_id = $1 AND status = 'active'",
        [req.params.approachId],
      );
      const { rows } = await client.query(
        `INSERT INTO quote (approach_id, type, rate, rol, premium, line_offered, terms, validity, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [req.params.approachId, body.type, body.rate ?? null, body.rol ?? null,
          body.premium ?? null, body.line_offered ?? null,
          JSON.stringify(body.terms || {}), body.validity || null, req.user.id],
      );
      for (const text of body.subjectivities || []) {
        await client.query('INSERT INTO subjectivity (quote_id, text) VALUES ($1,$2)', [rows[0].id, text]);
      }
      if (approach.status === 'APPROACHED') {
        await client.query("UPDATE approach SET status = 'QUOTED', updated_at = now() WHERE id = $1", [approach.id]);
      }
      await audit({ entityType: 'quote', entityId: rows[0].id, action: 'capture', userId: req.user.id, detail: { type: body.type } }, client);
      return rows[0];
    });
    res.status(201).json(quote);
  }),
);

// Mark a quote's terms agreed (advances approach to AGREED). Lead agreement is
// the precursor to setting FOT.
router.post(
  '/quotes/:id/agree',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const agreed = await withTransaction(async (client) => {
      const { rows: qRows } = await client.query('SELECT * FROM quote WHERE id = $1', [req.params.id]);
      if (!qRows[0]) throw new NotFoundError('Quote');
      const quote = qRows[0];
      if (quote.status === 'superseded' || quote.status === 'withdrawn') {
        throw new ConflictError('Cannot agree a superseded/withdrawn quote');
      }
      const { rows: aRows } = await client.query('SELECT * FROM approach WHERE id = $1', [quote.approach_id]);
      assertLineTransition(aRows[0].status, 'AGREED');
      await client.query("UPDATE quote SET status = 'accepted' WHERE id = $1", [quote.id]);
      await client.query("UPDATE approach SET status = 'AGREED', updated_at = now() WHERE id = $1", [quote.approach_id]);
      await audit({ entityType: 'quote', entityId: quote.id, action: 'agree', userId: req.user.id }, client);
      return quote;
    });
    res.json(agreed);
  }),
);

// ---- Subjectivities ----
router.get(
  '/quotes/:quoteId/subjectivities',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM subjectivity WHERE quote_id = $1 ORDER BY created_at', [req.params.quoteId]);
    res.json(rows);
  }),
);

router.post(
  '/quotes/:quoteId/subjectivities',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ text: z.string().min(1) }), req.body);
    const { rows } = await query(
      'INSERT INTO subjectivity (quote_id, text) VALUES ($1,$2) RETURNING *',
      [req.params.quoteId, body.text],
    );
    res.status(201).json(rows[0]);
  }),
);

router.post(
  '/subjectivities/:id/resolve',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'UPDATE subjectivity SET resolved = TRUE, resolved_date = CURRENT_DATE WHERE id = $1 RETURNING *',
      [req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Subjectivity');
    await audit({ entityType: 'subjectivity', entityId: req.params.id, action: 'resolve', userId: req.user.id });
    res.json(rows[0]);
  }),
);

// ---- Quote board: technical-vs-market for a layer ----
router.get(
  '/layers/:layerId/quote-board',
  asyncHandler(async (req, res) => {
    const { rows: layerRows } = await query('SELECT * FROM layer WHERE id = $1', [req.params.layerId]);
    if (!layerRows[0]) throw new NotFoundError('Layer');
    const layer = layerRows[0];
    const technical = await pullTechnical(layer);

    const { rows } = await query(
      `SELECT a.id AS approach_id, a.role, a.status AS approach_status,
              m.id AS market_id, m.name AS market_name, m.rating, m.security_status,
              q.id AS quote_id, q.type AS quote_type, q.rate, q.rol, q.premium,
              q.line_offered, q.validity, q.status AS quote_status,
              (SELECT COUNT(*) FROM subjectivity s WHERE s.quote_id = q.id AND NOT s.resolved) AS open_subjectivities
       FROM approach a
       JOIN market m ON m.id = a.market_id
       LEFT JOIN LATERAL (
         SELECT * FROM quote q2 WHERE q2.approach_id = a.id
         ORDER BY (q2.status = 'accepted') DESC, (q2.status = 'active') DESC, q2.created_at DESC
         LIMIT 1
       ) q ON TRUE
       WHERE a.layer_id = $1
       ORDER BY a.role DESC, m.name`,
      [req.params.layerId],
    );

    const techRol = technical.technical_rate_on_line;
    const board = rows.map((r) => ({
      ...r,
      open_subjectivities: Number(r.open_subjectivities || 0),
      spread_vs_technical: (r.rol != null && techRol != null)
        ? Math.round((r.rol - techRol) * 1e6) / 1e6
        : null,
    }));

    res.json({ layer: { id: layer.id, name: layer.name, order_pct: layer.order_pct, premium100: layer.premium100 }, technical, markets: board });
  }),
);

export default router;
