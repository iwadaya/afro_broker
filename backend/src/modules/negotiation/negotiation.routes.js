// Negotiation: the pack goes to market, and the quotes come back against the
// structures that were quoted. Brokers drive it; everyone can read it.
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './negotiation.service.js';
import * as submissions from './submission.service.js';
import * as replies from './replies.js';
import { simulateReplies, SCENARIOS } from './demoReplies.js';

const router = Router();
router.use(authenticate);

const uuid = z.string().uuid();

// Every market sent the pack is approached for a lead quote: no role to name.
const sendSchema = z.object({
  market_ids: z.array(uuid).min(1).max(100),
  // Defaults to the latest approved pack version, else the latest built.
  pack_id: uuid.optional(),
});

const lineSchema = z.object({
  layer_index: z.number().int().min(0).nullish(),
  status: z.enum(['quoted', 'declined']).optional(),
  // A lead quote — terms the placement can be built on — or an indication.
  kind: z.enum(['lead', 'indicative']).optional(),
  rate_pct: z.number().min(0).nullish(),
  premium: z.number().min(0).nullish(),
  line_pct: z.number().min(0).max(100).nullish(),
  commission_pct: z.number().min(0).max(100).nullish(),
  validity: z.string().nullish(),
  notes: z.string().max(2000).nullish(),
  terms: z.record(z.string(), z.any()).optional(),
  // Who at the reinsurer gave these terms.
  contact_id: uuid.nullish(),
  // The quoted layer itself: an underwriter may move any column of it.
  layer_name: z.string().max(120).nullish(),
  layer_type: z.string().max(40).nullish(),
  limit_amt: z.number().min(0).nullish(),
  attachment: z.number().min(0).nullish(),
  reinstatements: z.string().max(20).nullish(),
  reinstatement_pct: z.number().min(0).nullish(),
  egnpi: z.number().min(0).nullish(),
  aad: z.number().min(0).nullish(),
  order_pct: z.number().min(0).max(100).nullish(),
  risk_cover: z.boolean().nullish(),
  cat_cover: z.boolean().nullish(),
});

// One line of one structure: which structure it belongs to, then the answer.
const quoteSchema = lineSchema.extend({
  structure_index: z.number().int().min(1).optional(),
  market_structure_id: uuid.optional(),
}).refine((q) => Boolean(q.structure_index) !== Boolean(q.market_structure_id), {
  message: 'Name either the structure that was sent or the market’s own',
});

// A structure the market put up itself, in the same shape as a sent one.
const marketStructureSchema = z.object({
  id: uuid.optional(),
  label: z.string().min(1).max(120),
  basis: z.enum(['NP', 'PROP']),
  structure: z.object({
    layers: z.array(z.record(z.string(), z.any())).max(30).optional(),
    prop: z.record(z.string(), z.any()).optional(),
  }).default({}),
  notes: z.string().max(2000).nullish(),
});

/** A market's whole sheet: the structures it was sent, then any of its own. */
const sheetSchema = z.object({
  structures: z.array(z.object({
    structure_index: z.number().int().min(1).optional(),
    market_structure: marketStructureSchema.optional(),
    // Declined outright: every line of this structure is answered with a decline.
    declined: z.boolean().optional(),
    // An indication on this structure: every line it prices is marked so.
    indicative: z.boolean().optional(),
    lines: z.array(lineSchema).max(30).optional(),
  }).refine((e) => Boolean(e.structure_index) !== Boolean(e.market_structure), {
    message: 'Each entry is either a structure that was sent or the market’s own',
  })).max(20),
});

const negotiationPatchSchema = z.object({
  status: z.enum(['SENT', 'QUOTED', 'DECLINED', 'WITHDRAWN']).optional(),
  notes: z.string().max(2000).nullish(),
});

router.get(
  '/placements/:placementId/negotiation',
  asyncHandler(async (req, res) => res.json(await service.getNegotiation(req.params.placementId))),
);

