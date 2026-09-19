import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { asyncHandler, validate } from '../../lib/http.js';
import { NotFoundError, ConflictError, ValidationError } from '../../lib/errors.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { audit } from '../../lib/audit.js';
import { llmProviders } from '../../lib/llm.js';
import { analyseRenewalPacks, FLAG_KINDS } from './renewalPack.llm.js';
import { extractIntake, reviewIntake, CONFIDENCE, DOC_ROLES } from './renewalIntake.llm.js';
import { loadRefList, loadTreatyTypes, loadClassesOfBusiness } from '../refdata/lookups.routes.js';
import { deskContext, createDeskSubmission, latestDeskSubmission, summariseSubmission } from './renewalDesk.service.js';
import { responsesContext, releaseSignedLines } from './renewalDesk.responses.js';
import { signedLinesContext, sendSigningAdvices, sendDeclinatureNotes, latestSigningAdvice } from './renewalDesk.signed.js';

/*
 * Renewal pack analysis (nav §02): enter the cedant, class of business and
 * treaty type, upload the renewal packs — usually the expiring and the
 * current submissions — and have the model review and compare them.
 *
 * The details come onto the record one of two ways. The full renewal pack
 * is the manual route: the broker types them. The quick renewal pack hands
 * the packs to the AI first (POST /renewal-analyses/intake), which reads the
 * same details off them for the broker to correct; the create then carries
 * the model's picks so the record keeps them beside what was saved.
 */

const router = Router();
router.use(authenticate);

const MAX_DOC_BYTES = 15 * 1024 * 1024; // fits the 25mb JSON body limit after base64 overhead
// The quick intake reads every pack in one request, so together they have to
// fit the same body limit — base64 adds a third, so ~18MB of files is the cap.
const MAX_INTAKE_BYTES = 18 * 1024 * 1024;
const MAX_INTAKE_DOCS = 6;
const DOC_COLUMNS = 'id, analysis_id, role, filename, mime_type, size_bytes, uploaded_by, created_at';

const TEXT_TYPES = ['application/json', 'application/csv'];

/**
 * A base64 upload decoded and checked — the one shape both the document
 * upload and the quick intake read: the bytes, their size, and the text for
 * a text-like file (what the model reads inline).
 */
function decodeUpload(body) {
  const content = Buffer.from(body.content_base64, 'base64');
  if (!content.length) throw new ValidationError(`Uploaded file "${body.filename}" is empty or not valid base64`);
  if (content.length > MAX_DOC_BYTES) throw new ValidationError(`"${body.filename}" exceeds the 15MB upload limit`);
  const textLike = body.mime_type.startsWith('text/') || TEXT_TYPES.includes(body.mime_type);
  return {
    role: body.role,
    filename: body.filename,
    mime_type: body.mime_type,
    content,
    text_content: textLike ? content.toString('utf8') : null,
  };
}

async function getAnalysis(id) {
  const { rows } = await query('SELECT * FROM renewal_pack_analysis WHERE id = $1', [id]);
  if (!rows[0]) throw new NotFoundError('Renewal pack analysis');
  return rows[0];
}

/**
 * The record as the screens read it: its documents (without the blobs), the
 * linked placement, who drafted it and who signed it off, and whether an AI
 * provider is reachable.
 */
async function detailOf(analysis) {
  const people = [analysis.created_by, analysis.verified_by].filter(Boolean);
  const [{ rows: documents }, placement, { rows: users }] = await Promise.all([
    query(`SELECT ${DOC_COLUMNS} FROM renewal_pack_analysis_document WHERE analysis_id = $1 ORDER BY created_at`, [analysis.id]),
    linkedPlacement(analysis.placement_id),
    people.length
      ? query('SELECT id, name FROM users WHERE id = ANY($1::uuid[])', [people])
      : Promise.resolve({ rows: [] }),
  ]);
  const nameOf = (id) => users.find((u) => u.id === id)?.name || null;
  return {
    ...analysis,
    documents,
    placement,
    providers: llmProviders(),
    created_by_name: nameOf(analysis.created_by),
    verified_by_name: nameOf(analysis.verified_by),
    // Where the market submission and the signing advice stand, for the tab
    // strip: state, not content.
    submission: summariseSubmission(await latestDeskSubmission(analysis.id)),
    signed_advice: await latestSigningAdvice(analysis.placement_id),
  };
}

