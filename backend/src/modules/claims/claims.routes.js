import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, validate } from '../../lib/http.js';
import { authenticate, requireRole } from '../../middleware/auth.js';
import * as svc from './claims.service.js';
import * as advices from './claimAdvices.service.js';

const router = Router();
router.use(authenticate);

const lossSchema = z.object({
  name: z.string().min(1),
  loss_date: z.string(),
  gross_loss: z.number().nonnegative(),
  cat_event: z.boolean().optional(),
  description: z.string().optional(),
  // The cedant's particulars and the settlement ladder's inputs.
  reference: z.string().max(120).nullable().optional(),
  insured: z.string().max(300).nullable().optional(),
  cause: z.string().max(300).nullable().optional(),
  paid: z.number().nonnegative().nullable().optional(),
  outstanding: z.number().nonnegative().nullable().optional(),
  lae: z.number().nonnegative().optional(),
  salvage: z.number().nonnegative().optional(),
  cash_funded: z.number().nonnegative().optional(),
  waive_reinstatement: z.boolean().optional(),
});

const adviceSchema = z.object({
  subject: z.string().min(1).max(400).optional(),
  body: z.string().min(1).max(100000).optional(),
  market_ids: z.array(z.string().uuid()).max(200).optional(),
});

router.get(
  '/placements/:placementId/losses',
  asyncHandler(async (req, res) => {
    res.json(await svc.listLosses(req.params.placementId));
  }),
);

router.post(
  '/placements/:placementId/losses',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(lossSchema, req.body);
    res.status(201).json(await svc.createLoss(req.params.placementId, body, req.user.id));
  }),
);

router.get(
  '/losses/:id',
  asyncHandler(async (req, res) => {
    res.json(await svc.getLoss(req.params.id));
  }),
);

router.patch(
  '/losses/:id',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(lossSchema.partial(), req.body);
    res.json(await svc.updateLoss(req.params.id, body, req.user.id));
  }),
);

// Calculate loss to each bound XoL layer, market shares and reinstatement
// premium; persists the recoveries and issues the loss advice.
router.post(
  '/losses/:id/calculate',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await svc.calculateLoss(req.params.id, req.user.id));
  }),
);

router.post(
  '/losses/:id/settle',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    res.json(await svc.settleLoss(req.params.id, req.user.id));
  }),
);

// The advices: the preliminary loss advice to the whole signed panel, and
// the claim advice with each market's share merged in.
router.get(
  '/losses/:id/advices',
  asyncHandler(async (req, res) => res.json(await advices.listAdvices(req.params.id))),
);

router.get(
  '/losses/:id/advice-draft',
  asyncHandler(async (req, res) => res.json(await advices.draftClaimAdvice(req.params.id, req.user))),
);

router.post(
  '/losses/:id/preliminary-advice',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(z.object({ resend: z.boolean().optional() }), req.body || {});
    const out = await advices.issuePreliminaryAdvice(req.params.id, { resend: body.resend ?? true }, req.user);
    res.status(out.already ? 200 : 201).json(out);
  }),
);

router.post(
  '/losses/:id/claim-advice',
  requireRole('broker', 'admin'),
  asyncHandler(async (req, res) => {
    const body = validate(adviceSchema, req.body || {});
    res.status(201).json(await advices.issueClaimAdvice(req.params.id, body, req.user));
  }),
);

export default router;
