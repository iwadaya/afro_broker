import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { buildUpdate, defined } from '../../lib/sql.js';

/**
 * ContractYear reads, the renewal chain, and attaching a placement to its year.
 *
 * Renewing creates the NEXT year linked to this one. It does not copy the prior
 * year's contents: the link is what lets M5 read the expiring structures, and a
 * copy would let the two drift apart.
 */
const router = Router();
router.use(authenticate);

const patchSchema = z.object({
  year_label: z.string().min(1).optional(),
  inception: z.string().min(1).optional(),
  expiry: z.string().min(1).optional(),
  currency: z.string().min(1).optional(),
  notes: z.string().optional(),
});

const renewSchema = z.object({
  year_label: z.string().min(1),
  inception: z.string().optional(),
  expiry: z.string().optional(),
  currency: z.string().optional(),
  notes: z.string().optional(),
});

async function loadYear(id) {
  const { rows } = await query(
    `SELECT cy.*, c.name AS contract_name, c.cob, c.territory, c.cedant_id, ced.name AS cedant_name
     FROM contract_year cy
     JOIN contract c ON c.id = cy.contract_id
     JOIN cedant ced ON ced.id = c.cedant_id
     WHERE cy.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Contract year');
  return rows[0];
}

router.get(
  '/contract-years/:id',
  asyncHandler(async (req, res) => {
    const year = await loadYear(req.params.id);
    const { rows: successor } = await query(
      'SELECT id, year_label, inception, expiry FROM contract_year WHERE prior_contract_year_id = $1',
      [req.params.id],
    );
    const prior = year.prior_contract_year_id
      ? (await query(
        'SELECT id, year_label, inception, expiry, currency FROM contract_year WHERE id = $1',
        [year.prior_contract_year_id],
      )).rows[0]
      : null;
    const { rows: placement } = await query(
      'SELECT id, reference, status FROM placement WHERE contract_year_id = $1', [req.params.id],
    );
    res.json({ ...year, prior, successor: successor[0] || null, placement: placement[0] || null });
  }),
);

/**
 * The full renewal chain for this programme, oldest first — the query M1, M5
 * and M9 build on, so it lives here rather than being re-derived each time.
 */
router.get(
  '/contract-years/:id/chain',
  asyncHandler(async (req, res) => {
    await loadYear(req.params.id);
    const { rows } = await query(
      `WITH RECURSIVE backwards AS (
         SELECT cy.* FROM contract_year cy WHERE cy.id = $1
         UNION ALL
         SELECT prev.* FROM contract_year prev
           JOIN backwards b ON b.prior_contract_year_id = prev.id
       ), forwards AS (
         SELECT cy.* FROM contract_year cy WHERE cy.id = $1
         UNION ALL
         SELECT nxt.* FROM contract_year nxt
           JOIN forwards f ON nxt.prior_contract_year_id = f.id
       )
       SELECT DISTINCT ON (id) id, contract_id, year_label, inception, expiry, currency,
              prior_contract_year_id
       FROM (SELECT * FROM backwards UNION SELECT * FROM forwards) chain
       ORDER BY id, inception`,
      [req.params.id],
    );
    const ordered = rows.sort((a, b) => new Date(a.inception) - new Date(b.inception));
    res.json({
      contract_year_id: req.params.id,
      length: ordered.length,
      chain: ordered.map((y) => ({ ...y, is_current: y.id === req.params.id })),
    });
  }),
);

router.patch(
  '/contract-years/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(patchSchema, req.body);
    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM contract_year WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Contract year');

      const inception = body.inception || current[0].inception;
      const expiry = body.expiry || current[0].expiry;
      if (new Date(expiry) <= new Date(inception)) {
        throw new ValidationError('Expiry must be after inception');
      }
      const fields = defined({
        year_label: body.year_label, inception: body.inception,
        expiry: body.expiry, currency: body.currency, notes: body.notes,
      });
      if (Object.keys(fields).length === 0) return current[0];

      const upd = buildUpdate({ ...fields, updated_at: new Date() });
      const { rows } = await client.query(
        `UPDATE contract_year SET ${upd.text} WHERE id = $${upd.nextIndex} RETURNING *`,
        [...upd.values, req.params.id],
      );
      await audit(
        {
          entityType: 'contract_year', entityId: req.params.id, action: 'update',
          userId: req.user.id, before: current[0], after: rows[0],
        },
        client,
      );
      return rows[0];
    });
    res.json(row);
  }),
);

/**
 * Renew: create the following year, linked to this one (§1.1).
 *
 * Dates and currency default to the expiring year rolled forward twelve months
 * and are overridable. Nothing else is carried across — the link, not a copy,
 * is what makes the prior year readable.
 */
router.post(
  '/contract-years/:id/renew',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(renewSchema, req.body);
    const row = await withTransaction(async (client) => {
      const { rows: priorRows } = await client.query(
        'SELECT * FROM contract_year WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      const prior = priorRows[0];
      if (!prior) throw new NotFoundError('Contract year');

      const { rows: claimed } = await client.query(
        'SELECT year_label FROM contract_year WHERE prior_contract_year_id = $1', [req.params.id],
      );
      if (claimed[0]) {
        throw new ConflictError(
          `This year already renews into "${claimed[0].year_label}"; renewal is a chain, not a fork`,
        );
      }

      const inception = body.inception || addYear(prior.inception);
      const expiry = body.expiry || addYear(prior.expiry);
      if (new Date(expiry) <= new Date(inception)) {
        throw new ValidationError('Expiry must be after inception');
      }

      const { rows } = await client.query(
        `INSERT INTO contract_year (contract_id, year_label, inception, expiry, currency,
                                    prior_contract_year_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [prior.contract_id, body.year_label, inception, expiry,
          body.currency || prior.currency, prior.id, body.notes || null, req.user.id],
      );
      await audit(
        { entityType: 'contract_year', entityId: rows[0].id, action: 'renew', userId: req.user.id, after: rows[0] },
        client,
      );
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

/**
 * Attach a placement to the year it is the placing of.
 *
 * One placement per year, enforced by a partial unique index. Attaching is how
 * the existing book moves onto the spine: nothing is backfilled automatically,
 * because grouping placements into programmes is a judgement about the book,
 * not something to infer from (cedant, class).
 */
router.post(
  '/contract-years/:id/placement',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ placement_id: z.string().uuid() }), req.body);
    const row = await withTransaction(async (client) => {
      const { rows: yearRows } = await client.query(
        'SELECT * FROM contract_year WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!yearRows[0]) throw new NotFoundError('Contract year');

      const { rows: current } = await client.query(
        'SELECT * FROM placement WHERE id = $1 FOR UPDATE', [body.placement_id],
      );
      if (!current[0]) throw new NotFoundError('Placement');
      if (current[0].contract_year_id && current[0].contract_year_id !== req.params.id) {
        throw new ConflictError('That placement is already attached to another contract year');
      }

      const { rows: taken } = await client.query(
        'SELECT id, reference FROM placement WHERE contract_year_id = $1 AND id <> $2',
        [req.params.id, body.placement_id],
      );
      if (taken[0]) {
        throw new ConflictError(`This year is already placed by ${taken[0].reference}`);
      }

      const { rows } = await client.query(
        'UPDATE placement SET contract_year_id = $1, updated_at = now() WHERE id = $2 RETURNING *',
        [req.params.id, body.placement_id],
      );
      await audit(
        {
          entityType: 'placement', entityId: body.placement_id, action: 'attach_contract_year',
          userId: req.user.id, before: current[0], after: rows[0],
        },
        client,
      );
      return rows[0];
    });
    res.json(row);
  }),
);

/** Roll a date forward twelve months, as an ISO date string. */
function addYear(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()))
    .toISOString().slice(0, 10);
}

export default router;
