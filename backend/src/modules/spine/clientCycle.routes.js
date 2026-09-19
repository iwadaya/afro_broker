import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { assertApproved } from '../../lib/approvals.js';
import { termSchemaById } from '../../domain/termSchemas/index.js';
import { validateTerms } from '../../domain/terms.js';
import { assertCompleteForFot } from '../../domain/termRules.js';

/**
 * M8 — the quote-to-client cycle, on StructureVersion.
 *
 * Negotiation needs no machinery of its own: a negotiated structure is a
 * version with origin CEDANT or BROKER and status NEGOTIATED, written through
 * the ordinary version endpoint. What is added here is the conversation around
 * it, the promotion to FOT, and the outbound send that D7 gates.
 */
const router = Router();
router.use(authenticate);

// ---------------------------------------------------------------------------
// Threaded comments against a version
// ---------------------------------------------------------------------------
const commentSchema = z.object({
  body: z.string().min(1),
  audience: z.enum(['INTERNAL', 'CEDANT']).default('INTERNAL'),
  parent_comment_id: z.string().uuid().nullish(),
});

router.get(
  '/structure-versions/:id/comments',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT c.*, u.name AS author_name
       FROM structure_comment c LEFT JOIN users u ON u.id = c.created_by
       WHERE c.structure_version_id = $1
       ORDER BY c.created_at`,
      [req.params.id],
    );
    // Threads, so a reply reads under what it replies to.
    const byParent = new Map();
    for (const c of rows) {
      const key = c.parent_comment_id || 'root';
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push({ ...c, replies: [] });
    }
    const attach = (node) => {
      node.replies = byParent.get(node.id) || [];
      node.replies.forEach(attach);
      return node;
    };
    res.json((byParent.get('root') || []).map(attach));
  }),
);

router.post(
  '/structure-versions/:id/comments',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(commentSchema, req.body);
    const row = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'SELECT 1 FROM structure_version WHERE id = $1', [req.params.id],
      );
      if (!rowCount) throw new NotFoundError('Structure version');

      if (body.parent_comment_id) {
        const { rows: parent } = await client.query(
          'SELECT structure_version_id FROM structure_comment WHERE id = $1',
          [body.parent_comment_id],
        );
        if (!parent[0]) throw new NotFoundError('Parent comment');
        if (parent[0].structure_version_id !== req.params.id) {
          throw new ConflictError('A reply stays in the thread it replies to');
        }
      }

      const { rows } = await client.query(
        `INSERT INTO structure_comment (structure_version_id, parent_comment_id, audience, body, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [req.params.id, body.parent_comment_id || null, body.audience, body.body, req.user.id],
      );
      await audit({
        entityType: 'structure_comment', entityId: rows[0].id, action: 'create',
        userId: req.user.id, after: rows[0],
      }, client);
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

// ---------------------------------------------------------------------------
// FOT promotion
// ---------------------------------------------------------------------------
/**
 * Promote a version to firm order terms (M8).
 *
 * "FOT promotion is the point where terms must be complete and validated
 * against the JSON Schema — the claims and premium engine reads from here."
 *
 * Promotion creates a NEW version carrying the same terms with status FOT,
 * parented to the version taken up. It does not rewrite the status of the
 * version being promoted: that version was a NEGOTIATED counter or a QUOTED
 * offer, and it still is. Mutating it would erase the step it records.
 *
 * The live FOT is therefore the highest-numbered version with status FOT — a
 * query, not a flag, so nothing has to be kept in sync.
 *
 * Re-validation runs against the schema the version was written under, not
 * today's, so tightening a schema cannot retroactively invalidate a placement
 * already in the market.
 */
router.post(
  '/structure-versions/:id/promote-fot',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rows: source } = await client.query(
        `SELECT sv.*, s.id AS structure_id, s.treaty_type, s.cob
         FROM structure_version sv JOIN structure s ON s.id = sv.structure_id
         WHERE sv.id = $1 FOR UPDATE`,
        [req.params.id],
      );
      const version = source[0];
      if (!version) throw new NotFoundError('Structure version');
      if (version.status === 'FOT') throw new ConflictError('That version is already the firm order terms');
      if (version.status === 'BOUND') throw new ConflictError('A bound version cannot be re-promoted');

      const schema = await termSchemaById(version.term_schema_id, client);
      validateTerms(version.terms, schema);
      assertCompleteForFot(version.terms, schema);

      const { rows: next } = await client.query(
        'SELECT COALESCE(MAX(version_no),0)+1 AS n FROM structure_version WHERE structure_id = $1',
        [version.structure_id],
      );
      const { rows } = await client.query(
        `INSERT INTO structure_version
           (structure_id, version_no, status, origin, parent_version_id, terms, term_schema_id, created_by)
         VALUES ($1,$2,'FOT','BROKER',$3,$4,$5,$6) RETURNING *`,
        [version.structure_id, next[0].n, version.id, version.terms, schema.id, req.user.id],
      );
      await audit({
        entityType: 'structure_version', entityId: rows[0].id, action: 'promote_fot',
        userId: req.user.id, after: rows[0],
        detail: { promoted_from: version.id, promoted_from_status: version.status },
      }, client);
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

/** The live firm order terms for a structure, if it has any. */
router.get(
  '/structures/:id/fot',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT * FROM structure_version
       WHERE structure_id = $1 AND status = 'FOT'
       ORDER BY version_no DESC LIMIT 1`,
      [req.params.id],
    );
    res.json(rows[0] || null);
  }),
);

// ---------------------------------------------------------------------------
// The client stage — quotes out to the cedant, and what came back
// ---------------------------------------------------------------------------
router.get(
  '/contract-years/:id/cedant-sends',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT s.*, u.name AS created_by_name,
              (SELECT COUNT(*)::int FROM cedant_quote_send_version v WHERE v.send_id = s.id) AS version_count
       FROM cedant_quote_send s LEFT JOIN users u ON u.id = s.created_by
       WHERE s.contract_year_id = $1 ORDER BY s.created_at DESC`,
      [req.params.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/contract-years/:id/cedant-sends',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({ structure_version_ids: z.array(z.string().uuid()).min(1) }),
      req.body,
    );
    const row = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'SELECT 1 FROM contract_year WHERE id = $1', [req.params.id],
      );
      if (!rowCount) throw new NotFoundError('Contract year');

      // Every version must belong to this year, or the cedant is shown terms
      // from someone else's programme.
      const { rows: check } = await client.query(
        `SELECT sv.id FROM structure_version sv
         JOIN structure s ON s.id = sv.structure_id
         WHERE sv.id = ANY($1) AND s.contract_year_id = $2`,
        [body.structure_version_ids, req.params.id],
      );
      if (check.length !== body.structure_version_ids.length) {
        throw new ConflictError('Every version sent must belong to this contract year');
      }

      const { rows } = await client.query(
        `INSERT INTO cedant_quote_send (contract_year_id, created_by) VALUES ($1,$2) RETURNING *`,
        [req.params.id, req.user.id],
      );
      for (const id of body.structure_version_ids) {
        await client.query(
          'INSERT INTO cedant_quote_send_version (send_id, structure_version_id) VALUES ($1,$2)',
          [rows[0].id, id],
        );
      }
      await audit({
        entityType: 'cedant_quote_send', entityId: rows[0].id, action: 'create',
        userId: req.user.id, after: rows[0],
        detail: { versions: body.structure_version_ids.length },
      }, client);
      return rows[0];
    });
    res.status(201).json(row);
  }),
);