router.post(
  '/placements/:placementId/negotiation/send',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(sendSchema, req.body);
    const { pack, sent } = await service.sendPack(req.params.placementId, body, req.user.id);
    // The refreshed board, plus what this send did: `sent_pack` is the version
    // that went out and `sent` the markets it went to (any already holding it
    // are left alone).
    const board = await service.getNegotiation(req.params.placementId);
    res.status(201).json({ ...board, sent, sent_pack: pack });
  }),
);

router.patch(
  '/negotiations/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(negotiationPatchSchema, req.body);
    res.json(await service.updateNegotiation(req.params.id, body, req.user.id));
  }),
);

router.delete(
  '/negotiations/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await service.removeNegotiation(req.params.id, req.user.id);
    res.status(204).end();
  }),
);

/** One market's sheet, with the structures it was sent pulled through. */
router.get(
  '/negotiations/:id/sheet',
  asyncHandler(async (req, res) => res.json(await service.getQuoteSheet(req.params.id))),
);

/** Save that sheet: every structure it was sent, plus any of its own. */
router.put(
  '/negotiations/:id/sheet',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(sheetSchema, req.body);
    const saved = await service.saveQuoteSheet(req.params.id, body, req.user.id);
    res.json({ ...saved, ...(await service.getQuoteSheet(req.params.id)) });
  }),
);

router.delete(
  '/negotiations/:id/structures/:structureId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await service.removeMarketStructure(req.params.id, req.params.structureId, req.user.id);
    res.status(204).end();
  }),
);

/** Capture (or replace) what this market quoted on one line. */
router.put(
  '/negotiations/:id/quotes',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(quoteSchema, req.body);
    res.json(await service.saveQuote(req.params.id, body, req.user.id));
  }),
);

router.delete(
  '/negotiations/:id/quotes/:quoteId',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    await service.deleteQuote(req.params.id, req.params.quoteId, req.user.id);
    res.status(204).end();
  }),
);

// Lead quote or indication, per structure: the one this market was sent, or
// one of its own.
const quoteKindSchema = z.object({
  structure_index: z.number().int().min(1).optional(),
  market_structure_id: uuid.optional(),
  kind: z.enum(['lead', 'indicative']),
}).refine((k) => Boolean(k.structure_index) !== Boolean(k.market_structure_id), {
  message: 'Name either the structure that was sent or the market’s own',
});

/** Mark what this market quoted on a structure as a lead quote or an indication. */
router.put(
  '/negotiations/:id/quote-kind',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(quoteKindSchema, req.body);
    res.json(await service.setQuoteKind(req.params.id, body, req.user.id));
  }),
);

// ---------------------------------------------------------------------------
// Taking the pack to market: a covering email to named underwriters, drafted
// with AI commentary the broker must read, released by a second pair of eyes.
// ---------------------------------------------------------------------------

const recipientSchema = z.object({
  market_id: uuid,
  contact_id: uuid.optional(),
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
});

const submissionSchema = z.object({
  pack_id: uuid.optional(),
  wording_id: uuid.optional(),
  subject: z.string().min(1).max(400).optional(),
  // A broker who would rather write their own opening can pass it in.
  commentary: z.string().max(8000).optional(),
  attach_pack: z.boolean().optional(),
  recipients: z.array(recipientSchema).min(1).max(100),
});

const submissionPatchSchema = z.object({
  subject: z.string().min(1).max(400).optional(),
  body: z.string().min(1).max(100000).optional(),
  attach_pack: z.boolean().optional(),
  broker_reviewed: z.boolean().optional(),
  recipients: z.array(recipientSchema).min(1).max(100).optional(),
});

/** Markets with the underwriter addresses a submission can go to. */
router.get(
  '/underwriters',
  asyncHandler(async (_req, res) => res.json(await submissions.listUnderwriters())),
);

