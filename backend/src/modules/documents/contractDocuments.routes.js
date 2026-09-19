import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

/**
 * The contract's documents — the Documents step under Contracts: files
 * uploaded against the placement (the slip, the wording, the cedant's
 * submission, bordereaux, statements, correspondence), listed, downloaded
 * and removed. Uploads travel as base64 in the JSON body, as every upload
 * in the API does; everyone signed in reads, a broker or admin writes.
 */
const router = Router();
router.use(authenticate);

export const DOCUMENT_KINDS = ['slip', 'wording', 'submission', 'bordereau', 'statement', 'correspondence', 'other'];
// Fits the 25mb JSON body limit after the base64 overhead.
const MAX_DOC_BYTES = 15 * 1024 * 1024;
const COLUMNS = `d.id, d.placement_id, d.kind, d.filename, d.mime_type, d.size_bytes, d.note, d.uploaded_by, d.created_at,
                 u.name AS uploaded_by_name`;

async function placementExists(id) {
  const { rows } = await query('SELECT id FROM placement WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Placement');
}

/** One document's row for the list — never its bytes. */
async function documentRow(id) {
  const { rows } = await query(
    `SELECT ${COLUMNS} FROM contract_document d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.id = $1`,
    [id],
  );
  if (!rows[0]) throw new NotFoundError('Document');
  return rows[0];
}

router.get(
  '/placements/:id/contract-documents',
  asyncHandler(async (req, res) => {
    await placementExists(req.params.id);
    const { rows } = await query(
      `SELECT ${COLUMNS} FROM contract_document d LEFT JOIN users u ON u.id = d.uploaded_by
        WHERE d.placement_id = $1 ORDER BY d.created_at, d.filename`,
      [req.params.id],
    );
    res.json(rows);
  }),
);

const uploadSchema = z.object({
  kind: z.enum(DOCUMENT_KINDS).default('other'),
  filename: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(200),
  content_base64: z.string().min(1),
  note: z.string().max(2000).nullable().optional(),
});

router.post(
  '/placements/:id/contract-documents',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await placementExists(req.params.id);
    const body = validate(uploadSchema, req.body);
    const content = Buffer.from(body.content_base64, 'base64');
    if (!content.length) throw new ValidationError(`"${body.filename}" is empty or not valid base64`);
    if (content.length > MAX_DOC_BYTES) throw new ValidationError(`"${body.filename}" exceeds the 15MB upload limit`);
    const { rows } = await query(
      `INSERT INTO contract_document (placement_id, kind, filename, mime_type, size_bytes, content, note, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [req.params.id, body.kind, body.filename, body.mime_type, content.length, content, body.note || null, req.user.id],
    );
    await audit({
      entityType: 'contract_document', entityId: rows[0].id, action: 'upload', userId: req.user.id,
      detail: { placement_id: req.params.id, kind: body.kind, filename: body.filename, size_bytes: content.length },
    });
    res.status(201).json(await documentRow(rows[0].id));
  }),
);

router.get(
  '/contract-documents/:id/download',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT filename, mime_type, size_bytes, content FROM contract_document WHERE id = $1',
      [req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Document');
    const d = rows[0];
    // A plain ASCII name for older clients, the real one RFC 5987-encoded.
    const ascii = d.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.setHeader('Content-Type', d.mime_type);
    res.setHeader('Content-Length', d.size_bytes);
    res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.end(d.content);
  }),
);

router.patch(
  '/contract-documents/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({ kind: z.enum(DOCUMENT_KINDS).optional(), note: z.string().max(2000).nullable().optional() }),
      req.body,
    );
    const before = await documentRow(req.params.id);
    await query(
      `UPDATE contract_document
          SET kind = COALESCE($1, kind), note = CASE WHEN $3::boolean THEN $2 ELSE note END
        WHERE id = $4`,
      [body.kind ?? null, body.note ?? null, body.note !== undefined, req.params.id],
    );
    const after = await documentRow(req.params.id);
    await audit({
      entityType: 'contract_document', entityId: req.params.id, action: 'update', userId: req.user.id,
      before: { kind: before.kind, note: before.note }, after: { kind: after.kind, note: after.note },
    });
    res.json(after);
  }),
);

router.delete(
  '/contract-documents/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const doc = await documentRow(req.params.id);
    await query('DELETE FROM contract_document WHERE id = $1', [doc.id]);
    await audit({
      entityType: 'contract_document', entityId: doc.id, action: 'delete', userId: req.user.id,
      detail: { placement_id: doc.placement_id, kind: doc.kind, filename: doc.filename },
    });
    res.status(204).end();
  }),
);

export default router;