/* ── Broker sign-off ──────────────────────────────────────────────────────
   The AI draft is unverified until a broker has read it against the packs,
   and nothing goes to market before that — the desk's submission route
   checks verified_at. The sign-off is given for the draft and the packs as
   they were, so a new draft clears it: a re-run, a pack added or removed, or
   a corrected figure. */

/** The fields the sign-off audit records either side of a change. */
const signoffState = (a) => ({
  status: a.status, analysed_at: a.analysed_at, verified_at: a.verified_at, verified_by: a.verified_by,
});

/** Clear a sign-off the packs or the draft have moved from under. Returns whether one was cleared. */
async function clearSignoff(id) {
  const { rowCount } = await query(
    'UPDATE renewal_pack_analysis SET verified_at = NULL, verified_by = NULL WHERE id = $1 AND verified_at IS NOT NULL',
    [id],
  );
  return rowCount > 0;
}

/* ── The quick intake's extraction, as the create carries it back ─────────
   The model's picks are the browser's to hold between the read and the
   create (nothing is on the record until the broker creates it), so they come
   back with the create and are checked here before they are stored. The
   review — which fields the broker accepted, corrected or added — is worked
   out server-side from the two sides, never taken from the client. */

const provenanceShape = {
  source: z.string().max(400).default(''),
  confidence: z.enum(CONFIDENCE).default('low'),
};
const pickShape = z.object({
  value: z.string().max(400),
  as_written: z.string().max(400).default(''),
  ...provenanceShape,
});
const extractionSchema = z.object({
  cedant: z.object({ value: z.string().max(400), ...provenanceShape }),
  domicile: pickShape,
  treaty_type: pickShape,
  classes_of_business: z.object({
    values: z.array(z.string().max(200)).max(50),
    as_written: z.string().max(400).default(''),
    ...provenanceShape,
  }),
  notes: z.string().max(2000).default(''),
  documents: z.array(z.object({
    index: z.number().int().min(1),
    filename: z.string().max(400).optional(),
    role: z.enum(DOC_ROLES),
    year: z.string().max(40).default(''),
    reason: z.string().max(600).default(''),
  })).max(MAX_INTAKE_DOCS).default([]),
  flags: z.array(z.object({
    kind: z.enum(FLAG_KINDS),
    claim: z.string().max(600),
    source: z.string().max(400).default(''),
  })).max(50).default([]),
});
const intakeSchema = z.object({
  mode: z.enum(['quick', 'full']),
  provider: z.string().max(40).optional(),
  model: z.string().max(120).optional(),
  extraction: extractionSchema.optional(),
}).refine((i) => i.mode !== 'quick' || i.extraction, {
  message: 'A quick intake carries the extraction the form was filled from',
  path: ['extraction'],
});

const createSchema = z.object({
  cedant_name: z.string().min(1),
  cedant_domicile: z.string().optional(),
  cedant_notes: z.string().optional(),
  class_of_business: z.string().min(1),
  treaty_type: z.string().min(1),
  // How the details arrived: absent or full = typed; quick = read off the
  // pack by the AI and corrected here.
  intake: intakeSchema.optional(),
});

/* The placement an analysis is linked to, flattened for the list and the
   detail. Left-joined, so an unlinked analysis simply carries nulls. */
const PLACEMENT_JOIN = `
  LEFT JOIN placement p ON p.id = a.placement_id
  LEFT JOIN cedant pc ON pc.id = p.cedant_id`;
const PLACEMENT_COLUMNS = `
  p.reference AS placement_reference, p.status AS placement_status,
  p.class AS placement_class, p.inception AS placement_inception,
  p.expiry AS placement_expiry, p.currency AS placement_currency,
  pc.name AS placement_cedant`;