/** What a submission would be built from, and what stands in its way. */
router.get(
  '/placements/:placementId/negotiation/submission-context',
  asyncHandler(async (req, res) => {
    const { placement, cedant, pack, wording, structures, blockers, warnings, ready, mail_transport } =
      await submissions.submissionContext(req.params.placementId, {
        pack_id: req.query.pack_id || undefined,
        wording_id: req.query.wording_id || undefined,
      });
    res.json({
      placement: { id: placement.id, reference: placement.reference, currency: placement.currency },
      cedant,
      pack: pack && { id: pack.id, version: pack.version, status: pack.status, summary: pack.summary },
      wording: wording && {
        id: wording.id, title: wording.title, status: wording.status, clause_count: wording.clause_count,
      },
      structures: structures.map((s) => ({ index: s.index, label: s.label, basis: s.basis, lines: s.lines.length })),
      ready,
      blockers,
      warnings,
      mail_transport,
    });
  }),
);

router.get(
  '/placements/:placementId/negotiation/submissions',
  asyncHandler(async (req, res) => res.json(await submissions.listSubmissions(req.params.placementId))),
);

router.post(
  '/placements/:placementId/negotiation/submissions',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(submissionSchema, req.body);
    res.status(201).json(await submissions.createSubmission(req.params.placementId, body, req.user));
  }),
);

router.get(
  '/negotiation-submissions/:id',
  asyncHandler(async (req, res) => res.json(await submissions.getSubmission(req.params.id))),
);

router.patch(
  '/negotiation-submissions/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(submissionPatchSchema, req.body);
    res.json(await submissions.updateSubmission(req.params.id, body, req.user));
  }),
);

router.post(
  '/negotiation-submissions/:id/redraft',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => res.json(await submissions.redraftCommentary(req.params.id, req.user))),
);

router.post(
  '/negotiation-submissions/:id/request-approval',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => res.json(await submissions.requestApproval(req.params.id, req.user))),
);

/** The release: a *different* underwriter or admin sends it to market. */
router.post(
  '/negotiation-submissions/:id/approve',
  requireRole('underwriter', 'admin'),
  asyncHandler(async (req, res) => res.json(await submissions.approveAndSend(req.params.id, req.user))),
);

router.post(
  '/negotiation-submissions/:id/reject',
  requireRole('underwriter', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ reason: z.string().max(2000).optional() }), req.body);
    res.json(await submissions.rejectSubmission(req.params.id, req.user, body.reason));
  }),
);

router.post(
  '/negotiation-submissions/:id/cancel',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => res.json(await submissions.cancelSubmission(req.params.id, req.user))),
);

// ---------------------------------------------------------------------------
// The replies: what came back from the underwriters, read by the AI.
// ---------------------------------------------------------------------------

router.get(
  '/placements/:placementId/negotiation/replies',
  asyncHandler(async (req, res) => res.json(await replies.listReplies(req.params.placementId))),
);

const manualReplySchema = z.object({
  recipient_id: uuid.optional(),
  from_email: z.string().email().optional(),
  from_name: z.string().max(200).optional(),
  subject: z.string().max(400).optional(),
  body: z.string().min(1).max(100000),
  received_at: z.string().datetime({ offset: true }).optional(),
}).refine((b) => b.recipient_id || b.from_email, { message: 'Say who the reply is from: a recipient or an email address' });

/** A reply that arrived outside the mailbox, pasted in. */
router.post(
  '/negotiation-submissions/:id/replies',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(manualReplySchema, req.body);
    res.status(201).json(await replies.logManualReply(req.params.id, body, req.user));
  }),
);

/** Demo: the AI plays every underwriter still awaited and replies. */
router.post(
  '/placements/:placementId/negotiation/replies/simulate',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ only: z.enum(SCENARIOS).optional() }), req.body || {});
    res.status(201).json(await simulateReplies(req.params.placementId, { only: body.only, userId: req.user.id }));
  }),
);

router.post(
  '/negotiation-replies/:id/handled',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ handled: z.boolean().optional() }), req.body || {});
    res.json(await replies.markHandled(req.params.id, req.user, body.handled ?? true));
  }),
);

router.post(
  '/negotiation-replies/:id/reread',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => res.json(await replies.rereadReply(req.params.id))),
);

export default router;
