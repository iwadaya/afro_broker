import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { NotFoundError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

/**
 * Cedants — the clients we place business for. A cedant is the insurer side of
 * the market register, so each one carries a `market_id` pointing at its
 * register entry (type `insurer`), where its compliance file and group profile
 * live. Reinsurers, insurers and brokers themselves are served by
 * `modules/markets`.
 */
const router = Router();
router.use(authenticate);

const contactSchema = z.object({
  name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  role: z.string().optional(),
});

const cedantSchema = z.object({
  name: z.string().min(1),
  domicile: z.string().optional(),
  contacts: z.array(contactSchema).optional(),
});

router.get(
  '/cedants',
  asyncHandler(async (req, res) => {
    const { limit, offset } = pageParams(req.query);
    const { rows } = await query(
      'SELECT * FROM cedant ORDER BY name LIMIT $1 OFFSET $2',
      [limit, offset],
    );
    res.json(rows);
  }),
);

router.post(
  '/cedants',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(cedantSchema, req.body);
    const cedant = await withTransaction(async (client) => {
      // Give the cedant its register entry in the same breath, so it appears
      // on the Insurers tab with somewhere to hang its KYC and group profile.
      const { rows: markets } = await client.query(
        `INSERT INTO market (name, domicile, type)
         VALUES ($1, $2, 'insurer')
         ON CONFLICT (type, name, domicile) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [body.name, body.domicile || null],
      );
      const { rows } = await client.query(
        `INSERT INTO cedant (name, domicile, contacts, market_id)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [body.name, body.domicile || null, JSON.stringify(body.contacts || []), markets[0]?.id || null],
      );
      await audit({ entityType: 'cedant', entityId: rows[0].id, action: 'create', userId: req.user.id }, client);
      return rows[0];
    });
    res.status(201).json(cedant);
  }),
);

router.get(
  '/cedants/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM cedant WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Cedant');
    res.json(rows[0]);
  }),
);

export default router;
