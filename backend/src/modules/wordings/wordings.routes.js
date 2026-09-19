import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate, pageParams } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { extractDocumentText } from '../../lib/tabular.js';
import { llmProviders } from '../../lib/llm.js';
import * as service from './wordings.service.js';
import * as slips from './slips.service.js';
import { analyseSlipComparison } from './slips.llm.js';

const router = Router();
router.use(authenticate);

const CATEGORIES = ['coverage', 'extension', 'exclusion', 'condition', 'definition'];
const category = z.enum(CATEGORIES);
const uuid = z.string().uuid();

/* ------------------------------------------------------------------ library */

const clauseSchema = z.object({
  title: z.string().min(1),
  clause_ref: z.string().max(64).nullish(),
  category,
  cob: z.string().nullish(),
  treaty_type: z.string().nullish(),
  source: z.enum(['standard', 'market', 'house']).optional(),
  market_id: uuid.nullish(),
  body: z.string().min(1),
  summary: z.string().nullish(),
  tags: z.array(z.string()).optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
  provenance: z.enum(['market_standard', 'illustrative']).optional(),
  source_org: z.string().nullish(),
  source_url: z.string().url().nullish(),
  source_note: z.string().nullish(),
});

// Filter options + counts, for the library filter bar.
router.get(
  '/wordings/meta',
  asyncHandler(async (_req, res) => res.json(await service.libraryMeta())),
);

router.get(
  '/wordings/clauses',
  asyncHandler(async (req, res) => {
    const filters = {
      cob: req.query.cob || undefined,
      strict_cob: req.query.strict_cob === 'true',
      category: req.query.category || undefined,
      source: req.query.source || undefined,
      market_id: req.query.market_id || undefined,
      treaty_type: req.query.treaty_type || undefined,
      status: req.query.status || undefined,
      provenance: req.query.provenance || undefined,
      q: req.query.q || undefined,
    };
    res.json(await service.listClauses(filters, pageParams(req.query)));
  }),
);

router.post(
  '/wordings/clauses',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(clauseSchema, req.body);
    res.status(201).json(await service.createClause(body, req.user.id));
  }),
);

router.get(
  '/wordings/clauses/:id',
  asyncHandler(async (req, res) => res.json(await service.getClause(req.params.id))),
);

/* Clause review: what changed against the version this supersedes, which
   reinsurers hold their own form of it, and where it is in force. */
router.get(
  '/wordings/clauses/:id/history',
  asyncHandler(async (req, res) => res.json(await service.clauseHistory(req.params.id))),
);

router.get(
  '/wordings/clauses/:id/variants',
  asyncHandler(async (req, res) => res.json(await service.clauseVariants(req.params.id))),
);

router.get(
  '/wordings/clauses/:id/usage',
  asyncHandler(async (req, res) => res.json(await service.clauseUsage(req.params.id))),
);

router.patch(
  '/wordings/clauses/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(clauseSchema.partial(), req.body);
    res.json(await service.updateClause(req.params.id, body, req.user.id));
  }),
);

router.delete(
  '/wordings/clauses/:id',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    await service.deleteClause(req.params.id, req.user.id);
    res.status(204).end();
  }),
);

/* ------------------------------------------------------------------- drafts */

const draftSchema = z.object({
  title: z.string().min(1),
  cob: z.string().nullish(),
  treaty_type: z.string().nullish(),
  placement_id: uuid.nullish(),
  layer_id: uuid.nullish(),
  base_market_id: uuid.nullish(),
  notes: z.string().nullish(),
  status: z.enum(['draft', 'review', 'issued', 'archived']).optional(),
  // Seeding controls — creation only.
  seed: z.boolean().optional(),
  categories: z.array(category).optional(),
});

router.get(
  '/wordings/drafts',
  asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status || undefined,
      placement_id: req.query.placement_id || undefined,
      layer_id: req.query.layer_id || undefined,
      cob: req.query.cob || undefined,
    };
    res.json(await service.listDrafts(filters, pageParams(req.query)));
  }),
);

router.post(
  '/wordings/drafts',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(draftSchema, req.body);
    res.status(201).json(await service.createDraft(body, req.user.id));
  }),
);

router.get(
  '/wordings/drafts/:id',
  asyncHandler(async (req, res) => res.json(await service.getDraft(req.params.id))),
);

router.patch(
  '/wordings/drafts/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(draftSchema.partial().omit({ seed: true, categories: true }), req.body);
    res.json(await service.updateDraft(req.params.id, body, req.user.id));
  }),
);

router.delete(
  '/wordings/drafts/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await service.deleteDraft(req.params.id, req.user.id);
    res.status(204).end();
  }),
);

const draftClauseSchema = z.object({
  clause_id: uuid.optional(),
  title: z.string().min(1).optional(),
  clause_ref: z.string().max(64).nullish(),
  category: category.optional(),
  body: z.string().min(1).optional(),
  position: z.number().int().positive().optional(),
});

router.post(
  '/wordings/drafts/:id/clauses',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(draftClauseSchema, req.body);
    res.status(201).json(await service.addDraftClause(req.params.id, body, req.user.id));
  }),
);

router.patch(
  '/wordings/drafts/:id/clauses/:clauseRowId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(draftClauseSchema.omit({ clause_id: true }), req.body);
    res.json(await service.updateDraftClause(req.params.id, req.params.clauseRowId, body, req.user.id));
  }),
);