router.get(
  '/renewal-analyses',
  asyncHandler(async (req, res) => {
    // ?placement_id= is how the pack builder finds the uploaded pack behind
    // the placement it is building for.
    const params = [];
    let where = '';
    if (req.query.placement_id) {
      params.push(req.query.placement_id);
      where = `WHERE a.placement_id = $${params.length}`;
    }
    const { rows } = await query(
      // How far the upload covers the house skeleton, counted in SQL — the
      // result itself is far too large to ship on a list.
      `SELECT a.id, a.cedant_name, a.cedant_domicile, a.class_of_business, a.treaty_type,
              a.status, a.provider, a.created_at, a.analysed_at, a.verified_at, a.placement_id,
              a.intake_mode,
              ${PLACEMENT_COLUMNS},
              jsonb_array_length(COALESCE(a.result->'standard_pack', '[]'::jsonb)) AS sections_total,
              (SELECT COUNT(*)::int FROM jsonb_array_elements(COALESCE(a.result->'standard_pack', '[]'::jsonb)) s
                WHERE s->>'status' = 'supplied') AS sections_supplied,
              COALESCE(d.doc_count, 0)::int AS doc_count,
              COALESCE(d.roles, '{}') AS doc_roles
       FROM renewal_pack_analysis a
       ${PLACEMENT_JOIN}
       LEFT JOIN (
         SELECT analysis_id, COUNT(*) AS doc_count, array_agg(DISTINCT role) AS roles
         FROM renewal_pack_analysis_document GROUP BY analysis_id
       ) d ON d.analysis_id = a.id
       ${where}
       ORDER BY a.created_at DESC`,
      params,
    );
    res.json(rows);
  }),
);

/* ── The quick intake ──────────────────────────────────────────────────
   Declared before /renewal-analyses/:id, which would otherwise read
   "intake" as an id. GET says what the quick route needs to know before it
   offers itself — whether an AI provider is reachable, and the upload
   limits; POST reads the packs and answers with the model's picks. Nothing
   is written: the record is created when the broker has corrected the form. */

/** The reference lists the model is constrained to — the dropdowns' own rows. */
async function intakeLists() {
  const [countries, treatyTypes, classes] = await Promise.all([
    loadRefList('country'), loadTreatyTypes(), loadClassesOfBusiness(),
  ]);
  return { countries, treatyTypes, classes };
}

const intakeLimits = () => ({
  max_document_bytes: MAX_DOC_BYTES,
  max_total_bytes: MAX_INTAKE_BYTES,
  max_documents: MAX_INTAKE_DOCS,
});

router.get(
  '/renewal-analyses/intake',
  asyncHandler(async (_req, res) => {
    res.json({ providers: llmProviders(), limits: intakeLimits() });
  }),
);

const intakeUploadSchema = z.object({
  documents: z.array(z.object({
    role: z.enum(DOC_ROLES).optional(),
    filename: z.string().min(1).max(400),
    mime_type: z.string().min(1).max(200),
    content_base64: z.string().min(1),
  })).min(1, 'Upload at least one pack').max(MAX_INTAKE_DOCS, `Up to ${MAX_INTAKE_DOCS} documents at a time`),
});

router.post(
  '/renewal-analyses/intake',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(intakeUploadSchema, req.body);
    const documents = body.documents.map(decodeUpload);
    const total = documents.reduce((n, d) => n + d.content.length, 0);
    if (total > MAX_INTAKE_BYTES) {
      throw new ValidationError('The packs exceed the 18MB the quick intake reads in one go — read the main pack first and add the rest on the desk');
    }
    try {
      const result = await extractIntake({ documents, lists: await intakeLists() });
      await audit({
        entityType: 'renewal_pack_analysis', entityId: null, action: 'intake_read', userId: req.user.id,
        detail: {
          provider: result.provider, model: result.model,
          documents: documents.map((d) => ({ filename: d.filename, mime_type: d.mime_type, size_bytes: d.content.length })),
        },
      });
      res.json({ ...result, limits: intakeLimits() });
    } catch (e) {
      if (e.code === 'llm_unavailable') {
        res.status(503).json({ error: e.message, code: e.code, attempts: e.attempts, providers: llmProviders() });
        return;
      }
      throw e;
    }
  }),
);

/**
 * What the record keeps of a quick intake: the model's picks as they came,
 * and the broker's review of each — worked out here from the picks and what
 * was saved, so the client cannot mark its own homework.
 */
function intakeRecord(intake, saved, user) {
  if (!intake || intake.mode !== 'quick') return null;
  return {
    provider: intake.provider || null,
    model: intake.model || null,
    extraction: intake.extraction,
    review: reviewIntake(intake.extraction, saved),
    reviewed_by: user.id,
    reviewed_at: new Date().toISOString(),
  };
}

