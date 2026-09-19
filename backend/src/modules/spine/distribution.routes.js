import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { assertApproved } from '../../lib/approvals.js';
import { config } from '../../config.js';

/**
 * M3 — distribution and market approach, on StructureVersion.
 *
 * "Two stages, one engine: pack to quoting markets for terms; once FOT is set,
 * pack + FOT to follow markets for follow shares." The difference between the
 * stages is which versions go out and to whom, not how sending works, so there
 * is one table and one send path.
 *
 * Every send is a logged record tied to the ContractYear and the versions sent,
 * which is what lets a response (M6) attach to the terms a market actually saw.
 */
const router = Router();
router.use(authenticate);

/** D7 — the approval each stage consumes before anything leaves. */
const STAGE_ACTION = { QUOTING: 'submission_send', FOLLOW: 'fot_send' };

const distributionSchema = z.object({
  stage: z.enum(['QUOTING', 'FOLLOW']),
  subject: z.string().min(1),
  body: z.string().min(1),
  structure_version_ids: z.array(z.string().uuid()).min(1),
  recipients: z.array(z.object({
    reinsurer_id: z.string().uuid(),
    contact_id: z.string().uuid().nullish(),
    name: z.string().optional(),
    email: z.string().email(),
  })).min(1),
});

/**
 * D5 — `placements+<contract_year_id>@domain`. Returns null when no domain is
 * configured rather than inventing one: a reply-to nobody reads is worse than
 * an absent header, because it looks like it works.
 */
function replyToFor(contractYearId) {
  const { replyToMailbox, replyToDomain } = config.mail;
  if (!replyToDomain) return null;
  return `${replyToMailbox}+${contractYearId}@${replyToDomain}`;
}

/**
 * Candidate recipients from the register (M3/M4).
 *
 * Security-declined counterparties are excluded rather than flagged: this is a
 * list people send from. Note that class and territory filtering is not
 * available here — the register carries neither on its contacts yet, so the
 * filter is by counterparty type, security, region and active contacts.
 */
router.get(
  '/contract-years/:id/distribution-candidates',
  asyncHandler(async (req, res) => {
    const params = [];
    const filters = [
      "m.type = 'reinsurer'",
      "m.security_status <> 'declined'",
      'mc.active',
    ];
    if (req.query.region) {
      params.push(req.query.region);
      filters.push(`m.region = $${params.length}`);
    }
    if (req.query.role) {
      params.push(req.query.role);
      filters.push(`mc.role = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT m.id AS reinsurer_id, m.name AS reinsurer_name, m.security_status,
              m.rating, m.rating_agency, m.region,
              mc.id AS contact_id, mc.name AS contact_name, mc.email, mc.role, mc.is_primary
       FROM market m
       JOIN market_contact mc ON mc.market_id = m.id
       WHERE ${filters.join(' AND ')} AND mc.email IS NOT NULL
       ORDER BY m.name, mc.is_primary DESC, mc.name`,
      params,
    );
    res.json({
      filters: { region: req.query.region || null, role: req.query.role || null },
      note: 'Class and territory filtering needs those fields on the register (M4); not yet available.',
      candidates: rows,
    });
  }),
);

router.get(
  '/contract-years/:id/distributions',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT d.*, u.name AS created_by_name,
              (SELECT COUNT(*)::int FROM distribution_recipient r WHERE r.distribution_id = d.id) AS recipient_count,
              (SELECT COUNT(*)::int FROM distribution_version v WHERE v.distribution_id = d.id) AS version_count
       FROM distribution d LEFT JOIN users u ON u.id = d.created_by
       WHERE d.contract_year_id = $1 ORDER BY d.created_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  }),
);

router.get(
  '/distributions/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM distribution WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new NotFoundError('Distribution');
    const { rows: recipients } = await query(
      `SELECT r.*, m.name AS reinsurer_name FROM distribution_recipient r
       JOIN market m ON m.id = r.reinsurer_id
       WHERE r.distribution_id = $1 ORDER BY m.name, r.email`,
      [req.params.id],
    );
    const { rows: versions } = await query(
      `SELECT sv.id, sv.version_no, sv.status, s.label
       FROM distribution_version dv
       JOIN structure_version sv ON sv.id = dv.structure_version_id
       JOIN structure s ON s.id = sv.structure_id
       WHERE dv.distribution_id = $1 ORDER BY s.position, s.label`,
      [req.params.id],
    );
    res.json({ ...rows[0], versions, recipients });
  }),
);

