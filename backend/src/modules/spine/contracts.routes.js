import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { buildUpdate, defined } from '../../lib/sql.js';

/**
 * §1.1 — Contract (the treaty programme) and ContractYear (its annual renewal).
 *
 * The system already links one year's placement to the last through
 * `placement.renewal_of`. This is the same idea given its own spine: the
 * programme is an entity in its own right, and the renewal chain hangs off the
 * years rather than off the placements. A placement attaches to the year it is
 * the placing of.
 *
 * Renewal is a linked chain, never a copied record — that link is what buys the
 * expiring/current slip diff (M1), the expiring-panel flag (M9), and expiring
 * structures shown alongside those being quoted (M5).
 */
const router = Router();
router.use(authenticate);

const contractSchema = z.object({
  cedant_id: z.string().uuid(),
  name: z.string().min(1),
  cob: z.string().min(1),
  territory: z.string().optional(),
  notes: z.string().optional(),
});

const yearSchema = z.object({
  year_label: z.string().min(1),
  inception: z.string().min(1),
  expiry: z.string().min(1),
  currency: z.string().min(1),
  prior_contract_year_id: z.string().uuid().nullish(),
  notes: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
router.get(
  '/contracts',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const params = [];
    const filters = ['TRUE'];
    if (req.query.cedant_id) {
      params.push(req.query.cedant_id);
      filters.push(`c.cedant_id = $${params.length}`);
    }
    if (req.query.cob) {
      params.push(req.query.cob);
      filters.push(`c.cob = $${params.length}`);
    }
    params.push(limit, offset);
    const { rows } = await query(
      `SELECT c.*, ced.name AS cedant_name,
              (SELECT COUNT(*)::int FROM contract_year cy WHERE cy.contract_id = c.id) AS year_count
       FROM contract c JOIN cedant ced ON ced.id = c.cedant_id
       WHERE ${filters.join(' AND ')}
       ORDER BY ced.name, c.name
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(rows);
  }),
);

router.post(
  '/contracts',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(contractSchema, req.body);
    const row = await withTransaction(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM cedant WHERE id = $1', [body.cedant_id]);
      if (!rowCount) throw new NotFoundError('Cedant');
      const { rows } = await client.query(
        `INSERT INTO contract (cedant_id, name, cob, territory, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [body.cedant_id, body.name, body.cob, body.territory || null, body.notes || null, req.user.id],
      );
      await audit(
        { entityType: 'contract', entityId: rows[0].id, action: 'create', userId: req.user.id, after: rows[0] },
        client,
      );
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

router.get(
  '/contracts/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.*, ced.name AS cedant_name FROM contract c
       JOIN cedant ced ON ced.id = c.cedant_id WHERE c.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Contract');
    const { rows: years } = await query(
      `SELECT cy.*, p.id AS placement_id, p.reference AS placement_reference, p.status AS placement_status
       FROM contract_year cy
       LEFT JOIN placement p ON p.contract_year_id = cy.id
       WHERE cy.contract_id = $1
       ORDER BY cy.inception DESC`,
      [req.params.id],
    );
    res.json({ ...rows[0], years });
  }),
);

router.patch(
  '/contracts/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(contractSchema.partial().omit({ cedant_id: true }), req.body);
    const fields = defined({
      name: body.name, cob: body.cob, territory: body.territory, notes: body.notes,
    });
    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM contract WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Contract');
      if (Object.keys(fields).length === 0) return current[0];

      const upd = buildUpdate({ ...fields, updated_at: new Date() });
      const { rows } = await client.query(
        `UPDATE contract SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
        [...upd.values, req.params.id],
      );
      await audit(
        {
          entityType: 'contract', entityId: req.params.id, action: 'update',
          userId: req.user.id, before: current[0], after: rows[0],
        },
        client,
      );
      return rows[0];
    });
    res.json(row);
  }),
);

// ---------------------------------------------------------------------------
// Contract years
// ---------------------------------------------------------------------------
router.get(
  '/contracts/:id/years',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT * FROM contract_year WHERE contract_id = $1 ORDER BY inception DESC',
      [req.params.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/contracts/:id/years',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(yearSchema, req.body);
    if (new Date(body.expiry) <= new Date(body.inception)) {
      throw new ValidationError('Expiry must be after inception');
    }
    const row = await withTransaction(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM contract WHERE id = $1', [req.params.id]);
      if (!rowCount) throw new NotFoundError('Contract');
      if (body.prior_contract_year_id) {
        await assertLinkablePrior(client, req.params.id, body.prior_contract_year_id);
      }
      const { rows } = await client.query(
        `INSERT INTO contract_year (contract_id, year_label, inception, expiry, currency,
                                    prior_contract_year_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [req.params.id, body.year_label, body.inception, body.expiry, body.currency,
          body.prior_contract_year_id || null, body.notes || null, req.user.id],
      );
      await audit(
        { entityType: 'contract_year', entityId: rows[0].id, action: 'create', userId: req.user.id, after: rows[0] },
        client,
      );
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

/** The predecessor must exist, sit under the same contract, and be unclaimed. */
export async function assertLinkablePrior(client, contractId, priorId) {
  const { rows } = await client.query(
    'SELECT id, contract_id FROM contract_year WHERE id = $1', [priorId],
  );
  if (!rows[0]) throw new NotFoundError('Prior contract year');
  if (rows[0].contract_id !== contractId) {
    throw new ConflictError(
      'Prior contract year belongs to a different contract; a renewal chain stays within one programme',
    );
  }
  const { rows: claimed } = await client.query(
    'SELECT id FROM contract_year WHERE prior_contract_year_id = $1', [priorId],
  );
  if (claimed[0]) {
    throw new ConflictError('That year already renews into another; renewal is a chain, not a fork');
  }
}

export default router;
