import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';

/**
 * The contract's documents — the Documents step under Contracts, as the
 * Universe modelling tool's Documents screen keeps them: a file uploaded
 * against the placement with a document type off the tool's list, a title
 * and a description; listed newest first, viewed inline, downloaded and
 * deleted. Uploads travel as base64 in the JSON body, as every upload in
 * the API does; everyone signed in reads, a broker or admin writes.
 */
const router = Router();
router.use(authenticate);

/** The tool's document types, in the order its upload form lists them. */
export const DOCUMENT_TYPES = [
  'Final Slip', 'Draft Slip', 'Expiring Slip', 'Renewal Pack',
  'Large Loss List', 'Risk Profiles', 'Claims Profile',
  'Presentation', 'CAT Modelling', 'Bordereaux', 'Accounts', 'Other',
];
// Fits the 25mb JSON body limit after the base64 overhead.
const MAX_DOC_BYTES = 15 * 1024 * 1024;
const COLUMNS = `d.id, d.placement_id, d.doc_type, d.title, d.description, d.filename, d.mime_type, d.size_bytes,
                 d.uploaded_by, d.created_at, d.created_at AS uploaded_at, u.name AS uploaded_by_name`;

/** A file's name without its extension: the title an upload gets when none is typed. */
export const titleOfFilename = (filename) => String(filename).replace(/\.[^.]+$/, '').trim() || String(filename);

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
        WHERE d.placement_id = $1 ORDER BY d.created_at DESC, d.filename`,
      [req.params.id],
    );
    res.json(rows);
  }),
);

const uploadSchema = z.object({
  doc_type: z.enum(DOCUMENT_TYPES).default('Other'),
  title: z.string().trim().max(200).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  filename: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(200),
  content_base64: z.string().min(1),
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
    const title = body.title || titleOfFilename(body.filename);
    const { rows } = await query(
      `INSERT INTO contract_document (placement_id, doc_type, title, description, filename, mime_type, size_bytes, content, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [req.params.id, body.doc_type, title, body.description || null, body.filename, body.mime_type, content.length, content, req.user.id],
    );
    await audit({
      entityType: 'contract_document', entityId: rows[0].id, action: 'upload', userId: req.user.id,
      detail: { placement_id: req.params.id, doc_type: body.doc_type, title, filename: body.filename, size_bytes: content.length },
    });
    res.status(201).json(await documentRow(rows[0].id));
  }),
);

/** The bytes, inline (View) or as an attachment (Download). */
async function serve(req, res, disposition) {
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
  res.setHeader('Content-Disposition', `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Shown inline, a file the browser could run as a page (an HTML upload)
  // is sandboxed out of the app's origin; PDFs, images and plain text are
  // what View is for and render as they are.
  const renders = d.mime_type === 'application/pdf' || d.mime_type.startsWith('image/') || ['text/plain', 'text/csv'].includes(d.mime_type);
  if (disposition === 'inline' && !renders) res.setHeader('Content-Security-Policy', 'sandbox');
  res.end(d.content);
}

router.get('/contract-documents/:id/view', asyncHandler((req, res) => serve(req, res, 'inline')));
router.get('/contract-documents/:id/download', asyncHandler((req, res) => serve(req, res, 'attachment')));

router.patch(
  '/contract-documents/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(
      z.object({
        doc_type: z.enum(DOCUMENT_TYPES).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().trim().max(2000).nullable().optional(),
      }),
      req.body,
    );
    const before = await documentRow(req.params.id);
    await query(
      `UPDATE contract_document
          SET doc_type = COALESCE($1, doc_type),
              title = COALESCE($2, title),
              description = CASE WHEN $4::boolean THEN $3 ELSE description END
        WHERE id = $5`,
      [body.doc_type ?? null, body.title ?? null, body.description || null, body.description !== undefined, req.params.id],
    );
    const after = await documentRow(req.params.id);
    const facts = (d) => ({ doc_type: d.doc_type, title: d.title, description: d.description });
    await audit({
      entityType: 'contract_document', entityId: req.params.id, action: 'update', userId: req.user.id,
      before: facts(before), after: facts(after),
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
      detail: { placement_id: doc.placement_id, doc_type: doc.doc_type, title: doc.title, filename: doc.filename },
    });
    res.status(204).end();
  }),
);

export default router;