// Put an amended clause back to the library text.
router.post(
  '/wordings/drafts/:id/clauses/:clauseRowId/revert',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await service.revertDraftClause(req.params.id, req.params.clauseRowId, req.user.id));
  }),
);

router.delete(
  '/wordings/drafts/:id/clauses/:clauseRowId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await service.deleteDraftClause(req.params.id, req.params.clauseRowId, req.user.id);
    res.status(204).end();
  }),
);

router.post(
  '/wordings/drafts/:id/reorder',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ clause_ids: z.array(uuid).min(1) }), req.body);
    res.json(await service.reorderDraft(req.params.id, body.clause_ids, req.user.id));
  }),
);

/* --------------------------------------------------------------- comparison */

/**
 * Compare two wordings. Each side is `{left,right}_type` plus `{left,right}_id`
 * and, for market/standard sides, the class to resolve the wording for:
 *
 *   /api/wordings/compare?left_type=standard&left_cob=Property
 *                        &right_type=market&right_id=<market>&right_cob=Property
 */
const SIDE_TYPES = ['draft', 'market', 'standard', 'clause'];
const NEEDS_ID = ['draft', 'market', 'clause'];

// Query params are strings; each side is validated as a group so a missing id
// on a draft/market/clause side is a 422 rather than a confusing 404.
const sideQuery = (prefix) => ({
  [`${prefix}_type`]: z.enum(SIDE_TYPES),
  [`${prefix}_id`]: z.string().uuid().optional(),
  [`${prefix}_cob`]: z.string().optional(),
  [`${prefix}_treaty_type`]: z.string().optional(),
  [`${prefix}_layered`]: z.enum(['true', 'false']).optional(),
});

const compareSchema = z
  .object({ ...sideQuery('left'), ...sideQuery('right') })
  .passthrough()
  .superRefine((q, ctx) => {
    for (const prefix of ['left', 'right']) {
      if (NEEDS_ID.includes(q[`${prefix}_type`]) && !q[`${prefix}_id`]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`${prefix}_id`],
          message: `${prefix}_id is required when ${prefix}_type is ${q[`${prefix}_type`]}`,
        });
      }
    }
  });

const toSide = (q, prefix) => ({
  type: q[`${prefix}_type`],
  id: q[`${prefix}_id`],
  cob: q[`${prefix}_cob`],
  treaty_type: q[`${prefix}_treaty_type`],
  layered: q[`${prefix}_layered`] !== 'false',
});

router.get(
  '/wordings/compare',
  asyncHandler(async (req, res) => {
    const q = validate(compareSchema, req.query);
    res.json(await service.compare(toSide(q, 'left'), toSide(q, 'right')));
  }),
);

/* ------------------------------------------------------------------- slips

   Reading a market's slip wording and measuring it against our own form. One
   slip is checked against the market standard; two are compared with each
   other as well. */

const slipInput = z.object({
  name: z.string().max(200).optional(),
  filename: z.string().max(255).optional(),
  // A PDF or text file, base64 encoded, or the text pasted straight in.
  content_base64: z.string().optional(),
  text: z.string().optional(),
}).refine((d) => d.content_base64 || d.text, {
  message: 'Provide a file or the slip text',
});

// Read a slip and hand back the clauses found, so the UI can show what it got
// before anything is compared.
router.post(
  '/wordings/slips/parse',
  asyncHandler(async (req, res) => {
    const body = validate(slipInput, req.body);
    res.json(await slips.readSlip(body));
  }),
);

const compareSlipsSchema = z.object({
  slips: z.array(slipInput).min(1).max(2),
  cob: z.string().nullish(),
  treaty_type: z.string().nullish(),
});

router.post(
  '/wordings/slips/compare',
  asyncHandler(async (req, res) => {
    const body = validate(compareSlipsSchema, req.body);
    const read = [];
    for (const s of body.slips) read.push(await slips.readSlip(s));
    res.json(await slips.compareSlips({
      slips: read,
      cob: body.cob || undefined,
      treaty_type: body.treaty_type || undefined,
    }));
  }),
);

/* The AI reading of a comparison: which wording movements matter, plus the
   commercial-terms check (limits, attachments, reinstatements, aggregates,
   premium, brokerage…) pulled from the full slip text, where clause alignment
   cannot see. Nothing is stored — the commentary is regenerated on demand.
   ChatGPT only; an outage reports 503 with the attempt. */
router.post(
  '/wordings/slips/commentary',
  asyncHandler(async (req, res) => {
    const body = validate(compareSlipsSchema, req.body);
    const texts = [];
    const read = [];
    for (const s of body.slips) {
      const text = s.text || await extractDocumentText(s.filename, s.content_base64);
      texts.push(text || '');
      read.push(await slips.readSlip({ name: s.name, filename: s.filename, text }));
    }
    const comparison = await slips.compareSlips({
      slips: read,
      cob: body.cob || undefined,
      treaty_type: body.treaty_type || undefined,
    });

    try {
      const result = await analyseSlipComparison({
        comparison,
        slips: read.map((r, i) => ({ name: r.name, text: texts[i] })),
      });
      res.json({
        ...result.data,
        mode: comparison.mode,
        slips: comparison.slips.map((s) => s.name),
        provider: result.provider,
        model: result.model,
        generated_at: new Date().toISOString(),
      });
    } catch (e) {
      if (e.code !== 'llm_unavailable') throw e;
      res.status(503).json({ error: e.message, code: e.code, attempts: e.attempts, providers: llmProviders() });
    }
  }),
);

export default router;