router.post(
  '/contract-years/:id/distributions',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(distributionSchema, req.body);

    const row = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'SELECT 1 FROM contract_year WHERE id = $1', [req.params.id],
      );
      if (!rowCount) throw new NotFoundError('Contract year');

      const { rows: versions } = await client.query(
        `SELECT sv.id, sv.status FROM structure_version sv
         JOIN structure s ON s.id = sv.structure_id
         WHERE sv.id = ANY($1) AND s.contract_year_id = $2`,
        [body.structure_version_ids, req.params.id],
      );
      if (versions.length !== body.structure_version_ids.length) {
        throw new ConflictError('Every version sent must belong to this contract year');
      }

      // "Once FOT is set, pack + FOT to follow markets." A follow market is
      // being asked for a share of agreed terms, so sending it anything else
      // is asking the wrong question.
      if (body.stage === 'FOLLOW') {
        const notFot = versions.filter((v) => v.status !== 'FOT');
        if (notFot.length > 0) {
          throw new ConflictError(
            'A follow-market approach carries the firm order terms; promote the versions to FOT first',
          );
        }
      }

      const { rows } = await client.query(
        `INSERT INTO distribution (contract_year_id, stage, subject, body, reply_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, body.stage, body.subject, body.body,
          replyToFor(req.params.id), req.user.id],
      );

      for (const id of body.structure_version_ids) {
        await client.query(
          'INSERT INTO distribution_version (distribution_id, structure_version_id) VALUES ($1,$2)',
          [rows[0].id, id],
        );
      }
      for (const r of body.recipients) {
        await client.query(
          `INSERT INTO distribution_recipient (distribution_id, reinsurer_id, contact_id, name, email)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (distribution_id, reinsurer_id, email) DO NOTHING`,
          [rows[0].id, r.reinsurer_id, r.contact_id || null, r.name || null, r.email],
        );
      }

      await audit({
        entityType: 'distribution', entityId: rows[0].id, action: 'create',
        userId: req.user.id, after: rows[0],
        detail: { stage: body.stage, versions: body.structure_version_ids.length, recipients: body.recipients.length },
      }, client);
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

/**
 * Send it. D7: a submission to a market does not go out on one person's
 * authority, so this consumes an approval for the stage's action.
 */
router.post(
  '/distributions/:id/send',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM distribution WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Distribution');
      if (current[0].status !== 'DRAFT') throw new ConflictError('That distribution has already gone out');

      const approval = await assertApproved(client, {
        actionType: STAGE_ACTION[current[0].stage],
        entityType: 'distribution',
        entityId: req.params.id,
      });

      const { rows } = await client.query(
        `UPDATE distribution SET status = 'SENT', sent_at = now(), approval_id = $1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [approval.id, req.params.id],
      );
      // The recipients move with it. Actual dispatch is the mail transport's
      // job; what is recorded here is that the send was authorised and made.
      await client.query(
        `UPDATE distribution_recipient SET status = 'SENT', sent_at = now(), updated_at = now()
         WHERE distribution_id = $1 AND status = 'PENDING'`,
        [req.params.id],
      );

      await audit({
        entityType: 'distribution', entityId: req.params.id, action: 'send',
        userId: req.user.id, before: current[0], after: rows[0],
        detail: { approval_id: approval.id, stage: current[0].stage },
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

/**
 * Record what happened to one recipient's message (M3: sent, delivered, opened
 * if available, responded). Written by whatever reads the transport's webhooks,
 * or by a broker who knows.
 */
const EVENTS = {
  DELIVERED: 'delivered_at',
  OPENED: 'opened_at',
  RESPONDED: 'responded_at',
};

router.post(
  '/distribution-recipients/:id/event',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({
      event: z.enum(['DELIVERED', 'OPENED', 'RESPONDED', 'BOUNCED', 'FAILED']),
      message_id: z.string().optional(),
      error: z.string().optional(),
    }), req.body);

    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM distribution_recipient WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Recipient');
      if (current[0].status === 'PENDING') {
        throw new ConflictError('That message has not been sent yet');
      }

      const stampColumn = EVENTS[body.event];
      const { rows } = await client.query(
        `UPDATE distribution_recipient
         SET status = $1,
             ${stampColumn ? `${stampColumn} = COALESCE(${stampColumn}, now()),` : ''}
             message_id = COALESCE($2, message_id),
             error = COALESCE($3, error),
             updated_at = now()
         WHERE id = $4 RETURNING *`,
        [body.event, body.message_id || null, body.error || null, req.params.id],
      );
      await audit({
        entityType: 'distribution_recipient', entityId: req.params.id, action: body.event.toLowerCase(),
        userId: req.user.id, before: current[0], after: rows[0],
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

export default router;