router.post(
  '/renewal-analyses',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(createSchema, req.body);
    const mode = body.intake?.mode || 'full';
    const intake = intakeRecord(body.intake, body, req.user);
    const { rows } = await query(
      `INSERT INTO renewal_pack_analysis
         (cedant_name, cedant_domicile, cedant_notes, class_of_business, treaty_type, created_by, intake_mode, intake)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [body.cedant_name, body.cedant_domicile || null, body.cedant_notes || null,
        body.class_of_business, body.treaty_type, req.user.id, mode, intake ? JSON.stringify(intake) : null],
    );
    await audit({
      entityType: 'renewal_pack_analysis', entityId: rows[0].id, action: 'create', userId: req.user.id,
      detail: { intake_mode: mode, ...(intake ? { review: intake.review, provider: intake.provider, model: intake.model } : {}) },
    });
    res.status(201).json(rows[0]);
  }),
);

router.get(
  '/renewal-analyses/:id',
  asyncHandler(async (req, res) => {
    res.json(await detailOf(await getAnalysis(req.params.id)));
  }),
);

router.post(
  '/renewal-analyses/:id/verify',
  requireRole('broker', 'senior_broker', 'admin'),
  asyncHandler(async (req, res) => {
    const before = await getAnalysis(req.params.id);
    if (before.status !== 'complete' || !before.result) {
      throw new ConflictError('Nothing to sign off — run the analysis first');
    }
    // A second sign-off changes nothing: the first broker's stamp stands.
    if (before.verified_at) {
      res.json(await detailOf(before));
      return;
    }
    const { rows } = await query(
      'UPDATE renewal_pack_analysis SET verified_at = now(), verified_by = $1 WHERE id = $2 RETURNING *',
      [req.user.id, before.id],
    );
    await audit({
      entityType: 'renewal_pack_analysis', entityId: before.id, action: 'verify', userId: req.user.id,
      before: signoffState(before), after: signoffState(rows[0]),
    });
    res.json(await detailOf(rows[0]));
  }),
);

router.delete(
  '/renewal-analyses/:id/verify',
  requireRole('broker', 'senior_broker', 'admin'),
  asyncHandler(async (req, res) => {
    const before = await getAnalysis(req.params.id);
    if (!before.verified_at) {
      res.json(await detailOf(before));
      return;
    }
    const { rows } = await query(
      'UPDATE renewal_pack_analysis SET verified_at = NULL, verified_by = NULL WHERE id = $1 RETURNING *',
      [before.id],
    );
    await audit({
      entityType: 'renewal_pack_analysis', entityId: before.id, action: 'unverify', userId: req.user.id,
      before: signoffState(before), after: signoffState(rows[0]),
    });
    res.json(await detailOf(rows[0]));
  }),
);

/* A broker's correction to the drafted summary. The prose is the model's
   reading of the packs put into words, so it is the broker's to fix without a
   re-run; the figures carry their extraction trace and are corrected by
   re-running against a better pack. Any edit re-flags the draft. */
const summaryEditSchema = z.object({
  programme_prose: z.string().max(6000).optional(),
  executive_summary: z.string().max(8000).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change' });

router.patch(
  '/renewal-analyses/:id/summary',
  requireRole('broker', 'senior_broker', 'admin'),
  asyncHandler(async (req, res) => {
    const before = await getAnalysis(req.params.id);
    if (!before.result) throw new ConflictError('No summary to edit — run the analysis first');
    if (before.status === 'analysing') throw new ConflictError('Analysis is running — wait for it to finish');
    const body = validate(summaryEditSchema, req.body);
    const result = { ...before.result };
    if (body.executive_summary !== undefined) result.executive_summary = body.executive_summary;
    if (body.programme_prose !== undefined) {
      result.programme = { ...(result.programme || {}), prose: body.programme_prose };
    }
    const { rows } = await query(
      'UPDATE renewal_pack_analysis SET result = $1, verified_at = NULL, verified_by = NULL WHERE id = $2 RETURNING *',
      [JSON.stringify(result), before.id],
    );
    await audit({
      entityType: 'renewal_pack_analysis', entityId: before.id, action: 'edit_summary', userId: req.user.id,
      detail: { fields: Object.keys(body), was_verified: Boolean(before.verified_at) },
      before: signoffState(before), after: signoffState(rows[0]),
    });
    res.json(await detailOf(rows[0]));
  }),
);

/** The linked placement as the screens need it, or null when unlinked. */
async function linkedPlacement(placementId) {
  if (!placementId) return null;
  const { rows } = await query(
    `SELECT p.id, p.reference, p.class, p.inception, p.expiry, p.currency, p.status,
            c.name AS cedant_name
     FROM placement p LEFT JOIN cedant c ON c.id = p.cedant_id
     WHERE p.id = $1`,
    [placementId],
  );
  return rows[0] || null;
}

/* Link an analysis to a placement, or clear the link with null. The pairing
   is what lets the pack builder read an uploaded pack's section coverage, so
   it is deliberately a broker's decision rather than a match on cedant name —
   two placements can share a cedant and a class in the same season. */
const linkSchema = z.object({ placement_id: z.string().uuid().nullable() });

router.put(
  '/renewal-analyses/:id/placement',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await getAnalysis(req.params.id);
    const { placement_id: placementId } = validate(linkSchema, req.body);
    if (placementId) {
      const { rows } = await query('SELECT id FROM placement WHERE id = $1', [placementId]);
      if (!rows[0]) throw new NotFoundError('Placement');
    }
    const { rows } = await query(
      'UPDATE renewal_pack_analysis SET placement_id = $1 WHERE id = $2 RETURNING *',
      [placementId, req.params.id],
    );
    await audit({
      entityType: 'renewal_pack_analysis', entityId: req.params.id,
      action: placementId ? 'link_placement' : 'unlink_placement',
      userId: req.user.id, detail: { placement_id: placementId },
    });
    res.json({ ...rows[0], placement: await linkedPlacement(placementId) });
  }),
);

router.delete(
  '/renewal-analyses/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await getAnalysis(req.params.id);
    // A submission that went to market is the record of what went; it keeps
    // the pack it was drafted from.
    const { rowCount: submitted } = await query(
      'SELECT 1 FROM negotiation_submission WHERE analysis_id = $1 LIMIT 1', [req.params.id],
    );
    if (submitted) throw new ConflictError('This pack has gone to market — its submission keeps it. Unlink it from the placement instead of deleting it.');
    await query('DELETE FROM renewal_pack_analysis WHERE id = $1', [req.params.id]);
    await audit({ entityType: 'renewal_pack_analysis', entityId: req.params.id, action: 'delete', userId: req.user.id });
    res.status(204).end();
  }),
);

/* ── The market submission from the desk ──────────────────────────────
   The verified summary goes to market as a submission on the linked
   placement: drafted here, released by a second pair of eyes through the
   negotiation routes, mailed to each underwriter individually. */

const recipientSchema = z.object({
  market_id: z.string().uuid(),
  contact_id: z.string().uuid().optional(),
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
});

const deskSubmissionSchema = z.object({
  subject: z.string().min(1).max(400).optional(),
  body: z.string().min(1).max(100000).optional(),
  response_deadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').optional(),
  recipients: z.array(recipientSchema).min(1).max(100),
});

router.get(
  '/renewal-analyses/:id/submission',
  asyncHandler(async (req, res) => res.json(await deskContext(req.params.id, req.user))),
);

router.post(
  '/renewal-analyses/:id/submission',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(deskSubmissionSchema, req.body);
    res.status(201).json(await createDeskSubmission(req.params.id, body, req.user));
  }),
);

/* ── Responses and the release ─────────────────────────────────────────
   One row per reinsurer per layer, off the line ledger; the release is the
   one gate the desk adds — every layer signed to exactly its order. */

router.get(
  '/renewal-analyses/:id/responses',
  asyncHandler(async (req, res) => res.json(await responsesContext(req.params.id))),
);

router.post(
  '/renewal-analyses/:id/release',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => res.json(await releaseSignedLines(req.params.id, req.user))),
);

/* ── Signed lines: the advice merged per reinsurer ─────────────────────── */

const adviceSchema = z.object({
  subject: z.string().min(1).max(400).optional(),
  body: z.string().min(1).max(100000).optional(),
  market_ids: z.array(z.string().uuid()).max(200).optional(),
});

router.get(
  '/renewal-analyses/:id/signed-lines',
  asyncHandler(async (req, res) => res.json(await signedLinesContext(req.params.id, req.user))),
);

router.post(
  '/renewal-analyses/:id/signed-lines/send',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(adviceSchema, req.body || {});
    res.status(201).json(await sendSigningAdvices(req.params.id, body, req.user));
  }),
);

router.post(
  '/renewal-analyses/:id/signed-lines/courtesy',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(adviceSchema, req.body || {});
    res.status(201).json(await sendDeclinatureNotes(req.params.id, body, req.user));
  }),
);

const uploadSchema = z.object({
  role: z.enum(['expiring', 'current', 'other']).default('other'),
  filename: z.string().min(1),
  mime_type: z.string().min(1),
  content_base64: z.string().min(1),
});

// Upload a renewal pack (base64 JSON body, like bordereau imports).
router.post(
  '/renewal-analyses/:id/documents',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const analysis = await getAnalysis(req.params.id);
    if (analysis.status === 'analysing') throw new ConflictError('Analysis is running — wait for it to finish');
    const body = validate(uploadSchema, req.body);
    const { content, text_content: textContent } = decodeUpload(body);

    const { rows } = await query(
      `INSERT INTO renewal_pack_analysis_document (analysis_id, role, filename, mime_type, size_bytes, content, text_content, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${DOC_COLUMNS}`,
      [req.params.id, body.role, body.filename, body.mime_type, content.length, content, textContent, req.user.id],
    );
    const unverified = await clearSignoff(req.params.id);
    await audit({
      entityType: 'renewal_pack_analysis', entityId: req.params.id, action: 'upload_document',
      userId: req.user.id,
      detail: { filename: body.filename, role: body.role, size_bytes: content.length, cleared_signoff: unverified },
    });
    res.status(201).json(rows[0]);
  }),
);

router.delete(
  '/renewal-analyses/:id/documents/:docId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const analysis = await getAnalysis(req.params.id);
    if (analysis.status === 'analysing') throw new ConflictError('Analysis is running — wait for it to finish');
    const { rows } = await query(
      'DELETE FROM renewal_pack_analysis_document WHERE id = $1 AND analysis_id = $2 RETURNING id, filename',
      [req.params.docId, req.params.id],
    );
    if (!rows[0]) throw new NotFoundError('Document');
    const unverified = await clearSignoff(req.params.id);
    await audit({
      entityType: 'renewal_pack_analysis', entityId: req.params.id, action: 'delete_document',
      userId: req.user.id, detail: { filename: rows[0].filename, cleared_signoff: unverified },
    });
    res.status(204).end();
  }),
);

// Run (or re-run) the analysis over the uploaded packs with ChatGPT — no
// fallback provider; an outage reports 503 with the attempt rather than
// failing silently.
router.post(
  '/renewal-analyses/:id/run',
  requireRole('broker', 'admin', 'underwriter'),
  asyncHandler(async (req, res) => {
    const id = req.params.id;
    // Claim the run atomically so concurrent runs conflict instead of racing.
    const { rows: claimed } = await query(
      `UPDATE renewal_pack_analysis SET status = 'analysing', error = NULL
       WHERE id = $1 AND status <> 'analysing' RETURNING *`,
      [id],
    );
    if (!claimed[0]) {
      await getAnalysis(id); // 404 if missing
      throw new ConflictError('Analysis already running');
    }

    const { rows: documents } = await query(
      'SELECT * FROM renewal_pack_analysis_document WHERE analysis_id = $1 ORDER BY created_at',
      [id],
    );
    if (!documents.length) {
      await query(`UPDATE renewal_pack_analysis SET status = 'draft' WHERE id = $1`, [id]);
      throw new ConflictError('Upload at least one renewal pack before running the analysis');
    }

    let result;
    try {
      result = await analyseRenewalPacks({ analysis: claimed[0], documents });
    } catch (e) {
      const message = String(e?.message || e);
      await query(
        `UPDATE renewal_pack_analysis SET status = 'failed', error = $1 WHERE id = $2`,
        [message, id],
      );
      await audit({
        entityType: 'renewal_pack_analysis', entityId: id, action: 'analyse_failed',
        userId: req.user.id, detail: { error: message },
      });
      if (e.code === 'llm_unavailable') {
        res.status(503).json({ error: message, code: e.code, attempts: e.attempts, providers: llmProviders() });
        return;
      }
      throw e;
    }

    const { rows } = await query(
      `UPDATE renewal_pack_analysis
       SET status = 'complete', result = $1, provider = $2, model = $3, analysed_at = now(), error = NULL,
           verified_at = NULL, verified_by = NULL
       WHERE id = $4 RETURNING *`,
      [JSON.stringify(result.data), result.provider, result.model, id],
    );
    await audit({
      entityType: 'renewal_pack_analysis', entityId: id, action: 'analyse',
      userId: req.user.id, detail: { provider: result.provider, model: result.model, documents: documents.length },
    });
    res.json({ ...rows[0], attempts: result.attempts });
  }),
);

export default router;
