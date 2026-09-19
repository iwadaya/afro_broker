// Final placement: the details of the final terms, the firm order terms
// email, and the written and signed lines.
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as service from './final.service.js';

const router = Router();
router.use(authenticate);

const uuid = z.string().uuid();
const numeric = z.union([z.number(), z.string(), z.null()]).optional();

const detailsSchema = z.object({
  lead_won: z.boolean().optional(),
  lead_broker: z.string().max(200).nullish(),
  lead_reinsurer_id: uuid.nullish(),
  lead_reinsurer_name: z.string().max(200).nullish(),
  treaty_type: z.string().max(120).nullish(),
  notes: z.string().max(4000).nullish(),
  terms: z.array(z.object({
    key: z.string().max(40),
    quote_id: uuid.nullish(),
    premium: numeric,
    rate_pct: numeric,
    commission_pct: numeric,
    limit: numeric,
    attachment: numeric,
    treaty_type: z.string().max(120).nullish(),
    notes: z.string().max(1000).nullish(),
  })).max(100).optional(),
});

const recipientSchema = z.object({
  market_id: uuid,
  contact_id: uuid.optional(),
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
});

const emailSchema = z.object({
  kind: z.enum(['fot', 'confirmation', 'declinature']).optional(),
  recipients: z.array(recipientSchema).min(1).max(100),
  subject: z.string().min(1).max(400).optional(),
  body: z.string().min(1).max(100000).optional(),
  attach_pack: z.boolean().optional(),
  // A pack uploaded by hand (with its reason) to attach instead of the approved version.
  pack_upload_id: uuid.optional(),
});

const packUploadSchema = z.object({
  filename: z.string().min(1).max(300),
  mime_type: z.string().min(1).max(200).optional(),
  content_base64: z.string().min(1),
  reason: z.string().trim().min(5).max(2000),
});

const readEmailsSchema = z.object({
  emails: z.array(z.object({
    market_id: uuid.optional(),
    from_email: z.string().email(),
    from_name: z.string().max(200).optional(),
    subject: z.string().max(400).optional(),
    body: z.string().min(1).max(100000),
    received_at: z.string().datetime({ offset: true }).optional(),
  })).max(50).optional(),
});

const acceptSchema = z.object({ market_id: uuid, term_key: z.string().max(40) });

const linesSchema = z.object({
  lines: z.array(z.object({
    market_id: uuid,
    term_key: z.string().max(40),
    written_pct: z.union([z.number(), z.string()]),
    to_stand: z.boolean().optional(),
    contact_id: uuid.nullish(),
    notes: z.string().max(1000).nullish(),
  })).max(500),
});

const confirmSchema = z.object({
  send: z.boolean().optional(),
  subject: z.string().min(1).max(400).optional(),
  body: z.string().min(1).max(100000).optional(),
});

router.get(
  '/placements/:placementId/final',
  asyncHandler(async (req, res) => res.json(await service.getFinalPlacement(req.params.placementId))),
);

router.put(
  '/placements/:placementId/final',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(detailsSchema, req.body || {});
    res.json(await service.saveDetails(req.params.placementId, body, req.user));
  }),
);

/** The drafted email of a kind (`fot` by default), for the broker to edit. */
router.get(
  '/placements/:placementId/final/email-draft',
  asyncHandler(async (req, res) => {
    res.json(await service.draftEmail(req.params.placementId, req.query.kind === 'confirmation' ? 'confirmation' : 'fot', req.user));
  }),
);

router.post(
  '/placements/:placementId/final/emails',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(emailSchema, req.body || {});
    res.status(201).json(await service.sendEmail(req.params.placementId, body, req.user));
  }),
);

router.put(
  '/placements/:placementId/final/lines',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(linesSchema, req.body || {});
    res.json(await service.saveLines(req.params.placementId, body, req.user));
  }),
);

/** A renewal pack attached by hand at this stage — it has to say why. */
router.post(
  '/placements/:placementId/final/pack-upload',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(packUploadSchema, req.body || {});
    res.status(201).json(await service.uploadPack(req.params.placementId, body, req.user));
  }),
);

/** Read the reinsurers' emails (on file, plus any pasted in) for written and signed lines. */
router.post(
  '/placements/:placementId/final/lines/read-emails',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(readEmailsSchema, req.body || {});
    res.json(await service.readLinesFromEmails(req.params.placementId, body, req.user, req.app.locals.llmClients || {}));
  }),
);

/** A broker accepts a line the AI read off an email. */
router.post(
  '/placements/:placementId/final/lines/accept',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(acceptSchema, req.body || {});
    res.json(await service.acceptLine(req.params.placementId, body, req.user));
  }),
);

router.post(
  '/placements/:placementId/final/confirm',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(confirmSchema, req.body || {});
    res.json(await service.confirmShares(req.params.placementId, body, req.user));
  }),
);

export default router;