/**
 * Send it. D7: nothing reaches a cedant on one person's authority, so this
 * consumes a four-eyes approval for `quote_to_cedant` on this send.
 */
router.post(
  '/cedant-sends/:id/send',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM cedant_quote_send WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Cedant send');
      if (current[0].status !== 'DRAFT') throw new ConflictError('That send has already gone out');

      const approval = await assertApproved(client, {
        actionType: 'quote_to_cedant', entityType: 'cedant_quote_send', entityId: req.params.id,
      });

      const { rows } = await client.query(
        `UPDATE cedant_quote_send SET status = 'SENT', sent_at = now(), approval_id = $1,
                updated_at = now()
         WHERE id = $2 RETURNING *`,
        [approval.id, req.params.id],
      );
      await audit({
        entityType: 'cedant_quote_send', entityId: req.params.id, action: 'send',
        userId: req.user.id, before: current[0], after: rows[0],
        detail: { approval_id: approval.id },
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

/** Taken up, or not (M8). */
router.post(
  '/cedant-sends/:id/outcome',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({
        taken_up: z.boolean(),
        not_taken_up_reason: z.string().optional(),
      }),
      req.body,
    );
    const row = await withTransaction(async (client) => {
      const { rows: current } = await client.query(
        'SELECT * FROM cedant_quote_send WHERE id = $1 FOR UPDATE', [req.params.id],
      );
      if (!current[0]) throw new NotFoundError('Cedant send');
      if (current[0].status !== 'SENT') {
        throw new ConflictError('An outcome only follows a send that actually went out');
      }
      if (!body.taken_up && !String(body.not_taken_up_reason || '').trim()) {
        throw new ConflictError('Record why it was not taken up');
      }

      const { rows } = await client.query(
        `UPDATE cedant_quote_send SET status = $1, outcome_at = now(),
                not_taken_up_reason = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [body.taken_up ? 'TAKEN_UP' : 'NOT_TAKEN_UP',
          body.taken_up ? null : body.not_taken_up_reason, req.params.id],
      );
      await audit({
        entityType: 'cedant_quote_send', entityId: req.params.id, action: 'outcome',
        userId: req.user.id, before: current[0], after: rows[0],
      }, client);
      return rows[0];
    });
    res.json(row);
  }),
);

export default router;
